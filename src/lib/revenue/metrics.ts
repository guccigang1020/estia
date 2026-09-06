/**
 * The report. Every figure, and every refusal to produce one.
 *
 * ══ ADR IS ROOM REVENUE, NOT THE TOTAL ══════════════════════════════════════
 *
 * This is the mistake worth the most money. Average daily rate means what a
 * guest paid for the ROOM, per night. A booking's `total_agorot` also carries
 * the cleaning fee, the extra bed, the add-ons and the tax — and a ₪350 cabin
 * with a ₪150 cleaning fee on a two-night stay reports an ADR of ₪425 instead
 * of ₪350, a fifth too high. Price it against that number and the season is
 * mispriced all summer.
 *
 * So ADR sums `booking_price_lines` of kind `accommodation` and nothing else.
 * A booking with no accommodation lines is not "assume the total" — it is
 * EXCLUDED and COUNTED as excluded, and if every booking in the window is like
 * that, ADR is `no_source` rather than a number.
 *
 * `total_revenue` reports the other question honestly beside it, so nothing is
 * hidden — it is simply not called a rate.
 *
 * ══ OCCUPANCY NEEDS A DENOMINATOR NOBODY CAN GUESS ══════════════════════════
 *
 * Nights available = bookable units × nights in the window. With no units the
 * answer is `no_denominator`, never 0% and never 100%. Both of those are
 * statements about a business, and this module does not have one to make.
 *
 * ══ WHAT IS NOT HERE ════════════════════════════════════════════════════════
 *
 * Market position. Comparing a business to its competitors needs a source of
 * competitor prices, and no such source exists in this product or behind it.
 * It reports `not_in_product` for the same reason `unit.market_position` does
 * in `listing-quality`: any number invented here would be read as measured.
 */

import {
  isBackdated,
  isDemand,
  isLost,
  isOccupying,
  leadTimeDays,
  nightsBetween,
  nightsInWindow,
  shareInWindow,
} from './stays'
import {
  known,
  unknown,
  type ChannelShare,
  type Measure,
  type RevenueBooking,
  type RevenueReport,
  type Window,
} from './types'

/** Rounded to one decimal, so 61.53846 reads as 61.5 and not as precision. */
const pct = (part: number, whole: number): number =>
  Math.round((part / whole) * 1000) / 10

const mean = (values: readonly number[]): Measure =>
  values.length === 0
    ? unknown('no_data')
    : known(Math.round(values.reduce((sum, v) => sum + v, 0) / values.length))

export type RevenueInput = {
  readonly window: Window
  readonly bookings: readonly RevenueBooking[]
  /**
   * How many units were bookable across the window.
   *
   * Null, not zero, when it is unknown — a caller that cannot count units must
   * say so rather than pass a number that makes occupancy infinite or absent
   * by accident.
   */
  readonly bookableUnits: number | null
}

export function revenueReport(input: RevenueInput): RevenueReport {
  const { window, bookings, bookableUnits } = input

  const windowNights = nightsBetween(window.from, window.to)

  const stays = bookings.filter(
    (b) => isOccupying(b.status) && nightsInWindow(b, window) > 0,
  )
  const lost = bookings.filter(
    (b) => isLost(b.status) && nightsInWindow(b, window) > 0,
  )

  /* ------------------------------------------------------------ occupancy -- */

  const nightsSoldCount = stays.reduce(
    (sum, b) => sum + nightsInWindow(b, window),
    0,
  )

  const nightsAvailable: Measure =
    bookableUnits === null || windowNights === 0
      ? unknown('no_denominator')
      : known(bookableUnits * windowNights)

  const nightsSold: Measure =
    stays.length === 0 && lost.length === 0
      ? unknown('no_data')
      : known(nightsSoldCount)

  const occupancy: Measure =
    nightsAvailable.known && nightsAvailable.value > 0
      ? known(pct(nightsSoldCount, nightsAvailable.value))
      : unknown('no_denominator')

  /* ----------------------------------------------------------------- rate -- */

  const withLines = stays.filter((b) => b.accommodationAgorot !== null)
  const withoutAccommodationLines = stays.length - withLines.length

  const roomRevenue = withLines.reduce(
    (sum, b) => sum + shareInWindow(b.accommodationAgorot ?? 0, b, window),
    0,
  )
  const roomNights = withLines.reduce(
    (sum, b) => sum + nightsInWindow(b, window),
    0,
  )

  const roomRevenueAgorot: Measure =
    withLines.length === 0 ? unknown('no_source') : known(roomRevenue)

  // Divided by the nights of the bookings it could actually price, not by
  // every night sold. Mixing them would quietly average the excluded
  // bookings in at zero.
  const adrAgorot: Measure =
    roomNights === 0
      ? unknown('no_source')
      : known(Math.round(roomRevenue / roomNights))

  // RevPAR is room revenue over nights AVAILABLE, which is what makes it
  // different from ADR: it falls when the place is empty and ADR does not.
  const revparAgorot: Measure =
    nightsAvailable.known && nightsAvailable.value > 0 && withLines.length > 0
      ? known(Math.round(roomRevenue / nightsAvailable.value))
      : unknown(nightsAvailable.known ? 'no_source' : 'no_denominator')

  const totalRevenueAgorot: Measure =
    stays.length === 0
      ? unknown('no_data')
      : known(
          stays.reduce(
            (sum, b) => sum + shareInWindow(b.totalAgorot, b, window),
            0,
          ),
        )

  /* ----------------------------------------------------------------- pace -- */

  const averageStayNights = mean(
    stays.map((b) => nightsBetween(b.checkIn, b.checkOut)),
  )

  const onTime = stays.filter((b) => !isBackdated(b))
  const backdated = stays.length - onTime.length
  const leadTime = mean(onTime.map(leadTimeDays))
  const leadTimeDaysMeasure: Measure =
    onTime.length === 0 && stays.length > 0 ? unknown('no_source') : leadTime

  /* -------------------------------------------------------- cancellations -- */

  // Demand that never became a booking is not in either half of this. An
  // enquiry that goes quiet was not cancelled, and counting it would make
  // every busy business look unreliable.
  const decided = stays.length + lost.length
  const cancellationRate: Measure =
    decided === 0 ? unknown('no_data') : known(pct(lost.length, decided))

  /* ------------------------------------------------------------- channels -- */

  const channelMix = channelShares(stays, window, nightsSoldCount)

  return {
    window,
    nightsAvailable,
    nightsSold,
    occupancy,
    adrAgorot,
    revparAgorot,
    roomRevenueAgorot,
    totalRevenueAgorot,
    averageStayNights,
    leadTimeDays: leadTimeDaysMeasure,
    cancellationRate,
    channelMix,
    withoutAccommodationLines,
    backdated,
    marketPosition: unknown('not_in_product'),
  }
}

/**
 * Where the nights came from, biggest first.
 *
 * Share is of NIGHTS rather than of bookings, because that is the question an
 * owner is asking: a channel sending four one-night stays is not twice the
 * business of one that sends two week-long ones, and counting bookings says it
 * is. Ignored bookings do not appear, so the shares sum to 100 for what is
 * shown, and only sources that actually sent something get a row — an empty
 * column for `vrbo` is noise in a country where almost nobody uses it.
 */
function channelShares(
  stays: readonly RevenueBooking[],
  window: Window,
  totalNights: number,
): readonly ChannelShare[] {
  const bySource = new Map<string, { b: number; n: number; r: number }>()

  for (const booking of stays) {
    const entry = bySource.get(booking.source) ?? { b: 0, n: 0, r: 0 }
    entry.b += 1
    entry.n += nightsInWindow(booking, window)
    entry.r += shareInWindow(booking.totalAgorot, booking, window)
    bySource.set(booking.source, entry)
  }

  return [...bySource.entries()]
    .map(([source, entry]) => ({
      source: source as ChannelShare['source'],
      bookings: entry.b,
      nights: entry.n,
      revenueAgorot: entry.r,
      nightsShare: totalNights === 0 ? 0 : pct(entry.n, totalNights),
    }))
    .sort((a, b) => b.nights - a.nights || a.source.localeCompare(b.source))
}

/** Demand that never became a stay, for a screen that wants to say so. */
export function demandCount(bookings: readonly RevenueBooking[]): number {
  return bookings.filter((b) => isDemand(b.status)).length
}
