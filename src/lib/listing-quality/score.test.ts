import { describe, expect, it } from 'vitest'

import { scoreOf, weakestFirst, whatToFixFirst } from './score'
import type { ListingCheck } from './types'

const check = (over: Partial<ListingCheck> = {}): ListingCheck => ({
  code: 'x',
  area: 'description',
  status: 'pass',
  weight: 1,
  observed: null,
  ...over,
})

describe('what a score counts', () => {
  it('is the share of weight earned', () => {
    const result = scoreOf([
      check({ status: 'pass', weight: 3 }),
      check({ status: 'warn', weight: 1 }),
    ])
    expect(result.score).toBe(75)
    expect(result.assessed).toBe(2)
  })

  it('excludes not_assessed from BOTH sides of the fraction', () => {
    // Counting it as a failure punishes a business for a measurement this
    // product cannot take. Counting it as a pass inflates every score by the
    // same amount and makes the number meaningless.
    const withUnmeasurable = scoreOf([
      check({ status: 'pass', weight: 3 }),
      check({ status: 'warn', weight: 1 }),
      check({ status: 'not_assessed', weight: 0 }),
      check({ status: 'not_assessed', weight: 0 }),
    ])

    expect(withUnmeasurable.score).toBe(75)
    expect(withUnmeasurable.assessed).toBe(2)
    expect(withUnmeasurable.notAssessed).toBe(2)
  })

  it('reports how many were skipped, so two 80s are distinguishable', () => {
    // 80 over eight checks and 80 over twelve are different facts.
    const narrow = scoreOf([
      check({ status: 'pass', weight: 4 }),
      check({ status: 'warn', weight: 1 }),
      check({ status: 'not_assessed', weight: 0 }),
    ])
    const wide = scoreOf([
      check({ status: 'pass', weight: 4 }),
      check({ status: 'warn', weight: 1 }),
    ])

    expect(narrow.score).toBe(wide.score)
    expect(narrow.notAssessed).toBe(1)
    expect(wide.notAssessed).toBe(0)
  })

  it('says zero-assessed rather than pretending to a zero score', () => {
    const blind = scoreOf([
      check({ status: 'not_assessed', weight: 0 }),
      check({ status: 'not_assessed', weight: 0 }),
    ])
    // The number is 0, but `assessed: 0` is what a reader must key off:
    // "nothing could be judged" and "this listing is terrible" must not look
    // the same.
    expect(blind).toEqual({ score: 0, assessed: 0, notAssessed: 2 })
  })

  it('gives a perfect listing 100 and an empty one 0', () => {
    expect(scoreOf([check({ status: 'pass', weight: 2 })]).score).toBe(100)
    expect(scoreOf([check({ status: 'warn', weight: 2 })]).score).toBe(0)
  })
})

describe('what to fix first', () => {
  it('is failures only, heaviest first', () => {
    const ordered = whatToFixFirst([
      check({ code: 'light', status: 'warn', weight: 1 }),
      check({ code: 'heavy', status: 'warn', weight: 3 }),
      check({ code: 'passing', status: 'pass', weight: 5 }),
    ])
    expect(ordered.map((c) => c.code)).toEqual(['heavy', 'light'])
  })

  it('never lists something nobody can fix', () => {
    const ordered = whatToFixFirst([
      check({ code: 'rating', status: 'not_assessed', weight: 0 }),
      check({ code: 'photos', status: 'warn', weight: 2 }),
    ])
    expect(ordered.map((c) => c.code)).toEqual(['photos'])
  })

  it('is bounded, because a list of twenty is a list nobody starts', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      check({ code: `c${i}`, status: 'warn', weight: 1 }),
    )
    expect(whatToFixFirst(many)).toHaveLength(5)
    expect(whatToFixFirst(many, 2)).toHaveLength(2)
  })
})

describe('which listing to open first', () => {
  it('puts the weakest measurable listing at the top', () => {
    const reports = [
      { id: 'good', score: { score: 90, assessed: 8, notAssessed: 0 } },
      { id: 'weak', score: { score: 40, assessed: 8, notAssessed: 0 } },
    ]
    expect(weakestFirst(reports).map((r) => r.id)).toEqual(['weak', 'good'])
  })

  it('sorts a listing it cannot judge LAST, not first', () => {
    // Its score is zero, but it is not the worst listing — it is the one the
    // product knows least about, and sending somebody to work on it would
    // waste the twenty minutes they had.
    const reports = [
      { id: 'blind', score: { score: 0, assessed: 0, notAssessed: 4 } },
      { id: 'weak', score: { score: 40, assessed: 8, notAssessed: 0 } },
      { id: 'good', score: { score: 90, assessed: 8, notAssessed: 0 } },
    ]
    expect(weakestFirst(reports).map((r) => r.id)).toEqual([
      'weak',
      'good',
      'blind',
    ])
  })
})
