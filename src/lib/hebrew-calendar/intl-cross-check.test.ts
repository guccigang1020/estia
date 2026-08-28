/**
 * Cross-check against the runtime's own Hebrew calendar.
 *
 * `Intl.DateTimeFormat` with `calendar: 'hebrew'` is ICU's implementation:
 * written by different people, in C++, from the same published rules. It is
 * the closest thing available to a second opinion, and it costs nothing to
 * ask. Running the whole 200-year sweep through it turns "the legacy code has
 * worked for years" into "two independent implementations agree on 73,414
 * consecutive days".
 *
 * ## Result
 *
 * **Complete agreement on year, month and day for every date in the sweep.**
 * No disagreement was found, so nothing here is skipped, tolerated or
 * explained away. If this test ever goes red, the disagreement is the finding:
 * investigate before assuming either side is wrong.
 *
 * ## Two things the comparison has to normalise, neither of them a difference
 * of opinion about dates
 *
 * 1. **Month identity is compared by name, not by number.** ICU numbers months
 *    from Tishri and reserves a slot for Adar I even in common years; this
 *    module numbers from Nisan, the biblical order the legacy code used.
 *    Comparing numbers would compare two different conventions. English month
 *    names are unambiguous in both and are what is matched — including ICU's
 *    distinction between `Adar` (common year), `Adar I` and `Adar II`, which
 *    is exactly the distinction that matters.
 *
 * 2. **Dates are formatted at midday UTC.** `Intl` formats an instant, not a
 *    date, so midnight plus a time zone can land on the previous day. Midday
 *    with an explicit `timeZone: 'UTC'` removes both hazards. This is a
 *    property of the comparison harness, not of the calendar.
 */

import { describe, expect, it } from 'vitest'

import { fixedToHebrew, isHebrewLeapYear } from './arithmetic'
import { fixedToIso, isoToFixed } from './gregorian'
import { HEBREW_MONTH } from './types'
import type { HebrewMonth } from './types'

const SWEEP_FROM = '1900-01-01'
const SWEEP_TO = '2100-12-31'

const formatter = new Intl.DateTimeFormat('en-u-ca-hebrew', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
})

/**
 * ICU's English month names, mapped onto this module's month numbers.
 *
 * `Adar` and `Adar I` both map to 12: ICU uses the plain name in a common year
 * and the numbered one in a leap year, and 12 is this module's number for
 * both. The leap-year distinction is not lost — `Adar II` is a separate entry
 * — and a leap-year-specific assertion below pins it down.
 */
const ICU_MONTH_NUMBERS: Record<string, HebrewMonth> = {
  Nisan: HEBREW_MONTH.nisan,
  Iyar: HEBREW_MONTH.iyar,
  Sivan: HEBREW_MONTH.sivan,
  Tamuz: HEBREW_MONTH.tammuz,
  Av: HEBREW_MONTH.av,
  Elul: HEBREW_MONTH.elul,
  Tishri: HEBREW_MONTH.tishrei,
  Heshvan: HEBREW_MONTH.cheshvan,
  Kislev: HEBREW_MONTH.kislev,
  Tevet: HEBREW_MONTH.tevet,
  Shevat: HEBREW_MONTH.shevat,
  Adar: HEBREW_MONTH.adar,
  'Adar I': HEBREW_MONTH.adar,
  'Adar II': HEBREW_MONTH.adarII,
}

interface IcuHebrewDate {
  year: number
  monthName: string
  day: number
}

function icuHebrewDate(fixed: number): IcuHebrewDate {
  const iso = fixedToIso(fixed)
  const parts = formatter.formatToParts(new Date(`${iso}T12:00:00Z`))
  const read = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return {
    year: Number(read('year')),
    monthName: read('month'),
    day: Number(read('day')),
  }
}

describe('the runtime provides an independent Hebrew calendar to check against', () => {
  it('has ICU data for the hebrew calendar', () => {
    const sample = icuHebrewDate(isoToFixed('2024-10-03'))
    expect(sample).toEqual({ year: 5785, monthName: 'Tishri', day: 1 })
  })

  it('uses every month name the mapping table claims to know', () => {
    // Guards the table itself: if a future ICU renames a month, this fails
    // loudly here rather than silently mismatching one month for 200 years.
    const seen = new Set<string>()
    for (
      let fixed = isoToFixed('2024-01-01');
      fixed <= isoToFixed('2027-12-31');
      fixed += 1
    ) {
      seen.add(icuHebrewDate(fixed).monthName)
    }
    expect([...seen].sort()).toEqual(Object.keys(ICU_MONTH_NUMBERS).sort())
  })
})

describe('cross-check against Intl over the full 200-year sweep', () => {
  it('agrees on the Hebrew date for all 73,414 days', () => {
    const first = isoToFixed(SWEEP_FROM)
    const last = isoToFixed(SWEEP_TO)
    const disagreements: string[] = []
    let compared = 0

    for (let fixed = first; fixed <= last; fixed += 1) {
      const ours = fixedToHebrew(fixed)
      const theirs = icuHebrewDate(fixed)
      const theirMonth = ICU_MONTH_NUMBERS[theirs.monthName]

      if (
        ours.year !== theirs.year ||
        ours.day !== theirs.day ||
        ours.month !== theirMonth
      ) {
        disagreements.push(
          `${fixedToIso(fixed)}: ours ${ours.year}-${ours.month}-${ours.day}, ` +
            `ICU ${theirs.year}-${theirs.monthName}-${theirs.day}`,
        )
      }
      compared += 1
    }

    // Listed rather than counted, so a failure names the dates.
    expect(disagreements.slice(0, 20)).toEqual([])
    expect(disagreements).toHaveLength(0)
    expect(compared).toBe(73_414)
  })

  it('agrees about which years are leap years', () => {
    // Derived from ICU independently: a Hebrew year is a leap year exactly
    // when ICU ever names a month "Adar II" in it.
    const icuLeapYears = new Set<number>()
    const icuYears = new Set<number>()
    for (
      let fixed = isoToFixed('2000-01-01');
      fixed <= isoToFixed('2060-12-31');
      fixed += 1
    ) {
      const theirs = icuHebrewDate(fixed)
      icuYears.add(theirs.year)
      if (theirs.monthName === 'Adar II') icuLeapYears.add(theirs.year)
    }

    // Drop the two partial years at the ends of the Gregorian window.
    const years = [...icuYears].sort((a, b) => a - b).slice(1, -1)
    expect(years.length).toBeGreaterThan(55)
    for (const year of years) {
      expect(isHebrewLeapYear(year)).toBe(icuLeapYears.has(year))
    }
  })

  it('agrees about Adar I and Adar II specifically', () => {
    // 5787 is a leap year: ICU should call month 12 "Adar I" and 13 "Adar II".
    expect(isHebrewLeapYear(5787)).toBe(true)
    expect(icuHebrewDate(isoToFixed('2027-03-09')).monthName).toBe('Adar I')
    expect(icuHebrewDate(isoToFixed('2027-03-23')).monthName).toBe('Adar II')
    // 5786 is not: ICU should call month 12 plain "Adar".
    expect(isHebrewLeapYear(5786)).toBe(false)
    expect(icuHebrewDate(isoToFixed('2026-03-03')).monthName).toBe('Adar')
  })
})
