import { describe, expect, it } from 'vitest'

import type { ListingCheck, ListingCheckStatus } from '@/lib/listing-quality'

import { listingsShape, type ScoredListing } from './shape'

function check(status: ListingCheckStatus): ListingCheck {
  return {
    code: `fixture.${status}`,
    area: 'description',
    status,
    weight: status === 'not_assessed' ? 0 : 1,
    observed: null,
  }
}

/** A judgeable report: a score, and `warns` findings against it. */
function listing(score: number, warns = 0, passes = 1): ScoredListing {
  const checks = [
    ...Array.from({ length: warns }, () => check('warn')),
    ...Array.from({ length: passes }, () => check('pass')),
  ]
  return { score: { score, assessed: checks.length, notAssessed: 0 }, checks }
}

/** A report with nothing the product could apply a check to. */
function blind(): ScoredListing {
  return {
    score: { score: 0, assessed: 0, notAssessed: 3 },
    checks: [
      check('not_assessed'),
      check('not_assessed'),
      check('not_assessed'),
    ],
  }
}

describe('listingsShape', () => {
  it('averages the listings it could judge', () => {
    const shape = listingsShape([listing(80), listing(60), listing(70)])

    expect(shape.listings).toBe(3)
    expect(shape.judgeable).toBe(3)
    expect(shape.averageScore).toBe(70)
  })

  it('rounds rather than reporting a fraction of a point', () => {
    // 200/3 = 66.67
    expect(
      listingsShape([listing(80), listing(60), listing(60)]).averageScore,
    ).toBe(67)
  })

  it('keeps a listing it cannot judge out of the average', () => {
    // Without the exclusion the blind listing's 0 would pull 80 down to 40 and
    // report a healthy business as a failing one.
    const shape = listingsShape([listing(80), blind()])

    expect(shape.judgeable).toBe(1)
    expect(shape.blind).toBe(1)
    expect(shape.averageScore).toBe(80)
  })

  it('is null and not zero when nothing could be judged', () => {
    const shape = listingsShape([blind(), blind()])

    expect(shape.judgeable).toBe(0)
    expect(shape.averageScore).toBeNull()
    expect(shape.averageScore).not.toBe(0)
  })

  it('is null for no listings at all', () => {
    const shape = listingsShape([])

    expect(shape.listings).toBe(0)
    expect(shape.averageScore).toBeNull()
    expect(shape.findings).toBe(0)
  })

  it('counts every finding, and the listings carrying one', () => {
    const shape = listingsShape([listing(50, 3), listing(90, 1), listing(100)])

    expect(shape.findings).toBe(4)
    expect(shape.withFindings).toBe(2)
  })

  it('counts a listing with findings once, not once per finding', () => {
    const shape = listingsShape([listing(40, 7)])

    expect(shape.findings).toBe(7)
    expect(shape.withFindings).toBe(1)
  })

  it('does not count a blind listing as carrying findings', () => {
    const shape = listingsShape([blind()])

    expect(shape.withFindings).toBe(0)
    expect(shape.findings).toBe(0)
  })
})
