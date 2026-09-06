/**
 * EXECUTION CONTEXT — SERVER ONLY. Who runs the activation wizard.
 *
 * `autopilot.configure`, and here — unlike the settings screen it sits under —
 * that IS the right door. The settings screen is a statement of what the
 * business has switched on and everybody entitled to know should be able to
 * read it; the wizard is the act of switching it on, and somebody who cannot
 * perform it has no reason to be walked through eight steps that end in a
 * refusal.
 *
 * Refusing here rather than at the end is the whole point. A wizard that
 * collects a level, a set of modules, an approver and a property list and
 * *then* says "you may not do this" has wasted the one thing a guesthouse
 * owner has least of.
 */

import type { AutopilotAccess } from '../../../_lib/gate'
import { requireAutopilotGrant } from '../../../_lib/gate'

export function requireActivationWizard(): Promise<AutopilotAccess> {
  return requireAutopilotGrant('autopilot.configure')
}
