/**
 * EXECUTION CONTEXT — SERVER ONLY. Who opens the exception centre.
 *
 * `autopilot.view`, the same door as the command centre, and it is stated in
 * its own file rather than imported from the page above for the reason
 * `shell-screens/access.ts` gives: the route's gate and the menu's declaration
 * must be able to be read side by side, and a screen whose guard is a
 * re-export of another screen's is a screen whose refusal policy silently
 * changes when that other screen's does.
 *
 * The prepared actions shown beneath each exception are a SECOND grant —
 * `autopilot.activity_view` — checked by `listActions` and not here. A reader
 * with only `autopilot.view` gets every exception and no action history, which
 * is the correct outcome rather than a degraded one.
 */

import type { AutopilotAccess } from '../../_lib/gate'
import { requireAutopilotGrant } from '../../_lib/gate'

export function requireExceptionCentre(): Promise<AutopilotAccess> {
  return requireAutopilotGrant('autopilot.view')
}
