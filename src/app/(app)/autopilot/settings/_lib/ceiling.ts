/**
 * EXECUTION CONTEXT — SERVER ONLY. What the platform will not let you choose.
 *
 * ══ READ THIS BEFORE USING IT ANYWHERE THAT IS NOT A SCREEN ══════════════
 *
 * This module RESOLVES THE CEILING FOR DISPLAY. It is not the safety engine
 * and must never become the thing that decides whether an action may run.
 * `src/lib/autopilot/policy` is that, it is another worker's, and when it
 * exports a ruling this file should delegate to it and keep only the
 * formatting. The duplication is deliberate, bounded and written down here
 * rather than discovered later:
 *
 *   · The screens must show the ceiling — 0046 grants every reader `select` on
 *     `autopilot_safety_rules` for exactly that reason, and its own comment
 *     says a ceiling the customer cannot see is a ceiling they will spend an
 *     afternoon trying to configure their way past.
 *   · The policy engine did not exist when these screens were written, and a
 *     matrix that rendered `auto` as an ordinary option for a refund would be
 *     worse than a matrix with a bounded second reader of one platform table.
 *   · Nothing here is consulted at execution time. It reads rows and returns
 *     a label and a boolean. If it is ever wrong, a customer sees a cell
 *     drawn incorrectly — not an action that ran when it should not have.
 *
 * The integration point is reported to the coordinator: replace `ceilingFor`
 * with the policy module's own resolution the moment there is one.
 *
 * ── The rule the table encodes ───────────────────────────────────────────
 *
 * A row with `action_kind` null means "every action at or above
 * `max_safety_level`", which is the rule that actually matters and would
 * otherwise be written once per action name. A row naming a kind applies to
 * that kind alone. Where several apply, the MOST RESTRICTIVE wins — a ceiling
 * that took the highest of two caps would not be a ceiling.
 *
 * Both comparisons are ordinal over the tuples in `contracts/states.ts`, whose
 * order is documented as load-bearing in both cases: `ACTION_SAFETY_LEVELS`
 * ascends by harm and `AUTOPILOT_DISPOSITIONS` ascends by autonomy. Reading
 * the index rather than writing a switch is what keeps this in step with the
 * vocabulary when a member is added.
 */

import type { AutopilotActionSpec } from '@/lib/autopilot/actions'
import {
  ACTION_SAFETY_LEVELS,
  AUTOPILOT_DISPOSITIONS,
  type ActionSafetyLevel,
  type AutopilotDisposition,
} from '@/lib/contracts/states'
import type { CellState } from '@/components/autopilot/policy-matrix-cell'

import type { SafetyRuleView } from '../../_lib/reads'

function harmIndex(level: ActionSafetyLevel): number {
  return ACTION_SAFETY_LEVELS.indexOf(level)
}

function autonomyIndex(disposition: AutopilotDisposition): number {
  return AUTOPILOT_DISPOSITIONS.indexOf(disposition)
}

export type ResolvedCeiling = {
  /** The most autonomous disposition the platform permits for this action. */
  maxDisposition: AutopilotDisposition
  /** The rule that produced it, or null when nothing caps this action. */
  rule: SafetyRuleView | null
}

/** Nothing caps this action: the customer may choose any cell. */
const UNCAPPED: ResolvedCeiling = { maxDisposition: 'auto', rule: null }

export function ceilingFor(
  spec: AutopilotActionSpec,
  rules: readonly SafetyRuleView[],
): ResolvedCeiling {
  let resolved = UNCAPPED

  for (const rule of rules) {
    const applies =
      rule.actionKind === spec.kind ||
      (rule.actionKind === null &&
        harmIndex(spec.safety) >= harmIndex(rule.maxSafetyLevel))

    if (!applies) continue
    if (
      autonomyIndex(rule.maxDisposition) >=
      autonomyIndex(resolved.maxDisposition)
    ) {
      continue
    }

    resolved = { maxDisposition: rule.maxDisposition, rule }
  }

  return resolved
}

/**
 * How one cell of the matrix should render.
 *
 * `chosen` is `null` when the organization has written no policy row for this
 * action — which 0046 says means the LEVEL's default and not `off`, so no cell
 * is drawn as selected and the row says "לפי הרמה" instead. Drawing `off` as
 * chosen would show a business a decision nobody made.
 */
export function cellState(
  option: AutopilotDisposition,
  chosen: AutopilotDisposition | null,
  ceiling: ResolvedCeiling,
): CellState {
  if (autonomyIndex(option) > autonomyIndex(ceiling.maxDisposition)) {
    return 'blocked'
  }
  return option === chosen ? 'selected' : 'available'
}

/**
 * One row of the matrix: the action, what the customer chose, and the cap.
 *
 * `chosen` comes from `autopilot_policies` and is null for a cell nobody has
 * written. `overriddenAt` names the properties that have their own row for
 * this action, so an organization-wide matrix cannot quietly hide that one
 * villa is different.
 */
export type MatrixRow = {
  spec: AutopilotActionSpec
  chosen: AutopilotDisposition | null
  ceiling: ResolvedCeiling
  /** Property ids with their own policy row for this action kind. */
  overriddenAt: readonly string[]
}

export function buildMatrix(
  specs: readonly AutopilotActionSpec[],
  policies: readonly {
    actionKind: string
    propertyId: string | null
    disposition: AutopilotDisposition
  }[],
  rules: readonly SafetyRuleView[],
): readonly MatrixRow[] {
  const organizationWide = new Map<string, AutopilotDisposition>()
  const perProperty = new Map<string, string[]>()

  for (const policy of policies) {
    if (policy.propertyId === null) {
      organizationWide.set(policy.actionKind, policy.disposition)
      continue
    }
    const existing = perProperty.get(policy.actionKind)
    if (existing) existing.push(policy.propertyId)
    else perProperty.set(policy.actionKind, [policy.propertyId])
  }

  return specs.map((spec) => ({
    spec,
    chosen: organizationWide.get(spec.kind) ?? null,
    ceiling: ceilingFor(spec, rules),
    overriddenAt: perProperty.get(spec.kind) ?? [],
  }))
}
