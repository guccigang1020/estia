/**
 * The rows a metric source hands over.
 *
 * Flat, plain and boring on purpose — the same discipline as `ActorSource`.
 * Every decision worth arguing about (what counts as sold, whether a
 * complimentary night is revenue, what an out-of-service unit does to
 * occupancy) is made in `facts.ts` against these rows, in code that runs in
 * milliseconds with no database anywhere near it.
 *
 * Dates are property-local calendar dates in `YYYY-MM-DD`. Converting a
 * timestamp to the property's day is the source's job, and it must use
 * `localDate` from `booking/dates.ts`: at 22:30 UTC it is already tomorrow in
 * Israel, and a booking created then belongs to tomorrow's pace.
 */

import type { Agorot, BookingSource, BookingStatus } from '../booking/types'
import { OCCUPYING_STATUSES } from '../booking/types'

// ── Status classification ─────────────────────────────────────────────────

/**
 * The statuses of a stay that has already happened.
 *
 * `OCCUPYING_STATUSES` answers one question — which dates may not be sold
 * again — and it answers it looking forward. A completed stay from March no
 * longer blocks anything, and is correctly absent from that list; but it
 * absolutely occupied its nights and absolutely earned its money, and a March
 * occupancy report that ignored it would be nonsense.
 *
 * So this is the other half, and the union below is what reporting counts.
 * It is derived from the booking contract rather than restating it: a status
 * added there without being classified here shows up as a failing test.
 */
export const POST_STAY_STATUSES: readonly BookingStatus[] = [
  'checked_out',
  'inspection',
  'deposit_release',
  'completed',
  'review_requested',
]

/**
 * Every status that means "this stay is real": it holds nights now, or it held
 * them once.
 *
 * Deliberately excluded:
 *   · `inquiry` and `quote` — nobody has committed to anything.
 *   · `cancelled` — the nights were released and sold to somebody else.
 *   · `no_show` — the room stood empty. It may have been charged, but charging
 *     for an empty room is not occupancy, and counting it would let a bad month
 *     look full. No-shows are counted only where they are the subject.
 */
export const REALISED_STATUSES: ReadonlySet<BookingStatus> =
  new Set<BookingStatus>([...OCCUPYING_STATUSES, ...POST_STAY_STATUSES])

/**
 * A held option occupies inventory without being a sale.
 *
 * It blocks the calendar, so it belongs in occupancy — the room genuinely
 * cannot be sold to anyone else. It earns nothing, so it must stay out of the
 * denominator of ADR, or a week of speculative holds would report the business
 * halving its nightly rate.
 */
export function isSoldStatus(status: BookingStatus): boolean {
  return REALISED_STATUSES.has(status) && status !== 'option'
}

/** Sources the business owns outright — no channel, no commission, no middleman. */
export const DIRECT_SOURCES: readonly BookingSource[] = [
  'direct_website',
  'direct_manual',
]

const DIRECT_SOURCE_SET: ReadonlySet<BookingSource> = new Set(DIRECT_SOURCES)

export function isDirectSource(source: BookingSource): boolean {
  return DIRECT_SOURCE_SET.has(source)
}

// ── Inventory ─────────────────────────────────────────────────────────────

/**
 * A sellable unit, and the span over which it is part of the inventory.
 *
 * A unit added in the middle of a month contributes only the nights after it
 * existed. Counting the whole month would invent available nights the business
 * never had and report a fall in occupancy caused by growth.
 */
export interface UnitInventoryRow {
  unitId: string
  propertyId: string
  /** First night the unit is inventory, inclusive. `null` = since forever. */
  inServiceFrom: string | null
  /** First night it no longer is, exclusive. `null` = still in service. */
  inServiceUntil: string | null
}

/**
 * A span during which a unit could not be sold: renovation, damage, a closed
 * season, an owner staying in their own cabin.
 *
 * Half-open, like everything else. Overlapping blocks are allowed and are
 * counted once — `facts.ts` works in sets of unit-nights precisely so that two
 * overlapping maintenance windows cannot subtract the same night twice.
 */
export interface OutOfServiceRow {
  unitId: string
  propertyId: string
  from: string
  to: string
}

// ── Bookings ──────────────────────────────────────────────────────────────

/**
 * One booking, reduced to what measurement needs.
 *
 * Money is integer agorot and is **net of tax**: VAT collected on behalf of the
 * state was never the business's revenue, and a report that includes it
 * overstates every figure by 17%. The source subtracts the `tax` price lines.
 * Discounts and promotions are already netted in — they are negative lines, so
 * `roomRevenue` is what the guest actually owes for the room.
 */
export interface BookingFactRow {
  bookingId: string
  propertyId: string
  unitId: string
  status: BookingStatus
  source: BookingSource
  /** The stay, half-open. */
  checkIn: string
  checkOut: string
  /** Property-local date the booking record was created. */
  createdOn: string
  /** Property-local date it first reached a committed status. `null` if never. */
  committedOn: string | null
  /** Property-local date it was cancelled. `null` unless it was. */
  cancelledOn: string | null
  /** Accommodation only, net of tax and discounts. Recognised night by night. */
  roomRevenue: Agorot
  /** Cleaning, extras, add-ons. Recognised on arrival — see `facts.ts`. */
  ancillaryRevenue: Agorot
  /** Channel or agent commission owed on this stay. A cost, stored positive. */
  commission: Agorot
  /** Received against this booking to date. */
  collected: Agorot
  /**
   * A stay given away: an owner's own week, a compensation night, an influencer.
   * It occupies the room and it is not a sale — see `facts.ts` for what that
   * does to ADR.
   */
  isComplimentary: boolean
}
