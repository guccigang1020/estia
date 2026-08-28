/**
 * The Hebrew calendar.
 *
 * Ported from the frozen legacy product (`_reference/estia_live.html`), which
 * has priced and staffed a real Israeli guesthouse for years. The arithmetic
 * is the same arithmetic; the types, the names, the explanations, the
 * per-year holiday table and the proof are new.
 *
 * ```ts
 * import { toHebrewDate, formatHebrewDate, summarizeStay }
 *   from '@/lib/hebrew-calendar'
 *
 * toHebrewDate('2026-04-02')      // { year: 5786, month: 1, day: 15 }
 * formatHebrewDate('2026-04-02')  // 'ט״ו ניסן תשפ״ו'
 * summarizeStay({ checkIn: '2026-04-01', checkOut: '2026-04-06' })
 * ```
 *
 * ## Two things to know before using it
 *
 * **The festival set is Israeli, not diaspora.** One day of yom tov, so
 * Shemini Atzeret and Simchat Torah are the same day and chol hamoed Pesach
 * runs 16–20 Nisan. Correct for the product; wrong anywhere else.
 *
 * **Shabbat times are not computed and are not faked.** Candle lighting and
 * havdalah need a location and a solar calculation. This module gives the day
 * boundary and says so — see `SHABBAT_TIMES_UNAVAILABLE` in `./shabbat`.
 */

export type {
  DayOfWeek,
  FixedDay,
  HebrewDate,
  HebrewMonth,
  HebrewYearKind,
  HebrewYearLength,
  IsoDate,
  SpecialDay,
  SpecialDayKind,
  StayRange,
} from './types'
export {
  HEBREW_MONTH,
  HEBREW_YEAR_LENGTHS,
  SPECIAL_DAY_PRECEDENCE,
} from './types'

export {
  HEBREW_EPOCH,
  LEAP_YEARS_PER_CYCLE,
  METONIC_CYCLE_YEARS,
  daysInHebrewMonth,
  fixedToHebrew,
  hebrewDayBeginsEveningOf,
  hebrewMonthExists,
  hebrewMonthsInOrder,
  hebrewNewYear,
  hebrewToFixed,
  hebrewYearBounds,
  hebrewYearKind,
  hebrewYearLength,
  isHebrewLeapYear,
  monthsInHebrewYear,
  purimAdar,
  toHebrewDate,
  toIsoDate,
} from './arithmetic'

export {
  RD_AT_UNIX_EPOCH,
  addDays,
  dayOfWeek,
  daysBetween,
  fixedDayOfWeek,
  fixedToIso,
  isGregorianLeapYear,
  isoToFixed,
} from './gregorian'

export { MAX_GEMATRIA, toGematria, toHebrewYearNumeral } from './gematria'

export type { HebrewDateFormatOptions } from './format'
export {
  formatHebrewDate,
  formatHebrewDateParts,
  formatHebrewDayOfMonth,
  hebrewMonthName,
  hebrewWeekdayName,
} from './format'

export type { ShabbatWindow } from './shabbat'
export {
  SHABBAT_TIMES_UNAVAILABLE,
  SHABBAT_TIMES_UNAVAILABLE_EN,
  isErevShabbat,
  isShabbat,
  shabbatDatesBetween,
  shabbatWindow,
} from './shabbat'

export type { BeinHazmanimPeriod } from './special-days'
export {
  beinHazmanimPeriods,
  hebrewYearSpecialDays,
  hebrewYearsSpanning,
  isBeinHazmanim,
  isCholHaMoed,
  isYomTov,
  roshHashanahDate,
  specialDayOn,
  specialDaysBetween,
  specialDaysOn,
} from './special-days'

export type { RangeCalendarSummary } from './range'
export {
  isPeakNight,
  shabbatNightsInStay,
  specialDaysInStay,
  summarizeStay,
} from './range'
