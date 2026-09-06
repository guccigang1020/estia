/**
 * The failure queue.
 *
 * A failed action is not a finished action, and it is not a disposable one
 * either. Everything that failed either gets another attempt or gets a person,
 * and nothing is silently dropped — a queue that quietly forgets is worse than
 * no queue, because the business believes something was handled.
 *
 * ── What is never retried, and why the list is short ─────────────────────
 *
 *   · **`money_access_cancellation`.** Never, blindly, under any error code.
 *     A refund retried because a gateway timed out ambiguously is a second
 *     refund; a cancellation retried is a family arriving at a locked door.
 *     These go straight to `needs_review` with the failure intact.
 *   · **`business_impact`.** The platform floor already caps these at
 *     `ask_approval`, so a person agreed to this specific action once. Trying
 *     it again after a failure is a decision, and it is theirs.
 *   · **A permanent failure.** A validation error retried is a second
 *     identical failure. The retryability was decided where the error was
 *     caught, stored on the row, and read back here — not re-derived from an
 *     error code this file never saw thrown.
 *   · **An action that has run out of attempts.** Bounded, and the bound is
 *     `needs_review` rather than silence.
 *
 * What is left is `information`, `safe_internal` and `external_communication` —
 * and the last of those is only safe because the action's idempotency key is
 * handed to the domain command as well as claimed here, so a retry of a send
 * that actually got through replays the stored result instead of sending twice.
 *
 * ── The attempt counter moves before the attempt ─────────────────────────
 *
 * The row is marked `retrying` with the incremented attempt BEFORE the command
 * runs, for the same reason the claim is taken before the command runs: a
 * process that dies mid-attempt must leave evidence that the attempt was made.
 * A counter incremented afterwards counts successes and reports an infinite
 * supply of attempts to anything that crashes.
 */

import { ACTION_SAFETY_LEVELS } from '../../contracts/states'
import type { ActionSafetyLevel } from '../../contracts/states'
import { AUTOPILOT_ACTIONS } from '../actions'

import {
  executePreparedAction,
  failureOf,
  type ExecutionDeps,
  type ExecutionReport,
} from './dispatch'
import type { AutopilotActionRow } from './repository'

/**
 * The highest safety level an automatic retry may touch.
 *
 * Stated as a constant rather than as a condition inside the decision, so that
 * moving it is a visible edit to a named ceiling and not a `>=` somebody
 * loosened.
 */
export const AUTO_RETRY_CEILING: ActionSafetyLevel = 'external_communication'

/** Total attempts across all passes, including the first. */
export const DEFAULT_RETRY_LIMIT = 3

export type RetryRefusal =
  /** Money, access or a cancellation. Never automatic, whatever failed. */
  | 'money_access_cancellation'
  | 'safety_level_too_high'
  | 'permanent_failure'
  | 'attempts_exhausted'
  | 'not_failed'
  | 'undone'

export type RetryDecision =
  | { retry: true }
  /** `explanation` is Hebrew: it lands on the review screen. */
  | { retry: false; reason: RetryRefusal; explanation: string }

function rank(level: ActionSafetyLevel): number {
  return ACTION_SAFETY_LEVELS.indexOf(level)
}

/**
 * Whether this failure gets another attempt.
 *
 * Pure, and separate from the doing, so "would Autopilot retry a refund" is a
 * question a test answers without a repository, a clock or a registry.
 */
export function decideRetry(
  row: AutopilotActionRow,
  options: { limit?: number } = {},
): RetryDecision {
  const limit = options.limit ?? DEFAULT_RETRY_LIMIT

  if (row.undoneAt !== null) {
    return {
      retry: false,
      reason: 'undone',
      explanation: 'הפעולה בוטלה ידנית ולכן לא תבוצע שוב.',
    }
  }

  if (row.outcome !== 'failed' && row.outcome !== 'retrying') {
    return {
      retry: false,
      reason: 'not_failed',
      explanation: `הפעולה אינה במצב כשל (מצבה: ${row.outcome}).`,
    }
  }

  // First among the safety questions and asked by name, because this is the
  // one that must never be reachable by loosening a comparison.
  if (row.safetyLevel === 'money_access_cancellation') {
    return {
      retry: false,
      reason: 'money_access_cancellation',
      explanation:
        'פעולות של כסף, גישה או ביטול לעולם אינן מבוצעות שוב אוטומטית. ' +
        'נדרשת החלטה של אדם.',
    }
  }

  if (rank(row.safetyLevel) > rank(AUTO_RETRY_CEILING)) {
    return {
      retry: false,
      reason: 'safety_level_too_high',
      explanation:
        'פעולה בעלת השפעה עסקית אינה מבוצעת שוב אוטומטית לאחר כשל. ' +
        'נדרש אישור מחדש.',
    }
  }

  const failure = failureOf(row)
  if (failure && !failure.retryable) {
    return {
      retry: false,
      reason: 'permanent_failure',
      explanation: `הכשל (${failure.code}) לא ישתנה בניסיון נוסף.`,
    }
  }

  if (row.attempt >= limit) {
    return {
      retry: false,
      reason: 'attempts_exhausted',
      explanation: `הפעולה נוסתה ${row.attempt} פעמים ולא הצליחה.`,
    }
  }

  return { retry: true }
}

export type RetryResult =
  | { status: 'retried'; report: ExecutionReport }
  /**
   * Handed to a person. The row keeps its error code and its attempt count, so
   * the screen can say what failed and how many times.
   */
  | {
      status: 'needs_review'
      action: AutopilotActionRow
      reason: RetryRefusal
      explanation: string
    }

export async function retryAction(
  row: AutopilotActionRow,
  deps: ExecutionDeps,
  options: { limit?: number } = {},
): Promise<RetryResult> {
  const decision = decideRetry(row, options)

  if (!decision.retry) {
    // Not dropped, not left as `failed` for a sweep to pick up again forever:
    // moved to the state whose whole meaning is "a person has to look at this".
    const updated = await deps.repository.update(row, {
      outcome: 'needs_review',
      errorDetail: decision.explanation,
    })
    return {
      status: 'needs_review',
      action: updated,
      reason: decision.reason,
      explanation: decision.explanation,
    }
  }

  const retrying = await deps.repository.update(row, {
    outcome: 'retrying',
    attempt: row.attempt + 1,
  })

  return {
    status: 'retried',
    report: await executePreparedAction(retrying, deps),
  }
}

/**
 * One pass over everything that failed.
 *
 * Sequential rather than concurrent: these are the actions that already went
 * wrong once, and a burst of parallel attempts at a provider that just timed
 * out is how a transient failure becomes a rate limit.
 */
export async function runRetryQueue(
  organizationId: string,
  deps: ExecutionDeps,
  options: { limit?: number; batch?: number } = {},
): Promise<readonly RetryResult[]> {
  const rows = await deps.repository.listFailed(organizationId, {
    limit: options.batch ?? 50,
  })

  const results: RetryResult[] = []
  for (const row of rows) {
    results.push(await retryAction(row, deps, { limit: options.limit }))
  }
  return results
}

/** What the review screen calls a stuck action, in Hebrew. */
export function retryRefusalLabel(reason: RetryRefusal): string {
  switch (reason) {
    case 'money_access_cancellation':
      return 'כסף, גישה או ביטול'
    case 'safety_level_too_high':
      return 'השפעה עסקית'
    case 'permanent_failure':
      return 'כשל קבוע'
    case 'attempts_exhausted':
      return 'מיצוי ניסיונות'
    case 'not_failed':
      return 'אינה בכשל'
    case 'undone':
      return 'בוטלה'
  }
}

/** The catalogue label, for a screen listing what is waiting. */
export function actionLabel(row: AutopilotActionRow): string {
  return AUTOPILOT_ACTIONS[row.actionKind].label
}
