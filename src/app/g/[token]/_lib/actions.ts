'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. The five things a guest can do.
 *
 * ── Why the token is an argument, and why that is not a hole ──────────────
 *
 * Every action below takes the token from the client. That looks alarming for
 * about a second and then stops: the token IS the credential, it is already in
 * the URL the guest is looking at, and the SECURITY DEFINER function on the
 * other side re-resolves it and refuses a revoked, expired or unknown one. A
 * Server Action is a public endpoint reachable by a crafted POST whatever the
 * screen rendered, so the only question that matters is whether the server
 * checks — and it does, in the database, on every call.
 *
 * What would be a hole is a booking id beside it. There is none, in any of
 * these signatures or in any of the RPCs they call, and `idor.test.ts` asserts
 * that structurally rather than trusting this paragraph.
 *
 * ── Never a thrown error ──────────────────────────────────────────────────
 *
 * A throw inside a Server Action reaches the browser as a digest and a blank
 * screen. For a signed-in employee that is bad; for a guest on a telephone
 * with no account and no support screen it is the end of the road. So every
 * failure becomes the `SafeErrorBody` `src/lib/errors` already produces: a
 * Hebrew sentence, whether the data was saved, and whether retrying is safe.
 *
 * ── The correlation id is deliberately not shown to a guest ───────────────
 *
 * It is returned in the body and the screens do not render it. A guest cannot
 * use it, cannot quote it to anybody who can, and a UUID under an error
 * message reads as "something is broken" rather than as help. It stays in the
 * response so a developer reading a network tab can still find the log line.
 */

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import {
  confirmBooking,
  declareCheckout,
  saveDetails,
  signContract,
  submitRequest,
  type GuestDetailField,
  type GuestRequestCategory,
} from '@/lib/guest-journey'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

export type GuestActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

/**
 * The request's own fingerprint, for the consent records.
 *
 * Best effort and never fatal. `try_cast_inet` in 0034 turns a malformed
 * forwarded address into null rather than raising, because a guest behind a
 * proxy that sends something odd must still be able to confirm their booking.
 */
async function requestFingerprint(): Promise<{
  ip: string | null
  userAgent: string | null
}> {
  const list = await headers()
  const forwarded = list.get('x-forwarded-for')
  return {
    // The left-most entry is the client; the rest are proxies.
    ip: forwarded?.split(',')[0]?.trim() || list.get('x-real-ip') || null,
    userAgent: list.get('user-agent'),
  }
}

/** Every action revalidates the whole portal: one journey, six views of it. */
function revalidatePortal(token: string): void {
  revalidatePath(`/g/${token}`, 'layout')
}

async function run<TData>(
  action: () => Promise<TData>,
  token: string,
): Promise<GuestActionResult<TData>> {
  const correlationId = crypto.randomUUID()
  try {
    const data = await action()
    revalidatePortal(token)
    return { ok: true, data }
  } catch (cause) {
    // `toSafeResponse` never echoes its input, which is why every failure goes
    // through it — the token must not reach a log line or a response body.
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* -------------------------------------------------------------- confirm -- */

/**
 * `expectedVersion` is the version the guest was LOOKING at.
 *
 * Passing it is what turns "the booking changed under them" from a silent
 * mis-recording into a refusal they can act on. The database compares it with
 * the row the token found and raises `guest_confirmation_stale` on a mismatch,
 * carrying the live version so the screen can re-read and show the delta.
 */
export async function confirmBookingAction(
  token: string,
  expectedVersion: number,
): Promise<GuestActionResult<{ confirmedAt: string; created: boolean }>> {
  return run(async () => {
    const db = await createClient()
    const fingerprint = await requestFingerprint()
    const result = await confirmBooking(db, token, expectedVersion, fingerprint)
    return { confirmedAt: result.confirmedAt, created: result.created }
  }, token)
}

/* ----------------------------------------------------------------- sign -- */

export async function signContractAction(
  token: string,
  input: { signerName: string; signatureText: string; idNumber: string | null },
): Promise<GuestActionResult<{ signedAt: string; created: boolean }>> {
  return run(async () => {
    const db = await createClient()
    const fingerprint = await requestFingerprint()
    const result = await signContract(db, token, input, fingerprint)
    return { signedAt: result.signedAt, created: result.created }
  }, token)
}

/* -------------------------------------------------------------- details -- */

export async function saveDetailsAction(
  token: string,
  fields: Partial<Record<GuestDetailField, string>>,
): Promise<GuestActionResult<{ submittedAt: string | null }>> {
  return run(async () => {
    const db = await createClient()
    // The keys are filtered against the closed list inside `saveDetails`, so a
    // crafted payload cannot write an arbitrary name into a jsonb column that
    // a staff screen later renders.
    return saveDetails(db, token, fields, true)
  }, token)
}

/* -------------------------------------------------------------- request -- */

/**
 * `clientKey` is minted when the compose form OPENS, not when it is submitted.
 *
 * That is the entire idempotency story for this call: a double tap shares one
 * key and produces one request, while a second genuine request for towels an
 * hour later carries a new one and produces a second — which no combination of
 * category, body and timestamp could distinguish.
 */
export async function submitRequestAction(
  token: string,
  input: {
    category: GuestRequestCategory
    body: string | null
    clientKey: string
  },
): Promise<GuestActionResult<{ requestId: string; created: boolean }>> {
  return run(async () => {
    const db = await createClient()
    const result = await submitRequest(db, token, input)
    return { requestId: result.requestId, created: result.created }
  }, token)
}

/* ------------------------------------------------------------- checkout -- */

export async function declareCheckoutAction(
  token: string,
): Promise<GuestActionResult<{ declaredAt: string | null }>> {
  return run(async () => {
    const db = await createClient()
    return declareCheckout(db, token)
  }, token)
}
