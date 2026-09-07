/**
 * Which campaigns apply, and in what order.
 *
 * `docs/spec/20-pricing.md` §7.9, implemented as written, including the two
 * decisions in it that look arbitrary and are not:
 *
 *   · **`priority` is sorted before the value of the discount.** The explicit
 *     intention of the business beats "what is best for the guest". A revenue
 *     manager who ranked the winter campaign above the midweek one meant it,
 *     and a resolver that quietly gave away the larger of the two would be
 *     overruling them with arithmetic.
 *
 *   · **Ties break on `code`, ascending.** Arbitrary, and STABLE, which is the
 *     property that matters: the same inputs must produce the same quote in a
 *     year's time. A tie broken by insertion order is a quote that changes
 *     when somebody re-seeds a table.
 *
 * The discount values used for sorting are computed ONCE, before the loop,
 * against the pre-discount subtotal. Recomputing inside the loop as the
 * running total fell would make the result depend on the order it was
 * computing — a resolver whose output is a function of its own iteration.
 *
 * ── The coupon is a separate axis ──────────────────────────────────────────
 *
 * §6 rule 30: at most one coupon per booking, applied after the promotions and
 * not competing with them. So it is a separate field of the result rather than
 * an entry in the same list, and there is no path here that can select two.
 */

import { discountAgorot, type DiscountBase } from './discount'
import { evaluateCondition, type ConditionFailure } from './conditions'
import type { Coupon, Promotion, PromotionFacts } from './types'

/** Why a campaign that exists did not reach the quote. */
export type IneligibleReason =
  | { reason: 'inactive' }
  | { reason: 'outside_window' }
  | { reason: 'condition'; failure: ConditionFailure }
  | { reason: 'worth_nothing' }
  /** Another campaign in the same `exclusiveGroup` was chosen first. */
  | { reason: 'excluded_by'; code: string }
  /** A non-stackable campaign was already chosen, or this one is. */
  | { reason: 'not_stackable' }

export interface SelectedPromotion {
  promotion: Promotion
  /** What it takes off, in agorot. Always ≥ 1 — a zero is not selected. */
  amountAgorot: number
}

export interface RejectedPromotion {
  promotion: Promotion
  because: IneligibleReason
}

export interface PromotionSelection {
  selected: readonly SelectedPromotion[]
  /**
   * Everything that did not make it, and why.
   *
   * Kept rather than discarded because §6 rule 29 says a promotion skipped
   * after a non-stackable one was chosen is NOT shown to the guest as
   * something they missed — and the only way a screen can honour that rule is
   * to be told which ones those were.
   */
  rejected: readonly RejectedPromotion[]
}

/**
 * Is this campaign live at this instant?
 *
 * Half-open, like every range in the product: `effectiveTo` is the first
 * instant OUTSIDE the window, not the last one inside it. §3.5 makes these
 * instants rather than dates because a campaign ends at midnight in the
 * property's time zone, and midnight is a moment rather than a day.
 */
export function isLive(
  window: {
    isActive: boolean
    effectiveFrom: string
    effectiveTo: string | null
    expiresAt?: string | null
  },
  at: Date,
): boolean {
  if (!window.isActive) return false
  const now = at.getTime()
  const from = Date.parse(window.effectiveFrom)
  // An unparseable window is not a window. Treating it as open would run a
  // campaign forever on the strength of a malformed string.
  if (!Number.isFinite(from) || now < from) return false

  for (const bound of [window.effectiveTo, window.expiresAt ?? null]) {
    if (bound === null) continue
    const until = Date.parse(bound)
    if (!Number.isFinite(until) || now >= until) return false
  }
  return true
}

/**
 * §7.9, in the order the spec writes it.
 *
 * `candidates` is every campaign the organization has. Filtering happens here
 * so that the reasons survive; a caller that pre-filtered would arrive with a
 * list and no explanation for what is missing from it.
 */
export function selectPromotions(
  candidates: readonly Promotion[],
  facts: PromotionFacts,
  base: DiscountBase,
  at: Date,
): PromotionSelection {
  const rejected: RejectedPromotion[] = []
  const eligible: SelectedPromotion[] = []

  for (const promotion of candidates) {
    if (!promotion.isActive) {
      rejected.push({ promotion, because: { reason: 'inactive' } })
      continue
    }
    if (!isLive(promotion, at)) {
      rejected.push({ promotion, because: { reason: 'outside_window' } })
      continue
    }

    const condition = evaluateCondition(promotion.conditions, facts)
    if (!condition.met) {
      rejected.push({
        promotion,
        because: { reason: 'condition', failure: condition.because },
      })
      continue
    }

    // Computed once, here, against the pre-discount subtotal. See the header.
    const amount = discountAgorot(promotion, base)
    if (amount.agorot === null || amount.agorot <= 0) {
      // §7.10: a discount that works out to nothing omits its line. It must
      // also not consume one of a hundred available redemptions on the way.
      rejected.push({ promotion, because: { reason: 'worth_nothing' } })
      continue
    }

    eligible.push({ promotion, amountAgorot: amount.agorot })
  }

  eligible.sort(compareCandidates)

  const selected: SelectedPromotion[] = []
  const groups = new Set<string>()
  let stopped = false

  for (const candidate of eligible) {
    const { promotion } = candidate

    if (stopped) {
      // Everything after a non-stackable choice. Rule 29: these are recorded
      // as skipped and are NOT shown to the guest — they were never on offer
      // once the exclusive one was chosen, and presenting them as missed
      // savings would be inventing a regret.
      rejected.push({ promotion, because: { reason: 'not_stackable' } })
      continue
    }

    if (
      promotion.exclusiveGroup !== null &&
      groups.has(promotion.exclusiveGroup)
    ) {
      const winner = selected.find(
        (chosen) =>
          chosen.promotion.exclusiveGroup === promotion.exclusiveGroup,
      )
      rejected.push({
        promotion,
        because: { reason: 'excluded_by', code: winner?.promotion.code ?? '' },
      })
      continue
    }

    if (!promotion.stackable && selected.length > 0) {
      rejected.push({ promotion, because: { reason: 'not_stackable' } })
      continue
    }

    selected.push(candidate)
    if (promotion.exclusiveGroup !== null) groups.add(promotion.exclusiveGroup)
    // Chosen first and not stackable: nothing else joins it.
    if (!promotion.stackable) stopped = true
  }

  return { selected, rejected }
}

function compareCandidates(a: SelectedPromotion, b: SelectedPromotion): number {
  if (a.promotion.priority !== b.promotion.priority) {
    return b.promotion.priority - a.promotion.priority
  }
  if (a.amountAgorot !== b.amountAgorot) return b.amountAgorot - a.amountAgorot
  // Arbitrary, stable, and therefore the whole point. `localeCompare` is
  // deliberately not used: it depends on the runtime's collation data, and a
  // quote that differs between two servers is not a deterministic quote.
  return a.promotion.code < b.promotion.code
    ? -1
    : a.promotion.code > b.promotion.code
      ? 1
      : 0
}

/**
 * The coupon, checked on its own.
 *
 * Returns the amount, or the reason there is none. It does not consult the
 * promotions at all: rule 30 makes it a separate axis, and a coupon that was
 * suppressed because a campaign happened to be non-stackable would be a code
 * the business handed out and then refused to honour.
 */
export function assessCoupon(
  coupon: Coupon,
  facts: PromotionFacts,
  base: DiscountBase,
  at: Date,
):
  { amountAgorot: number } | { amountAgorot: null; because: IneligibleReason } {
  if (!coupon.isActive) {
    return { amountAgorot: null, because: { reason: 'inactive' } }
  }
  if (!isLive(coupon, at)) {
    return { amountAgorot: null, because: { reason: 'outside_window' } }
  }

  const condition = evaluateCondition(coupon.conditions, facts)
  if (!condition.met) {
    return {
      amountAgorot: null,
      because: { reason: 'condition', failure: condition.because },
    }
  }

  const amount = discountAgorot(coupon, base)
  if (amount.agorot === null || amount.agorot <= 0) {
    return { amountAgorot: null, because: { reason: 'worth_nothing' } }
  }
  return { amountAgorot: amount.agorot }
}
