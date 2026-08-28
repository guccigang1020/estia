/**
 * The vocabulary of measurement.
 *
 * One rule governs this whole directory: **a metric is defined once**. The
 * owner's dashboard, the revenue report, the owner statement and the export all
 * call the same function and receive the same number, rounded the same way. A
 * customer who finds two screens disagreeing about occupancy stops believing
 * the third, and that trust does not come back.
 *
 * So nothing outside this directory is allowed to divide revenue by nights.
 *
 * ── Two values that are not the same ──────────────────────────────────────
 *
 * `null` is not `0`. A property with no available nights has no occupancy —
 * there is no fraction to state. That is not "0% occupied", which would mean
 * the rooms stood empty. The dashboard renders the first as "—" and the second
 * as a red zero, and a formula that returns `0` for both has destroyed the
 * distinction before the interface ever sees it. Every formula here returns
 * `MetricValue`, and every division goes through `safeDivide`.
 */

import type { DateRange } from '../booking/types'
import { nightsBetween } from '../booking/types'
import { isIsoDate } from '../booking/dates'

// ── The window ────────────────────────────────────────────────────────────

/**
 * A reporting window, half-open: `[start, end)`.
 *
 * The same convention as a stay, and for the same reason. "March" is
 * `2026-03-01 → 2026-04-01`: thirty-one nights, with the first of April
 * belonging to April. Closed ranges lose or double-count a night at every
 * boundary, and a month that is one night short is a revenue report that does
 * not tie out.
 *
 * Dates are property-local calendar dates, never instants. See
 * `booking/dates.ts` — the source is responsible for converting timestamps to
 * the property's calendar date before a row reaches this layer.
 */
export interface MetricRange {
  start: string
  end: string
}

/** A window is invalid, not empty, when it is reversed or malformed. */
export class InvalidRangeError extends RangeError {
  constructor(range: MetricRange) {
    super(`Not a valid reporting window: ${range.start} → ${range.end}`)
    this.name = 'InvalidRangeError'
  }
}

export function isValidRange(range: MetricRange): boolean {
  return (
    isIsoDate(range.start) && isIsoDate(range.end) && range.start < range.end
  )
}

export function assertValidRange(range: MetricRange): void {
  if (!isValidRange(range)) throw new InvalidRangeError(range)
}

/** Nights in a window. Counted through the booking domain, not re-derived. */
export function rangeNights(range: MetricRange): number {
  assertValidRange(range)
  return nightsBetween(toDateRange(range))
}

/** A window as the booking domain spells a stay, for the shared helpers. */
export function toDateRange(range: MetricRange): DateRange {
  return { checkIn: range.start, checkOut: range.end }
}

/** Is this calendar date inside the window? Half-open, so `end` is outside. */
export function containsDate(range: MetricRange, date: string): boolean {
  return date >= range.start && date < range.end
}

// ── Values ────────────────────────────────────────────────────────────────

/**
 * The unit a metric is measured in.
 *
 * `days` and `nights` are both here and are not interchangeable. A stay is
 * measured in nights — that is what is sold. Lead time is measured in days
 * between two calendar dates and nothing is sold during them. Collapsing the
 * two would put "14 nights" on a tooltip about how far ahead people book.
 */
export type MetricUnit = 'currency' | 'percentage' | 'count' | 'nights' | 'days'

export const METRIC_UNITS: readonly MetricUnit[] = [
  'currency',
  'percentage',
  'count',
  'nights',
  'days',
]

/**
 * A measured value, or `null` for "not applicable".
 *
 * Currency values are integer agorot, as everywhere in the product.
 * Percentages are percent points to one decimal (`73.3`, not `0.733`), rounded
 * once, here, so that no screen rounds a second time and lands a tenth away
 * from the screen beside it.
 */
export type MetricValue = number | null

// ── Meaning ───────────────────────────────────────────────────────────────

/**
 * Which way is good.
 *
 * This exists because a dashboard that colours every rise green is lying about
 * half its tiles. A rise in cancellations is not good news; a fall in
 * outstanding balance is. `neutral` is a real answer — a longer average stay
 * is not obviously better than a shorter one for every business, and inventing
 * an opinion is worse than declining to have one.
 */
export type MetricSentiment = 'higher_is_better' | 'lower_is_better' | 'neutral'

/** What the interface should say about a figure. Decided by meaning, not sign. */
export type MetricState = 'positive' | 'neutral' | 'warning' | 'critical'

/**
 * Which way the number moved. `unknown` when there is nothing to compare
 * against — which is emphatically not `flat`.
 */
export type TrendDirection = 'up' | 'down' | 'flat' | 'unknown'

/**
 * A figure that crosses this line means something regardless of last month.
 *
 * Stated in the metric's own unit: percent points for a percentage, agorot for
 * currency. Thresholds beat trend, because 8% occupancy is critical even when
 * it doubled from 4%.
 */
export interface MetricThresholds {
  warningAbove?: number
  criticalAbove?: number
  warningBelow?: number
  criticalBelow?: number
}
