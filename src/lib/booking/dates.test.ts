/**
 * Calendar arithmetic.
 *
 * Small functions, and the sort that produce bugs nobody finds for months: a
 * date that shifts by one because the server is in another timezone, a "today"
 * computed in UTC when the property is in Israel, a `2026-02-30` accepted
 * because the string looked like a date.
 */

import { describe, expect, it } from 'vitest'
import {
  addDays,
  describeDateChange,
  eachNight,
  formatDayMonth,
  formatDayMonthYear,
  formatRange,
  isIsoDate,
  localDate,
  parseIsoDate,
} from './dates'

describe('parsing', () => {
  it('accepts a real calendar date', () => {
    expect(parseIsoDate('2026-09-03')?.toISOString()).toBe(
      '2026-09-03T00:00:00.000Z',
    )
  })

  it.each([
    '2026-02-30',
    '2026-13-01',
    '2026-09-3',
    '03/09/2026',
    '2026-09-03T10:00:00Z',
    'yesterday',
    '',
  ])('refuses %s', (value) => {
    expect(parseIsoDate(value)).toBeNull()
    expect(isIsoDate(value)).toBe(false)
  })

  it('refuses a non-string', () => {
    expect(isIsoDate(20260903)).toBe(false)
    expect(isIsoDate(null)).toBe(false)
  })

  it('crosses a month and a year boundary', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('knows 2028 is a leap year', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('throws rather than guessing at nonsense', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError)
  })
})

describe('today at the property', () => {
  it('is the Israeli date, not the UTC one', () => {
    // 22:30 UTC on the 2nd is already the 3rd in Israel. A no-show judged in
    // UTC would be refused as "too early" for an arrival that day.
    expect(localDate(new Date('2026-09-02T22:30:00.000Z'))).toBe('2026-09-03')
    expect(localDate(new Date('2026-09-02T20:30:00.000Z'))).toBe('2026-09-02')
  })

  it('rolls over an hour later in winter, when the offset is UTC+2', () => {
    // Summer time is UTC+3, so the day turns at 21:00 UTC; in January it is
    // UTC+2 and turns at 22:00. A fixed offset would be wrong half the year.
    expect(localDate(new Date('2026-01-01T21:30:00.000Z'))).toBe('2026-01-01')
    expect(localDate(new Date('2026-01-01T22:30:00.000Z'))).toBe('2026-01-02')
    expect(localDate(new Date('2026-07-01T21:30:00.000Z'))).toBe('2026-07-02')
  })
})

describe('nights', () => {
  it('lists the nights occupied and never the departure day', () => {
    expect(
      eachNight({ checkIn: '2026-09-03', checkOut: '2026-09-06' }),
    ).toEqual(['2026-09-03', '2026-09-04', '2026-09-05'])
  })

  it('is empty for a zero-length or reversed stay', () => {
    expect(
      eachNight({ checkIn: '2026-09-03', checkOut: '2026-09-03' }),
    ).toEqual([])
    expect(
      eachNight({ checkIn: '2026-09-06', checkOut: '2026-09-03' }),
    ).toEqual([])
  })

  it('is empty rather than looping for an unparseable range', () => {
    expect(eachNight({ checkIn: 'soon', checkOut: '2026-09-03' })).toEqual([])
  })
})

describe('Hebrew wording', () => {
  it('writes a date the way a manager says it', () => {
    expect(formatDayMonth('2026-09-03')).toBe('3.9')
    expect(formatDayMonth('2026-12-25')).toBe('25.12')
    expect(formatDayMonthYear('2026-09-03')).toBe('3.9.2026')
  })

  it('leaves an unparseable value alone rather than printing NaN', () => {
    expect(formatDayMonth('later')).toBe('later')
  })

  it('joins a range with an en dash', () => {
    expect(formatRange({ checkIn: '2026-09-03', checkOut: '2026-09-06' })).toBe(
      '3.9–6.9',
    )
  })

  it('names only the end that moved', () => {
    expect(
      describeDateChange(
        { checkIn: '2026-09-03', checkOut: '2026-09-06' },
        { checkIn: '2026-09-05', checkOut: '2026-09-06' },
      ),
    ).toBe('מ-3.9 ל-5.9')

    expect(
      describeDateChange(
        { checkIn: '2026-09-03', checkOut: '2026-09-06' },
        { checkIn: '2026-09-03', checkOut: '2026-09-08' },
      ),
    ).toBe('מ-6.9 ל-8.9')
  })

  it('spells out both ranges when the whole stay moved', () => {
    expect(
      describeDateChange(
        { checkIn: '2026-09-03', checkOut: '2026-09-06' },
        { checkIn: '2026-09-10', checkOut: '2026-09-14' },
      ),
    ).toBe('מ-3.9–6.9 ל-10.9–14.9')
  })
})
