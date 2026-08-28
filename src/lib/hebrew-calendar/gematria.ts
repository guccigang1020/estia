/**
 * Hebrew numerals (gematria).
 *
 * Hebrew has no digits; numbers are written with letters, largest first, and
 * marked as numerals rather than words by a `geresh` (׳) on a single letter or
 * a `gershayim` (״) before the last letter of several. So 15 Nisan 5786 is
 * written `ט״ו ניסן תשפ״ו`, and an Israeli guest reading `15/4` on a booking
 * confirmation would find it faintly foreign.
 *
 * Ported from the legacy `G1` / `G10` / `G100` tables and `gem` function.
 * Two changes, both deliberate:
 *
 *  1. **The legacy `gem` was silently wrong above 999.** It indexed a
 *     ten-entry hundreds table with `floor(n / 100)`, so any n ≥ 1000 read off
 *     the end and produced `undefined…`. It was never hit because the only
 *     caller passed `year % 1000`. Here the valid range is stated and enforced,
 *     and thousands are handled properly by `toHebrewYearNumeral`.
 *
 *  2. **`gem(0)` returned the empty string.** Same cause: it is unreachable
 *     for days 1–30, but it would have made Hebrew year 6000 render with no
 *     year at all. Zero is now rejected.
 */

/**
 * Units 1–9: alef … tet.
 *
 * Index 0 is an empty slot so the tables can be indexed by digit directly.
 */
const UNITS = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'] as const

/** Tens 10–90: yud … tsadi. */
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'] as const

/**
 * Hundreds 100–900: kuf, resh, shin, tav, then tav-plus-the-rest.
 *
 * The alphabet runs out at 400 (tav), so 500–900 are written as tav followed
 * by the remainder: 500 = תק, 900 = תתק.
 */
const HUNDREDS = [
  '',
  'ק',
  'ר',
  'ש',
  'ת',
  'תק',
  'תר',
  'תש',
  'תת',
  'תתק',
] as const

const GERESH = '׳'
const GERSHAYIM = '״'

/** The largest number `toGematria` will render. */
export const MAX_GEMATRIA = 999

/**
 * Write a number 1–999 in Hebrew numerals, with geresh or gershayim.
 *
 * The two special cases are not decoration. 15 would naturally be yud-he and
 * 16 yud-vav, both of which spell forms of the Divine Name, so they are
 * conventionally written tet-vav (טו) and tet-zayin (טז) instead. Getting this
 * wrong is not a rounding error to a Hebrew reader.
 */
export function toGematria(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > MAX_GEMATRIA) {
    throw new RangeError(
      `Cannot write ${value} as a Hebrew numeral: expected 1…${MAX_GEMATRIA}.`,
    )
  }

  let letters = HUNDREDS[Math.floor(value / 100)]
  const remainder = value % 100
  if (remainder === 15) {
    letters += 'טו' // not יה — avoids spelling the Divine Name
  } else if (remainder === 16) {
    letters += 'טז' // not יו — same reason
  } else {
    letters += TENS[Math.floor(remainder / 10)] + UNITS[remainder % 10]
  }

  // A lone letter takes a geresh; several take a gershayim before the last.
  if (letters.length === 1) return letters + GERESH
  return letters.slice(0, -1) + GERSHAYIM + letters.slice(-1)
}

/**
 * Write a Hebrew year in numerals.
 *
 * Israeli usage almost always drops the millennium — 5786 is written `תשפ״ו`,
 * the way English writes '86. That short form is the default because it is
 * what the legacy product printed and what a guest expects to see. Pass
 * `{ includeMillennium: true }` for the formal `ה׳תשפ״ו` used on documents.
 */
export function toHebrewYearNumeral(
  year: number,
  options: { includeMillennium?: boolean } = {},
): string {
  if (!Number.isInteger(year) || year < 1) {
    throw new RangeError(`Hebrew year ${year} is out of range (AM 1 onwards).`)
  }
  const millennium = Math.floor(year / 1000)
  const withinMillennium = year % 1000

  // Years before AM 1000 have no millennium letter to write.
  if (millennium === 0) return toGematria(withinMillennium)

  const millenniumPart = toGematria(millennium)
  if (withinMillennium === 0) {
    // Year 6000 and its multiples have no remainder to write, so the short
    // form does not exist and the millennium is returned on its own. The
    // legacy code returned an empty string here.
    return millenniumPart
  }
  const shortPart = toGematria(withinMillennium)
  return options.includeMillennium ? millenniumPart + shortPart : shortPart
}
