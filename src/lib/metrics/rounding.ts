/**
 * Rounding, and where it is allowed to happen.
 *
 * Two rules, both of which exist because of the same customer conversation.
 *
 * **1. Rounding happens once, inside the metric.** The value that leaves this
 * directory is already at display precision. A screen that rounds again cannot
 * disagree with another screen, because there is nothing left to round. The
 * moment two components each hold a raw float and each call `toFixed(1)` with
 * different intermediate arithmetic, one shows 73.2 and the other 73.3, and the
 * customer is right to ask which is true.
 *
 * **2. Parts sum to the whole, exactly.** Percentages that add to 101%, or a
 * per-night breakdown that adds to a shekel more than the booking, are small
 * errors with a large effect: they are the visible end of "this system cannot
 * count". Both allocators here use the largest-remainder method, which
 * distributes the leftover deterministically instead of hoping it cancels out.
 */

import type { Agorot } from '../booking/types'
import type { MetricUnit, MetricValue } from './types'

/** Display precision for a percentage. One decimal: `73.3%`. */
export const PERCENT_DECIMALS = 1

const PERCENT_SCALE = 10 ** PERCENT_DECIMALS

/** Percent points in a whole, at display precision. 100.0% as tenths. */
const WHOLE_IN_TENTHS = 100 * PERCENT_SCALE

/**
 * Round half away from zero.
 *
 * `Math.round` rounds half *up*, so it turns −0.5 into −0 and 0.5 into 1 —
 * asymmetric, which for a refund or a negative adjustment means the sign of the
 * amount decides the direction of the error. Money should not behave
 * differently on the way out than on the way in.
 */
function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) return value
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/** An agorot amount, as an integer. The only place a money float collapses. */
export function roundAgorot(value: number): Agorot {
  return roundHalfAwayFromZero(value)
}

/** A percentage at display precision. Input is already in percent points. */
export function roundPercent(value: number): number {
  return roundHalfAwayFromZero(value * PERCENT_SCALE) / PERCENT_SCALE
}

/** Round to a fixed number of decimals — for averages measured in days or nights. */
export function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals
  return roundHalfAwayFromZero(value * scale) / scale
}

// ── Division ──────────────────────────────────────────────────────────────

/**
 * Divide, or answer that the question does not apply.
 *
 * A zero denominator is a state, not an error: a property with no available
 * nights has no occupancy and no RevPAR, and a property that took no bookings
 * has no average booking value. Returning `0` would claim the business
 * performed badly; returning `NaN` would put the word "NaN" on a customer's
 * screen. Both are worse than saying nothing, which is what `null` says.
 */
export function safeDivide(
  numerator: number,
  denominator: number,
): MetricValue {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null
  if (denominator === 0) return null
  return numerator / denominator
}

/** A ratio as percent points at display precision, or `null` if undefined. */
export function percentOf(part: number, whole: number): MetricValue {
  const ratio = safeDivide(part, whole)
  return ratio === null ? null : roundPercent(ratio * 100)
}

/** A quotient in agorot, or `null`. For ADR, RevPAR and average value. */
export function agorotPer(total: Agorot, count: number): MetricValue {
  const quotient = safeDivide(total, count)
  return quotient === null ? null : roundAgorot(quotient)
}

/**
 * Round a derived figure to the precision its unit is displayed at.
 *
 * Subtracting two values that are each already at display precision does not
 * stay there: `73.3 − 70.1` is `3.2000000000000028` in binary floating point,
 * and that is what would reach the screen beside a tidy "73.3%". A delta is a
 * displayed value too, so it rounds like one.
 */
export function roundForUnit(unit: MetricUnit, value: number): number {
  switch (unit) {
    case 'currency':
      return roundAgorot(value)
    case 'percentage':
      return roundPercent(value)
    case 'count':
      return roundAgorot(value)
    case 'nights':
    case 'days':
    default:
      return roundTo(value, 1)
  }
}

/** A quotient of days or nights at one decimal, or `null`. */
export function averagePer(total: number, count: number): MetricValue {
  const quotient = safeDivide(total, count)
  return quotient === null ? null : roundTo(quotient, 1)
}

// ── Allocation ────────────────────────────────────────────────────────────

/**
 * Split an amount evenly across `slots`, losing nothing.
 *
 * Used to recognise a stay's revenue night by night. A ₪1,000 stay over three
 * nights is 33,334 + 33,333 + 33,333 agorot, not three times 33,333 with an
 * agora quietly discarded — and when the reporting window covers all three
 * nights the parts add back to exactly what the guest was charged.
 *
 * The remainder goes to the earliest nights, deterministically. Which night
 * receives it does not matter; that the same night receives it on every run
 * does, because a report that changes when you refresh it is not a report.
 */
export function allocateEvenly(total: Agorot, slots: number): Agorot[] {
  if (!Number.isInteger(slots) || slots <= 0) return []
  const sign = total < 0 ? -1 : 1
  const magnitude = Math.abs(total)
  const base = Math.floor(magnitude / slots)
  const remainder = magnitude - base * slots

  const parts: Agorot[] = new Array<Agorot>(slots)
  for (let index = 0; index < slots; index += 1) {
    parts[index] = sign * (base + (index < remainder ? 1 : 0))
  }
  return parts
}

/**
 * Turn parts into percentages that add to exactly 100.0.
 *
 * Three sources at a third each are 33.3 + 33.3 + 33.4, not 33.3 three times.
 * The largest remainder goes to the part that was cut hardest, so the mix on
 * screen is both correct and stable.
 *
 * Returns `null` rather than a mix when there is nothing to divide:
 *
 *   · a total of zero — no revenue means no source mix, not an even split;
 *   · a negative part — a source in net refund has no meaningful share of a
 *     positive whole, and forcing one produces shares above 100% beside
 *     negative ones. The dashboard must show the amounts instead.
 */
export function allocateShares(
  parts: readonly number[],
): readonly number[] | null {
  if (parts.length === 0) return null
  if (parts.some((part) => part < 0 || !Number.isFinite(part))) return null

  const total = parts.reduce((sum, part) => sum + part, 0)
  if (total <= 0) return null

  const exact = parts.map((part) => (part / total) * WHOLE_IN_TENTHS)
  const floors = exact.map((value) => Math.floor(value))
  const allocated = floors.reduce((sum, value) => sum + value, 0)

  // Hand the leftover tenths to the largest fractional remainders first, ties
  // broken by position so the answer is deterministic.
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) =>
      b.remainder === a.remainder
        ? a.index - b.index
        : b.remainder - a.remainder,
    )

  const shares = [...floors]
  let leftover = WHOLE_IN_TENTHS - allocated
  for (const entry of order) {
    if (leftover <= 0) break
    shares[entry.index] += 1
    leftover -= 1
  }

  return shares.map((tenths) => tenths / PERCENT_SCALE)
}
