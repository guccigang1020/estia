/**
 * Calendar arithmetic and Hebrew date wording for the booking domain.
 *
 * Two rules are worth stating once here rather than rediscovering in four
 * files:
 *
 *   1. **A stay date is a calendar date, not an instant.** `2026-09-03` is the
 *      third of September at the property, whatever the server's clock is set
 *      to. So every operation below is done in UTC on a date-only string and
 *      never through the local `Date` constructor, which would shift a booking
 *      by a day for anyone whose machine sits west of Greenwich.
 *
 *   2. **"Today" is a question about the property, not about UTC.** At 22:30
 *      UTC it is already tomorrow in Israel, and a no-show recorded then must
 *      not be judged against yesterday's arrival date. `localDate` is the one
 *      place that conversion happens.
 */

import type { DateRange } from './types'

/**
 * Where the properties are.
 *
 * Israel today, and a per-property field eventually — a customer with a unit
 * in Cyprus is a plausible year-two request. This constant is the single place
 * that change lands, which is why the timezone is not spelled inline at the
 * three call sites that need it.
 */
export const PROPERTY_TIME_ZONE = 'Asia/Jerusalem'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Parse `YYYY-MM-DD` into a UTC midnight `Date`, or `null`.
 *
 * The round trip at the end is the part that matters: `Date.parse` accepts
 * `2026-02-30` on some runtimes and rolls it into March, which would silently
 * turn an impossible arrival date into a real one.
 */
export function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null
  const time = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(time)) return null
  const date = new Date(time)
  return date.toISOString().slice(0, 10) === value ? date : null
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && parseIsoDate(value) !== null
}

export function addDays(value: string, days: number): string {
  const date = parseIsoDate(value)
  if (!date) throw new RangeError(`Not an ISO date: ${value}`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** The calendar date at the property for a given instant. */
export function localDate(now: Date, timeZone = PROPERTY_TIME_ZONE): string {
  // en-CA renders as YYYY-MM-DD, which is the format the whole domain speaks.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/**
 * Every night a stay occupies: `[checkIn, checkOut)`.
 *
 * The check-out date is not in the list, and that is the whole half-open
 * convention in one function. Availability, pricing and the calendar all count
 * nights through here so that none of them can disagree about whether the
 * departure day is occupied.
 */
export function eachNight(range: DateRange): string[] {
  const nights: string[] = []
  if (!isIsoDate(range.checkIn) || !isIsoDate(range.checkOut)) return nights

  let cursor = range.checkIn
  // Bounded by the comparison, not by a count, so a reversed range yields an
  // empty list rather than looping.
  while (cursor < range.checkOut) {
    nights.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return nights
}

// ── Hebrew wording ────────────────────────────────────────────────────────

/** `2026-09-03` → `3.9`. The form a manager writes on a whiteboard. */
export function formatDayMonth(value: string): string {
  const date = parseIsoDate(value)
  if (!date) return value
  return `${date.getUTCDate()}.${date.getUTCMonth() + 1}`
}

/** `2026-09-03` → `3.9.2026`. For a sentence that outlives the season. */
export function formatDayMonthYear(value: string): string {
  const date = parseIsoDate(value)
  if (!date) return value
  return `${formatDayMonth(value)}.${date.getUTCFullYear()}`
}

/** `3.9–5.9`. An en dash, because a hyphen reads as part of the number. */
export function formatRange(range: DateRange): string {
  return `${formatDayMonth(range.checkIn)}–${formatDayMonth(range.checkOut)}`
}

/**
 * The clause an audit sentence needs: what actually moved.
 *
 * When one end of the stay moved, naming both ends twice makes the reader work
 * out the difference for themselves — so a moved arrival reads
 * "מ-3.9 ל-5.9" and only a change to both ends spells out both ranges.
 */
export function describeDateChange(
  before: DateRange,
  after: DateRange,
): string {
  const checkInMoved = before.checkIn !== after.checkIn
  const checkOutMoved = before.checkOut !== after.checkOut

  if (checkInMoved && !checkOutMoved) {
    return `מ-${formatDayMonth(before.checkIn)} ל-${formatDayMonth(after.checkIn)}`
  }
  if (checkOutMoved && !checkInMoved) {
    return `מ-${formatDayMonth(before.checkOut)} ל-${formatDayMonth(after.checkOut)}`
  }
  return `מ-${formatRange(before)} ל-${formatRange(after)}`
}
