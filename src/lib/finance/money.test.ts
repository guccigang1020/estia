import { describe, expect, it } from 'vitest'

import { InternalError } from '../errors'
import {
  allocateByWeight,
  allocateEvenly,
  applyPercent,
  assertSumsExactly,
  isWholeAgorot,
  roundAgorot,
  sumAgorot,
} from './money'

/**
 * The rounding rule, proved rather than asserted.
 *
 * The claim this module makes is strong — "parts sum to the whole, exactly,
 * for every input" — and a handful of examples cannot support it. So the
 * exactness tests sweep hundreds of combinations of night counts, split counts
 * and weights, which is the only honest way to make a claim of that shape.
 */
describe('roundAgorot — half away from zero, on the magnitude', () => {
  it('rounds a half up in magnitude, whichever way it points', () => {
    expect(roundAgorot(50.5)).toBe(51)
    expect(roundAgorot(-50.5)).toBe(-51)
    expect(roundAgorot(0.5)).toBe(1)
    expect(roundAgorot(-0.5)).toBe(-1)
  })

  it('treats a discount and a fee of the same size identically', () => {
    // The house must not win both coin flips. `Math.round(-50.5)` is -50,
    // which would shave the guest's half-agora and round the business's up.
    for (const value of [0.5, 1.5, 2.5, 12.5, 99.5]) {
      expect(roundAgorot(-value)).toBe(-roundAgorot(value))
    }
  })

  it('never returns negative zero', () => {
    expect(Object.is(roundAgorot(-0.4), 0)).toBe(true)
  })
})

describe('applyPercent', () => {
  it('rounds once, by the product rule', () => {
    expect(applyPercent(10_101, 50)).toBe(5051)
    expect(applyPercent(100_000, 18)).toBe(18_000)
    expect(applyPercent(-10_101, 50)).toBe(-5051)
  })

  it('answers zero for a percentage that is not a number', () => {
    expect(applyPercent(10_000, Number.NaN)).toBe(0)
  })
})

describe('isWholeAgorot', () => {
  it('refuses a fraction of an agora', () => {
    expect(isWholeAgorot(500)).toBe(true)
    expect(isWholeAgorot(500.5)).toBe(false)
    expect(isWholeAgorot('500')).toBe(false)
  })
})

describe('allocateByWeight — hand-worked cases', () => {
  it('splits ₪10.00 three ways as 3.34 + 3.33 + 3.33', () => {
    expect(allocateByWeight(1000, [1, 1, 1])).toEqual([334, 333, 333])
  })

  it('splits by weight when the weights differ', () => {
    expect(allocateByWeight(1000, [3, 1])).toEqual([750, 250])
    expect(allocateByWeight(1000, [1, 2, 7])).toEqual([100, 200, 700])
  })

  it('gives the leftover to the largest remainder, ties by position', () => {
    // 100 over weights 1,1,1,1,1,1,1 → 14.28… each. Floors are 14, allocated
    // 98, so two agorot go to the first two positions.
    expect(allocateByWeight(100, [1, 1, 1, 1, 1, 1, 1])).toEqual([
      15, 15, 14, 14, 14, 14, 14,
    ])
  })

  it('allocates a negative total on its magnitude and signs it back', () => {
    expect(allocateByWeight(-1000, [1, 1, 1])).toEqual([-334, -333, -333])
  })

  it('allocates nothing when there is no weight to divide by', () => {
    expect(allocateByWeight(1000, [0, 0])).toEqual([0, 0])
    expect(allocateByWeight(1000, [])).toEqual([])
  })

  it('refuses to guess at a negative or non-finite weight', () => {
    expect(allocateByWeight(1000, [1, -1])).toEqual([0, 0])
    expect(allocateByWeight(1000, [1, Number.NaN])).toEqual([0, 0])
  })

  it('is deterministic — the same input gives the same split every time', () => {
    const first = allocateByWeight(9_999_991, [7, 3, 11, 1])
    for (let run = 0; run < 20; run += 1) {
      expect(allocateByWeight(9_999_991, [7, 3, 11, 1])).toEqual(first)
    }
  })
})

describe('allocateByWeight — exactness across many shapes', () => {
  it('sums to the total for every night count from 1 to 60', () => {
    for (let nights = 1; nights <= 60; nights += 1) {
      const total = 100_000 * nights + 12_345
      const weights = Array.from({ length: nights }, (_, i) => i + 1)
      expect(sumAgorot(allocateByWeight(total, weights))).toBe(total)
    }
  })

  it('sums to the total for every split count from 1 to 12', () => {
    // A stay's total split into instalments, across every awkward amount.
    for (const total of [1, 7, 99, 100, 333, 1000, 100_001, 999_999]) {
      for (let parts = 1; parts <= 12; parts += 1) {
        const weights = new Array<number>(parts).fill(1)
        expect(sumAgorot(allocateByWeight(total, weights))).toBe(total)
        expect(sumAgorot(allocateEvenly(total, parts))).toBe(total)
      }
    }
  })

  it('sums to the total for lopsided weights', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const weights = [seed, seed * 3 + 1, 1, seed % 7, 11]
      const total = 7 * seed + 1
      expect(sumAgorot(allocateByWeight(total, weights))).toBe(total)
    }
  })

  it('never allocates more to a part than the whole', () => {
    const parts = allocateByWeight(1000, [1, 0, 0])
    expect(parts).toEqual([1000, 0, 0])
  })
})

describe('assertSumsExactly', () => {
  it('passes silently when the parts add up', () => {
    expect(() => assertSumsExactly('t', [334, 333, 333], 1000)).not.toThrow()
  })

  it('is an internal failure, not a user error, when they do not', () => {
    // Drift is a defect in this module. It must never be reported to a
    // hotelier as though they did something wrong.
    try {
      assertSumsExactly('t', [333, 333, 333], 1000)
      expect.unreachable('expected the invariant to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(InternalError)
      expect((error as InternalError).status).toBe(500)
      expect((error as InternalError).dataOutcome).toBe('unknown')
    }
  })
})
