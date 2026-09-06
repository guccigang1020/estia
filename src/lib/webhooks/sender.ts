/**
 * One attempt at one delivery.
 *
 * SERVER ONLY — it signs, and it opens sockets. Not in `index.ts`.
 *
 * ══ THE SECOND GATE ═════════════════════════════════════════════════════════
 *
 * `url-safety.ts` checks the URL a person typed. It cannot check where that
 * hostname points, because DNS answers change — and an attacker who owns
 * `hooks.example.com` can point it at `169.254.169.254` any time after
 * registration passed. That is DNS rebinding, and it is the whole reason a
 * registration-time check alone is theatre.
 *
 * So the sender resolves the hostname itself and runs `isBlockedAddress`
 * against every address that comes back, before connecting. Same function,
 * same list — if the two gates had separate lists, the one that drifted would
 * be the one nobody was watching.
 *
 * **The honest limit:** between this lookup and the socket connecting, the
 * resolver could answer differently — a genuine time-of-check-to-time-of-use
 * race. Closing it completely means pinning the connection to the address
 * that was checked, through a custom agent with a `lookup` hook. That is a
 * transport concern, and `WebhookTransport` is an interface precisely so a
 * pinning implementation can be substituted without this file changing. What
 * is NOT acceptable is leaving the check out because it is imperfect: it
 * turns a reliable attack into a race an attacker has to win.
 *
 * ══ REDIRECTS ARE NOT FOLLOWED, AND THAT IS A SECURITY DECISION ═════════════
 *
 * A checked, public, well-behaved host answering `302 Location:
 * http://169.254.169.254/` walks straight through every gate above, because
 * the gates ran against the URL that was requested and not the one that was
 * finally fetched. So a 3xx is a failure, it is not retried, and the customer
 * is told their endpoint redirects. `retry.ts` asserts this.
 *
 * ══ WHAT IS SENT, AND WHAT IS READ BACK ═════════════════════════════════════
 *
 * Sent: the exact serialised envelope, signed with every live secret. Read
 * back: the status code and nothing else. The response body is never parsed,
 * never stored beyond a truncated error string, and never acted on — a
 * webhook receiver has no way to tell ESTIA anything, by design. The one
 * exception is `410`, which is a documented instruction to stop, and is
 * handled in `retry.ts` rather than here.
 */

import { isBlockedAddress } from './url-safety'
import { serialiseEnvelope, type WebhookEnvelope } from './subscription'
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  signPayload,
} from './signature'
import type { AttemptOutcome } from './types'

/** How long one attempt may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 10_000

/**
 * The two pieces of I/O, named so they can be faked in a test and replaced in
 * production without touching the logic above them.
 */
export interface WebhookTransport {
  /** Every address the hostname resolves to. Empty is a failure, not a pass. */
  resolve(hostname: string): Promise<readonly string[]>
  /**
   * POST, WITHOUT following redirects, with a timeout. Returns the status; a
   * transport failure is reported as a value, never thrown — the same rule
   * `fiscal/provider.ts` sets for the invoicing port, for the same reason:
   * a call that dies after the request left has either had an effect or not,
   * and an exception asserts it did not.
   */
  post(request: {
    readonly url: string
    readonly body: string
    readonly headers: Readonly<Record<string, string>>
    readonly timeoutMs: number
  }): Promise<
    | { readonly kind: 'responded'; readonly statusCode: number }
    | { readonly kind: 'timed_out' }
    | { readonly kind: 'network_error'; readonly detail: string }
  >
}

/**
 * Send one delivery, once.
 *
 * Returns what happened. It decides nothing about retries, endpoint health or
 * storage — `retry.ts` reads this and the caller writes the consequence.
 */
export async function attemptDelivery(
  envelope: WebhookEnvelope,
  url: string,
  secrets: readonly string[],
  transport: WebhookTransport,
  now: Date,
): Promise<AttemptOutcome> {
  if (secrets.length === 0) {
    // Sending unsigned would be worse than not sending: the receiver would
    // reject it, and every retry would burn an attempt on a delivery that
    // could never succeed.
    return {
      kind: 'unsafe_address',
      detail: 'no signing secret is configured for this endpoint',
    }
  }

  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return { kind: 'unsafe_address', detail: 'the stored URL is not a URL' }
  }

  let addresses: readonly string[]
  try {
    addresses = await transport.resolve(hostname)
  } catch (error) {
    // A name that will not resolve is a network problem and worth retrying —
    // a receiver's DNS can be down without their service being gone.
    return {
      kind: 'network_error',
      detail:
        error instanceof Error ? error.message : 'the host did not resolve',
    }
  }

  if (addresses.length === 0) {
    return { kind: 'network_error', detail: 'the host resolved to no address' }
  }

  // EVERY address, not the first. A hostname with one public A record and one
  // private one is the cheapest possible bypass, and picking whichever the
  // resolver happened to order first makes the check a coin toss.
  const blocked = addresses.find((address) => isBlockedAddress(address))
  if (blocked !== undefined) {
    return {
      kind: 'unsafe_address',
      detail: `${hostname} resolved to ${blocked}`,
    }
  }

  const body = serialiseEnvelope(envelope)

  const outcome = await transport.post({
    url,
    body,
    headers: {
      'content-type': 'application/json',
      // Signed AFTER the body string exists and over that exact string. See
      // signature.ts: anything that re-serialises between the two has signed
      // something the receiver will never see.
      [SIGNATURE_HEADER]: signPayload(body, secrets, now),
      [EVENT_HEADER]: envelope.type,
      [DELIVERY_HEADER]: envelope.id,
      'user-agent': 'ESTIA-Webhooks/1',
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
  })

  return outcome
}
