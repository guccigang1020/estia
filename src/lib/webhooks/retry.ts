/**
 * When to try again, and when to stop.
 *
 * Pure, deterministic, clock-injected. Every decision this file makes is one
 * a person will eventually be asked to justify to a customer whose webhook
 * stopped, so none of it is allowed to live inside the sender as an `if`.
 *
 * ══ RETRY IS NOT A KINDNESS, IT IS A CLASSIFICATION ═════════════════════════
 *
 * The temptation is to retry everything: a failed delivery feels like
 * something to keep trying. It is not. A 404 means the customer typed the URL
 * wrong, and retrying it six times over eight hours does not find the page —
 * it just delays the moment they are told, and fills their log with noise
 * that hides the real failures.
 *
 * So the question is never "did it fail" but **"could the same request
 * succeed later, unchanged?"**
 *
 *   · **5xx, 408, 429, timeouts, connection errors** — yes. The receiver is
 *     down, restarting, rate limiting, or the network moved. The identical
 *     request may well work in five minutes.
 *   · **Every other 4xx** — no. 401, 403, 404, 422: the receiver understood
 *     the request and rejected it. It will reject it identically forever, and
 *     the fix is a person changing the configuration.
 *   · **410 Gone** — no, and stronger: the receiver is explicitly saying stop.
 *     That is the one response that disables the endpoint on the spot, because
 *     it is the only one where the receiver has told us what it wants.
 *   · **An unsafe address** — no. Nothing was sent. See `blocked` in
 *     `types.ts`: it is not a delivery failure and must not count as one.
 *
 * ══ THE SCHEDULE ════════════════════════════════════════════════════════════
 *
 * 1m · 5m · 30m · 2h · 6h — five retries after the first attempt, spanning
 * a little under nine hours. Long enough to ride out a deploy or an incident;
 * short enough that a customer who broke something on Friday afternoon still
 * finds out about it on Friday.
 *
 * Jitter is applied by the caller if it wants it. It is not applied here
 * because this function is the thing under test, and a scheduler that returns
 * a different answer each call is a scheduler nobody can assert against.
 */

import type { AttemptOutcome } from './types'

/** The first attempt plus five retries. */
export const MAX_ATTEMPTS = 6

/** Delay before attempt N+1, in seconds, indexed by attempts already made. */
export const RETRY_SCHEDULE_SECONDS: readonly number[] = [
  60, // after the 1st attempt
  300, // 5m
  1_800, // 30m
  7_200, // 2h
  21_600, // 6h
]

/**
 * Consecutive failed DELIVERIES before the endpoint is turned off.
 *
 * Counted across deliveries, not attempts: an endpoint that is down for a
 * morning fails one delivery six times and that is one failure, not six. The
 * count resets on any success, so an endpoint that is merely flaky is never
 * disabled — only one that has stopped answering entirely.
 */
export const FAILURES_BEFORE_DISABLE = 20

export type RetryDecision =
  | { readonly kind: 'retry'; readonly at: Date; readonly attempts: number }
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'give_up'; readonly permanent: boolean }
  | { readonly kind: 'disable_endpoint' }

/** Did the receiver accept it? Any 2xx, and nothing else. */
export function isSuccess(outcome: AttemptOutcome): boolean {
  return (
    outcome.kind === 'responded' &&
    outcome.statusCode >= 200 &&
    outcome.statusCode < 300
  )
}

/** Could the identical request succeed later? */
export function isRetryable(outcome: AttemptOutcome): boolean {
  switch (outcome.kind) {
    case 'timed_out':
    case 'network_error':
      return true
    case 'unsafe_address':
      return false
    case 'responded': {
      const code = outcome.statusCode
      if (code === 408 || code === 429) return true
      if (code >= 500) return true
      return false
    }
  }
}

/**
 * What to do after one attempt.
 *
 * `attemptsMade` counts the attempt that just happened, so the first call
 * passes 1.
 */
export function decideAfterAttempt(
  outcome: AttemptOutcome,
  attemptsMade: number,
  now: Date,
): RetryDecision {
  if (isSuccess(outcome)) return { kind: 'succeeded' }

  // The receiver asking to be forgotten outranks everything else, including
  // how many attempts are left. It is the only response that is an
  // instruction rather than a symptom.
  if (outcome.kind === 'responded' && outcome.statusCode === 410) {
    return { kind: 'disable_endpoint' }
  }

  if (!isRetryable(outcome)) return { kind: 'give_up', permanent: true }

  const delay = RETRY_SCHEDULE_SECONDS[attemptsMade - 1]
  if (delay === undefined || attemptsMade >= MAX_ATTEMPTS) {
    return { kind: 'give_up', permanent: false }
  }

  return {
    kind: 'retry',
    at: new Date(now.getTime() + delay * 1000),
    attempts: attemptsMade,
  }
}

/**
 * Should the endpoint be turned off after this many consecutive failures?
 *
 * Separate from `decideAfterAttempt` because it is a different subject: one
 * is about a message, the other about a destination. A delivery giving up
 * says nothing about the endpoint until it has happened many times in a row.
 */
export function shouldDisableAfterFailures(
  consecutiveFailures: number,
): boolean {
  return consecutiveFailures >= FAILURES_BEFORE_DISABLE
}
