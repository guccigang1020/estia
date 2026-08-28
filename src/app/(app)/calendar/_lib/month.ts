/**
 * The month a calendar screen is looking at, and what the Hebrew calendar has
 * to say about each of its days.
 *
 * PURE, AND THEREFORE TESTED. Nothing here reads a cookie, a database or a
 * clock. The month is a `YYYY-MM` string in the query string, the days are
 * derived from it, and the Hebrew decoration comes from
 * `src/lib/hebrew-calendar` — which is complete, proven by 236 tests, and was
 * until now imported by nothing.
 *
 * ONE THING IS DELIBERATELY ABSENT. `shabbatWindow` returns `candleLighting:
 * null` and `havdalah: null` by design: those are astronomical events that need
 * the property's latitude and a solar calculation, and the module says so in
 * `SHABBAT_TIMES_UNAVAILABLE`. No time is invented here. The calendar marks
 * *which* day is Shabbat, which is a fact a date alone can settle, and states
 * the limitation where a reader would otherwise expect a time.
 *
 * HALF-OPEN, LIKE EVERYTHING ELSE. A month is `[first, firstOfNextMonth)` and
 * its days are `eachNight` of that range — the same function the availability
 * engine and the pricing engine count nights with, so none of the three can
 * disagree about how many nights September has.
 */

import { eachNight, isIsoDate } from '@/lib/booking/dates'
import type { DateRange } from '@/lib/booking/types'
import {
  formatHebrewDate,
  formatHebrewDayOfMonth,
  hebrewMonthName,
  isErevShabbat,
  isPeakNight,
  isShabbat,
  specialDayOn,
  specialDaysBetween,
  toHebrewDate,
  toHebrewYearNumeral,
  type SpecialDay,
} from '@/lib/hebrew-calendar'

/* ------------------------------------------------------------ month keys -- */

/** `YYYY-MM`. The one form a month travels in, query string included. */
export type MonthKey = string

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * The months the calendar will draw.
 *
 * A bound is needed, not merely tidy. `monthRange` needs the *first of the
 * following* month, and ISO dates in this domain are four-digit years — so
 * `?month=9999-12` asks for `10000-01-01`, which `eachNight` correctly refuses,
 * leaving the grid with no days and the page throwing on a query parameter a
 * stranger chose. Bounding the input is the fix; widening the date format to
 * five digits to satisfy a URL nobody meant is not.
 *
 * The window is deliberately far wider than a guesthouse's diary, so no real
 * use is refused, and it is stated rather than implied.
 */
export const MONTH_MIN: MonthKey = '1900-01'
export const MONTH_MAX: MonthKey = '2999-12'

/**
 * A month key from untrusted input, or `null`.
 *
 * Deny by default, exactly as everywhere else a value arrives from a browser:
 * `?month=2026-13`, `?month=drop-table` and `?month=9999-12` all resolve to
 * `null`, and the caller falls back to the current month rather than rendering
 * a range the calendar cannot compute.
 */
export function parseMonthKey(
  value: string | null | undefined,
): MonthKey | null {
  if (typeof value !== 'string' || !MONTH_KEY.test(value)) return null
  if (value < MONTH_MIN || value > MONTH_MAX) return null
  return isIsoDate(`${value}-01`) ? value : null
}

/** The month an ISO date falls in. */
export function monthKeyOf(iso: string): MonthKey {
  return iso.slice(0, 7)
}

/**
 * `delta` months later, or earlier.
 *
 * Done on the numbers rather than by adding days, because "one month later"
 * is not a fixed number of days and stepping through 31 of them from the 31st
 * of a month lands in the wrong place.
 */
export function shiftMonth(key: MonthKey, delta: number): MonthKey {
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5, 7))
  const zeroBased = year * 12 + (month - 1) + delta
  const shiftedYear = Math.floor(zeroBased / 12)
  const shiftedMonth = zeroBased - shiftedYear * 12 + 1
  return `${String(shiftedYear).padStart(4, '0')}-${String(shiftedMonth).padStart(2, '0')}`
}

/** The month as a half-open range: `[first, firstOfNextMonth)`. */
export function monthRange(key: MonthKey): DateRange {
  return { checkIn: `${key}-01`, checkOut: `${shiftMonth(key, 1)}-01` }
}

/**
 * `delta` months away, or `null` when that is outside the drawable window.
 *
 * What the month arrows are built from, so the calendar never offers a link to
 * a month it would then refuse and silently redraw as today.
 */
export function shiftMonthWithin(
  key: MonthKey,
  delta: number,
): MonthKey | null {
  return parseMonthKey(shiftMonth(key, delta))
}

/* --------------------------------------------------------------- wording -- */

const GREGORIAN_MONTHS = [
  'ינואר',
  'פברואר',
  'מרץ',
  'אפריל',
  'מאי',
  'יוני',
  'יולי',
  'אוגוסט',
  'ספטמבר',
  'אוקטובר',
  'נובמבר',
  'דצמבר',
] as const

/** `2026-09` → `ספטמבר 2026`. */
export function monthLabel(key: MonthKey): string {
  const month = GREGORIAN_MONTHS[Number(key.slice(5, 7)) - 1]
  return `${month} ${key.slice(0, 4)}`
}

/**
 * The Hebrew months the civil month straddles, e.g. `אלול–תשרי תשפ״ז`.
 *
 * A civil month almost always spans two Hebrew ones, and a manager who thinks
 * in חגים needs to see which. Built from the calendar module's own naming, so
 * Adar I and Adar II are distinguished in a leap year without this file
 * knowing that leap years exist.
 */
export function hebrewMonthSpan(key: MonthKey): string {
  const days = eachNight(monthRange(key))
  const first = toHebrewDate(days[0])
  const last = toHebrewDate(days[days.length - 1])

  const firstName = hebrewMonthName(first.year, first.month)
  const lastName = hebrewMonthName(last.year, last.month)
  const lastYear = toHebrewYearNumeral(last.year)

  if (first.year === last.year && first.month === last.month) {
    return `${firstName} ${lastYear}`
  }
  if (first.year === last.year) {
    return `${firstName}–${lastName} ${lastYear}`
  }
  return `${firstName} ${toHebrewYearNumeral(first.year)} – ${lastName} ${lastYear}`
}

/** Sunday first, matching `dayOfWeek`. Shabbat is named, the rest are ordinals. */
const WEEKDAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'] as const

/* ------------------------------------------------------------------ days -- */

/**
 * One column of the month grid.
 *
 * Everything a header cell needs, resolved once, so the grid component holds
 * no calendar logic at all and can be read as layout.
 */
export interface CalendarDay {
  /** `YYYY-MM-DD`. The night, not the check-out day. */
  date: string
  dayOfMonth: number
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number
  /** `א`…`ש`. */
  weekdayLetter: string
  /** The Hebrew day of the month, e.g. `ט״ו`. */
  hebrewDay: string
  /** The full Hebrew date, e.g. `ט״ו ניסן תשפ״ו`. For the cell's title. */
  hebrewFull: string
  shabbat: boolean
  erevShabbat: boolean
  /** The one special day this cell should show, precedence resolved, or `null`. */
  special: SpecialDay | null
  /** Shabbat, yom tov or chol hamoed — the nights that carry a premium. */
  peak: boolean
}

/** Every night of the month, in order, with its Hebrew decoration. */
export function buildMonthDays(key: MonthKey): CalendarDay[] {
  return eachNight(monthRange(key)).map((date) => {
    // UTC throughout: a calendar date is not an instant, and the local `Date`
    // constructor would shift the whole month for anyone west of Greenwich.
    const parsed = new Date(`${date}T00:00:00Z`)
    const weekday = parsed.getUTCDay()

    return {
      date,
      dayOfMonth: parsed.getUTCDate(),
      weekday,
      weekdayLetter: WEEKDAY_LETTERS[weekday],
      hebrewDay: formatHebrewDayOfMonth(date),
      hebrewFull: formatHebrewDate(date),
      shabbat: isShabbat(date),
      erevShabbat: isErevShabbat(date),
      special: specialDayOn(date),
      peak: isPeakNight(date),
    }
  })
}

/**
 * The month's special days, in date order.
 *
 * `specialDaysBetween` is inclusive of both ends, and both ends here are
 * nights of the month, so the last day of the month is included and the first
 * of the next is not.
 */
export function monthSpecialDays(key: MonthKey): SpecialDay[] {
  const days = eachNight(monthRange(key))
  return specialDaysBetween(days[0], days[days.length - 1])
}
