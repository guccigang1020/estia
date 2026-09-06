/**
 * EXECUTION CONTEXT — SERVER ONLY. The activity log's read.
 *
 * ── The four views, and why "everything" is the default ──────────────────
 *
 * A log that showed only what executed would show an empty screen to the
 * customer most worried about what Autopilot might do. 0046 puts it plainly:
 * suppressed, simulated and cancelled are rows in `autopilot_actions` and
 * their count is what this screen reports. So the default view is every
 * outcome, and the narrower views are opt-in.
 *
 * `attention` is the one view that is a judgment about which outcomes need a
 * person, and it is not a judgment this file invented: `failed`,
 * `needs_review` and `executed_unaudited` are precisely the three the schema's
 * own `autopilot_actions_review_idx` indexes together, for the same reason.
 *
 * ── The filter never reaches the query as text ───────────────────────────
 *
 * `parseView` maps a query parameter onto a member of a tuple, and the outcome
 * list comes from `AUTOPILOT_ACTION_OUTCOMES`. A typo renders the default
 * view, not an empty log — and an empty log is a claim about the business.
 */

import {
  AUTOPILOT_ACTION_OUTCOMES,
  type AutopilotActionOutcome,
} from '@/lib/contracts/states'
import type { ActionView } from '@/components/autopilot/views'

import { listActions, type AutopilotReadArgs } from '../../_lib/reads'

export const ACTIVITY_VIEWS = [
  'all',
  'executed',
  'suppressed',
  'attention',
] as const

export type ActivityView = (typeof ACTIVITY_VIEWS)[number]

export const ACTIVITY_VIEW_LABEL: Record<ActivityView, string> = {
  all: 'הכול',
  executed: 'בוצעו',
  suppressed: 'נמנעו',
  attention: 'דורש בדיקה',
}

/**
 * Which outcomes each view asks for.
 *
 * `all` is `undefined` rather than the full tuple: an absent filter is one
 * fewer predicate on a table whose `organization_id, created_at desc` index is
 * exactly what an unfiltered page wants.
 */
export function outcomesFor(
  view: ActivityView,
): readonly AutopilotActionOutcome[] | undefined {
  switch (view) {
    case 'executed':
      return ['executed', 'executed_unaudited', 'simulated']
    case 'suppressed':
      return ['suppressed', 'cancelled']
    case 'attention':
      // The same three `autopilot_actions_review_idx` indexes together.
      return ['failed', 'needs_review', 'executed_unaudited']
    default:
      return undefined
  }
}

export function parseView(value: string | null): ActivityView {
  return value !== null && (ACTIVITY_VIEWS as readonly string[]).includes(value)
    ? (value as ActivityView)
    : 'all'
}

export function loadActivity(
  args: AutopilotReadArgs,
  view: ActivityView,
): Promise<readonly ActionView[]> {
  const outcomes = outcomesFor(view)
  return listActions(args, outcomes === undefined ? {} : { outcomes })
}

/** Every outcome the vocabulary has, for the counts beside the tabs. */
export function countByOutcome(
  actions: readonly ActionView[],
): ReadonlyMap<AutopilotActionOutcome, number> {
  const counts = new Map<AutopilotActionOutcome, number>()
  for (const outcome of AUTOPILOT_ACTION_OUTCOMES) counts.set(outcome, 0)
  for (const action of actions) {
    counts.set(action.outcome, (counts.get(action.outcome) ?? 0) + 1)
  }
  return counts
}
