/**
 * The real socket. SERVER ONLY, and the only file in the module that opens one.
 *
 * Everything above this is a decision; this is the one place that acts, which
 * is why `WebhookTransport` is an interface and why the tests never come here.
 *
 * ══ THREE SETTINGS, EACH OF THEM A REFUSAL ══════════════════════════════════
 *
 *   · `redirect: 'manual'` — a 3xx is returned as a status and never followed.
 *     Following it is the bypass: a checked, public, well-behaved host answers
 *     `302 Location: http://169.254.169.254/` and every gate that ran against
 *     the requested URL is now protecting the wrong request. `retry.ts` treats
 *     3xx as a permanent failure, so the customer is told their endpoint
 *     redirects rather than being quietly followed somewhere.
 *   · `signal: AbortSignal.timeout(...)` — a receiver that accepts the
 *     connection and then never answers must not hold a sweep worker open.
 *     Ten seconds, and `timed_out` is retryable.
 *   · `dns.lookup(all: true)` — EVERY address, handed back for
 *     `isBlockedAddress` to judge. `family: 0` so both A and AAAA records come
 *     back: asking only for IPv4 would let an AAAA record pointing at `::1`
 *     through unexamined.
 *
 * ══ THE RESPONSE BODY IS NEVER READ ═════════════════════════════════════════
 *
 * `response.body?.cancel()` and nothing else. A webhook receiver has no way to
 * tell ESTIA anything — there is no protocol here for it to answer with — so
 * reading its body would only create somewhere for a hostile receiver to put a
 * gigabyte. The status code is the entire reply.
 */

import { lookup } from 'node:dns/promises'

import { REQUEST_TIMEOUT_MS, type WebhookTransport } from './sender'

/**
 * The production transport.
 *
 * A function rather than a class because it holds nothing: no pool, no cache,
 * no state that could leak between tenants.
 */
export function nodeWebhookTransport(): WebhookTransport {
  return {
    async resolve(hostname) {
      // `family: 0` — both A and AAAA. Asking for IPv4 alone would let an
      // AAAA record pointing at ::1 through without ever being looked at.
      const found = await lookup(hostname, { all: true, family: 0 })
      return found.map((entry) => entry.address)
    },

    async post(request) {
      try {
        const response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers as Record<string, string>,
          body: request.body,
          // Never followed. See this file's header.
          redirect: 'manual',
          signal: AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS),
        })

        // Discarded without being read. The status is the entire reply.
        await response.body?.cancel().catch(() => {})

        return { kind: 'responded', statusCode: response.status }
      } catch (error) {
        // `AbortSignal.timeout` rejects with a TimeoutError, which is a
        // different fact from "the connection was refused": one says the
        // receiver may be alive and slow, the other that nothing answered.
        // `retry.ts` treats both as retryable, but the delivery log shows the
        // customer which one happened, and those need different fixes.
        if (error instanceof Error && error.name === 'TimeoutError') {
          return { kind: 'timed_out' }
        }
        return {
          kind: 'network_error',
          detail:
            error instanceof Error
              ? error.message
              : 'the request did not complete',
        }
      }
    },
  }
}
