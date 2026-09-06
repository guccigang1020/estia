/**
 * EXECUTION CONTEXT — SERVER ONLY. What the value screen counts.
 *
 * Counting, and nothing else. Every figure below is the length of a filtered
 * list of rows that already exist, and every filter reads a stored enum. There
 * is no rate, no percentage and no comparison against a period nobody chose.
 *
 * ── Why "risks detected early" is a count of exceptions and not of saves ──
 *
 * ESTIA cannot know that a shortage it flagged would otherwise have become a
 * guest complaint. Counting "disasters prevented" would be counting things
 * that did not happen, which is the shape of every dishonest value dashboard
 * ever built. What is countable is: this many problems were written down
 * before their deadline, with evidence, and here they are.
 *
 * ── The window is the caller's ───────────────────────────────────────────
 *
 * The page passes a `since`, and the screen prints it. A figure whose period
 * is implicit is a figure nobody can reproduce next month.
 */

import type { ActionView, ExceptionView } from '@/components/autopilot/views'
import { AUTOPILOT_EXCEPTION_STATES } from '@/lib/contracts/states'

import {
  listActions,
  listExceptions,
  type AutopilotReadArgs,
} from '../../_lib/reads'

/** Actions that reached the world, one way or another. */
export type ValueCounts = {
  /** `executed` plus `executed_unaudited`. Work that really happened. */
  automated: number
  /** Correctly declined. A refusal is the system working, and it is counted. */
  suppressed: number
  /** Recorded in simulation. Never counted as time saved. */
  simulated: number
  /** External communication that actually went out. */
  remindersSent: number
  /** Exceptions raised before their deadline, with evidence. */
  risksDetected: number
  /** Of those, inventory shortages specifically. */
  shortagesCaught: number
  /** Exceptions that reached `resolved`. */
  resolved: number
  failed: number
}

export function countValue(
  actions: readonly ActionView[],
  exceptions: readonly ExceptionView[],
): ValueCounts {
  let automated = 0
  let suppressed = 0
  let simulated = 0
  let remindersSent = 0
  let failed = 0

  for (const action of actions) {
    if (
      action.outcome === 'executed' ||
      action.outcome === 'executed_unaudited'
    ) {
      automated += 1
      if (action.safetyLevel === 'external_communication') remindersSent += 1
    } else if (action.outcome === 'suppressed') {
      suppressed += 1
    } else if (action.outcome === 'simulated') {
      simulated += 1
    } else if (action.outcome === 'failed') {
      failed += 1
    }
  }

  let risksDetected = 0
  let shortagesCaught = 0
  let resolved = 0

  for (const row of exceptions) {
    risksDetected += 1
    if (row.domain === 'inventory') shortagesCaught += 1
    if (row.state === 'resolved') resolved += 1
  }

  return {
    automated,
    suppressed,
    simulated,
    remindersSent,
    risksDetected,
    shortagesCaught,
    resolved,
    failed,
  }
}

export function loadValueActions(
  args: AutopilotReadArgs,
  since: string,
): Promise<readonly ActionView[]> {
  return listActions(args, { since })
}

/**
 * Every exception in the window, in every state.
 *
 * Including `resolved` and `dismissed`, unlike the command centre: this screen
 * is about what ESTIA caught, and a problem somebody has already fixed is the
 * best possible example of that.
 */
export function loadValueExceptions(
  args: AutopilotReadArgs,
): Promise<readonly ExceptionView[]> {
  return listExceptions(args, { states: AUTOPILOT_EXCEPTION_STATES })
}
