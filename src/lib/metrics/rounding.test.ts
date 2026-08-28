/**
 * Rounding, and the drift it is there to prevent.
 *
 * The interesting assertions here are the ones about sums. A single rounded
 * value being one agora out is invisible; a breakdown that adds to 101%, or a
 * per-night split that adds to a shekel more than the guest was charged, is the
 * thing a customer photographs and sends to support.
 */

import { describe, expect, it } from 'vitest'
import {
  agorotPer,
  allocateEvenly,
  allocateShares,
  averagePer,
  percentOf,
  roundAgorot,
  roundForUnit,
  roundPercent,
  roundTo,
  safeDivide,
} from './rounding'

describe('rounding money', () => {
  it('rounds half away from zero, symmetrically', () => {
    expect(roundAgorot(0.5)).toBe(1)
    expect(roundAgorot(2.5)).toBe(3)
    // Math.round would give -2 here, so a refund would round the other way
    // from the charge it reverses.
    expect(roundAgorot(-0.5)).toBe(-1)
    expect(roundAgorot(-2.5)).toBe(-3)
  })

  it('leaves an integer alone', () => {
    expect(roundAgorot(12_345)).toBe(12_345)
  })
})

describe('rounding percentages', () => {
  it('keeps one decimal', () => {
    expect(roundPercent(73.25)).toBe(73.3)
    expect(roundPercent(66.6666)).toBe(66.7)
    expect(roundPercent(0.04)).toBe(0)
  })

  it('rounds a delta to the precision of the unit it belongs to', () => {
    // 73.3 − 70.1 is 3.2000000000000028 in binary floating point.
    expect(roundForUnit('percentage', 73.3 - 70.1)).toBe(3.2)
    expect(roundForUnit('currency', 1_234.6)).toBe(1_235)
    expect(roundForUnit('nights', 3.449)).toBe(3.4)
  })

  it('rounds to an arbitrary precision', () => {
    expect(roundTo(3.14159, 2)).toBe(3.14)
    expect(roundTo(-3.15, 1)).toBe(-3.2)
  })
})

describe('dividing by nothing', () => {
  it('answers null, not zero and not NaN', () => {
    expect(safeDivide(10, 0)).toBeNull()
    expect(percentOf(10, 0)).toBeNull()
    expect(agorotPer(10, 0)).toBeNull()
    expect(averagePer(10, 0)).toBeNull()
  })

  it('answers null for a nonsense input rather than propagating NaN', () => {
    expect(safeDivide(Number.NaN, 4)).toBeNull()
    expect(safeDivide(4, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('still answers zero when zero is the measurement', () => {
    // The whole point of the distinction: no sales out of ten nights is 0%,
    // and no nights at all is null. A dashboard renders them differently.
    expect(percentOf(0, 10)).toBe(0)
    expect(agorotPer(0, 10)).toBe(0)
  })
})

describe('allocating an amount across nights', () => {
  it('loses nothing to rounding', () => {
    const parts = allocateEvenly(100_001, 3)
    expect(parts).toEqual([33_334, 33_334, 33_333])
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(100_001)
  })

  it('splits evenly when it divides evenly', () => {
    expect(allocateEvenly(90_000, 3)).toEqual([30_000, 30_000, 30_000])
  })

  it('handles a negative amount without flipping the shortfall', () => {
    const parts = allocateEvenly(-1_000, 3)
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(-1_000)
  })

  it('refuses a nonsensical number of slots instead of guessing', () => {
    expect(allocateEvenly(1_000, 0)).toEqual([])
    expect(allocateEvenly(1_000, -2)).toEqual([])
  })

  it.each([
    [1, 7],
    [99_999, 7],
    [123_457, 13],
    [1, 365],
    [-500_003, 11],
  ])('allocates %i across %i slots without drift', (total, slots) => {
    const parts = allocateEvenly(total, slots)
    expect(parts).toHaveLength(slots)
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(total)
    expect(parts.every((part) => Number.isInteger(part))).toBe(true)
  })
})

describe('a set of parts always adds to its whole', () => {
  /**
   * Summed in tenths rather than as decimals.
   *
   * `33.4 + 33.3 + 33.3` is 99.99999999999999 in floating point — which is the
   * reason the shares are computed in integer tenths in the first place, and
   * checking them as decimals would be checking the wrong thing.
   */
  const sumTenths = (shares: readonly number[]): number =>
    shares.reduce((sum, share) => sum + Math.round(share * 10), 0)

  it('gives the odd tenth to one part, not to all of them', () => {
    expect(allocateShares([1, 1, 1])).toEqual([33.4, 33.3, 33.3])
  })

  it.each([
    [[1, 1, 1]],
    [[1, 1, 1, 1, 1, 1, 1]],
    [[100_000, 90_000, 20_000]],
    [[1, 999_999]],
    [[3, 3, 3, 1]],
    [[0, 5, 5]],
    [[12_345, 67_890, 1, 2, 3, 4]],
  ])('adds to exactly 100.0 for %j', (parts) => {
    const shares = allocateShares(parts)
    expect(shares).not.toBeNull()
    expect(sumTenths(shares ?? [])).toBe(1_000)
  })

  it('has no mix to report when there is nothing to divide', () => {
    expect(allocateShares([])).toBeNull()
    expect(allocateShares([0, 0])).toBeNull()
  })

  it('declines rather than inventing a share above 100 beside a negative one', () => {
    expect(allocateShares([-1_000, 5_000])).toBeNull()
  })
})
