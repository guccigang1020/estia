/**
 * The price of a proposed stay in one unit.
 *
 * PURE. It takes a unit's configured rates and a range and returns whatever
 * `priceStay` says. Nothing is added, nothing is rounded a second time, and no
 * figure on the screen is computed anywhere but inside the pricing engine —
 * the total is `sumLines(lines)` by construction, so "why is it ₪6,400?" is
 * answered by reading the lines back.
 *
 * ── VAT, and the one thing that is not a line ─────────────────────────────
 *
 * `properties.tax_included_in_price` decides which of two shapes applies, and
 * they are genuinely different calculations rather than two renderings of one:
 *
 *   · **Exclusive** — the configured rates do not contain the tax, so
 *     `taxRatePercent` is handed to `priceStay` and VAT becomes a real line in
 *     the total.
 *   · **Inclusive** — the Israeli default, and the case where a tax line would
 *     be wrong twice over: adding one would charge the tax again, and it would
 *     make the lines stop summing to the total. `taxIncludedIn` gives the
 *     "מתוכם מע״מ" figure for display, and the pricing engine's own header says
 *     why it is a formatted string and not a `PriceLine`.
 *
 * ── WHAT THIS DOES NOT DECIDE ─────────────────────────────────────────────
 *
 * Whether the dates are free. That is the availability engine's answer and it
 * is asked separately; a quote for taken dates is still a correct quote, and
 * conflating the two would put a pricing bug in the path of a double booking.
 */

import { priceStay, taxIncludedIn, type StayQuote } from '@/lib/booking/pricing'
import type { DateRange } from '@/lib/booking/types'

import type { CalendarUnit } from './inventory'

export interface UnitQuote extends StayQuote {
  /**
   * The VAT already contained in the total, when the property's rates include
   * it. `null` when tax is charged as its own line, where the figure is in
   * `taxAgorot` and reading it from two places would let the two disagree.
   */
  taxIncludedAgorot: number | null
  /** Basis points, straight off the property. 1700 is 17%. */
  taxRateBps: number
}

/**
 * A quote for one unit, or `null` when the unit has no rate configured.
 *
 * A unit with `base_price_agorot = 0` — the column default — has not been
 * priced. Rendering "₪0" for it would be a number the business never chose and
 * would look like a free stay; the honest answer is that there is no price to
 * show yet, and the screen says so.
 */
export function quoteFor(
  unit: CalendarUnit,
  range: DateRange,
  guests: number,
): UnitQuote | null {
  if (unit.basePriceAgorot <= 0) return null

  const taxRatePercent = unit.taxRateBps / 100

  const quote = priceStay({
    range,
    baseNightlyAgorot: unit.basePriceAgorot,
    guests,
    // The rate covers this many; anyone beyond it is an extra-guest line.
    includedGuests: unit.standardGuests,
    extraGuestNightlyAgorot: unit.extraGuestPriceAgorot,
    cleaningFeeAgorot: unit.cleaningFeeAgorot,
    depositAgorot: unit.depositAgorot,
    // Only when the rates genuinely exclude it. See the header.
    ...(unit.taxIncludedInPrice ? {} : { taxRatePercent }),
  })

  return {
    ...quote,
    taxIncludedAgorot: unit.taxIncludedInPrice
      ? // Computed on the stay, not on the total: a refundable deposit is the
        // guest's own money being held and is not a supply of anything.
        taxIncludedIn(quote.stayTotalAgorot, taxRatePercent)
      : null,
    taxRateBps: unit.taxRateBps,
  }
}

/**
 * Does the unit physically hold this party?
 *
 * Stated as its own fact rather than folded into availability, because it is
 * not the availability engine's answer: `checkAvailability` knows about
 * bookings, holds, blocked dates and length of stay, and knows nothing about
 * capacity. `units.max_guests` is a real column and this is a comparison of two
 * real numbers — no rule is being invented here, and a unit that is free but
 * too small is reported as exactly that rather than as unavailable.
 */
export function fitsParty(unit: CalendarUnit, guests: number): boolean {
  return guests <= unit.maxGuests
}
