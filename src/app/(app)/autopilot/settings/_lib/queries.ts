/**
 * EXECUTION CONTEXT — SERVER ONLY. The settings screen's read.
 *
 * Composition over `_lib/reads.ts` plus the catalogue, and the only shaping is
 * putting the actions in the order somebody reviewing them cares about.
 *
 * ── The catalogue is the row set, not the policy table ───────────────────
 *
 * The matrix has one row per action in `AUTOPILOT_ACTIONS`, whether or not the
 * organization has ever written a policy for it. Building the matrix from
 * `autopilot_policies` instead would show a business only the decisions they
 * have already made, and hide every action they have not thought about — which
 * is precisely the set worth reviewing before switching anything on.
 *
 * ── Actions the package cannot run are shown, and marked ─────────────────
 *
 * `spec.requires` names the module an action depends on. An organization
 * without `laundry` will never see a laundry action planned — the engine drops
 * it — and hiding the row here would leave the customer wondering why the
 * matrix has holes. So the row is rendered with the missing module named,
 * which is also the honest place to say what a module would add.
 */

import {
  AUTOPILOT_ACTIONS,
  type AutopilotActionSpec,
} from '@/lib/autopilot/actions'
import {
  ACTION_SAFETY_LEVELS,
  type ActionSafetyLevel,
} from '@/lib/contracts/states'
import type { Entitlement } from '@/lib/plans/entitlements'

/**
 * Every action, grouped by what it costs if it is wrong.
 *
 * `ACTION_SAFETY_LEVELS` ascends by harm, so reading the groups top to bottom
 * is reading the escalation of consequence — the order somebody reviewing a
 * matrix actually cares about, and the same order the catalogue file itself is
 * written in.
 */
export function actionsBySafety(): ReadonlyMap<
  ActionSafetyLevel,
  readonly AutopilotActionSpec[]
> {
  const grouped = new Map<ActionSafetyLevel, AutopilotActionSpec[]>()
  for (const level of ACTION_SAFETY_LEVELS) grouped.set(level, [])

  for (const spec of Object.values(AUTOPILOT_ACTIONS)) {
    grouped.get(spec.safety)?.push(spec)
  }

  return grouped
}

/** Every action in catalogue order, for the matrix. */
export function allActionSpecs(): readonly AutopilotActionSpec[] {
  return Object.values(AUTOPILOT_ACTIONS)
}

/**
 * Whether this organization's package can actually run an action.
 *
 * `null` in `requires` means core — every customer has it. Anything else is
 * checked against the actor's entitlements, which is the same set `can()`
 * reads, so the matrix and the engine cannot disagree about which modules the
 * business bought.
 */
export function missingModule(
  spec: AutopilotActionSpec,
  entitlements: ReadonlySet<Entitlement>,
): Entitlement | null {
  if (spec.requires === null) return null
  return entitlements.has(spec.requires) ? null : spec.requires
}
