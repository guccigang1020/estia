/**
 * EXECUTION CONTEXT — SERVER ONLY. The exception centre's read.
 *
 * Composition over `_lib/reads.ts`, which owns the grant check, the scope
 * narrowing and the `can()` re-check for every table. What is here is the
 * filter this screen offers and the joining of prepared actions to the
 * exceptions they belong to.
 *
 * ── The filter is a closed vocabulary, never free text ───────────────────
 *
 * `parseStateFilter` accepts two words and returns a member of a tuple. A
 * query parameter that reached `.in('state', ...)` unvalidated would be a
 * string from the browser going into a query, which is the shape of every
 * injection this codebase does not have — and, more mundanely, a typo would
 * render "no exceptions" for a business that has forty.
 *
 * ── Actions are attached, never re-derived ──────────────────────────────
 *
 * `autopilot_actions.exception_id` is the link. This groups by it and reads
 * each action's stored `reason` and `evidence`. Nothing recomputes what ESTIA
 * would suggest today for an exception raised this morning: the suggestion the
 * person is looking at is the one that was made, which is the only version
 * they can hold anybody to.
 */

import type { ActionView, ExceptionView } from '@/components/autopilot/views'
import { AUTOPILOT_EXCEPTION_STATES } from '@/lib/contracts/states'
import type { AutopilotExceptionState } from '@/lib/contracts/states'

import {
  listActions,
  listExceptions,
  OPEN_EXCEPTION_STATES,
  type AutopilotReadArgs,
} from '../../_lib/reads'

export const EXCEPTION_FILTERS = ['open', 'all'] as const
export type ExceptionFilter = (typeof EXCEPTION_FILTERS)[number]

/** The query parameter, or the default. Never the raw string. */
export function parseStateFilter(value: string | null): ExceptionFilter {
  return value !== null &&
    (EXCEPTION_FILTERS as readonly string[]).includes(value)
    ? (value as ExceptionFilter)
    : 'open'
}

export function statesFor(
  filter: ExceptionFilter,
): readonly AutopilotExceptionState[] {
  return filter === 'all' ? AUTOPILOT_EXCEPTION_STATES : OPEN_EXCEPTION_STATES
}

export function loadExceptions(
  args: AutopilotReadArgs,
  filter: ExceptionFilter,
): Promise<readonly ExceptionView[]> {
  return listExceptions(args, { states: statesFor(filter) })
}

/**
 * Every prepared action, keyed by the exception it belongs to.
 *
 * Returns an empty map — not a refusal — when the reader lacks
 * `autopilot.activity_view`, because `listActions` has already made that
 * decision and returned nothing. The screen says so once, at the top, rather
 * than printing "no suggested action" forty times, which would be false.
 */
export function actionsByException(
  actions: readonly ActionView[],
): ReadonlyMap<string, readonly ActionView[]> {
  const byException = new Map<string, ActionView[]>()
  for (const action of actions) {
    if (action.exceptionId === null) continue
    const existing = byException.get(action.exceptionId)
    if (existing) existing.push(action)
    else byException.set(action.exceptionId, [action])
  }
  return byException
}

export function loadActionsForExceptions(
  args: AutopilotReadArgs,
): Promise<readonly ActionView[]> {
  return listActions(args)
}
