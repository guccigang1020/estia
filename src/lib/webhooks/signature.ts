/**
 * Proving that a delivery came from ESTIA.
 *
 * ══ SERVER ONLY ═════════════════════════════════════════════════════════════
 *
 * This file imports `node:crypto` and is therefore **deliberately absent from
 * `index.ts`**. The barrel stays importable by a Client Component; the sender
 * imports this module by path. Same argument `fiscal/index.ts` makes about
 * keeping the read side out of the barrel, for the same reason: a screen that
 * accidentally pulls in the signer pulls in the signing secret's whole
 * neighbourhood.
 *
 * ══ WHAT THE RECEIVER IS ACTUALLY ASKED TO BELIEVE ══════════════════════════
 *
 * A webhook arrives at a URL that anybody on the internet can also POST to.
 * Without a signature the receiver's only options are "trust every POST" or
 * "call back to confirm", and the first is how a stranger cancels somebody's
 * booking by curling an endpoint they found in a JS bundle.
 *
 * So each delivery carries:
 *
 *     Estia-Signature: t=1757155200,v1=6f2a…
 *
 * where `v1` is HMAC-SHA256 over the exact bytes `${t}.${body}`, keyed with
 * the endpoint's signing secret. Three properties fall out of that shape and
 * each one is load-bearing:
 *
 *   1. **The timestamp is inside the MAC.** If it were a separate header an
 *      attacker could replay yesterday's body with today's `t`, and the
 *      freshness check would pass on a message it never protected.
 *   2. **The body is signed byte-for-byte, before parsing.** A receiver that
 *      re-serialises the JSON and then verifies is checking its own output.
 *      `signPayload` therefore takes the string that will actually be sent,
 *      and the sender must not touch it afterwards.
 *   3. **`v1` is a version, not decoration.** When the scheme changes, both
 *      headers ship for a period and receivers migrate. A signature format
 *      with no version is one that can never be changed without breaking
 *      every customer at once.
 *
 * ══ ROTATION IS PART OF THE DESIGN, NOT A LATER FEATURE ═════════════════════
 *
 * `signPayload` accepts several secrets and emits a `v1=` for each. During a
 * rotation the old and the new secret are both live, so a receiver that has
 * updated and one that has not both verify — and `verifySignature` accepts a
 * delivery if ANY of the offered signatures matches. Without this, rotating a
 * secret means a window where every delivery fails, which means nobody rotates.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** The header ESTIA sets. Lower-case: HTTP header names are insensitive and
 *  fetch normalises, and a mixed-case constant invites a case-sensitive
 *  comparison somewhere downstream. */
export const SIGNATURE_HEADER = 'estia-signature'

/** Named on every delivery so a receiver can route without parsing the body. */
export const EVENT_HEADER = 'estia-event'
export const DELIVERY_HEADER = 'estia-delivery'

/**
 * How far out of step a delivery's clock may be, in seconds.
 *
 * Five minutes each way. Long enough for ordinary drift and a slow queue,
 * short enough that a captured request stops being useful quickly. Exported
 * so the receiver-side helper and its tests agree on one number.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300

/** A new signing secret. 32 bytes from the CSPRNG, hex encoded. */
export function generateSigningSecret(): string {
  return randomBytes(32).toString('hex')
}

function hmac(secret: string, signedPayload: string): string {
  return createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex')
}

/**
 * The header value for a body that is about to be sent.
 *
 * `body` must be the exact string the request will carry. Sign, then send the
 * same variable — anything that re-serialises between the two has signed
 * something the receiver will never see.
 */
export function signPayload(
  body: string,
  secrets: readonly string[],
  now: Date,
): string {
  if (secrets.length === 0) {
    throw new Error('a delivery cannot be signed with no secret')
  }
  const t = Math.floor(now.getTime() / 1000)
  const signed = `${t}.${body}`
  const parts = secrets.map((secret) => `v1=${hmac(secret, signed)}`)
  return [`t=${t}`, ...parts].join(',')
}

/** Constant time, and length-safe: `timingSafeEqual` throws on a mismatch. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export const SIGNATURE_FAILURES = [
  'malformed',
  'no_signature',
  'stale',
  'mismatch',
] as const

export type SignatureFailure = (typeof SIGNATURE_FAILURES)[number]

export type SignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SignatureFailure }

/**
 * The receiver's half, shipped rather than described.
 *
 * ESTIA does not call this in the send path — it is what a customer needs in
 * order to trust a delivery, and documentation that says "compute an HMAC
 * over `t.body`" produces ten subtly different implementations, of which the
 * one that compares with `===` leaks the secret a byte at a time.
 *
 * It is also what the module's own tests verify against, so the thing
 * customers are handed is the thing that is under test.
 */
export function verifySignature(
  body: string,
  header: string | null,
  secrets: readonly string[],
  now: Date,
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): SignatureVerdict {
  if (header === null || header.trim() === '') {
    return { ok: false, reason: 'no_signature' }
  }

  let timestamp: number | null = null
  const offered: string[] = []
  for (const part of header.split(',')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    const key = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    if (key === 't' && /^\d{1,15}$/.test(value)) timestamp = Number(value)
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) offered.push(value)
  }

  if (timestamp === null) return { ok: false, reason: 'malformed' }
  if (offered.length === 0) return { ok: false, reason: 'no_signature' }

  // Both directions. A future timestamp is as suspicious as an old one, and
  // a check that only looks backwards accepts a signature minted for tomorrow
  // and replayed until then.
  const drift = Math.abs(Math.floor(now.getTime() / 1000) - timestamp)
  if (drift > toleranceSeconds) return { ok: false, reason: 'stale' }

  const signed = `${timestamp}.${body}`
  // Every combination is computed rather than short-circuiting on the first
  // match, so the time taken does not reveal which secret verified.
  let matched = false
  for (const secret of secrets) {
    const expected = hmac(secret, signed)
    for (const candidate of offered) {
      if (equals(expected, candidate)) matched = true
    }
  }

  return matched ? { ok: true } : { ok: false, reason: 'mismatch' }
}
