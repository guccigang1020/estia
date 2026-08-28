/**
 * Rendering Hebrew dates in Hebrew.
 *
 * The month names are the legacy product's strings and are treated as a
 * contract: they have been on the guesthouse's screens for years, so a test
 * pins each one rather than letting a well-meaning refactor "correct" the
 * spelling of חשון or drop the geresh from אדר א׳.
 */

import { describe, expect, it } from 'vitest'

import { isHebrewLeapYear, toHebrewDate, toIsoDate } from './arithmetic'
import { dayOfWeek } from './gregorian'
import {
  formatHebrewDate,
  formatHebrewDateParts,
  formatHebrewDayOfMonth,
  hebrewMonthName,
  hebrewWeekdayName,
} from './format'
import { toGematria } from './gematria'
import { HEBREW_MONTH } from './types'

describe('month names', () => {
  it.each([
    [HEBREW_MONTH.nisan, 'ניסן'],
    [HEBREW_MONTH.iyar, 'אייר'],
    [HEBREW_MONTH.sivan, 'סיון'],
    [HEBREW_MONTH.tammuz, 'תמוז'],
    [HEBREW_MONTH.av, 'אב'],
    [HEBREW_MONTH.elul, 'אלול'],
    [HEBREW_MONTH.tishrei, 'תשרי'],
    [HEBREW_MONTH.cheshvan, 'חשון'],
    [HEBREW_MONTH.kislev, 'כסלו'],
    [HEBREW_MONTH.tevet, 'טבת'],
    [HEBREW_MONTH.shevat, 'שבט'],
  ])('names month %i as %s in any year', (month, expected) => {
    // 5786 is a common year, 5787 a leap year; these eleven are unaffected.
    expect(hebrewMonthName(5786, month)).toBe(expected)
    expect(hebrewMonthName(5787, month)).toBe(expected)
  })

  it('names the single Adar of a common year plainly', () => {
    expect(isHebrewLeapYear(5786)).toBe(false)
    expect(hebrewMonthName(5786, HEBREW_MONTH.adar)).toBe('אדר')
  })

  it('distinguishes Adar I from Adar II in a leap year', () => {
    expect(isHebrewLeapYear(5787)).toBe(true)
    expect(hebrewMonthName(5787, HEBREW_MONTH.adar)).toBe('אדר א׳')
    expect(hebrewMonthName(5787, HEBREW_MONTH.adarII)).toBe('אדר ב׳')
  })

  it('refuses a month number it has no name for', () => {
    expect(() => hebrewMonthName(5786, 0)).toThrow(/No Hebrew name/)
    expect(() => hebrewMonthName(5786, 14)).toThrow(/No Hebrew name/)
  })
})

describe('full dates', () => {
  it('renders day, month and year in Hebrew', () => {
    expect(formatHebrewDate('2026-04-02')).toBe('ט״ו ניסן תשפ״ו')
    expect(formatHebrewDate('2026-09-12')).toBe('א׳ תשרי תשפ״ז')
    expect(formatHebrewDate('2026-03-03')).toBe('י״ד אדר תשפ״ו')
  })

  it('honours every formatting option', () => {
    expect(formatHebrewDate('2026-04-02', { monthPrefix: true })).toBe(
      'ט״ו בניסן תשפ״ו',
    )
    expect(formatHebrewDate('2026-04-02', { includeMillennium: true })).toBe(
      'ט״ו ניסן ה׳תשפ״ו',
    )
    expect(formatHebrewDate('2026-04-02', { omitYear: true })).toBe('ט״ו ניסן')
    expect(
      formatHebrewDate('2026-04-02', { omitYear: true, monthPrefix: true }),
    ).toBe('ט״ו בניסן')
  })

  it('formats a Hebrew date directly, without a civil date', () => {
    expect(
      formatHebrewDateParts({
        year: 5787,
        month: HEBREW_MONTH.adarII,
        day: 14,
      }),
    ).toBe('י״ד אדר ב׳ תשפ״ז')
  })

  it('gives just the day of the month for a calendar cell', () => {
    expect(formatHebrewDayOfMonth('2026-04-02')).toBe('ט״ו')
    expect(formatHebrewDayOfMonth('2026-09-12')).toBe('א׳')
  })

  it('agrees with the underlying conversion on every day of a year', () => {
    // The formatter must never disagree with `toHebrewDate` about which day
    // it is rendering.
    for (
      let fixed = 0;
      fixed < 400;
      fixed += 1 // one Hebrew year and change
    ) {
      const iso = toIsoDate(
        toHebrewDate(
          new Date(Date.UTC(2026, 0, 1 + fixed)).toISOString().slice(0, 10),
        ),
      )
      expect(formatHebrewDayOfMonth(iso)).toBe(
        toGematria(toHebrewDate(iso).day),
      )
    }
  })
})

describe('weekday names', () => {
  it('numbers six days and names the seventh', () => {
    expect(hebrewWeekdayName(0)).toBe('יום ראשון')
    expect(hebrewWeekdayName(4)).toBe('יום חמישי')
    expect(hebrewWeekdayName(5)).toBe('יום שישי')
    // Shabbat is a name, not an ordinal: "יום שבת" would be wrong.
    expect(hebrewWeekdayName(6)).toBe('שבת')
  })

  it('lines up with the day-of-week calculation', () => {
    // 2026-04-02 was a Thursday.
    expect(hebrewWeekdayName(dayOfWeek('2026-04-02'))).toBe('יום חמישי')
  })

  it('refuses an index outside the week', () => {
    expect(() => hebrewWeekdayName(7)).toThrow(/No Hebrew name/)
    expect(() => hebrewWeekdayName(-1)).toThrow(/No Hebrew name/)
  })
})
