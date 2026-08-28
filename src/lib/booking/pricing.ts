/**
 * Pricing.
 *
 * The rule the whole file is built around: **the total is the sum of the
 * lines.** Not a number computed alongside them, not a number a person typed
 * and the lines explain afterwards. `totalAgorot` is literally
 * `lines.reduce(...)`, which makes "why is it ₪6,400?" — the most common
 * question a guest asks — answerable by reading the array back, and makes
 * rounding drift between the total and its explanation impossible by
 * construction rather than by care.
 *
 * ── Rounding ──────────────────────────────────────────────────────────────
 *
 * Money is integer agorot everywhere, so the only places a fraction can appear
 * are the percentage lines: a discount, VAT, a commission. Every one of them is
 * rounded **half away from zero, on the magnitude**, at the moment the line is
 * created — and never again afterwards.
 *
 * Why that rule and not another:
 *
 *   - *Half away from zero* rather than banker's rounding. Banker's rounding is
 *     right when thousands of values are summed and a systematic bias would
 *     accumulate. An invoice is not that: it is one document a person checks
 *     with a calculator, and their calculator rounds ₪0.005 up. Matching the
 *     guest's arithmetic is worth more here than a fraction of an agora of
 *     statistical neutrality.
 *
 *   - *On the magnitude* rather than on the signed value. `Math.round(-50.5)`
 *     is `-50`, so a discount of exactly half an agora would be quietly shaved
 *     while a fee of the same size was rounded up — the house winning both
 *     coin flips. Rounding `50.5` and then applying the sign treats the guest's
 *     half-agora and the business's identically.
 *
 *   - *Once, at the line.* Each percentage is applied to a subtotal of already
 *     integer lines and rounded there. Nothing is rounded twice and no total is
 *     re-derived from a rounded intermediate, so there is no drift to chase.
 *
 * ── What is and is not in the total ───────────────────────────────────────
 *
 * A refundable **security deposit** is a line and is in the total, because the
 * guest genuinely pays it — an invoice that omits it does not match the amount
 * charged. It is restated as `depositAgorot` so a screen can say "of which
 * ₪1,000 refundable", and `stayTotalAgorot` gives the cost of the stay without
 * it.
 *
 * **Agent commission** is not in the guest's total and never will be. The
 * business pays it out of what the guest paid; adding it would inflate the
 * price by money the guest is not being asked for. `agentCommissionLine`
 * produces it separately, for the commission statement, and deliberately does
 * not touch the quote.
 *
 * **VAT** is added as a line when a rate is supplied, which means rates given
 * to this function are VAT-exclusive. Israeli listed prices usually include
 * VAT; for that presentation the rates already contain the tax and
 * `taxIncludedIn` computes the "מתוכם מע״מ" figure for display without
 * inventing a line, because a line would either double the tax or fail to sum.
 */

import { ValidationError, type FieldIssue } from '../errors'
import { eachNight, formatDayMonth } from './dates'
import {
  nightsBetween,
  type Agorot,
  type DateRange,
  type PriceLine,
} from './types'

// ── Request ───────────────────────────────────────────────────────────────

export interface AddonRequest {
  code: string
  label: string
  unitPriceAgorot: Agorot
  quantity: number
}

export interface DiscountRequest {
  label: string
  /** `percent` of the pre-discount subtotal, or a flat `fixed` amount. */
  kind: 'percent' | 'fixed'
  /** Percentage points for `percent`; agorot for `fixed`. Always positive. */
  value: number
  /** `promotion` for a campaign, `discount` for a negotiated reduction. */
  lineKind?: 'discount' | 'promotion'
}

export interface StayPricingRequest {
  range: DateRange
  /** The rate for any night without a specific one. */
  baseNightlyAgorot: Agorot
  /** Per-date rates: weekends, holidays, a yield-managed calendar. */
  nightlyOverrides?: Readonly<Record<string, Agorot>>
  guests: number
  /** Guests the nightly rate already covers. Defaults to all of them. */
  includedGuests?: number
  extraGuestNightlyAgorot?: Agorot
  cleaningFeeAgorot?: Agorot
  addons?: readonly AddonRequest[]
  discounts?: readonly DiscountRequest[]
  /** VAT-exclusive percentage, e.g. `18`. Omitted means no tax line. */
  taxRatePercent?: number
  taxLabel?: string
  /** A refundable security deposit charged with the stay. */
  depositAgorot?: Agorot
}

export interface StayQuote {
  nights: number
  lines: readonly PriceLine[]
  /** Always `sumLines(lines)`. */
  totalAgorot: Agorot
  /** The total without the refundable deposit. */
  stayTotalAgorot: Agorot
  depositAgorot: Agorot
  taxAgorot: Agorot
}

// ── The calculation ───────────────────────────────────────────────────────

export function priceStay(request: StayPricingRequest): StayQuote {
  const issues: FieldIssue[] = []
  const nights = nightsBetween(request.range)

  if (!Number.isFinite(nights) || nights <= 0) {
    issues.push({
      field: 'checkOut',
      code: 'invalid_range',
      message: 'תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה.',
      label: 'תאריך עזיבה',
    })
  }
  if (!Number.isInteger(request.guests) || request.guests < 1) {
    issues.push({
      field: 'guests',
      code: 'too_small',
      message: 'חייב להיות לפחות אורח אחד בהזמנה.',
      label: 'מספר אורחים',
    })
  }
  if (
    !Number.isInteger(request.baseNightlyAgorot) ||
    request.baseNightlyAgorot < 0
  ) {
    issues.push({
      field: 'baseNightlyAgorot',
      code: 'invalid_amount',
      message: 'מחיר ללילה חייב להיות מספר שלם של אגורות, ולא שלילי.',
      label: 'מחיר ללילה',
    })
  }
  if (issues.length > 0) throw new ValidationError(issues)

  const lines: PriceLine[] = []

  // 1 ── Accommodation, one line per night.
  //      Per-night lines are the source of the accommodation figure rather
  //      than a split of it, so a nightly calendar with forty different rates
  //      sums exactly and a guest can see which night was the expensive one.
  for (const night of eachNight(request.range)) {
    const amount =
      request.nightlyOverrides?.[night] ?? request.baseNightlyAgorot
    lines.push({
      kind: 'accommodation',
      label: `לינה ${formatDayMonth(night)}`,
      amount,
      quantity: 1,
      date: night,
    })
  }

  // 2 ── Extra guests, per guest per night. Integers throughout.
  const included = request.includedGuests ?? request.guests
  const extraGuests = Math.max(0, request.guests - included)
  const extraRate = request.extraGuestNightlyAgorot ?? 0
  if (extraGuests > 0 && extraRate > 0) {
    lines.push({
      kind: 'extra_guest',
      label: `אורח נוסף · ${extraGuests} × ${nights} לילות`,
      amount: extraGuests * extraRate * nights,
      quantity: extraGuests * nights,
      date: null,
    })
  }

  // 3 ── Fixed charges.
  const cleaning = request.cleaningFeeAgorot ?? 0
  if (cleaning > 0) {
    lines.push({
      kind: 'cleaning_fee',
      label: 'דמי ניקיון',
      amount: cleaning,
      quantity: 1,
      date: null,
    })
  }

  for (const addon of request.addons ?? []) {
    if (addon.quantity <= 0 || addon.unitPriceAgorot <= 0) continue
    lines.push({
      kind: 'addon',
      label: addon.label,
      amount: addon.unitPriceAgorot * addon.quantity,
      quantity: addon.quantity,
      date: null,
    })
  }

  // 4 ── Discounts, against everything charged so far.
  //      Percentages are all taken against the same pre-discount subtotal, so
  //      two 10% discounts remove 20% and not 19% — stacking order must not
  //      change the price a guest was quoted.
  const discountable = sumLines(lines)
  let remaining = discountable
  for (const discount of request.discounts ?? []) {
    const raw =
      discount.kind === 'percent'
        ? roundAgorot((discountable * discount.value) / 100)
        : Math.round(discount.value)

    // Clamped: a discount may bring a stay to zero and never below it. A
    // negative total is a refund, and a refund is not something a price
    // calculator is allowed to invent.
    const applied = Math.min(Math.max(raw, 0), remaining)
    if (applied === 0) continue
    remaining -= applied

    lines.push({
      kind: discount.lineKind ?? 'discount',
      label: discount.label,
      amount: -applied,
      quantity: 1,
      date: null,
    })
  }

  // 5 ── Tax, on the discounted subtotal. A discount reduces the taxable
  //      amount; taxing before discounting would charge VAT on money nobody
  //      paid.
  const taxable = sumLines(lines)
  const taxRate = request.taxRatePercent ?? 0
  let taxAgorot = 0
  if (taxRate > 0 && taxable > 0) {
    taxAgorot = roundAgorot((taxable * taxRate) / 100)
    lines.push({
      kind: 'tax',
      label: request.taxLabel ?? `מע״מ ${formatPercent(taxRate)}%`,
      amount: taxAgorot,
      quantity: 1,
      date: null,
    })
  }

  // 6 ── The refundable deposit, last, and outside the tax base: a security
  //      deposit is not a supply of anything, it is the guest's own money
  //      being held.
  const depositAgorot = request.depositAgorot ?? 0
  if (depositAgorot > 0) {
    lines.push({
      kind: 'deposit',
      label: 'פיקדון ביטחון (מוחזר בתום השהות)',
      amount: depositAgorot,
      quantity: 1,
      date: null,
    })
  }

  const totalAgorot = sumLines(lines)

  return {
    nights,
    lines,
    totalAgorot,
    stayTotalAgorot: totalAgorot - depositAgorot,
    depositAgorot,
    taxAgorot,
  }
}

/** The only way a total is ever produced. */
export function sumLines(lines: readonly PriceLine[]): Agorot {
  return lines.reduce((total, line) => total + line.amount, 0)
}

/**
 * The commission owed on a stay.
 *
 * Returned on its own and never appended to the guest's quote — see the header.
 * Computed on the stay total excluding the refundable deposit, because nobody
 * earns commission on money that is going back to the guest.
 */
export function agentCommissionLine(
  quote: StayQuote,
  percent: number,
  label = 'עמלת סוכן',
): PriceLine {
  return {
    kind: 'agent_commission',
    label: `${label} · ${formatPercent(percent)}%`,
    amount: roundAgorot((quote.stayTotalAgorot * percent) / 100),
    quantity: 1,
    date: null,
  }
}

/**
 * The VAT contained in a tax-inclusive figure.
 *
 * For the "מתוכם מע״מ ₪X" line on a page whose rates already include tax. It is
 * a display figure, not a `PriceLine`: adding it as a line would either double
 * the tax or break the sum, and both are worse than a formatted string.
 */
export function taxIncludedIn(total: Agorot, ratePercent: number): Agorot {
  if (ratePercent <= 0) return 0
  return roundAgorot(total - total / (1 + ratePercent / 100))
}

/** Only the lines of one kind — for a screen that itemises by section. */
export function linesOfKind(
  lines: readonly PriceLine[],
  kind: PriceLine['kind'],
): readonly PriceLine[] {
  return lines.filter((line) => line.kind === kind)
}

// ── Internals ─────────────────────────────────────────────────────────────

/** Half away from zero, on the magnitude. See the header for why. */
export function roundAgorot(value: number): Agorot {
  const rounded = Math.round(Math.abs(value))
  // `+ 0` normalises the -0 that `-rounded` produces when rounded is 0.
  return (value < 0 ? -rounded : rounded) + 0
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
