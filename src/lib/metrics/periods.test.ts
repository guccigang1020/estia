/**
 * Comparison periods, including the three that break naive arithmetic.
 */

import { describe, expect, it } from 'vitest'
import {
  addMonths,
  compareValues,
  comparisonRange,
  isWholeCalendarMonth,
  previousPeriod,
  previousYear,
  type CompareInput,
} from './periods'
import { InvalidRangeError, rangeNights, type MetricRange } from './types'

const MARCH_2026: MetricRange = { start: '2026-03-01', end: '2026-04-01' }
const FEBRUARY_2026: MetricRange = { start: '2026-02-01', end: '2026-03-01' }
const FEBRUARY_2028: MetricRange = { start: '2028-02-01', end: '2028-03-01' }

describe('shifting a calendar date by months', () => {
  it('clamps to the last day of a shorter month', () => {
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28')
    expect(addMonths('2026-05-31', -1)).toBe('2026-04-30')
  })

  it('lands on the leap day when there is one', () => {
    expect(addMonths('2028-03-31', -1)).toBe('2028-02-29')
    expect(addMonths('2028-02-29', -12)).toBe('2027-02-28')
  })

  it('crosses the year boundary in both directions', () => {
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMonths('2026-06-15', -18)).toBe('2024-12-15')
  })
})

describe('recognising a whole calendar month', () => {
  it('accepts the first to the first', () => {
    expect(isWholeCalendarMonth(MARCH_2026)).toBe(true)
    expect(isWholeCalendarMonth(FEBRUARY_2028)).toBe(true)
  })

  it('rejects a range that merely looks like one', () => {
    // 1–31 March is thirty nights: the last night of the month is missing.
    expect(
      isWholeCalendarMonth({ start: '2026-03-01', end: '2026-03-31' }),
    ).toBe(false)
    expect(
      isWholeCalendarMonth({ start: '2026-03-05', end: '2026-04-05' }),
    ).toBe(false)
  })
})

describe('the previous period', () => {
  it('steps a calendar month back to the calendar month before it', () => {
    // Not "the 31 days before March", which would start on 29 January and
    // compare a month against two half-months.
    expect(previousPeriod(MARCH_2026)).toEqual(FEBRUARY_2026)
  })

  it('reports the length difference rather than smoothing it over', () => {
    expect(rangeNights(MARCH_2026)).toBe(31)
    expect(rangeNights(previousPeriod(MARCH_2026))).toBe(28)
  })

  it('steps an arbitrary range back by its own length, with no gap', () => {
    const week: MetricRange = { start: '2026-03-10', end: '2026-03-17' }
    expect(previousPeriod(week)).toEqual({
      start: '2026-03-03',
      end: '2026-03-10',
    })
  })

  it('handles a 30-day month against a 31-day one', () => {
    const april: MetricRange = { start: '2026-04-01', end: '2026-05-01' }
    expect(previousPeriod(april)).toEqual(MARCH_2026)
    expect(rangeNights(april)).toBe(30)
    expect(rangeNights(MARCH_2026)).toBe(31)
  })

  it('refuses a reversed or malformed window', () => {
    expect(() =>
      previousPeriod({ start: '2026-04-01', end: '2026-03-01' }),
    ).toThrow(InvalidRangeError)
    expect(() => previousPeriod({ start: 'March', end: '2026-03-01' })).toThrow(
      InvalidRangeError,
    )
  })
})

describe('the previous year', () => {
  it('shifts both ends back a year', () => {
    expect(previousYear(MARCH_2026)).toEqual({
      start: '2025-03-01',
      end: '2025-04-01',
    })
  })

  it('compares a leap February against a 28-night one, and says so', () => {
    const baseline = previousYear(FEBRUARY_2028)
    expect(baseline).toEqual({ start: '2027-02-01', end: '2027-03-01' })
    expect(rangeNights(FEBRUARY_2028)).toBe(29)
    expect(rangeNights(baseline)).toBe(28)
  })

  it('clamps a window that starts on the leap day itself', () => {
    expect(previousYear({ start: '2028-02-29', end: '2028-03-10' })).toEqual({
      start: '2027-02-28',
      end: '2027-03-10',
    })
  })
})

describe('choosing a baseline window', () => {
  it('returns nothing when no comparison was asked for', () => {
    expect(comparisonRange(MARCH_2026, 'none')).toBeNull()
  })

  it('returns the right window for each mode', () => {
    expect(comparisonRange(MARCH_2026, 'previous_period')).toEqual(
      FEBRUARY_2026,
    )
    expect(comparisonRange(MARCH_2026, 'previous_year')).toEqual({
      start: '2025-03-01',
      end: '2025-04-01',
    })
  })
})

// ── The comparison ────────────────────────────────────────────────────────

function compare(overrides: Partial<CompareInput> = {}) {
  return compareValues({
    basis: 'previous_period',
    range: MARCH_2026,
    baselineRange: FEBRUARY_2026,
    unit: 'percentage',
    extensive: false,
    current: 73.3,
    baseline: 70.1,
    baselineHasData: true,
    ...overrides,
  })
}

describe('comparing two windows', () => {
  it('states the delta at the precision of the unit', () => {
    const result = compare()
    expect(result.delta).toBe(3.2)
    expect(result.deltaPercent).toBe(4.6) // 3.2 ÷ 70.1 = 4.564…
    expect(result.direction).toBe('up')
  })

  it('reads a fall as a fall, whatever the metric means', () => {
    const result = compare({ current: 60, baseline: 75 })
    expect(result.delta).toBe(-15)
    expect(result.direction).toBe('down')
  })

  it('calls an unchanged figure flat, not unknown', () => {
    expect(compare({ current: 70.1 }).direction).toBe('flat')
  })

  it('keeps money in agorot', () => {
    const result = compare({
      unit: 'currency',
      current: 210_000,
      baseline: 180_000,
    })
    expect(result.delta).toBe(30_000)
    expect(result.deltaPercent).toBe(16.7)
  })
})

describe('a baseline window with no data at all', () => {
  const result = compare({ baselineHasData: false, current: 0, baseline: 0 })

  it('is not a 100% drop', () => {
    expect(result.empty).toBe(true)
    expect(result.value).toBeNull()
    expect(result.delta).toBeNull()
    expect(result.deltaPercent).toBeNull()
    expect(result.deltaPercent).not.toBe(-100)
  })

  it('has no direction, which is not the same as flat', () => {
    expect(result.direction).toBe('unknown')
  })

  it('still states which window it looked at, so the gap can be explained', () => {
    expect(result.range).toEqual(FEBRUARY_2026)
  })
})

describe('a baseline that exists but has no value', () => {
  it('withholds the delta when either side is not applicable', () => {
    const result = compare({ baseline: null })
    expect(result.value).toBeNull()
    expect(result.delta).toBeNull()
    expect(result.direction).toBe('unknown')
    expect(result.empty).toBe(false)
  })

  it('has no percentage for growth from zero', () => {
    const result = compare({ unit: 'currency', current: 5_000, baseline: 0 })
    expect(result.delta).toBe(5_000)
    // Everything is infinitely more than nothing. The absolute figure says it.
    expect(result.deltaPercent).toBeNull()
    expect(result.direction).toBe('up')
  })
})

describe('windows of different lengths', () => {
  it('marks a volume metric as not comparable', () => {
    const result = compare({ unit: 'currency', extensive: true })
    expect(result.nights).toBe(31)
    expect(result.baselineNights).toBe(28)
    expect(result.comparable).toBe(false)
  })

  it('leaves a rate comparable, because length does not change it', () => {
    expect(compare({ extensive: false }).comparable).toBe(true)
  })

  it('is comparable again when the two windows match', () => {
    const result = compare({
      range: { start: '2026-03-10', end: '2026-03-17' },
      baselineRange: { start: '2026-03-03', end: '2026-03-10' },
      unit: 'currency',
      extensive: true,
    })
    expect(result.comparable).toBe(true)
  })
})
