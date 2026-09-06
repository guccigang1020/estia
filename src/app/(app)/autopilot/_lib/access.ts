/**
 * EXECUTION CONTEXT — SERVER ONLY. Who opens the Autopilot command centre.
 *
 * One grant, not a list. Unlike `/action-center`, which is a union of five
 * independent questions held by five different roles, every panel of this
 * screen reads `autopilot_exceptions` — and `autopilot_exceptions_select`
 * requires `autopilot.view` and nothing else. Admitting somebody on a
 * different grant would open a screen that RLS then empties, which reads as
 * "ESTIA has noticed nothing" rather than as a refusal.
 *
 * IT IS THE DOOR, NOT THE ROWS. The prepared actions on this screen come from
 * `autopilot_actions`, whose policy requires `autopilot.activity_view` — a
 * different and larger amount of authority. So a reader admitted here on
 * `autopilot.view` alone gets the exceptions and no action history, which is
 * the correct outcome and is why `listActions` checks its own grant rather
 * than trusting the door.
 */

import type { Grant } from '@/lib/authz/permissions'

import { requireAutopilotGrant, type AutopilotAccess } from './gate'

/** The grant that opens the command centre, the exceptions and the value screen. */
export const AUTOPILOT_VIEW_GRANT: Grant = 'autopilot.view'

/**
 * The activity log's grant.
 *
 * `autopilot.activity_view`, and the separation is deliberate: somebody who
 * can see today's exceptions is not thereby entitled to the full history of
 * every message ESTIA has sent on the business's behalf. 0046 states it in
 * the policy; the route states it here so the two cannot drift.
 */
export const AUTOPILOT_ACTIVITY_GRANT: Grant = 'autopilot.activity_view'

/** Changing the matrix, the level or the run mode. */
export const AUTOPILOT_CONFIGURE_GRANT: Grant = 'autopilot.configure'

/**
 * The pause and the kill switch.
 *
 * Separate from configure because it is urgent: the person who has to stop it
 * at 23:00 is rarely the person who set it up, and making them wait for
 * somebody with configure rights is how a safety control becomes decorative.
 */
export const AUTOPILOT_PAUSE_GRANT: Grant = 'autopilot.pause'

export function requireAutopilotView(): Promise<AutopilotAccess> {
  return requireAutopilotGrant(AUTOPILOT_VIEW_GRANT)
}

export function requireAutopilotActivity(): Promise<AutopilotAccess> {
  return requireAutopilotGrant(AUTOPILOT_ACTIVITY_GRANT)
}
