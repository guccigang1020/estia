/**
 * The window, and the three ways a URL can be wrong about it.
 *
 * A hand-edited address bar must never reach `assertValidRange`, which throws,
 * because an error page is the wrong answer to a typo. It must also never be
 * silently corrected: a screen that quietly shows a different month from the
 * one somebody typed is a screen they will quote in a meeting. So a bad range
 * falls back *and says so*, and both halves are asserted here.
 */

import { describe, expect, it } from 'vitest'

import {
  COMPARISON_MODES,
  describePeriod,
  monthContaining,
  parseInsightPeriod,
  periodIssue,
  recentMonths,
} from './period'

const NOW = new Date('2026-03-17T08:00:00Z')

describe('the default window', () => {
  it('is the calendar month containing today, half-open', () => {
    expect(monthContaining(NOW)).toEqual({
      start: '2026-03-01',
      // The first of April is outside the window, as everywhere in the
      // product. A closed range would count it as a March night.
      end: '2026-04-01',
    })
  })

  it('opens with a comparison, because half these claims are directions', () => {
    const period = parseInsightPeriod({}, NOW)
    expect(period.comparison).toBe('previous_period')
    expect(period.explicit).toBe(false)
  })
})

describe('a window the URL asked for', () => {
  it('is used when both dates are valid and ordered', () => {
    const period = parseInsightPeriod(
      { from: '2026-01-01', to: '2026-02-01', compare: 'previous_year' },
      NOW,
    )
    expect(period.range).toEqual({ start: '2026-01-01', end: '2026-02-01' })
    expect(period.comparison).toBe('previous_year')
    expect(period.explicit).toBe(true)
  })

  it('falls back on a reversed range, and says why', () => {
    const params = { from: '2026-04-01', to: '2026-03-01' }
    expect(parseInsightPeriod(params, NOW).range).toEqual(monthContaining(NOW))
    expect(periodIssue(params)).toContain('אינו מאוחר')
  })

  it('falls back on a date that is not a date, and says why', () => {
    const params = { from: 'yesterday', to: '2026-03-01' }
    expect(parseInsightPeriod(params, NOW).range).toEqual(monthContaining(NOW))
    expect(periodIssue(params)).toContain('אינו תקין')
  })

  it('falls back on half a range, and says why', () => {
    const params = { from: '2026-03-01' }
    expect(parseInsightPeriod(params, NOW).range).toEqual(monthContaining(NOW))
    expect(periodIssue(params)).toContain('תאריך סיום')
  })

  it('is silent when nothing was asked for', () => {
    expect(periodIssue({})).toBeNull()
  })

  it('ignores a comparison mode the domain does not understand', () => {
    const period = parseInsightPeriod({ compare: 'last-tuesday' }, NOW)
    expect(COMPARISON_MODES).toContain(period.comparison)
    expect(period.comparison).toBe('previous_period')
  })
})

describe('the window in words', () => {
  it('names a whole calendar month as a month', () => {
    // Reading "1.3.2026 – 1.4.2026" back invites the question of whether the
    // first of April is included. It is not, and naming the month avoids it.
    expect(
      describePeriod({ start: '2026-03-01', end: '2026-04-01' }),
    ).not.toContain('–')
  })

  it('spells anything else as its two ends', () => {
    expect(
      describePeriod({ start: '2026-03-05', end: '2026-03-12' }),
    ).toContain('–')
  })
})

describe('the month picker', () => {
  it('offers whole months, newest first, ending at the current one', () => {
    const months = recentMonths(NOW, 3)
    expect(months.map((month) => month.range.start)).toEqual([
      '2026-03-01',
      '2026-02-01',
      '2026-01-01',
    ])
    // Every option is a whole month, which is what unlocks the like-for-like
    // comparison an extensive metric needs.
    for (const month of months) {
      expect(month.range.end).toBe(
        monthContaining(new Date(`${month.range.start}T12:00:00Z`)).end,
      )
    }
  })
})
