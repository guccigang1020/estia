/**
 * The reporting window, and the three ways a naive one is wrong.
 *
 * Everything measured here is a decision the screen cannot make for itself and
 * a screenshot would not reveal: whether "August" ends on the 31st or on the
 * 1st of September, whether a hand-edited address bar produces an error page
 * or a sensible default, and whether the person is told their dates were
 * ignored. Getting the first wrong makes every monthly report disagree with
 * the calendar by one night; getting the third wrong lets somebody quote a
 * figure for a month they did not ask for.
 */

import { describe, expect, it } from 'vitest'

import { isWholeCalendarMonth, previousPeriod } from '@/lib/metrics'

import {
  COMPARISON_MODES,
  describePeriod,
  monthContaining,
  parseReportPeriod,
  periodIssue,
  periodQuery,
  recentMonths,
} from './period'

/** A fixed instant in Jerusalem, so nothing here depends on when it runs. */
const AUGUST = new Date('2026-08-17T09:00:00+03:00')

describe('the default window', () => {
  it('is the calendar month containing today, half-open', () => {
    expect(monthContaining(AUGUST)).toEqual({
      start: '2026-08-01',
      end: '2026-09-01',
    })
  })

  it('ends on the first of the next month, which is outside it', () => {
    // The whole half-open convention in one assertion: the 1st of September
    // belongs to September. A closed range would lose or double-count a night
    // at every month boundary.
    const range = monthContaining(AUGUST)
    expect(range.end).toBe('2026-09-01')
    expect(isWholeCalendarMonth(range)).toBe(true)
  })

  it('is a window the comparison engine can step back from', () => {
    // The reason the default is a month rather than "the last thirty days":
    // only a whole calendar month compares against the previous calendar
    // month rather than against a fortnight of two of them.
    expect(previousPeriod(monthContaining(AUGUST))).toEqual({
      start: '2026-07-01',
      end: '2026-08-01',
    })
  })

  it('follows the property timezone rather than the server clock', () => {
    // 23:30 on the 31st in Jerusalem is still August, and is already the 1st
    // of September in UTC+4. The month must follow the property.
    const lateOnTheLastNight = new Date('2026-08-31T23:30:00+03:00')
    expect(monthContaining(lateOnTheLastNight).start).toBe('2026-08-01')
  })
})

describe('reading the window out of the URL', () => {
  it('takes a valid explicit range and marks it as chosen', () => {
    const period = parseReportPeriod(
      { from: '2026-03-01', to: '2026-04-01', compare: 'previous_year' },
      AUGUST,
    )

    expect(period.range).toEqual({ start: '2026-03-01', end: '2026-04-01' })
    expect(period.comparison).toBe('previous_year')
    expect(period.explicit).toBe(true)
  })

  it('falls back to the default month rather than throwing on nonsense', () => {
    // `assertValidRange` would throw on each of these, and an error page is
    // the wrong answer to a hand-edited address bar.
    for (const params of [
      { from: 'yesterday', to: '2026-04-01' },
      { from: '2026-04-01', to: '2026-03-01' },
      { from: '2026-04-01', to: '2026-04-01' },
      { from: '2026-02-30', to: '2026-03-01' },
      { from: '2026-03-01' },
    ]) {
      const period = parseReportPeriod(params, AUGUST)
      expect(period.range).toEqual(monthContaining(AUGUST))
      expect(period.explicit).toBe(false)
    }
  })

  it('takes the first value when a key is repeated', () => {
    const period = parseReportPeriod(
      { from: ['2026-03-01', '2026-05-01'], to: ['2026-04-01'] },
      AUGUST,
    )
    expect(period.range).toEqual({ start: '2026-03-01', end: '2026-04-01' })
  })

  it('defaults the comparison rather than accepting an unknown mode', () => {
    expect(
      parseReportPeriod({ compare: 'last_decade' }, AUGUST).comparison,
    ).toBe('previous_period')
    expect(parseReportPeriod({}, AUGUST).comparison).toBe('previous_period')
  })

  it('accepts every mode the domain understands and no others', () => {
    for (const mode of COMPARISON_MODES) {
      expect(parseReportPeriod({ compare: mode }, AUGUST).comparison).toBe(mode)
    }
  })
})

describe('saying that the window was ignored', () => {
  it('says nothing when nothing was asked for', () => {
    expect(periodIssue({})).toBeNull()
    expect(periodIssue({ compare: 'none' })).toBeNull()
  })

  it('says nothing when the window was used', () => {
    expect(periodIssue({ from: '2026-03-01', to: '2026-04-01' })).toBeNull()
  })

  it('names each way it could not be used', () => {
    // A silent substitution is the failure that matters here: a report headed
    // "August" showing September is a figure somebody quotes in a meeting.
    expect(periodIssue({ from: '2026-03-01' })).toContain('תאריך סיום')
    expect(periodIssue({ from: 'nope', to: '2026-04-01' })).toContain(
      'אינו תקין',
    )
    expect(periodIssue({ from: '2026-04-01', to: '2026-03-01' })).toContain(
      'אינו מאוחר',
    )
  })
})

describe('naming the window', () => {
  it('names a whole month as a month', () => {
    const label = describePeriod({ start: '2026-08-01', end: '2026-09-01' })
    expect(label).toContain('2026')
    expect(label).not.toContain('–')
  })

  it('spells anything else out as two ends', () => {
    expect(
      describePeriod({ start: '2026-08-03', end: '2026-08-10' }),
    ).toContain('–')
  })
})

describe('the months on offer', () => {
  it('starts at the current month and steps back whole months', () => {
    const months = recentMonths(AUGUST, 3)

    expect(months.map((month) => month.range.start)).toEqual([
      '2026-08-01',
      '2026-07-01',
      '2026-06-01',
    ])
    for (const month of months) {
      expect(isWholeCalendarMonth(month.range)).toBe(true)
      expect(month.label.length).toBeGreaterThan(0)
    }
  })

  it('steps back over a year boundary without drifting', () => {
    const months = recentMonths(new Date('2026-01-10T09:00:00+02:00'), 2)
    expect(months.map((month) => month.range.start)).toEqual([
      '2026-01-01',
      '2025-12-01',
    ])
  })
})

describe('the window as a link', () => {
  it('round-trips through the query string it produces', () => {
    const range = { start: '2026-03-01', end: '2026-04-01' }
    const query = periodQuery(range, 'previous_year')

    const params = Object.fromEntries(new URLSearchParams(query.slice(1)))
    const period = parseReportPeriod(params, AUGUST)

    expect(period.range).toEqual(range)
    expect(period.comparison).toBe('previous_year')
  })
})
