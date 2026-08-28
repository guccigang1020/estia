/**
 * Proof that the ported arithmetic is right.
 *
 * The legacy implementation was evidence — it ran a business for years — but
 * never proof. These tests are the proof, and they are deliberately brutal
 * rather than illustrative:
 *
 *  - every civil date across **two centuries** is converted to Hebrew and back
 *    and must return unchanged, and every Hebrew date in the same span is
 *    converted the other way and back;
 *  - every Hebrew year in the span must satisfy the structural laws of the
 *    fixed calendar — six legal lengths, the 19-year leap cycle, `lo ADU
 *    rosh`, month lengths summing to the year;
 *  - the sweeps assert they actually saw every case they claim to cover, so
 *    that a bug which silently narrows the range cannot leave a green suite.
 *
 * Two hundred years is far more than the thirty asked for, because the sweep
 * costs milliseconds and the extra span is the only way to see rare
 * combinations — a `GaTaRaD` postponement, a 383-day year — often enough to
 * trust them.
 */

import { describe, expect, it } from 'vitest'

import {
  HEBREW_EPOCH,
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
import {
  RD_AT_UNIX_EPOCH,
  addDays,
  dayOfWeek,
  daysBetween,
  fixedDayOfWeek,
  fixedToIso,
  isGregorianLeapYear,
  isoToFixed,
} from './gregorian'
import { HEBREW_MONTH, HEBREW_YEAR_LENGTHS } from './types'

// ── The sweep ─────────────────────────────────────────────────────────────

const SWEEP_FROM = '1900-01-01'
const SWEEP_TO = '2100-12-31'

const SWEEP_FIRST_FIXED = isoToFixed(SWEEP_FROM)
const SWEEP_LAST_FIXED = isoToFixed(SWEEP_TO)

const FIRST_HEBREW_YEAR = toHebrewDate(SWEEP_FROM).year
const LAST_HEBREW_YEAR = toHebrewDate(SWEEP_TO).year

/** Every Hebrew year fully or partly inside the sweep. */
const HEBREW_YEARS: number[] = []
for (let year = FIRST_HEBREW_YEAR; year <= LAST_HEBREW_YEAR; year += 1) {
  HEBREW_YEARS.push(year)
}

describe('the sweep is as wide as it claims', () => {
  it('covers more than two centuries of civil dates', () => {
    expect(SWEEP_LAST_FIXED - SWEEP_FIRST_FIXED + 1).toBe(73414)
  })

  it('covers more than two centuries of Hebrew years', () => {
    expect(FIRST_HEBREW_YEAR).toBe(5660)
    expect(LAST_HEBREW_YEAR).toBe(5861)
    expect(HEBREW_YEARS).toHaveLength(202)
  })
})

// ── Round trips ───────────────────────────────────────────────────────────

describe('Gregorian → Hebrew → Gregorian round trip', () => {
  it('returns every one of 73,414 civil dates unchanged', () => {
    let checked = 0
    const failures: string[] = []
    for (let fixed = SWEEP_FIRST_FIXED; fixed <= SWEEP_LAST_FIXED; fixed += 1) {
      const iso = fixedToIso(fixed)
      const back = toIsoDate(toHebrewDate(iso))
      if (back !== iso) failures.push(`${iso} → ${back}`)
      checked += 1
    }
    expect(failures.slice(0, 10)).toEqual([])
    expect(checked).toBe(73414)
  })

  it('returns every fixed day unchanged through the Hebrew date', () => {
    const failures: number[] = []
    for (let fixed = SWEEP_FIRST_FIXED; fixed <= SWEEP_LAST_FIXED; fixed += 1) {
      if (hebrewToFixed(fixedToHebrew(fixed)) !== fixed) failures.push(fixed)
    }
    expect(failures.slice(0, 10)).toEqual([])
  })
})

describe('Hebrew → Gregorian → Hebrew round trip', () => {
  it('returns every Hebrew date of 202 years unchanged', () => {
    let checked = 0
    const failures: string[] = []
    for (const year of HEBREW_YEARS) {
      for (const month of hebrewMonthsInOrder(year)) {
        for (let day = 1; day <= daysInHebrewMonth(year, month); day += 1) {
          const back = toHebrewDate(toIsoDate({ year, month, day }))
          if (back.year !== year || back.month !== month || back.day !== day) {
            failures.push(
              `${year}-${month}-${day} → ${back.year}-${back.month}-${back.day}`,
            )
          }
          checked += 1
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([])
    // 202 Hebrew years average a little over 365 days.
    expect(checked).toBeGreaterThan(73_000)
  })
})

describe('consecutive days advance by exactly one Hebrew day', () => {
  it('never skips, repeats or reorders a day across the sweep', () => {
    const failures: string[] = []
    let previous = fixedToHebrew(SWEEP_FIRST_FIXED)
    for (
      let fixed = SWEEP_FIRST_FIXED + 1;
      fixed <= SWEEP_LAST_FIXED;
      fixed += 1
    ) {
      const current = fixedToHebrew(fixed)
      const sameMonth =
        current.year === previous.year &&
        current.month === previous.month &&
        current.day === previous.day + 1
      const rolledOver =
        current.day === 1 &&
        previous.day === daysInHebrewMonth(previous.year, previous.month)
      if (!sameMonth && !rolledOver) {
        failures.push(`${fixedToIso(fixed)}: ${JSON.stringify(current)}`)
      }
      previous = current
    }
    expect(failures.slice(0, 10)).toEqual([])
  })
})

// ── Structural invariants of every Hebrew year ────────────────────────────

describe('every Hebrew year in the sweep obeys the fixed calendar', () => {
  it('is 353, 354, 355, 383, 384 or 385 days and nothing else', () => {
    const lengthsSeen = new Set<number>()
    const illegal: string[] = []
    for (const year of HEBREW_YEARS) {
      const length = hebrewYearLength(year)
      lengthsSeen.add(length)
      if (!(HEBREW_YEAR_LENGTHS as readonly number[]).includes(length)) {
        illegal.push(`${year}: ${length}`)
      }
    }
    expect(illegal).toEqual([])
    // Not vacuous: all six lengths really occur, so all six branches of the
    // month-length rules were exercised above.
    expect([...lengthsSeen].sort((a, b) => a - b)).toEqual([
      353, 354, 355, 383, 384, 385,
    ])
  })

  it('never starts Rosh Hashanah on Sunday, Wednesday or Friday', () => {
    const forbidden = new Set([0, 3, 5]) // lo ADU rosh
    const weekdaysSeen = new Set<number>()
    const violations: string[] = []
    for (const year of HEBREW_YEARS) {
      const weekday = fixedDayOfWeek(hebrewNewYear(year))
      weekdaysSeen.add(weekday)
      if (forbidden.has(weekday)) violations.push(`${year}: ${weekday}`)
    }
    expect(violations).toEqual([])
    // The four permitted weekdays — Monday, Tuesday, Thursday, Shabbat — all
    // occur, so the rule is not passing by accident of a narrow range.
    expect([...weekdaysSeen].sort((a, b) => a - b)).toEqual([1, 2, 4, 6])
  })

  it('has month lengths that sum exactly to the year length', () => {
    const mismatches: string[] = []
    for (const year of HEBREW_YEARS) {
      const total = hebrewMonthsInOrder(year).reduce(
        (sum, month) => sum + daysInHebrewMonth(year, month),
        0,
      )
      if (total !== hebrewYearLength(year)) {
        mismatches.push(`${year}: ${total} ≠ ${hebrewYearLength(year)}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('starts the next year on the day after the last day of this one', () => {
    const gaps: string[] = []
    for (const year of HEBREW_YEARS) {
      const expected = hebrewNewYear(year) + hebrewYearLength(year)
      if (hebrewNewYear(year + 1) !== expected) gaps.push(String(year))
    }
    expect(gaps).toEqual([])
  })
})

describe('the 19-year leap cycle', () => {
  it('marks exactly seven leap years in every cycle', () => {
    for (let cycleStart = 5661; cycleStart <= 5842; cycleStart += 19) {
      const leaps: number[] = []
      for (let offset = 0; offset < 19; offset += 1) {
        if (isHebrewLeapYear(cycleStart + offset)) leaps.push(offset)
      }
      expect(leaps).toHaveLength(7)
    }
  })

  it('places them at positions 3, 6, 8, 11, 14, 17 and 19 of the cycle', () => {
    const positions = new Set<number>()
    for (const year of HEBREW_YEARS) {
      if (isHebrewLeapYear(year)) positions.add(((year - 1) % 19) + 1)
    }
    expect([...positions].sort((a, b) => a - b)).toEqual([
      3, 6, 8, 11, 14, 17, 19,
    ])
  })

  it('gives leap years 13 months and common years 12', () => {
    for (const year of HEBREW_YEARS) {
      expect(monthsInHebrewYear(year)).toBe(isHebrewLeapYear(year) ? 13 : 12)
      expect(hebrewMonthsInOrder(year)).toHaveLength(
        isHebrewLeapYear(year) ? 13 : 12,
      )
    }
  })

  it('gives leap years a length 30 days longer than the common form', () => {
    for (const year of HEBREW_YEARS) {
      const length = hebrewYearLength(year)
      expect(length > 380).toBe(isHebrewLeapYear(year))
    }
  })
})

describe('Adar exists only where it should', () => {
  it('has Adar II in leap years and not in common ones', () => {
    for (const year of HEBREW_YEARS) {
      expect(hebrewMonthExists(year, HEBREW_MONTH.adarII)).toBe(
        isHebrewLeapYear(year),
      )
      expect(hebrewMonthExists(year, HEBREW_MONTH.adar)).toBe(true)
    }
  })

  it('makes Adar 29 days in a common year and Adar I 30 in a leap year', () => {
    for (const year of HEBREW_YEARS) {
      const leap = isHebrewLeapYear(year)
      expect(daysInHebrewMonth(year, HEBREW_MONTH.adar)).toBe(leap ? 30 : 29)
      if (leap) expect(daysInHebrewMonth(year, HEBREW_MONTH.adarII)).toBe(29)
    }
  })

  it('puts Adar II between Adar I and Nisan in the lived order', () => {
    const leapYear = HEBREW_YEARS.find((year) => isHebrewLeapYear(year))!
    const order = hebrewMonthsInOrder(leapYear)
    expect(order.indexOf(HEBREW_MONTH.adarII)).toBe(
      order.indexOf(HEBREW_MONTH.adar) + 1,
    )
    expect(order.indexOf(HEBREW_MONTH.nisan)).toBe(
      order.indexOf(HEBREW_MONTH.adarII) + 1,
    )
  })

  it('points Purim at Adar in a common year and Adar II in a leap year', () => {
    for (const year of HEBREW_YEARS) {
      expect(purimAdar(year)).toBe(
        isHebrewLeapYear(year) ? HEBREW_MONTH.adarII : HEBREW_MONTH.adar,
      )
    }
  })

  it('refuses to measure Adar II in a common year', () => {
    const commonYear = HEBREW_YEARS.find((year) => !isHebrewLeapYear(year))!
    expect(() => daysInHebrewMonth(commonYear, HEBREW_MONTH.adarII)).toThrow(
      /not a leap year/,
    )
  })
})

describe('Cheshvan and Kislev absorb the variable days', () => {
  it('follows the deficient / regular / complete rule in every year', () => {
    const kindsSeen = new Set<string>()
    for (const year of HEBREW_YEARS) {
      const kind = hebrewYearKind(year)
      kindsSeen.add(kind)
      const cheshvan = daysInHebrewMonth(year, HEBREW_MONTH.cheshvan)
      const kislev = daysInHebrewMonth(year, HEBREW_MONTH.kislev)
      if (kind === 'deficient') {
        expect([cheshvan, kislev]).toEqual([29, 29])
      } else if (kind === 'regular') {
        expect([cheshvan, kislev]).toEqual([29, 30])
      } else {
        expect([cheshvan, kislev]).toEqual([30, 30])
      }
    }
    expect([...kindsSeen].sort()).toEqual(['complete', 'deficient', 'regular'])
  })

  it('keeps every other month at its fixed length', () => {
    const fixedLengths: Array<[number, number]> = [
      [HEBREW_MONTH.nisan, 30],
      [HEBREW_MONTH.iyar, 29],
      [HEBREW_MONTH.sivan, 30],
      [HEBREW_MONTH.tammuz, 29],
      [HEBREW_MONTH.av, 30],
      [HEBREW_MONTH.elul, 29],
      [HEBREW_MONTH.tishrei, 30],
      [HEBREW_MONTH.tevet, 29],
      [HEBREW_MONTH.shevat, 30],
    ]
    for (const year of HEBREW_YEARS) {
      for (const [month, length] of fixedLengths) {
        expect(daysInHebrewMonth(year, month)).toBe(length)
      }
    }
  })

  it('classifies the year kind from the year length', () => {
    for (const year of HEBREW_YEARS) {
      const lastDigit = hebrewYearLength(year) % 10
      const expected =
        lastDigit === 3 ? 'deficient' : lastDigit === 5 ? 'complete' : 'regular'
      expect(hebrewYearKind(year)).toBe(expected)
    }
  })
})

// ── Year boundaries ───────────────────────────────────────────────────────

describe('the turn of the Hebrew year', () => {
  it('makes 29 Elul the last day and 1 Tishrei the first', () => {
    for (const year of HEBREW_YEARS) {
      const erevRoshHashanah = toIsoDate({
        year,
        month: HEBREW_MONTH.elul,
        day: 29,
      })
      const roshHashanah = toIsoDate({
        year: year + 1,
        month: HEBREW_MONTH.tishrei,
        day: 1,
      })
      expect(addDays(erevRoshHashanah, 1)).toBe(roshHashanah)
      expect(toHebrewDate(roshHashanah)).toEqual({
        year: year + 1,
        month: HEBREW_MONTH.tishrei,
        day: 1,
      })
    }
  })

  it('reports year bounds that hold exactly one year of days', () => {
    for (const year of HEBREW_YEARS) {
      const { from, to } = hebrewYearBounds(year)
      expect(daysBetween(from, to) + 1).toBe(hebrewYearLength(year))
      expect(toHebrewDate(from)).toEqual({
        year,
        month: HEBREW_MONTH.tishrei,
        day: 1,
      })
      expect(toHebrewDate(to).year).toBe(year)
      expect(toHebrewDate(to).month).toBe(HEBREW_MONTH.elul)
      expect(toHebrewDate(to).day).toBe(29)
    }
  })

  it('starts a Hebrew day on the evening of the civil day before', () => {
    expect(hebrewDayBeginsEveningOf('2026-04-02')).toBe('2026-04-01')
    expect(hebrewDayBeginsEveningOf('2026-01-01')).toBe('2025-12-31')
  })
})

// ── Refusals ──────────────────────────────────────────────────────────────

describe('impossible inputs are refused, not guessed at', () => {
  it('rejects a malformed ISO date', () => {
    expect(() => toHebrewDate('2026-4-2')).toThrow(/expected YYYY-MM-DD/)
    expect(() => toHebrewDate('not a date')).toThrow(/expected YYYY-MM-DD/)
    expect(() => toHebrewDate('')).toThrow(/expected YYYY-MM-DD/)
  })

  it('rejects an out-of-range month or day rather than rolling over', () => {
    expect(() => toHebrewDate('2026-13-01')).toThrow(/Invalid ISO date/)
    expect(() => toHebrewDate('2026-00-10')).toThrow(/Invalid ISO date/)
    expect(() => toHebrewDate('2026-01-32')).toThrow(/Invalid ISO date/)
  })

  it('rejects 30 February even though Date would happily return 2 March', () => {
    expect(() => toHebrewDate('2026-02-30')).toThrow(/no such day/)
    expect(() => toHebrewDate('2025-02-29')).toThrow(/no such day/)
    // …and accepts the leap day that does exist.
    expect(() => toHebrewDate('2024-02-29')).not.toThrow()
  })

  it('rejects Hebrew dates that do not exist', () => {
    expect(() =>
      toIsoDate({ year: 5786, month: HEBREW_MONTH.adarII, day: 1 }),
    ).toThrow(/not a leap year/)
    expect(() =>
      toIsoDate({ year: 5786, month: HEBREW_MONTH.iyar, day: 30 }),
    ).toThrow(/out of range/)
    expect(() =>
      toIsoDate({ year: 5786, month: HEBREW_MONTH.cheshvan, day: 30 }),
    ).toThrow(/out of range/)
    expect(() =>
      toIsoDate({ year: 0, month: HEBREW_MONTH.tishrei, day: 1 }),
    ).toThrow(/out of range/)
  })

  it('rejects dates before the Hebrew epoch', () => {
    expect(() => fixedToHebrew(HEBREW_EPOCH - 1)).toThrow(/Hebrew epoch/)
    expect(() => fixedToHebrew(1.5)).toThrow(/must be an integer/)
    // The epoch itself is 1 Tishrei AM 1.
    expect(fixedToHebrew(HEBREW_EPOCH)).toEqual({
      year: 1,
      month: HEBREW_MONTH.tishrei,
      day: 1,
    })
  })

  it('knows which months exist without throwing', () => {
    expect(hebrewMonthExists(5786, 0)).toBe(false)
    expect(hebrewMonthExists(5786, 14)).toBe(false)
    expect(hebrewMonthExists(5786, 1.5)).toBe(false)
  })

  it('names the reason a month is impossible', () => {
    // Adar II gets the specific explanation; a nonsense number does not
    // claim to be about leap years.
    expect(() => daysInHebrewMonth(5786, HEBREW_MONTH.adarII)).toThrow(
      'Hebrew month 13 does not exist in year 5786 (not a leap year).',
    )
    expect(() => daysInHebrewMonth(5786, 14)).toThrow(
      'Hebrew month 14 does not exist in year 5786.',
    )
    expect(() => daysInHebrewMonth(5786, 0)).toThrow(/does not exist/)
  })
})

// ── The Gregorian plumbing underneath ─────────────────────────────────────

describe('fixed day numbers', () => {
  it('puts the Unix epoch where Rata Die says it is', () => {
    expect(isoToFixed('1970-01-01')).toBe(RD_AT_UNIX_EPOCH)
    expect(isoToFixed('0001-01-01')).toBe(1)
    expect(fixedToIso(1)).toBe('0001-01-01')
  })

  it('agrees with Date on every civil date in the sweep', () => {
    // An independent check of the Gregorian half, so a round-trip failure can
    // never be blamed on the wrong layer.
    const failures: string[] = []
    for (let fixed = SWEEP_FIRST_FIXED; fixed <= SWEEP_LAST_FIXED; fixed += 1) {
      const iso = fixedToIso(fixed)
      const viaDate = new Date((fixed - RD_AT_UNIX_EPOCH) * 86_400_000)
        .toISOString()
        .slice(0, 10)
      if (viaDate !== iso) failures.push(`${fixed}: ${iso} vs ${viaDate}`)
    }
    expect(failures.slice(0, 10)).toEqual([])
  })

  it('agrees with Date about the day of the week', () => {
    const failures: string[] = []
    for (let fixed = SWEEP_FIRST_FIXED; fixed <= SWEEP_LAST_FIXED; fixed += 1) {
      const viaDate = new Date(
        (fixed - RD_AT_UNIX_EPOCH) * 86_400_000,
      ).getUTCDay()
      if (fixedDayOfWeek(fixed) !== viaDate) failures.push(String(fixed))
    }
    expect(failures.slice(0, 10)).toEqual([])
    // 2026-08-27, the day this was written, was a Thursday.
    expect(dayOfWeek('2026-08-27')).toBe(4)
  })

  it('runs the Gregorian rules back past year 1, as proleptic means', () => {
    // The Hebrew epoch is conventionally quoted as 7 October 3761 BCE — but
    // that is the **Julian** proleptic date, which is the trap. At that
    // remove the Julian calendar runs
    // `floor(y/100) − floor(y/400) − 2 = −30` days ahead of the Gregorian
    // one, so the proleptic *Gregorian* date, in astronomical year
    // numbering, is thirty days earlier: −3760-09-07.
    expect(fixedToIso(HEBREW_EPOCH)).toBe('-3760-09-07')
    expect(isoToFixed('-3760-09-07')).toBe(HEBREW_EPOCH)
    // BaHaRaD's `bet` is Monday, and 1 Tishrei AM 1 lands on one.
    expect(fixedDayOfWeek(HEBREW_EPOCH)).toBe(1)
    expect(fixedToIso(0)).toBe('0000-12-31')
    expect(isoToFixed('0000-12-31')).toBe(0)
    expect(daysBetween('-0001-12-31', '0001-01-01')).toBe(367) // year 0 is a leap year
  })

  it('handles Gregorian leap years including the century rule', () => {
    expect(isGregorianLeapYear(2024)).toBe(true)
    expect(isGregorianLeapYear(1900)).toBe(false)
    expect(isGregorianLeapYear(2000)).toBe(true)
    expect(isGregorianLeapYear(2100)).toBe(false)
    expect(daysBetween('1900-02-28', '1900-03-01')).toBe(1)
    expect(daysBetween('2000-02-28', '2000-03-01')).toBe(2)
  })

  it('adds and subtracts days across month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0)
    expect(daysBetween('2027-01-01', '2026-01-01')).toBe(-365)
  })
})
