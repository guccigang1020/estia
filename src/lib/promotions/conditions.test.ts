import { describe, expect, it } from 'vitest'

import { MAX_CONDITION_DEPTH, evaluateCondition } from './conditions'
import {
  NO_CONDITION,
  type PromotionCondition,
  type PromotionFacts,
} from './types'

function facts(over: Partial<PromotionFacts> = {}): PromotionFacts {
  return {
    measures: { nights: 3, guests: 4, adults: 4, children: 0, booking: 1 },
    advanceDays: 30,
    nightWeekdays: [0, 1, 2],
    source: 'direct_website',
    completedBookings: 0,
    ...over,
  }
}

describe('a condition that cannot be decided is not met', () => {
  it('refuses a comparison whose fact was never measured, rather than reading it as zero', () => {
    const condition: PromotionCondition = {
      kind: 'compare',
      basis: 'nights',
      comparator: 'lte',
      value: 2,
    }
    // `nights <= 2` would be TRUE against a defaulted zero, and the guest
    // would get a short-stay discount because nobody counted the nights.
    const result = evaluateCondition(condition, facts({ measures: {} }))
    expect(result.met).toBe(false)
    expect(result.met === false && result.because).toEqual({
      reason: 'fact_absent',
      fact: 'nights',
    })
  })

  it('refuses an advance-days condition when the booking date is unknown', () => {
    const result = evaluateCondition(
      { kind: 'advance', comparator: 'gte', days: 90 },
      facts({ advanceDays: null }),
    )
    expect(result.met === false && result.because.reason).toBe('fact_absent')
  })

  it('refuses a repeat-guest condition when the history was not counted', () => {
    const result = evaluateCondition(
      { kind: 'guest_history', minCompletedBookings: 1 },
      facts({ completedBookings: null }),
    )
    expect(result.met === false && result.because.reason).toBe('fact_absent')
  })

  it('does not let a negation rescue a missing fact', () => {
    // `not(nights >= 5)` on a booking whose nights were never counted is still
    // undecidable. Reporting it as met would give the discount away on
    // missing data, through the back door.
    const result = evaluateCondition(
      {
        kind: 'not',
        of: { kind: 'compare', basis: 'nights', comparator: 'gte', value: 5 },
      },
      facts({ measures: {} }),
    )
    expect(result.met).toBe(false)
    expect(result.met === false && result.because.reason).toBe('fact_absent')
  })

  it('does not let an any-branch turn a missing fact into a match', () => {
    const result = evaluateCondition(
      {
        kind: 'any',
        of: [
          { kind: 'compare', basis: 'nights', comparator: 'gte', value: 5 },
          { kind: 'source', anyOf: ['airbnb'] },
        ],
      },
      facts({ measures: {}, source: 'direct_website' }),
    )
    expect(result.met).toBe(false)
  })
})

describe('the six shapes of the closed language', () => {
  it('runs long stay', () => {
    const condition: PromotionCondition = {
      kind: 'compare',
      basis: 'nights',
      comparator: 'gte',
      value: 5,
    }
    expect(evaluateCondition(condition, facts()).met).toBe(false)
    expect(
      evaluateCondition(condition, facts({ measures: { nights: 5 } })).met,
    ).toBe(true)
  })

  it('runs early bird from the advance days it was given', () => {
    const condition: PromotionCondition = {
      kind: 'advance',
      comparator: 'gte',
      days: 90,
    }
    expect(evaluateCondition(condition, facts({ advanceDays: 89 })).met).toBe(
      false,
    )
    expect(evaluateCondition(condition, facts({ advanceDays: 90 })).met).toBe(
      true,
    )
  })

  it('runs last minute, which is the same shape with the comparator turned round', () => {
    const condition: PromotionCondition = {
      kind: 'advance',
      comparator: 'lte',
      days: 3,
    }
    expect(evaluateCondition(condition, facts({ advanceDays: 3 })).met).toBe(
      true,
    )
    expect(evaluateCondition(condition, facts({ advanceDays: 4 })).met).toBe(
      false,
    )
  })

  it('requires EVERY night to be midweek, not just one of them', () => {
    const condition: PromotionCondition = {
      kind: 'weekday_set',
      allOf: [0, 1, 2, 3],
    }
    expect(
      evaluateCondition(condition, facts({ nightWeekdays: [0, 1, 2] })).met,
    ).toBe(true)
    // Sunday, Monday and Friday: one weekend night makes the stay not midweek.
    expect(
      evaluateCondition(condition, facts({ nightWeekdays: [0, 1, 5] })).met,
    ).toBe(false)
  })

  it('runs the direct-booking channel test', () => {
    const condition: PromotionCondition = {
      kind: 'source',
      anyOf: ['direct_website', 'direct_manual'],
    }
    expect(evaluateCondition(condition, facts()).met).toBe(true)
    expect(evaluateCondition(condition, facts({ source: 'airbnb' })).met).toBe(
      false,
    )
  })

  it('runs the repeat guest test against this organization only', () => {
    const condition: PromotionCondition = {
      kind: 'guest_history',
      minCompletedBookings: 1,
    }
    expect(
      evaluateCondition(condition, facts({ completedBookings: 0 })).met,
    ).toBe(false)
    expect(
      evaluateCondition(condition, facts({ completedBookings: 1 })).met,
    ).toBe(true)
  })

  it('composes with all, any and not', () => {
    const condition: PromotionCondition = {
      kind: 'all',
      of: [
        { kind: 'compare', basis: 'nights', comparator: 'gte', value: 3 },
        {
          kind: 'any',
          of: [
            { kind: 'source', anyOf: ['direct_website'] },
            { kind: 'source', anyOf: ['direct_manual'] },
          ],
        },
        { kind: 'not', of: { kind: 'source', anyOf: ['airbnb'] } },
      ],
    }
    expect(evaluateCondition(condition, facts()).met).toBe(true)
    expect(evaluateCondition(condition, facts({ source: 'airbnb' })).met).toBe(
      false,
    )
  })

  it('treats a campaign with no condition as applying to everybody', () => {
    // The empty conjunction. Vacuously true, and deliberately spelled that way
    // rather than as null, so no reader has to remember a null case.
    expect(evaluateCondition(NO_CONDITION, facts()).met).toBe(true)
  })
})

describe('a condition the evaluator cannot run says so instead of guessing', () => {
  it('refuses an empty any, which would be vacuously false and look like an empty all', () => {
    const result = evaluateCondition({ kind: 'any', of: [] }, facts())
    expect(result.met === false && result.because.reason).toBe('malformed')
  })

  it('refuses a weekday set that names no days, which would always be true', () => {
    const result = evaluateCondition(
      { kind: 'weekday_set', allOf: [] },
      facts(),
    )
    expect(result.met === false && result.because.reason).toBe('malformed')
  })

  it('refuses a weekday outside 0 to 6', () => {
    const result = evaluateCondition(
      { kind: 'weekday_set', allOf: [0, 9] },
      facts(),
    )
    expect(result.met === false && result.because.reason).toBe('malformed')
  })

  it('refuses a channel that is not a booking source', () => {
    const result = evaluateCondition(
      { kind: 'source', anyOf: ['carrier_pigeon' as 'airbnb'] },
      facts(),
    )
    expect(result.met === false && result.because.reason).toBe('malformed')
  })

  it('refuses a threshold that is not a finite number, without coercing it', () => {
    const result = evaluateCondition(
      {
        kind: 'compare',
        basis: 'nights',
        comparator: 'gte',
        value: '5' as unknown as number,
      },
      facts(),
    )
    expect(result.met === false && result.because.reason).toBe('malformed')
  })

  it('refuses a kind no version of this evaluator has shipped', () => {
    const result = evaluateCondition(
      {
        kind: 'sql',
        run: 'drop table bookings',
      } as unknown as PromotionCondition,
      facts(),
    )
    expect(result.met).toBe(false)
    expect(result.met === false && result.because.reason).toBe('malformed')
  })

  it('refuses a tree nested past the readable limit', () => {
    let condition: PromotionCondition = {
      kind: 'compare',
      basis: 'nights',
      comparator: 'gte',
      value: 1,
    }
    for (let level = 0; level <= MAX_CONDITION_DEPTH; level += 1) {
      condition = { kind: 'all', of: [condition] }
    }
    const result = evaluateCondition(condition, facts())
    expect(result.met).toBe(false)
    expect(result.met === false && result.because.reason).toBe('malformed')
  })

  it('still runs a tree exactly at the limit', () => {
    let condition: PromotionCondition = {
      kind: 'compare',
      basis: 'nights',
      comparator: 'gte',
      value: 1,
    }
    for (let level = 0; level < MAX_CONDITION_DEPTH; level += 1) {
      condition = { kind: 'all', of: [condition] }
    }
    expect(evaluateCondition(condition, facts()).met).toBe(true)
  })
})
