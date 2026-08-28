import { describe, expect, it } from 'vitest'

import {
  MONTH_MAX,
  MONTH_MIN,
  buildMonthDays,
  hebrewMonthSpan,
  monthKeyOf,
  monthLabel,
  monthRange,
  monthSpecialDays,
  parseMonthKey,
  shiftMonth,
  shiftMonthWithin,
} from './month'

describe('parseMonthKey', () => {
  it('accepts a well-formed month', () => {
    expect(parseMonthKey('2026-09')).toBe('2026-09')
    expect(parseMonthKey('2026-01')).toBe('2026-01')
    expect(parseMonthKey('2026-12')).toBe('2026-12')
  })

  it('refuses anything else, rather than guessing', () => {
    for (const value of [
      '2026-13',
      '2026-00',
      '2026-9',
      '202609',
      '2026',
      'drop-table',
      '',
      null,
      undefined,
    ]) {
      expect(parseMonthKey(value)).toBeNull()
    }
  })

  it('refuses a month whose following month is not representable', () => {
    // Regression. `monthRange('9999-12')` needs 10000-01-01, which is not a
    // four-digit ISO date, so `eachNight` returned nothing and the page threw
    // on a query parameter a stranger chose.
    expect(parseMonthKey('9999-12')).toBeNull()
    expect(parseMonthKey('3000-01')).toBeNull()
    expect(parseMonthKey('1899-12')).toBeNull()
    expect(parseMonthKey(MONTH_MIN)).toBe(MONTH_MIN)
    expect(parseMonthKey(MONTH_MAX)).toBe(MONTH_MAX)
  })
})

describe('the drawable window', () => {
  it('builds a whole month at either edge without throwing', () => {
    for (const key of [MONTH_MIN, MONTH_MAX]) {
      expect(() => {
        buildMonthDays(key)
        hebrewMonthSpan(key)
        monthSpecialDays(key)
      }).not.toThrow()
      expect(buildMonthDays(key).length).toBeGreaterThan(27)
    }
  })

  it('offers no arrow past either edge', () => {
    expect(shiftMonthWithin(MONTH_MAX, 1)).toBeNull()
    expect(shiftMonthWithin(MONTH_MIN, -1)).toBeNull()
    expect(shiftMonthWithin('2026-09', 1)).toBe('2026-10')
    expect(shiftMonthWithin('2026-09', -1)).toBe('2026-08')
  })
})

describe('shiftMonth', () => {
  it('crosses a year boundary in both directions', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  })

  it('moves by whole months, never by a fixed number of days', () => {
    // The 31st is the case that breaks a day-stepping implementation.
    expect(shiftMonth('2026-01', 1)).toBe('2026-02')
    expect(shiftMonth('2026-03', -1)).toBe('2026-02')
  })

  it('is its own inverse', () => {
    expect(shiftMonth(shiftMonth('2026-07', 5), -5)).toBe('2026-07')
  })
})

describe('monthRange', () => {
  it('is half-open: the first of the next month is the exclusive end', () => {
    expect(monthRange('2026-09')).toEqual({
      checkIn: '2026-09-01',
      checkOut: '2026-10-01',
    })
  })

  it('rolls into the next year', () => {
    expect(monthRange('2026-12')).toEqual({
      checkIn: '2026-12-01',
      checkOut: '2027-01-01',
    })
  })
})

describe('buildMonthDays', () => {
  it('has one column per night and never the check-out day', () => {
    expect(buildMonthDays('2026-09')).toHaveLength(30)
    expect(buildMonthDays('2026-10')).toHaveLength(31)
    // February 2028 is a leap February; the arithmetic is the domain's.
    expect(buildMonthDays('2028-02')).toHaveLength(29)
    expect(buildMonthDays('2026-02')).toHaveLength(28)
  })

  it('never includes a date from the following month', () => {
    const days = buildMonthDays('2026-09')
    expect(days[0].date).toBe('2026-09-01')
    expect(days[days.length - 1].date).toBe('2026-09-30')
    expect(days.every((day) => day.date.startsWith('2026-09'))).toBe(true)
  })

  it('carries the Hebrew date the calendar module computes', () => {
    // The module's own documented example: 2026-04-02 is ט״ו ניסן תשפ״ו.
    const day = buildMonthDays('2026-04').find(
      (candidate) => candidate.date === '2026-04-02',
    )
    expect(day?.hebrewDay).toBe('ט״ו')
    expect(day?.hebrewFull).toBe('ט״ו ניסן תשפ״ו')
  })

  it('marks the first day of Pesach as a peak night', () => {
    const day = buildMonthDays('2026-04').find(
      (candidate) => candidate.date === '2026-04-02',
    )
    expect(day?.special?.kind).toBe('yom_tov')
    expect(day?.peak).toBe(true)
  })

  it('marks Shabbat and erev Shabbat, and nothing else', () => {
    const days = buildMonthDays('2026-09')
    const shabbatot = days.filter((day) => day.shabbat).map((day) => day.date)
    expect(shabbatot).toEqual([
      '2026-09-05',
      '2026-09-12',
      '2026-09-19',
      '2026-09-26',
    ])
    expect(days.filter((day) => day.erevShabbat)).toHaveLength(4)
    // Every Shabbat is a peak night, and no Shabbat is an erev Shabbat.
    expect(days.filter((day) => day.shabbat).every((day) => day.peak)).toBe(
      true,
    )
    expect(days.some((day) => day.shabbat && day.erevShabbat)).toBe(false)
  })

  it('gives every day a weekday letter that matches its weekday index', () => {
    const days = buildMonthDays('2026-09')
    for (const day of days) {
      expect(day.weekdayLetter).toBe('אבגדהוש'[day.weekday])
      expect(day.shabbat).toBe(day.weekday === 6)
    }
  })
})

describe('monthSpecialDays', () => {
  it('finds the festival days of Tishrei 5787 in September 2026', () => {
    const names = monthSpecialDays('2026-09').map((day) => day.name)
    expect(names.some((name) => name.includes('ראש השנה'))).toBe(true)
    expect(names.some((name) => name.includes('כיפור'))).toBe(true)
  })

  it('stays inside the month', () => {
    const dates = monthSpecialDays('2026-09').map((day) => day.date)
    expect(dates.every((date) => date.startsWith('2026-09'))).toBe(true)
  })
})

describe('labels', () => {
  it('names the civil month in Hebrew', () => {
    expect(monthLabel('2026-09')).toBe('ספטמבר 2026')
    expect(monthLabel('2026-01')).toBe('ינואר 2026')
    expect(monthLabel('2026-12')).toBe('דצמבר 2026')
  })

  it('names the Hebrew months the civil month straddles', () => {
    // September 2026 runs from Elul 5786 into Tishrei 5787.
    const span = hebrewMonthSpan('2026-09')
    expect(span).toContain('אלול')
    expect(span).toContain('תשרי')
  })

  it('collapses to one name when the civil month sits inside one Hebrew month', () => {
    // Whatever month that is, the label must not repeat a name.
    const span = hebrewMonthSpan('2026-04')
    expect(span.split('–')).not.toHaveLength(3)
  })
})

describe('monthKeyOf', () => {
  it('reads the month out of an ISO date', () => {
    expect(monthKeyOf('2026-09-17')).toBe('2026-09')
  })
})
