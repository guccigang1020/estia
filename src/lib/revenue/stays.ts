/**
 * Which bookings are revenue, and how many nights each one contributed.
 *
 * ══ THE DECISION THAT DECIDES EVERY OTHER NUMBER ════════════════════════════
 *
 * `booking_status` has nineteen members and only some of them are a stay.
 *
 * An `inquiry`, a `quote` and an `option` are DEMAND, not occupancy. Counting
 * them would report a guesthouse as full on a weekend where nobody has paid
 * anything and half the enquiries will evaporate — and it would do it in the
 * direction that makes an owner turn away a real booking. They are excluded,
 * and they are excluded from the denominator of the cancellation rate too,
 * because an enquiry that goes quiet was never cancelled.
 *
 * `cancelled` and `no_show` are excluded from occupancy and rate: the room was
 * empty. They ARE counted in the cancellation rate, which is the one figure
 * that exists to measure them.
 *
 * Everything from `awaiting_payment` onward counts. That starts earlier than
 * "confirmed" on purpose: from the moment a booking is awaiting payment the
 * unit is held and cannot be sold to anybody else, so for the purpose of "how
 * full am I" the night is gone. A business that wants the stricter question —
 * how much is actually committed — reads the cancellation rate beside it.
 *
 * ══ NIGHTS, NOT DAYS ════════════════════════════════════════════════════════
 *
 * The stay is half-open. A guest arriving Friday and leaving Sunday occupies
 * two nights, not three. Getting this wrong inflates occupancy by one night
 * per booking, which on short stays is a third.
 */

import type { BookingStatusName, RevenueBooking, Window } from './types'

/** Statuses where a unit is held or was used. */
const OCCUPYING: ReadonlySet<BookingStatusName> = new Set([
  'awaiting_payment',
  'deposit_paid',
  'contract_pending',
  'confirmed',
  'pre_arrival',
  'ready_for_check_in',
  'checked_in',
  'in_house',
  'checkout_pending',
  'checked_out',
  'inspection',
  'deposit_release',
  'completed',
  'review_requested',
])

/** Statuses that were a real booking and then were not. */
const LOST: ReadonlySet<BookingStatusName> = new Set(['cancelled', 'no_show'])

/** Statuses that were never a booking at all. */
const DEMAND: ReadonlySet<BookingStatusName> = new Set([
  'inquiry',
  'quote',
  'option',
])

export const isOccupying = (status: BookingStatusName): boolean =>
  OCCUPYING.has(status)

export const isLost = (status: BookingStatusName): boolean => LOST.has(status)

export const isDemand = (status: BookingStatusName): boolean =>
  DEMAND.has(status)

const MS_PER_DAY = 86_400_000

/** Midnight UTC for a `YYYY-MM-DD`, or NaN. Dates here carry no time zone. */
export function dayValue(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

/** Whole nights between two dates. Never negative, never NaN. */
export function nightsBetween(from: string, to: string): number {
  const a = dayValue(from)
  const b = dayValue(to)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.max(0, Math.round((b - a) / MS_PER_DAY))
}

/**
 * Nights of this booking that fall inside the window.
 *
 * A stay that straddles the edge contributes only the part inside, which is
 * what makes a monthly figure add up to the year rather than double-counting
 * every booking that crosses the first of the month.
 */
export function nightsInWindow(
  booking: RevenueBooking,
  window: Window,
): number {
  const start = Math.max(dayValue(booking.checkIn), dayValue(window.from))
  const end = Math.min(dayValue(booking.checkOut), dayValue(window.to))
  if (Number.isNaN(start) || Number.isNaN(end)) return 0
  return Math.max(0, Math.round((end - start) / MS_PER_DAY))
}

/**
 * Revenue attributed to the part of the stay inside the window.
 *
 * Straight-line across the nights, and this is an approximation worth naming:
 * a booking priced higher for its Saturday than its Sunday is spread evenly
 * here. `booking_price_lines.line_date` could do better and the honest reason
 * it is not used yet is that most price lines in this product carry no date.
 * The approximation is exact for any window that contains the whole stay,
 * which is every window a screen actually asks for except the edges.
 */
export function shareInWindow(
  amountAgorot: number,
  booking: RevenueBooking,
  window: Window,
): number {
  const total = nightsBetween(booking.checkIn, booking.checkOut)
  if (total === 0) return 0
  const inside = nightsInWindow(booking, window)
  if (inside === total) return amountAgorot
  return Math.round((amountAgorot * inside) / total)
}

/**
 * Was this row written after the guest had already arrived?
 *
 * Then it was entered by hand after the fact, or imported by the migration
 * module from a business's previous system. Either way the gap between
 * `created_at` and `check_in` is not how far ahead this guest booked, and
 * averaging it in reports a lead time of zero days for a business whose guests
 * actually book two months out. Excluded from pace, and counted so the screen
 * can say how many were excluded.
 */
export function isBackdated(booking: RevenueBooking): boolean {
  const created = Date.parse(booking.createdAt)
  const arrival = dayValue(booking.checkIn)
  if (Number.isNaN(created) || Number.isNaN(arrival)) return true
  return created > arrival + MS_PER_DAY
}

/** Days between the booking being made and the guest arriving. */
export function leadTimeDays(booking: RevenueBooking): number {
  const created = Date.parse(booking.createdAt)
  const arrival = dayValue(booking.checkIn)
  return Math.max(0, Math.round((arrival - created) / MS_PER_DAY))
}
