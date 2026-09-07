/**
 * 🔒 A recommendation is never a price.
 *
 * ══ THE BOUNDARY ════════════════════════════════════════════════════════════
 *
 * Everything probabilistic lives on one side of this file and everything
 * deterministic on the other, and the boundary is a person's name.
 *
 * A suggestion is written to `rate_suggestions` and stops there. It becomes a
 * price in exactly two ways, and both carry a name:
 *
 *   · somebody with `pricing.manage` approves it, which writes a
 *     `rate_calendar` row with `source = 'ai_approved'`, `suggestion_id` and
 *     `approved_by` — all three enforced together by a CHECK in 0072, so a
 *     price cannot claim to be AI-approved without saying whose approval;
 *   · an `auto_apply` policy applies it, and the policy carries
 *     `enabled_by_user_id` — the person who switched automation on. That id is
 *     what goes into `audit_events.on_behalf_of_user_id` on every automatic
 *     change. "The system did it" is not an admissible answer to "why did this
 *     price move", so the schema will not store it.
 *
 * ══ EVERY GATE IS A REFUSAL, AND NONE IS A CLAMP ════════════════════════════
 *
 * `autoApplyDecision` returns the FULL list of reasons an application was
 * refused, not the first. An approver looking at a stuck suggestion needs to
 * know it is over the delta AND on a sold night; fixing one and rediscovering
 * the other is how people stop reading the screen.
 *
 * It never quietly clamps a proposal into range. Spec §6 rule 33 makes the
 * same point about an agent's discount ceiling: a silent clamp sends somebody
 * away quoting a number the system will not honour, which is worse than a
 * refusal they can see.
 *
 * A proposal ABOVE the ceiling is a different case and is not a refusal at
 * all: spec §16 row 6 says it is stored as proposed and applied as clamped,
 * and both numbers are kept. That clamp happens in `resolve.ts`, after the
 * price is in the calendar, where every other clamp happens.
 *
 * ══ A FIGURE WITH NO SOURCE IS ABSENT ═══════════════════════════════════════
 *
 * `deltaBps` is a `Measure` and not a number. A suggestion against a
 * deterministic price of zero has no percentage gap — there is nothing to be a
 * percentage OF — and reporting `0%` or `∞%` would both be inventions. The
 * screen says so in Hebrew and shows the two amounts instead, which is the
 * honest answer and also the more useful one.
 */

import { known, unknown, type Measure } from '../revenue/types'
import {
  BPS_PER_UNIT,
  type DynamicPricingPolicy,
  type RateSuggestion,
} from './types'

/**
 * How far a proposal sits from the deterministic price, in basis points.
 *
 * `no_denominator` when the deterministic price is zero: a unit priced at
 * nothing has no percentage to be a multiple of, and that is a fact about the
 * rate card rather than a fact about the proposal.
 */
export function suggestionDeltaBps(suggestion: RateSuggestion): Measure {
  if (suggestion.deterministicAgorot === 0) return unknown('no_denominator')
  const gap = suggestion.suggestedAgorot - suggestion.deterministicAgorot
  return known(
    Math.round((gap * BPS_PER_UNIT) / suggestion.deterministicAgorot),
  )
}

/** Why an automatic application was refused. Each carries a Hebrew message. */
export type AutoApplyBlocker =
  | { code: 'no_policy' }
  | { code: 'policy_disabled' }
  | { code: 'policy_unattributed' }
  | { code: 'not_pending' }
  | { code: 'expired' }
  | { code: 'night_is_sold' }
  | { code: 'delta_unmeasurable' }
  | { code: 'delta_exceeded'; deltaBps: number; maxDeltaBps: number }
  | { code: 'below_floor'; floorAgorot: number }
  | { code: 'above_ceiling'; ceilingAgorot: number }
  | { code: 'daily_changes_used'; used: number; allowed: number }

export interface AutoApplyFacts {
  /** Is a booking occupying this night? Spec §6 rule 25. */
  nightIsSold: boolean
  /** Changes already applied to this unit today, per `maxDailyChanges`. */
  changesToday: number
  /** For the expiry test. Passed in rather than read from a clock. */
  now: Date
}

/**
 * May this suggestion be applied without asking a person?
 *
 * ALL of spec §6 rule 26 must hold. One failing leaves the suggestion
 * `pending` and waiting for a human, which is the safe direction — a
 * suggestion nobody applies costs a business a little margin, and one applied
 * wrongly costs it a stay.
 */
export function autoApplyDecision(
  suggestion: RateSuggestion,
  policy: DynamicPricingPolicy | null,
  facts: AutoApplyFacts,
): { apply: true } | { apply: false; blockers: readonly AutoApplyBlocker[] } {
  const blockers: AutoApplyBlocker[] = []

  if (policy === null) {
    blockers.push({ code: 'no_policy' })
  } else {
    if (!policy.autoApply) blockers.push({ code: 'policy_disabled' })
    // Belt and braces against the database CHECK, and worth having twice: an
    // automatic change with nobody behind it is the single failure this whole
    // subsystem is designed around, and the code should refuse it even if a
    // future migration relaxed the constraint.
    if (policy.enabledByUserId === null) {
      blockers.push({ code: 'policy_unattributed' })
    }
  }

  if (suggestion.status !== 'pending') blockers.push({ code: 'not_pending' })

  if (
    suggestion.expiresAt !== null &&
    Date.parse(suggestion.expiresAt) <= facts.now.getTime()
  ) {
    blockers.push({ code: 'expired' })
  }

  // Spec §6 rule 25. The price of a night that has been sold is a historical
  // fact, and a policy that could move it would be re-pricing a stay somebody
  // already agreed to — the same failure the snapshot exists to prevent,
  // arriving from the other direction.
  if (facts.nightIsSold) blockers.push({ code: 'night_is_sold' })

  if (policy !== null) {
    const delta = suggestionDeltaBps(suggestion)
    if (!delta.known) {
      // Unmeasurable is a refusal, not a pass. A gap that cannot be measured
      // cannot be shown to be within the limit, and "we could not tell" must
      // never resolve to "go ahead" on a path that spends money.
      blockers.push({ code: 'delta_unmeasurable' })
    } else if (Math.abs(delta.value) > policy.maxDeltaBps) {
      blockers.push({
        code: 'delta_exceeded',
        deltaBps: delta.value,
        maxDeltaBps: policy.maxDeltaBps,
      })
    }

    if (
      policy.floorAgorot !== null &&
      suggestion.suggestedAgorot < policy.floorAgorot
    ) {
      blockers.push({ code: 'below_floor', floorAgorot: policy.floorAgorot })
    }
    if (
      policy.ceilingAgorot !== null &&
      suggestion.suggestedAgorot > policy.ceilingAgorot
    ) {
      blockers.push({
        code: 'above_ceiling',
        ceilingAgorot: policy.ceilingAgorot,
      })
    }

    if (facts.changesToday >= policy.maxDailyChanges) {
      blockers.push({
        code: 'daily_changes_used',
        used: facts.changesToday,
        allowed: policy.maxDailyChanges,
      })
    }
  }

  return blockers.length === 0 ? { apply: true } : { apply: false, blockers }
}

/**
 * May a PERSON approve this one?
 *
 * A shorter list than the automatic gate, and deliberately so. A person may
 * approve a proposal that is far from the deterministic price — that is what
 * judgement is for, and the screen shows them the gap, the floor and the
 * ceiling so the judgement is informed. What a person may not do is approve a
 * night that has already been sold, or approve a proposal twice.
 */
export function approvalBlockers(
  suggestion: RateSuggestion,
  facts: { nightIsSold: boolean; now: Date },
): readonly AutoApplyBlocker[] {
  const blockers: AutoApplyBlocker[] = []
  if (suggestion.status !== 'pending') blockers.push({ code: 'not_pending' })
  if (
    suggestion.expiresAt !== null &&
    Date.parse(suggestion.expiresAt) <= facts.now.getTime()
  ) {
    blockers.push({ code: 'expired' })
  }
  if (facts.nightIsSold) blockers.push({ code: 'night_is_sold' })
  return blockers
}

/**
 * How long a proposal stays worth deciding.
 *
 * Twenty-four hours, from spec §4.2. A recommendation about tomorrow night is
 * not a recommendation the day after tomorrow — the demand it read has already
 * happened — and an expiry keeps a queue of stale prices from becoming the
 * screen nobody opens.
 */
export const SUGGESTION_TTL_HOURS = 24

export function suggestionExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + SUGGESTION_TTL_HOURS * 3_600_000)
}
