/**
 * EXECUTION CONTEXT — SERVER ONLY. The rate card, on the path a guest is on.
 *
 * ══ THE GAP THIS CLOSES ═════════════════════════════════════════════════════
 *
 * `resolveStay` had no caller. Not one, outside its own tests — verified by
 * hand after an audit claimed it, because the lesson of G-033 in this
 * repository is that an audit's finding is a hypothesis until you check it.
 *
 * So every price a guest was ever quoted came from `priceStay` over
 * `units.base_price_agorot`, and a business that built a summer rate card saw
 * it on the pricing screen while the guest was charged the base rate. No
 * error, no warning — which is what made it the worst kind of defect this
 * product can have: one that does not look like one.
 *
 * ══ WHY ASSEMBLY NEEDS THREE STEPS AND NOT ONE ══════════════════════════════
 *
 * `PricingContext` wants `plans`, `rules`, `calendar` and `modifiers` up
 * front, but the rules and the calendar belong to ONE plan and nobody knows
 * which until the plan is chosen. Loading every rule of every plan to find out
 * would read a rate card of any size to price one stay.
 *
 * So: select the plan from the plans alone, follow its derivation to the plan
 * whose rules actually apply, and only then read that plan's rules and nights.
 * `selectRatePlan` and `resolveDerivation` are exported for exactly this, and
 * the derivation step is not optional — a derived plan takes its PARENT's
 * rules, so loading the child's would price the stay off an empty rule set and
 * silently fall through to the base rate.
 *
 * ══ ONE REFUSAL IS A FALL-BACK, AND THE REST ARE REFUSALS ═══════════════════
 *
 * `no_rate_plan` means this business has not built a rate card, or has none
 * that covers this stay. That is the ordinary state of a guesthouse on its
 * first day, and refusing to quote would make the product unusable before it
 * is configured. It falls back to the unit's base price — which is what the
 * `unit_base_price` rung of the ladder already means — and says so in the
 * result, so a screen can tell a quote that came from a rate card from one
 * that did not.
 *
 * **Every other refusal propagates.** `invalid_range`, a derivation cycle, a
 * price below a configured floor: each of those means a rate card that EXISTS
 * did not resolve, and quoting around it would hand the guest a number the
 * business never set. Spec §7.8 and §6 rule 5 both say refuse rather than
 * price, and they are talking about exactly this case.
 *
 * The distinction is the whole design of this file. Collapsing the two —
 * falling back on any refusal — would restore the old behaviour under a new
 * name and hide a broken rate card behind a plausible number.
 */

import type { Db } from '../persistence/client'

import { PricingRepository } from './repository'
import {
  resolveDerivation,
  resolveStay,
  selectRatePlan,
  type ResolvedStay,
} from './resolve'
import type {
  PricingContext,
  PricingRefusal,
  RateCalendarEntry,
  RateModifier,
  RateRule,
} from './types'

/** What the caller needs to know, and nothing it has to interpret. */
export type StayPrice =
  /** A rate card was found and it priced the stay. */
  | { readonly status: 'resolved'; readonly stay: ResolvedStay }
  /**
   * No rate card covers this stay. The caller prices from the unit's base
   * rate, which is the same rung `resolveStay` would have landed on anyway.
   */
  | { readonly status: 'no_rate_card' }
  /** A rate card exists and did not resolve. Do not quote around this. */
  | { readonly status: 'refused'; readonly refusal: PricingRefusal }

/** Everything the context needs that is not read from the rate card itself. */
export type StayPriceInput = Omit<
  PricingContext,
  'plans' | 'rules' | 'calendar' | 'modifiers'
>

/**
 * Price one stay against the organization's rate card.
 *
 * Four reads at most, and none at all for a business with no rate plans: the
 * first read answers that, and the rest are skipped. A guesthouse that has
 * never opened the pricing screen pays one query for the whole feature.
 */
export async function priceWithRateCard(
  db: Db,
  input: StayPriceInput,
): Promise<StayPrice> {
  const repository = new PricingRepository(db)

  // `null` is the repository saying the table is not in this database at all,
  // which is a deployment fact and not a pricing decision. Same answer as an
  // empty rate card, for the same reason: there is nothing to price against.
  const plans = await repository.plans(input.organizationId)
  if (plans === null || plans.length === 0) return { status: 'no_rate_card' }

  const withPlans: PricingContext = {
    ...input,
    plans,
    rules: [],
    calendar: [],
    modifiers: [],
  }

  const selected = selectRatePlan(withPlans)
  if (!selected.ok) return fallbackOrRefusal(selected.refusal)

  // The plan whose RULES apply, which is the far end of the derivation chain
  // and not necessarily the plan that was selected.
  const derived = resolveDerivation(selected.plan, plans)
  if (!derived.ok) return fallbackOrRefusal(derived.refusal)

  const [rules, calendar, modifiers] = await Promise.all([
    repository.rulesForPlan(input.organizationId, derived.source.id),
    repository.calendar(input.organizationId, {
      unitId: input.unitId,
      ratePlanId: derived.source.id,
      from: input.range.checkIn,
      to: input.range.checkOut,
    }),
    repository.modifiers(input.organizationId, input.propertyId),
  ])

  const resolved = resolveStay({
    ...withPlans,
    // A missing table for any of the three is an empty list rather than a
    // refusal: `rate_plans` existed, so the rate card is real, and a plan with
    // no rules prices every night off the plan's own base — which is a rate
    // card decision and not an error.
    rules: (rules ?? []) as readonly RateRule[],
    calendar: (calendar ?? []) as readonly RateCalendarEntry[],
    modifiers: (modifiers ?? []) as readonly RateModifier[],
  })

  if (!resolved.ok) return fallbackOrRefusal(resolved.refusal)
  return { status: 'resolved', stay: resolved.resolved }
}

/**
 * The one refusal that is not a refusal.
 *
 * Written as its own function so the exception is stated once and cannot be
 * widened by somebody adding a second code to a condition.
 */
function fallbackOrRefusal(refusal: PricingRefusal): StayPrice {
  return refusal.code === 'no_rate_plan'
    ? { status: 'no_rate_card' }
    : { status: 'refused', refusal }
}
