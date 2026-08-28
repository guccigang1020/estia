/**
 * The Hebrew calendar arithmetic.
 *
 * This is a faithful port of the legacy `hLeap` / `hDelay1` / `hDelay2` /
 * `hElapsed` / `hYearDays` / `hMonthDays` / `hToAbs` / `absToHeb` functions.
 * The numbers are unchanged; only the names, the types and the explanations
 * are new. Where the original had a bare constant, the comment says which rule
 * of the fixed calendar it encodes.
 *
 * The algorithm itself is the standard one (Reingold & Dershowitz,
 * *Calendrical Calculations*): compute the molad — the mean lunar conjunction
 * — of Tishrei, apply the postponement rules, and derive everything else from
 * the gap between one year's Rosh Hashanah and the next.
 *
 * ## How the calendar actually works
 *
 * The Hebrew calendar is lunisolar: months follow the moon, years follow the
 * sun, and the two do not divide. Twelve lunar months fall about eleven days
 * short of a solar year, so a thirteenth month is inserted seven times in
 * every nineteen years — the Metonic cycle, because 235 lunar months are
 * within two hours of 19 solar years.
 *
 * That fixes the *number* of months. The *start* of the year is fixed
 * separately: Rosh Hashanah is set to the day of the molad of Tishrei, then
 * pushed later by up to two days by four postponement rules (`dechiyot`). The
 * postponements are what make the calendar hard, and they are the reason a
 * year can be any of six lengths.
 */

import { fixedToIso, isoToFixed } from './gregorian'
import type {
  FixedDay,
  HebrewDate,
  HebrewMonth,
  HebrewYearKind,
  HebrewYearLength,
  IsoDate,
} from './types'
import { HEBREW_MONTH } from './types'

// ── Constants of the fixed calendar ───────────────────────────────────────

/**
 * The fixed day number of 1 Tishrei AM 1 — the calendar's epoch.
 *
 * Corresponds to the proleptic Gregorian date 7 October 3761 BCE. The legacy
 * code expressed the same thing as the magic number `-1373428` used with a
 * 1-based day, which is this value minus one.
 */
export const HEBREW_EPOCH: FixedDay = -1373427

/** A day is divided into 24 hours of 1080 `chalakim` (parts) each. */
const PARTS_PER_HOUR = 1080
const PARTS_PER_DAY = 24 * PARTS_PER_HOUR // 25920

/** Whole days in the mean lunation, 29d 12h 793p. */
const LUNATION_WHOLE_DAYS = 29

/**
 * The mean lunation with the whole days taken out: 12 × 1080 + 793 parts.
 *
 * This is the fractional remainder that accumulates month by month and
 * eventually rolls the molad over a day boundary.
 */
const LUNATION_REMAINDER_PARTS = 12 * PARTS_PER_HOUR + 793 // 13753

/**
 * The first molad, `BaHaRaD`: Monday, 5 hours and 204 parts.
 *
 * Traditionally reckoned from 6pm, because the halakhic day starts in the
 * evening. Adding those 6 hours converts it to a midnight-based clock:
 * 5h 204p + 6h = 11h 204p = 11 × 1080 + 204 = 12084 parts. The legacy code
 * used the converted figure directly, unexplained.
 *
 * The conversion is not cosmetic. Once the clock starts at midnight, taking
 * `floor(parts / PARTS_PER_DAY)` rolls the day over at what was noon on the
 * evening-based clock — which is precisely the `molad zaken` postponement
 * ("if the molad falls at or after noon, Rosh Hashanah is the next day").
 * That rule is therefore already baked into `moladBasedStart` and never
 * appears as an explicit branch.
 */
const FIRST_MOLAD_PARTS = 11 * PARTS_PER_HOUR + 204 // 12084

/** Months in a common year (12) and a leap year (13). */
const MONTHS_IN_COMMON_YEAR = 12
const MONTHS_IN_LEAP_YEAR = 13

/** Years in the Metonic cycle, and how many of them are leap years. */
export const METONIC_CYCLE_YEARS = 19
export const LEAP_YEARS_PER_CYCLE = 7

/** Months in one Metonic cycle: 12 × 12 + 7 × 13. */
const MONTHS_PER_METONIC_CYCLE = 235

/**
 * The mean Hebrew year as an exact fraction of days.
 *
 * 235 lunations spread over 19 years, in parts:
 * `235 × (29 × 25920 + 13753) / 19 / 25920` days = 179876755 / 492480
 * ≈ 365.2468 days. Kept as a ratio of integers so the year estimate in
 * `fixedToHebrew` involves no floating point at all.
 */
const MEAN_YEAR_DAYS_NUMERATOR =
  MONTHS_PER_METONIC_CYCLE *
  (LUNATION_WHOLE_DAYS * PARTS_PER_DAY + LUNATION_REMAINDER_PARTS) // 179876755
const MEAN_YEAR_DAYS_DENOMINATOR = METONIC_CYCLE_YEARS * PARTS_PER_DAY // 492480

// ── Leap years ────────────────────────────────────────────────────────────

/**
 * Is this a leap year — a year with a thirteenth month, Adar I?
 *
 * The seven leap years of the 19-year cycle are positions 3, 6, 8, 11, 14, 17
 * and 19. `((7y + 1) mod 19) < 7` selects exactly those: it spreads the seven
 * intercalations as evenly as integers allow across the cycle, which is what
 * keeps Pesach in the spring.
 */
export function isHebrewLeapYear(year: number): boolean {
  return (year * LEAP_YEARS_PER_CYCLE + 1) % METONIC_CYCLE_YEARS < 7
}

/** Months in a Hebrew year: 12, or 13 in a leap year. */
export function monthsInHebrewYear(year: number): number {
  return isHebrewLeapYear(year) ? MONTHS_IN_LEAP_YEAR : MONTHS_IN_COMMON_YEAR
}

/**
 * The months of a Hebrew year in the order they are actually lived.
 *
 * Tishrei (7) through Elul (6), with Adar II (13) slotted between Adar I (12)
 * and Nisan (1) in a leap year. Both conversion directions walk this list, so
 * they cannot disagree about month order — which is the single most likely
 * place for a port of this algorithm to go wrong.
 */
export function hebrewMonthsInOrder(year: number): HebrewMonth[] {
  const last = monthsInHebrewYear(year)
  const months: HebrewMonth[] = []
  for (let m = HEBREW_MONTH.tishrei; m <= last; m += 1) {
    months.push(m as HebrewMonth)
  }
  for (let m = 1; m < HEBREW_MONTH.tishrei; m += 1) {
    months.push(m as HebrewMonth)
  }
  return months
}

// ── Rosh Hashanah: the molad and the postponements ────────────────────────

/**
 * Days elapsed from the epoch to the molad of Tishrei of `year`, with the
 * `molad zaken` and `lo ADU rosh` postponements applied.
 *
 * Legacy `hDelay1`. Three steps:
 *
 *  1. **Count the months.** `floor((235y - 234) / 19)` is the number of lunar
 *     months from the epoch to Tishrei of `year`. Written out, it is
 *     `235 × floor((y−1)/19)` whole cycles, plus `12 × ((y−1) mod 19)` regular
 *     months, plus `floor((7 × ((y−1) mod 19) + 1) / 19)` leap months. The
 *     one-line form is the same value and is what the legacy code used.
 *
 *  2. **Accumulate the molad.** 29 whole days per month plus the fractional
 *     remainder, on top of the initial BaHaRaD offset. Because that offset is
 *     on a midnight-based clock, the `floor` here also applies `molad zaken`.
 *
 *  3. **`Lo ADU rosh`.** Rosh Hashanah may not fall on Sunday, Wednesday or
 *     Friday — aleph, dalet, vav, hence *ADU*. (Sunday or Friday would put Yom
 *     Kippur next to Shabbat, giving two consecutive days on which no food may
 *     be prepared; Wednesday would put Hoshana Rabbah on Shabbat.)
 *     `(3 × (day + 1)) mod 7 < 3` is a compact test for exactly those three
 *     weekdays; when it hits, the year starts a day later.
 */
function moladBasedStart(year: number): number {
  const monthsElapsed = Math.floor(
    (MONTHS_PER_METONIC_CYCLE * year - (MONTHS_PER_METONIC_CYCLE - 1)) /
      METONIC_CYCLE_YEARS,
  )
  const partsElapsed =
    FIRST_MOLAD_PARTS + LUNATION_REMAINDER_PARTS * monthsElapsed
  const day =
    monthsElapsed * LUNATION_WHOLE_DAYS +
    Math.floor(partsElapsed / PARTS_PER_DAY)
  // JavaScript's `%` keeps the sign of the dividend, so this test behaves
  // oddly for a negative `day`. That can only happen for year 0, which is
  // reached solely as the `previous` term of `postponementCorrection(1)`
  // — and there the 382-day test comes out the same either way. Public
  // entry points reject anything before AM 1, so the sign never escapes.
  return (3 * (day + 1)) % 7 < 3 ? day + 1 : day
}

/**
 * The remaining two postponements, applied by looking at the neighbouring
 * years.
 *
 * Legacy `hDelay2`. Once `lo ADU rosh` has moved things around, two illegal
 * year lengths can appear. Rather than test the molad directly, the classical
 * trick is to notice them in the gaps and absorb them:
 *
 *  - **`GaTaRaD`** — a common year would come out at 356 days, two more than
 *    any legal length. Start this year two days later, making it 354.
 *  - **`BeTU'TaKaPoT`** — a leap year would come out at 382 days, one short of
 *    the legal 383. Start this year one day later, which makes the *previous*
 *    year 383.
 *
 * Both are detected as a gap between adjacent molad-based starts, which is why
 * this needs the year before and the year after.
 */
function postponementCorrection(year: number): number {
  const previous = moladBasedStart(year - 1)
  const current = moladBasedStart(year)
  const next = moladBasedStart(year + 1)
  if (next - current === 356) return 2 // GaTaRaD
  if (current - previous === 382) return 1 // BeTU'TaKaPoT
  return 0
}

/**
 * Days from the epoch to Rosh Hashanah of `year` — the fully postponed value.
 *
 * Legacy `hElapsed`. Memoised, because `postponementCorrection` calls
 * `moladBasedStart` three times and `hebrewYearLength` calls this twice: an
 * uncached version recomputes the same molad five or six times for every date
 * converted, which over a 200-year sweep is millions of redundant divisions.
 */
const elapsedDaysCache = new Map<number, number>()

function elapsedDays(year: number): number {
  const cached = elapsedDaysCache.get(year)
  if (cached !== undefined) return cached
  const value = moladBasedStart(year) + postponementCorrection(year)
  elapsedDaysCache.set(year, value)
  return value
}

/** The fixed day number of 1 Tishrei of `year` — Rosh Hashanah. */
export function hebrewNewYear(year: number): FixedDay {
  return HEBREW_EPOCH + elapsedDays(year)
}

// ── Year and month lengths ────────────────────────────────────────────────

/**
 * Days in a Hebrew year: one of 353, 354, 355, 383, 384 or 385.
 *
 * Not looked up from a rule — simply the distance to the next Rosh Hashanah.
 * Every legal length falls out of the postponements above, which is the whole
 * elegance of the design.
 */
export function hebrewYearLength(year: number): HebrewYearLength {
  return (elapsedDays(year + 1) - elapsedDays(year)) as HebrewYearLength
}

/**
 * Whether the year is deficient, regular or complete.
 *
 * Read off the last digit of the year length: 3 deficient, 4 regular, 5
 * complete. Leap years share the classification with their common
 * counterparts (383/384/385), which is why the modulo works.
 */
export function hebrewYearKind(year: number): HebrewYearKind {
  const lastDigit = hebrewYearLength(year) % 10
  if (lastDigit === 3) return 'deficient'
  if (lastDigit === 5) return 'complete'
  return 'regular'
}

/**
 * Days in a Hebrew month.
 *
 * Months alternate 30 and 29 days, except for the adjustable ones:
 *
 *  - Iyar, Tammuz, Elul, Tevet and Adar II are always 29.
 *  - Adar is 29 in a common year; in a leap year, Adar I is 30 and Adar II 29.
 *  - **Cheshvan** is 30 only in a complete year (355 or 385 days), else 29.
 *  - **Kislev** is 29 only in a deficient year (353 or 383 days), else 30.
 *  - Everything else — Nisan, Sivan, Av, Tishrei, Shevat — is 30.
 *
 * The two `% 10` tests are the legacy code's, and they work because 355 and
 * 385 both end in 5 while 353 and 383 both end in 3.
 */
export function daysInHebrewMonth(year: number, month: number): number {
  assertMonthExists(year, month)
  if (
    month === HEBREW_MONTH.iyar ||
    month === HEBREW_MONTH.tammuz ||
    month === HEBREW_MONTH.elul ||
    month === HEBREW_MONTH.tevet ||
    month === HEBREW_MONTH.adarII
  ) {
    return 29
  }
  // Adar in a common year. In a leap year this number is Adar I, which has 30.
  if (month === HEBREW_MONTH.adar && !isHebrewLeapYear(year)) return 29
  if (month === HEBREW_MONTH.cheshvan && hebrewYearLength(year) % 10 !== 5) {
    return 29
  }
  if (month === HEBREW_MONTH.kislev && hebrewYearLength(year) % 10 === 3) {
    return 29
  }
  return 30
}

/** Does this month exist in this year? Adar II only does in a leap year. */
export function hebrewMonthExists(year: number, month: number): boolean {
  if (!Number.isInteger(month) || month < 1 || month > MONTHS_IN_LEAP_YEAR) {
    return false
  }
  return month !== HEBREW_MONTH.adarII || isHebrewLeapYear(year)
}

function assertMonthExists(year: number, month: number): void {
  if (!hebrewMonthExists(year, month)) {
    throw new RangeError(
      `Hebrew month ${month} does not exist in year ${year}` +
        (month === HEBREW_MONTH.adarII ? ' (not a leap year).' : '.'),
    )
  }
}

/**
 * The Adar that carries Purim.
 *
 * Adar (12) in a common year, Adar II (13) in a leap year. The legacy code
 * inlined `hLeap(hy) ? 13 : 12` at the Purim entries; naming it stops the next
 * person from reaching for 12 and quietly moving Purim by a month.
 */
export function purimAdar(year: number): HebrewMonth {
  return isHebrewLeapYear(year) ? HEBREW_MONTH.adarII : HEBREW_MONTH.adar
}

// ── Conversion ────────────────────────────────────────────────────────────

/**
 * Hebrew date → fixed day number.
 *
 * Legacy `hToAbs`, restated over `hebrewMonthsInOrder`. The original had two
 * loops because the year turns at Tishrei: a date in Nisan…Elul (1…6) is near
 * the *end* of its Hebrew year and has to count the whole autumn and winter
 * first. Walking the ordered month list expresses the same sum with the
 * ordering stated once, in one place, shared with the inverse.
 */
export function hebrewToFixed(date: HebrewDate): FixedDay {
  const { year, month, day } = date
  if (!Number.isInteger(year) || year < 1) {
    throw new RangeError(`Hebrew year ${year} is out of range (AM 1 onwards).`)
  }
  assertMonthExists(year, month)
  const monthLength = daysInHebrewMonth(year, month)
  if (!Number.isInteger(day) || day < 1 || day > monthLength) {
    throw new RangeError(
      `Day ${day} is out of range for Hebrew month ${month} of ${year} ` +
        `(1…${monthLength}).`,
    )
  }

  let fixed = hebrewNewYear(year) + (day - 1)
  for (const m of hebrewMonthsInOrder(year)) {
    if (m === month) break
    fixed += daysInHebrewMonth(year, m)
  }
  return fixed
}

/**
 * Fixed day number → Hebrew date.
 *
 * Legacy `absToHeb`. The estimate is the day count divided by the mean year;
 * because that is a rational approximation it can land either side of the true
 * year, so both corrections are present. (The legacy version divided by 366 —
 * longer than any Hebrew year, so it could only undershoot — and walked
 * forward only. Same answer; this converges in about one step instead of
 * twelve.)
 */
export function fixedToHebrew(fixed: FixedDay): HebrewDate {
  if (!Number.isInteger(fixed)) {
    throw new RangeError(`Fixed day ${fixed} must be an integer.`)
  }
  if (fixed < HEBREW_EPOCH) {
    throw new RangeError(
      'Dates before the Hebrew epoch (1 Tishrei AM 1) are not supported.',
    )
  }

  let year =
    Math.floor(
      ((fixed - HEBREW_EPOCH) * MEAN_YEAR_DAYS_DENOMINATOR) /
        MEAN_YEAR_DAYS_NUMERATOR,
    ) + 1
  while (year > 1 && hebrewNewYear(year) > fixed) year -= 1
  while (hebrewNewYear(year + 1) <= fixed) year += 1

  let remaining = fixed - hebrewNewYear(year)
  for (const month of hebrewMonthsInOrder(year)) {
    const length = daysInHebrewMonth(year, month)
    if (remaining < length) return { year, month, day: remaining + 1 }
    remaining -= length
  }

  /* c8 ignore next 4 -- unreachable unless the month lengths stop summing to
     the year length, which `arithmetic.test.ts` asserts for every year in a
     200-year sweep. Kept as a loud failure rather than a silent wrong date. */
  throw new Error(
    `Hebrew calendar invariant broken: day ${fixed} fell outside year ${year}.`,
  )
}

// ── Public ISO-facing conversion ──────────────────────────────────────────

/** The Hebrew date in force during the daylight of this civil date. */
export function toHebrewDate(iso: IsoDate): HebrewDate {
  return fixedToHebrew(isoToFixed(iso))
}

/** The civil date on which this Hebrew date's daylight falls. */
export function toIsoDate(date: HebrewDate): IsoDate {
  return fixedToIso(hebrewToFixed(date))
}

/**
 * The civil date on whose *evening* a Hebrew date begins.
 *
 * Always the day before. The Hebrew day runs sunset to sunset, so 15 Nisan —
 * the Seder — begins on the evening of the civil day before the one
 * `toIsoDate` returns. Guesthouses care: the guests arrive that afternoon.
 *
 * This is a calendrical fact and is always true. It is *not* a claim about
 * when any particular observance starts — a minor fast such as 17 Tammuz
 * begins at dawn, not the previous evening — which is why it is a date helper
 * and not a field on `SpecialDay`.
 */
export function hebrewDayBeginsEveningOf(iso: IsoDate): IsoDate {
  return fixedToIso(isoToFixed(iso) - 1)
}

/** The first and last civil dates of a Hebrew year, inclusive. */
export function hebrewYearBounds(year: number): { from: IsoDate; to: IsoDate } {
  return {
    from: fixedToIso(hebrewNewYear(year)),
    to: fixedToIso(hebrewNewYear(year + 1) - 1),
  }
}
