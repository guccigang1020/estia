/**
 * What a discount is worth, in agorot.
 *
 * ── THE ROUNDING, STATED ONCE ──────────────────────────────────────────────
 *
 * A percentage discount is rounded **half away from zero, on the magnitude**,
 * by `roundAgorot` from `src/lib/booking/pricing.ts`. That is not a new rule
 * and not a choice made here: it is the codebase's single definition of
 * rounding, imported rather than re-derived, and `docs/spec/20-pricing.md`
 * §7.5 names it as one of the only two rounding sites in the product.
 *
 * The direction has a consequence worth writing down: on an exact half agora,
 * the magnitude of the discount rounds UP, so the half goes to the guest. That
 * is the right way for the error to fall — a business that over-discounts by
 * half an agora has a rounding policy, and one that under-discounts by half an
 * agora has an argument with a customer.
 *
 * **There is exactly one rounding call in this module and it is in this file.**
 * The alternative — each caller rounding its own share — is how a total stops
 * equalling the sum of its lines: the drift is invisible on one line and grows
 * with every line added.
 *
 * ── The seam with `priceStay` ──────────────────────────────────────────────
 *
 * §7.1: the resolver produces INPUT, `priceStay` produces the price. So the
 * output of this file is a `DiscountRequest`, not a `PriceLine` and not a
 * total. `priceStay` remains the only thing in ESTIA that makes money.
 *
 * **Every request is handed over as `fixed`, including the percentages.** That
 * looks like the wrong choice and it is the load-bearing one.
 *
 *   · §6 rule 31 says all percentage discounts are taken against the same
 *     pre-discount subtotal, so two 10% discounts remove 20% and not 19% and
 *     the order they were entered cannot move the quote. Computing all of them
 *     here, against one `DiscountBase`, makes that true in this file rather
 *     than depending on `priceStay`'s internal subtotal happening to equal the
 *     one this module was given.
 *
 *   · `priceStay` takes a percentage as percentage POINTS and computes
 *     `value * subtotal / 100`; this module stores basis points and would
 *     compute `bps * subtotal / 10000`. Those are the same rational number and
 *     not always the same double — `bps / 100` is inexact for 333 bps before
 *     it is multiplied by anything. Two arithmetic paths for one figure is
 *     exactly the drift the rounding rule above exists to prevent.
 *
 *   · §7.9 sorts candidate promotions by what they are worth in agorot. That
 *     number has to be the number actually charged, or the ordering is decided
 *     by a figure nothing else agrees with.
 *
 * `accommodation_only` could not have been expressed as a percentage anyway:
 * `priceStay` has exactly one discountable base and it is the whole subtotal.
 */

import { roundAgorot, type Agorot, type DiscountRequest } from '../booking'
import { BPS_PER_UNIT, type DiscountTerms } from './types'

/**
 * What there is to discount, taken from the lines that already exist.
 *
 * Not computed here and not guessed: the caller passes the real subtotals it
 * is about to hand `priceStay`. `stayTotalAgorot` must be the same number
 * `priceStay` will use as its `discountable` — everything charged before the
 * discount step, which is accommodation, extra guests, the cleaning fee and
 * the add-ons, and never tax and never the deposit, because both of those come
 * after (§6 rule 32).
 */
export interface DiscountBase {
  /** Everything charged before any discount. */
  stayTotalAgorot: Agorot
  /** The accommodation lines alone. */
  accommodationAgorot: Agorot
  /**
   * What each night cost, after the nightly rounding of §7.5.
   *
   * Needed only by `free_nights`, and its absence is why a `free_nights`
   * discount is reported ABSENT rather than estimated: how much three free
   * nights are worth depends on which nights were sold and at what rate, and
   * no fraction of a subtotal is that number.
   */
  nightlyAgorot?: readonly Agorot[]
}

/**
 * The amount, or its absence with the reason.
 *
 * A discount that cannot be sourced from real data is reported absent — the
 * charter's rule, and here it has teeth: an estimated discount is an estimated
 * invoice.
 */
export type DiscountAmount =
  | { agorot: Agorot }
  | { agorot: null; absent: 'nightly_rates_unknown' | 'nothing_to_discount' }

/**
 * Which nights a `free_nights` promotion gives away.
 *
 * **The cheapest.** "Stay four nights, pay for three" is sold against the
 * quietest night of the stay, not the most expensive one, and a business that
 * discovered its "third night free" campaign had given away Saturday of Sukkot
 * would switch it off and never turn it on again. Choosing the cheapest makes
 * the campaign's cost predictable, which is the only property that lets
 * somebody set `budgetAgorot` honestly.
 *
 * Stated here because it is a commercial decision, not an implementation
 * detail, and a reader has to be able to find it.
 */
function cheapestNights(
  nightly: readonly Agorot[],
  count: number,
): readonly Agorot[] {
  // A copy: sorting the caller's array in place would reorder the nights on
  // whatever produced it, and those are in date order for a reason.
  return [...nightly].sort((a, b) => a - b).slice(0, count)
}

/**
 * What this discount takes off, given what there is to take it off.
 *
 * Never negative and never larger than its own base. `priceStay` clamps again
 * against what remains after earlier discounts — §6 rule 23, a total may reach
 * zero and never pass it — and the two clamps are not redundant: this one
 * keeps a single promotion honest about its own basis, and that one keeps the
 * booking honest about all of them together.
 */
export function discountAgorot(
  terms: DiscountTerms,
  base: DiscountBase,
): DiscountAmount {
  const against =
    terms.appliesTo === 'accommodation_only'
      ? base.accommodationAgorot
      : base.stayTotalAgorot

  if (terms.discountKind === 'free_nights') {
    const nightly = base.nightlyAgorot
    if (nightly === undefined) {
      // Reported absent, with the reason. Falling back to a percentage of the
      // subtotal would be inventing a figure, and it would be wrong in the
      // direction that costs money on exactly the expensive stays.
      return { agorot: null, absent: 'nightly_rates_unknown' }
    }
    if (nightly.length === 0)
      return { agorot: null, absent: 'nothing_to_discount' }
    // Fewer nights than the promotion gives away means the whole stay is free.
    // Clamped rather than refused: "fourth night free" on a three-night stay is
    // a stay that does not qualify, and the eligibility conditions are where
    // that is said. Here it is only arithmetic.
    const free = cheapestNights(
      nightly,
      Math.min(terms.discountValue, nightly.length),
    )
    // A sum of integers. No rounding, because there is nothing fractional.
    const total = free.reduce((sum, night) => sum + night, 0)
    return { agorot: clamp(total, against) }
  }

  if (against <= 0) return { agorot: null, absent: 'nothing_to_discount' }

  if (terms.discountKind === 'fixed') {
    // Already agorot, already integer. `Math.trunc` and not `roundAgorot`: a
    // fixed amount that arrived fractional is a malformed row, not a number to
    // round, and the CHECK in 0073 refuses it. Truncating cannot invent money.
    return { agorot: clamp(Math.trunc(terms.discountValue), against) }
  }

  // The one rounding call. Basis points, so the division is by 10,000.
  return {
    agorot: clamp(
      roundAgorot((against * terms.discountValue) / BPS_PER_UNIT),
      against,
    ),
  }
}

function clamp(value: Agorot, ceiling: Agorot): Agorot {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(value, Math.max(ceiling, 0))
}

/**
 * The `DiscountRequest` `priceStay` should be given.
 *
 * `lineKind: 'promotion'` throughout: `booking_price_lines` distinguishes a
 * campaign from a negotiated reduction, and the /promotions screen already
 * groups by that distinction. A coupon is a campaign instance, so it is a
 * `promotion` line too — the coupon's identity lives in
 * `discount_redemptions`, which is where a question about it will be asked.
 *
 * Returns `null` when there is nothing to apply. An omitted line is the right
 * answer for a zero discount — §7.10 — and it is also what stops a redemption
 * of nothing consuming one of a hundred available.
 */
export function toDiscountRequest(
  terms: DiscountTerms,
  base: DiscountBase,
  label: string,
): DiscountRequest | null {
  const amount = discountAgorot(terms, base)
  if (amount.agorot === null || amount.agorot <= 0) return null

  // `fixed`, always. See the header: one arithmetic path, one rounding, and
  // the figure §7.9 sorted by is the figure the guest is charged.
  return { label, kind: 'fixed', value: amount.agorot, lineKind: 'promotion' }
}
