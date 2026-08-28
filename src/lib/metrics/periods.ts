/**
 * "Compared to what?"
 *
 * Every figure on a dashboard is meaningless alone, and every comparison is a
 * chance to lie. Three cases break naive arithmetic, and all three are handled
 * here rather than in whichever screen happens to draw the arrow.
 *
 * **A 31-day month against a 30-day one.** If the user picked March, they mean
 * February — not "the 31 days before March", which starts in the middle of
 * February and compares a month against a fortnight of two months. So a window
 * that is exactly a calendar month compares against the previous calendar
 * month, and the length difference is *reported* rather than hidden: February
 * earns less than March because it is three nights shorter, and a dashboard
 * that shows −10% without saying so has manufactured a crisis. Extensive
 * metrics carry `comparable: false` when the lengths differ.
 *
 * **A leap day.** February 2028 has 29 nights and February 2027 has 28. Shifting
 * a year back from the 29th lands on a date that does not exist, so the shift
 * clamps to the last day of the month — and the resulting length difference is
 * again reported, not smoothed over.
 *
 * **A comparison window with no data at all.** A property that did not exist
 * last year did not suffer a 100% collapse. When the baseline window holds no
 * rows, the comparison is `null` in every field and the direction is `unknown`.
 * That is the difference between "we cannot say" and "it went to zero", and on
 * a screen those are opposite messages.
 */

import { addDays, parseIsoDate } from '../booking/dates'
import { roundForUnit, roundPercent, safeDivide } from './rounding'
import {
  assertValidRange,
  rangeNights,
  type MetricRange,
  type MetricUnit,
  type MetricValue,
  type TrendDirection,
} from './types'

// ── Modes ─────────────────────────────────────────────────────────────────

export type ComparisonBasis = 'previous_period' | 'previous_year'

export type ComparisonMode = 'none' | ComparisonBasis

// ── Calendar arithmetic ───────────────────────────────────────────────────

/**
 * Shift a calendar date by whole months, clamping the day.
 *
 * 31 March minus one month is 28 or 29 February, never "3 March" — which is
 * what day-based arithmetic produces and what makes a monthly comparison drift
 * a little further wrong every month.
 */
export function addMonths(value: string, delta: number): string {
  const date = parseIsoDate(value)
  if (!date) throw new RangeError(`Not an ISO date: ${value}`)

  const year = date.getUTCFullYear()
  const monthIndex = date.getUTCMonth() + delta
  const targetYear = year + Math.floor(monthIndex / 12)
  const targetMonth = ((monthIndex % 12) + 12) % 12

  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate()
  const day = Math.min(date.getUTCDate(), lastDay)

  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Is this window exactly one calendar month, first to first? */
export function isWholeCalendarMonth(range: MetricRange): boolean {
  assertValidRange(range)
  return range.start.endsWith('-01') && addMonths(range.start, 1) === range.end
}

/**
 * The window immediately before this one.
 *
 * A calendar month steps back a calendar month. Anything else steps back its
 * own length, ending exactly where the requested window begins — a fortnight
 * compares against the fortnight before it, with no gap and no overlap.
 */
export function previousPeriod(range: MetricRange): MetricRange {
  assertValidRange(range)
  if (isWholeCalendarMonth(range)) {
    return { start: addMonths(range.start, -1), end: range.start }
  }
  return { start: addDays(range.start, -rangeNights(range)), end: range.start }
}

/** The same dates a year earlier, with the leap day clamped to 28 February. */
export function previousYear(range: MetricRange): MetricRange {
  assertValidRange(range)
  const shifted = {
    start: addMonths(range.start, -12),
    end: addMonths(range.end, -12),
  }
  assertValidRange(shifted)
  return shifted
}

/** The baseline window for a mode, or `null` when no comparison was asked for. */
export function comparisonRange(
  range: MetricRange,
  mode: ComparisonMode,
): MetricRange | null {
  switch (mode) {
    case 'previous_period':
      return previousPeriod(range)
    case 'previous_year':
      return previousYear(range)
    case 'none':
    default:
      return null
  }
}

// ── The comparison itself ─────────────────────────────────────────────────

export interface MetricComparison {
  basis: ComparisonBasis
  /** The window the baseline was measured over. Always stated, never implied. */
  range: MetricRange
  /** The baseline figure. `null` when there is no baseline to state. */
  value: MetricValue
  /** Current minus baseline, at the unit's own precision. */
  delta: MetricValue
  /** The change as a percentage of the baseline. `null` when growth is from zero. */
  deltaPercent: MetricValue
  direction: TrendDirection
  /** The baseline window held no rows at all. */
  empty: boolean
  /**
   * The two windows are like for like.
   *
   * `false` when the metric grows with the length of the window and the two
   * windows are different lengths — February against March. The number is still
   * shown; the interface must not draw a conclusion from it.
   */
  comparable: boolean
  nights: number
  baselineNights: number
}

export interface CompareInput {
  basis: ComparisonBasis
  range: MetricRange
  baselineRange: MetricRange
  unit: MetricUnit
  /** Does the figure grow simply because the window is longer? */
  extensive: boolean
  current: MetricValue
  baseline: MetricValue
  /** Did the source return anything at all for the baseline window? */
  baselineHasData: boolean
}

export function compareValues(input: CompareInput): MetricComparison {
  const nights = rangeNights(input.range)
  const baselineNights = rangeNights(input.baselineRange)
  const comparable = !input.extensive || nights === baselineNights

  const skeleton = {
    basis: input.basis,
    range: input.baselineRange,
    nights,
    baselineNights,
    comparable,
  }

  // No data is not a zero. Everything downstream — the delta, the arrow, the
  // colour — is withheld rather than computed from a baseline that does not
  // exist.
  if (!input.baselineHasData) {
    return {
      ...skeleton,
      value: null,
      delta: null,
      deltaPercent: null,
      direction: 'unknown',
      empty: true,
    }
  }

  const { current, baseline } = input
  if (current === null || baseline === null) {
    return {
      ...skeleton,
      value: baseline,
      delta: null,
      deltaPercent: null,
      direction: 'unknown',
      empty: false,
    }
  }

  const delta = roundForUnit(input.unit, current - baseline)

  // Growth from nothing has no percentage: everything is infinitely more than
  // zero. The absolute delta says it better, and "+∞%" says nothing at all.
  const ratio = safeDivide(delta, Math.abs(baseline))

  return {
    ...skeleton,
    value: baseline,
    delta,
    deltaPercent: ratio === null ? null : roundPercent(ratio * 100),
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    empty: false,
  }
}
