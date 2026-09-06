/**
 * What a revenue figure is made of, and what it is allowed to be missing.
 *
 * ══ THE LAW THIS MODULE INHERITS ════════════════════════════════════════════
 *
 * `website/quality.ts` set it and `listing-quality` restated it: **a number
 * that cannot be sourced from real data is reported as absent, with the
 * reason, and never estimated.** Revenue is where breaking that rule costs
 * the most, because a business will price a season on what this screen says.
 *
 * So every figure here is `Measure` — a number or a stated reason there is
 * none. There is no `| 0` anywhere in this module, because zero occupancy and
 * unknown occupancy are opposite facts about a business and a chart cannot
 * tell them apart.
 */

/** Why a figure could not be produced. Each one is shown to the reader. */
export type Unmeasurable =
  /** Nothing in the window to average, divide by, or count. */
  | 'no_data'
  /** Rows exist but the one field this figure needs is empty on all of them. */
  | 'no_source'
  /** The denominator is unknown — usually: how many units, for how many days. */
  | 'no_denominator'
  /** No source of this kind exists in the product at all. */
  | 'not_in_product'

export type Measure =
  | { readonly known: true; readonly value: number }
  | { readonly known: false; readonly reason: Unmeasurable }

export const known = (value: number): Measure => ({ known: true, value })
export const unknown = (reason: Unmeasurable): Measure => ({
  known: false,
  reason,
})

/**
 * A booking, reduced to what a revenue figure needs.
 *
 * `accommodationAgorot` is deliberately separate from `totalAgorot` and
 * deliberately nullable. See `rates.ts`: a cleaning fee is not room revenue,
 * and a booking with no accommodation price lines cannot contribute to an
 * average nightly rate — it can only be left out and counted as left out.
 */
export type RevenueBooking = {
  readonly id: string
  readonly propertyId: string
  readonly unitId: string
  readonly status: BookingStatusName
  readonly source: BookingSourceName
  /** Inclusive. */
  readonly checkIn: string
  /** Exclusive — the departure day is not a night. */
  readonly checkOut: string
  readonly totalAgorot: number
  /** Sum of `accommodation` price lines, or null when there are none. */
  readonly accommodationAgorot: number | null
  /** When the row was written, which is not always when it was booked. */
  readonly createdAt: string
}

/** The statuses this module knows, as `booking_status` in the database. */
export type BookingStatusName =
  | 'inquiry'
  | 'quote'
  | 'option'
  | 'awaiting_payment'
  | 'deposit_paid'
  | 'contract_pending'
  | 'confirmed'
  | 'pre_arrival'
  | 'ready_for_check_in'
  | 'checked_in'
  | 'in_house'
  | 'checkout_pending'
  | 'checked_out'
  | 'inspection'
  | 'deposit_release'
  | 'completed'
  | 'review_requested'
  | 'cancelled'
  | 'no_show'

export type BookingSourceName =
  | 'direct_website'
  | 'direct_manual'
  | 'agent'
  | 'agency'
  | 'airbnb'
  | 'booking_com'
  | 'vrbo'
  | 'other_channel'

/** Half-open, like the stay itself: `from` is a night, `to` is not. */
export type Window = { readonly from: string; readonly to: string }

export type RevenueReport = {
  readonly window: Window
  /** How many bookable unit-nights the window contained. */
  readonly nightsAvailable: Measure
  readonly nightsSold: Measure
  readonly occupancy: Measure
  readonly adrAgorot: Measure
  readonly revparAgorot: Measure
  readonly roomRevenueAgorot: Measure
  readonly totalRevenueAgorot: Measure
  readonly averageStayNights: Measure
  readonly leadTimeDays: Measure
  readonly cancellationRate: Measure
  readonly channelMix: readonly ChannelShare[]
  /** Bookings excluded from ADR because they carry no accommodation lines. */
  readonly withoutAccommodationLines: number
  /** Bookings excluded from lead time because they were entered after arrival. */
  readonly backdated: number
  /** Always absent. See `market.ts`. */
  readonly marketPosition: Measure
}

export type ChannelShare = {
  readonly source: BookingSourceName
  readonly bookings: number
  readonly nights: number
  readonly revenueAgorot: number
  /** Share of nights, 0–100, rounded to one decimal. */
  readonly nightsShare: number
}
