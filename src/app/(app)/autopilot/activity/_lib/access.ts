/**
 * EXECUTION CONTEXT — SERVER ONLY. Who opens the activity log.
 *
 * `autopilot.activity_view`, and NOT `autopilot.view`. They are different
 * amounts of authority and 0046 says so in the policy itself: somebody who can
 * see today's exceptions is not thereby entitled to the full history of every
 * message ESTIA has sent on the business's behalf.
 *
 * ── Why gating on the wrong grant would be invisible ─────────────────────
 *
 * `autopilot_actions_select` requires `autopilot.activity_view`. A route that
 * admitted somebody on `autopilot.view` would not error and would not refuse —
 * Postgres would simply return no rows, and the screen would render an empty
 * log. "ESTIA has never done anything" is a false and reassuring sentence to
 * show the one person in the business who is checking. So the door asks for
 * the same grant the policy does, `listActions` asks again before it queries,
 * and the two cannot disagree.
 */

import type { AutopilotAccess } from '../../_lib/gate'
import { requireAutopilotGrant } from '../../_lib/gate'

export function requireActivityLog(): Promise<AutopilotAccess> {
  return requireAutopilotGrant('autopilot.activity_view')
}
