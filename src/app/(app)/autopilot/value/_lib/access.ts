/**
 * EXECUTION CONTEXT — SERVER ONLY. Who opens the value screen.
 *
 * `autopilot.view` opens the door, and every figure that is counted from the
 * ACTION log needs `autopilot.activity_view` as well — which `listActions`
 * checks for itself. That asymmetry is deliberate and visible on the screen: a
 * reader with only `autopilot.view` sees the exceptions ESTIA caught and an
 * honest sentence where the actions would be, rather than a confident zero.
 *
 * A confident zero is the specific failure this screen could produce. "ESTIA
 * automated 0 actions" reads as a product that does nothing, and it would be
 * what somebody without the second grant saw — on the one screen whose job is
 * to say whether the module is worth its price.
 */

import type { AutopilotAccess } from '../../_lib/gate'
import { requireAutopilotGrant } from '../../_lib/gate'

export function requireValueScreen(): Promise<AutopilotAccess> {
  return requireAutopilotGrant('autopilot.view')
}
