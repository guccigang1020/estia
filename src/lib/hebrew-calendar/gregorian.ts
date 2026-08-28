/**
 * Civil-date plumbing: ISO strings ↔ fixed day numbers.
 *
 * Everything in the Hebrew calendar is arithmetic on a day count, so this file
 * exists to get in and out of that day count exactly once, correctly.
 *
 * **Deliberate deviation from the legacy code.** The original used
 * `Date.UTC(...)` to reach a day number and `new Date(ms)` to come back, and
 * read the components off a `Date` built in *local* time. That mixture works
 * until it does not: a `Date` built locally and read as UTC is off by a day
 * either side of midnight in some zones, and an Israeli guesthouse server is
 * not guaranteed to be in Israel. The arithmetic below is pure integer maths
 * with no `Date` anywhere, so there is no time zone to get wrong.
 */

import type { DayOfWeek, FixedDay, IsoDate } from './types'

/**
 * The fixed day number of 1970-01-01.
 *
 * Rata Die counts from 0001-01-01 = RD 1, and this is the offset between that
 * and the Unix epoch. The legacy code carried the same constant, unnamed.
 */
export const RD_AT_UNIX_EPOCH = 719163

/** Internal: the shift used by the era-based civil↔days algorithm. */
const ERA_SHIFT = 719468

const ISO_DATE_PATTERN = /^(-?\d{4,6})-(\d{2})-(\d{2})$/

/** Is this Gregorian year a leap year? */
export function isGregorianLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/**
 * Convert a Gregorian calendar date to its fixed day number.
 *
 * This is Howard Hinnant's `days_from_civil`, shifted from the Unix epoch to
 * Rata Die. It is branch-light, exact for every year, and — unlike anything
 * built on `Date` — has no two-digit-year special case waiting to bite.
 *
 * The shape of it: shift the year so that March starts it, which puts the leap
 * day at the *end* where it stops disturbing month lengths; count whole
 * 400-year eras, which are exactly 146097 days each; then count days within
 * the era.
 */
export function gregorianToFixed(
  year: number,
  month: number,
  day: number,
): FixedDay {
  // March-based year: January and February belong to the previous one.
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yearOfEra = y - era * 400 // 0…399
  // Day of the March-based year, 0…365.
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  // Day of the 400-year era, 0…146096.
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear
  return era * 146097 + dayOfEra - ERA_SHIFT + RD_AT_UNIX_EPOCH
}

/** Convert a fixed day number back to a Gregorian calendar date. */
export function fixedToGregorian(fixed: FixedDay): {
  year: number
  month: number
  day: number
} {
  const z = fixed - RD_AT_UNIX_EPOCH + ERA_SHIFT
  const era = Math.floor(z / 146097)
  const dayOfEra = z - era * 146097 // 0…146096
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  ) // 0…399
  const y = yearOfEra + era * 400
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100)) // 0…365
  // Undo the March-based shift.
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153) // 0…11
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1
  const month = monthPrime + (monthPrime < 10 ? 3 : -9)
  return { year: month <= 2 ? y + 1 : y, month, day }
}

function pad(value: number, width: number): string {
  return String(Math.abs(value)).padStart(width, '0')
}

/** Render a Gregorian calendar date as `YYYY-MM-DD`. */
export function formatIsoDate(
  year: number,
  month: number,
  day: number,
): IsoDate {
  const sign = year < 0 ? '-' : ''
  return `${sign}${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

/**
 * Parse `YYYY-MM-DD` into a fixed day number.
 *
 * Strict on purpose. A calendar that silently accepts `2026-02-30` and answers
 * with 2 March has turned a typo into a wrong Hebrew date, a wrong nightly
 * rate and a staffing rota nobody can explain. Round-tripping the parsed
 * components back out is the cheapest possible way to reject an impossible
 * day, and it also rejects the `Date`-style rollover the legacy code inherited.
 */
export function isoToFixed(iso: IsoDate): FixedDay {
  const match = ISO_DATE_PATTERN.exec(iso)
  if (!match) {
    throw new RangeError(
      `Invalid ISO date ${JSON.stringify(iso)}: expected YYYY-MM-DD.`,
    )
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError(`Invalid ISO date ${JSON.stringify(iso)}.`)
  }
  const fixed = gregorianToFixed(year, month, day)
  const back = fixedToGregorian(fixed)
  if (back.year !== year || back.month !== month || back.day !== day) {
    throw new RangeError(
      `Invalid ISO date ${JSON.stringify(iso)}: no such day in that month.`,
    )
  }
  return fixed
}

/** Render a fixed day number as `YYYY-MM-DD`. */
export function fixedToIso(fixed: FixedDay): IsoDate {
  const { year, month, day } = fixedToGregorian(fixed)
  return formatIsoDate(year, month, day)
}

/**
 * Day of week, 0 = Sunday.
 *
 * RD 1 (0001-01-01) was a Monday, so `fixed % 7` gives 1 for Monday and 0 for
 * Sunday with no offset needed. The double modulo keeps it right for the
 * negative fixed days that proleptic dates produce.
 */
export function fixedDayOfWeek(fixed: FixedDay): DayOfWeek {
  return (((fixed % 7) + 7) % 7) as DayOfWeek
}

/** Day of week of a civil date, 0 = Sunday. */
export function dayOfWeek(iso: IsoDate): DayOfWeek {
  return fixedDayOfWeek(isoToFixed(iso))
}

/** The ISO date `offset` days after `iso` (negative offsets go backwards). */
export function addDays(iso: IsoDate, offset: number): IsoDate {
  return fixedToIso(isoToFixed(iso) + offset)
}

/** Whole days from `from` to `to`; negative if `to` precedes `from`. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return isoToFixed(to) - isoToFixed(from)
}
