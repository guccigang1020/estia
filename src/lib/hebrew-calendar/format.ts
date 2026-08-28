/**
 * Rendering Hebrew dates in Hebrew.
 *
 * Ported from the legacy `HMN` table and the `hMonthName` / `hebDay` /
 * `hebFull` functions. The month names are the legacy strings verbatim,
 * including the `׳` on `אדר א׳` and `אדר ב׳`, because those are what has been
 * on the guesthouse's screens for years and changing them would be a visible
 * change nobody asked for.
 */

import { isHebrewLeapYear, toHebrewDate } from './arithmetic'
import { toGematria, toHebrewYearNumeral } from './gematria'
import type { HebrewDate, IsoDate } from './types'
import { HEBREW_MONTH } from './types'

/**
 * Month names indexed by month number, Nisan = 1.
 *
 * Index 12 is `אדר`, which is only right in a common year — in a leap year it
 * is Adar I. `hebrewMonthName` handles that; do not read this table directly.
 */
const MONTH_NAMES = [
  '',
  'ניסן',
  'אייר',
  'סיון',
  'תמוז',
  'אב',
  'אלול',
  'תשרי',
  'חשון',
  'כסלו',
  'טבת',
  'שבט',
  'אדר',
  'אדר ב׳',
] as const

/** The Hebrew month name, disambiguating Adar in a leap year. */
export function hebrewMonthName(year: number, month: number): string {
  if (month === HEBREW_MONTH.adar && isHebrewLeapYear(year)) return 'אדר א׳'
  const name = MONTH_NAMES[month]
  if (!name) {
    throw new RangeError(`No Hebrew name for month ${month}.`)
  }
  return name
}

/** Options for `formatHebrewDate`. */
export interface HebrewDateFormatOptions {
  /**
   * Write the year as the formal `ה׳תשפ״ו` rather than the everyday `תשפ״ו`.
   * Off by default, matching the legacy output.
   */
  includeMillennium?: boolean
  /**
   * Prefix the month with `ב` — `ט״ו בניסן` rather than `ט״ו ניסן`.
   *
   * Both are correct Hebrew and both are in common use. The legacy product
   * omitted it, so it is off by default; documents and certificates usually
   * want it on.
   */
  monthPrefix?: boolean
  /** Leave the year off entirely: `ט״ו ניסן`. */
  omitYear?: boolean
}

/** Format a Hebrew date in Hebrew, e.g. `ט״ו ניסן תשפ״ו`. */
export function formatHebrewDateParts(
  date: HebrewDate,
  options: HebrewDateFormatOptions = {},
): string {
  const day = toGematria(date.day)
  const monthName = hebrewMonthName(date.year, date.month)
  const month = options.monthPrefix ? `ב${monthName}` : monthName
  if (options.omitYear) return `${day} ${month}`
  const year = toHebrewYearNumeral(date.year, {
    includeMillennium: options.includeMillennium,
  })
  return `${day} ${month} ${year}`
}

/**
 * Format the Hebrew date of a civil date, e.g. `ט״ו ניסן תשפ״ו`.
 *
 * The legacy `hebFull`, with the year form and the `ב` prefix made optional.
 */
export function formatHebrewDate(
  iso: IsoDate,
  options: HebrewDateFormatOptions = {},
): string {
  return formatHebrewDateParts(toHebrewDate(iso), options)
}

/**
 * Just the day of the month in Hebrew numerals, e.g. `ט״ו`.
 *
 * The legacy `hebDay`. This is what goes in the corner of a calendar cell
 * beside the Gregorian number.
 */
export function formatHebrewDayOfMonth(iso: IsoDate): string {
  return toGematria(toHebrewDate(iso).day)
}

/** Hebrew weekday names, indexed 0 = Sunday, matching `dayOfWeek`. */
const WEEKDAY_NAMES = [
  'ראשון',
  'שני',
  'שלישי',
  'רביעי',
  'חמישי',
  'שישי',
  'שבת',
] as const

/**
 * The Hebrew weekday name.
 *
 * Six of the seven are ordinals — "day one", "day two" — and only Shabbat has
 * a name of its own, so `יום שבת` is wrong and the seventh entry is returned
 * bare. Not in the legacy code; added because a calendar that prints Hebrew
 * dates and English weekdays looks unfinished.
 */
export function hebrewWeekdayName(dayIndex: number): string {
  const name = WEEKDAY_NAMES[dayIndex]
  if (!name) {
    throw new RangeError(`No Hebrew name for weekday ${dayIndex}.`)
  }
  return dayIndex === 6 ? name : `יום ${name}`
}
