/**
 * Money in the finance domain, and the single rounding rule.
 *
 * The pricing engine already settled how a fraction becomes an agora: **half
 * away from zero, on the magnitude, once, at the moment the figure is
 * created**. That decision is not re-argued here and it is not re-implemented
 * here — `roundAgorot` is imported from `booking/pricing.ts` and re-exported,
 * so there is exactly one function in the product that turns a fraction into
 * money. A second implementation that agreed today would disagree the first
 * time somebody "improved" one of them.
 *
 * What this file adds is the other half of the problem. Pricing rounds a
 * percentage into a line. Finance has to *split* an amount that already exists
 * — a monthly cleaning contract across eleven bookings, a payment across three
 * instalments, a fixed cost across the nights of a stay — and a split that
 * rounds each part independently loses or invents agorot. Three ways of ₪10.00
 * is 3.34 + 3.33 + 3.33, not three times 3.33.
 *
 * ── The rule, stated once ─────────────────────────────────────────────────
 *
 *   1. Money is an integer number of agorot, always. Nothing here returns a
 *      fraction, so nothing downstream has anything left to round.
 *   2. A derived figure is rounded exactly once, where it is created, half away
 *      from zero on the magnitude (`roundAgorot`).
 *   3. A figure that is *split* is never rounded per part. It is allocated by
 *      the largest-remainder method, which is exact by construction: the parts
 *      are floors, and every leftover agora is handed to a specific part in a
 *      deterministic order. `sum(parts) === total` holds for every input, not
 *      approximately and not usually.
 *   4. Nothing is rounded twice. A total is never re-derived from rounded
 *      intermediates; it is the sum of the parts that were already integers.
 *
 * Rule 3 is why `assertSumsExactly` exists and is called on every allocation
 * this module performs. Drift is caught at the moment it is introduced, in the
 * function that introduced it, rather than three screens later as a ₪0.02
 * discrepancy nobody can explain.
 *
 * `metrics/rounding.ts` holds the same largest-remainder idea for the two
 * shapes reporting needs — an even split (`allocateEvenly`) and a set of
 * percentage shares (`allocateShares`). Finance needs a third: a split by
 * arbitrary non-negative weights. It is here rather than there because the
 * metrics module is about display precision and this one is about money that
 * has to tie out to the agora.
 */

import { roundAgorot } from '../booking/pricing'
import type { Agorot } from '../booking/types'
import { InternalError } from '../errors'
import { allocateEvenly } from '../metrics/rounding'

export { roundAgorot, allocateEvenly }

/** The only currency the product handles. Stated so a foreign amount is refusable. */
export type Currency = 'ILS'

export const CURRENCY: Currency = 'ILS'

// ── Sums ──────────────────────────────────────────────────────────────────

/** The only way a set of amounts becomes one amount. */
export function sumAgorot(values: readonly Agorot[]): Agorot {
  return values.reduce((total, value) => total + value, 0)
}

/** A percentage of an amount, rounded once, by the product's one rule. */
export function applyPercent(base: Agorot, percent: number): Agorot {
  if (!Number.isFinite(percent)) return 0
  return roundAgorot((base * percent) / 100)
}

/** Is this a legitimate money value at all? Integers only, never a float. */
export function isWholeAgorot(value: unknown): value is Agorot {
  return typeof value === 'number' && Number.isInteger(value)
}

// ── Allocation ────────────────────────────────────────────────────────────

/**
 * Split an amount across weighted parts, losing nothing.
 *
 * Each part receives `floor(|total| × weightᵢ ÷ Σweight)`, and the leftover
 * agorot — always fewer than the number of parts — go one each to the parts
 * with the largest fractional remainder, ties broken by position. That last
 * clause is what makes the answer stable: a report that reallocates its
 * rounding differently on every refresh is not a report.
 *
 * Negative totals are allocated on the magnitude and signed afterwards, for
 * the same reason `roundAgorot` works on the magnitude: a credit note and an
 * invoice must split the same way, or the business wins every coin flip.
 *
 * Degenerate inputs return zeros rather than throwing. A weight vector that
 * sums to zero — eleven bookings that all earned nothing — has no defensible
 * split, and inventing an even one would allocate a cost to bookings that
 * generated no basis for it. The caller sees the zeros, compares against the
 * total, and reports the unallocated remainder honestly. `allocateExpense`
 * does exactly that.
 */
export function allocateByWeight(
  total: Agorot,
  weights: readonly number[],
): Agorot[] {
  if (weights.length === 0) return []

  const usable = weights.every(
    (weight) => Number.isFinite(weight) && weight >= 0,
  )
  if (!usable) return weights.map(() => 0)

  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0)
  if (weightTotal <= 0 || total === 0) return weights.map(() => 0)

  const sign = total < 0 ? -1 : 1
  const magnitude = Math.abs(total)

  const exact = weights.map((weight) => (magnitude * weight) / weightTotal)
  const floors = exact.map((value) => Math.floor(value))
  const allocated = floors.reduce((sum, value) => sum + value, 0)

  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) =>
      b.remainder === a.remainder
        ? a.index - b.index
        : b.remainder - a.remainder,
    )

  const parts = [...floors]
  let leftover = magnitude - allocated
  for (const entry of order) {
    if (leftover <= 0) break
    parts[entry.index] += 1
    leftover -= 1
  }

  const signed = parts.map((part) => sign * part)
  assertSumsExactly('allocateByWeight', signed, total)
  return signed
}

/**
 * The invariant, enforced rather than hoped for.
 *
 * A 500, not a 4xx: parts that do not add to their whole is a defect in this
 * module, never something a user did. It is thrown at the point of failure so
 * the stack names the allocation that drifted, instead of surfacing as a
 * two-agora discrepancy on an owner statement a month later.
 */
export function assertSumsExactly(
  label: string,
  parts: readonly Agorot[],
  total: Agorot,
): void {
  const sum = sumAgorot(parts)
  if (sum === total) return
  throw new InternalError({
    message:
      `Money invariant broken in ${label}: ${parts.length} part(s) sum to ` +
      `${sum} agorot, but the total is ${total} agorot`,
  })
}
