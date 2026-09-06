/**
 * EXECUTION CONTEXT — SERVER ONLY. Who opens the Autopilot settings.
 *
 * ── Reading and changing are different grants, and the door is the reading one ──
 *
 * `autopilot.view` opens the screen. `autopilot.configure` changes the matrix,
 * the level and the run mode. `autopilot.pause` works the pause and the kill
 * switch and is deliberately separate from configure, because the person who
 * has to stop it at 23:00 is rarely the person who set it up — and making them
 * wait for somebody with configure rights is how a safety control becomes
 * decorative. `autopilot.override` writes the per-property narrowing.
 *
 * Gating the door on `configure` would hide the whole configuration from a
 * general manager who is entitled to know what the business has switched on,
 * and — worse — would hide the KILL SWITCH from the person holding
 * `autopilot.pause`, whose entire reason for existing is to reach it quickly.
 *
 * So the route asks for the smallest grant that makes the screen honest, and
 * every control below asks for its own. `holdsGrant` is checked per control by
 * the page; RLS refuses underneath: `autopilot_settings_update` admits
 * configure OR pause, `autopilot_policies_write` admits configure only, and
 * `autopilot_property_settings_write` admits override only.
 */

import type { Grant } from '@/lib/authz/permissions'

import type { AutopilotAccess } from '../../_lib/gate'
import { requireAutopilotGrant } from '../../_lib/gate'

/** What each control on the settings screen actually needs. */
export const SETTINGS_CONTROL_GRANTS = {
  level: 'autopilot.configure',
  runMode: 'autopilot.configure',
  matrix: 'autopilot.configure',
  propertyOverride: 'autopilot.override',
  brief: 'autopilot.configure',
  pause: 'autopilot.pause',
  killSwitch: 'autopilot.pause',
} as const satisfies Record<string, Grant>

export function requireAutopilotSettings(): Promise<AutopilotAccess> {
  return requireAutopilotGrant('autopilot.view')
}
