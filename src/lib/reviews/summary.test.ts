import { describe, expect, it } from 'vitest'

import { needsReplyFirst, summarise } from './summary'
import { MIN_REVIEWS_TO_AVERAGE, type Review } from './types'

let seq = 0
const review = (over: Partial<Review> = {}): Review => ({
  id: `r-${++seq}`,
  propertyId: 'p-1',
  unitId: 'u-1',
  bookingId: `b-${seq}`,
  status: 'published',
  source: 'guest_portal',
  overall: 5,
  dimensions: {},
  comment: null,
  hostReply: null,
  stayedAt: '2026-08-10',
  ...over,
})

describe('a hidden review is excluded from the average and never from the count', () => {
  it('reports both numbers together', () => {
    // The whole point of the module. A business that hid four of nine reviews
    // must not be able to show the same figure as one that hid none.
    const reviews = [
      review({ overall: 5 }),
      review({ overall: 5 }),
      review({ overall: 5 }),
      review({ overall: 1, status: 'hidden' }),
      review({ overall: 1, status: 'hidden' }),
    ]
    const summary = summarise(reviews)

    expect(summary.average).toBe(5)
    expect(summary.counted).toBe(3)
    expect(summary.hidden).toBe(2)
  })

  it('keeps hidden reviews out of the star distribution too', () => {
    const summary = summarise([
      review({ overall: 5 }),
      review({ overall: 1, status: 'hidden' }),
    ])
    expect(summary.distribution[1]).toBe(0)
    expect(summary.distribution[5]).toBe(1)
  })
})

describe('an average of one review is not an average', () => {
  it('is null below the threshold', () => {
    const summary = summarise([review({ overall: 5 }), review({ overall: 5 })])
    expect(summary.counted).toBe(2)
    expect(summary.average).toBeNull()
  })

  it('appears exactly at the threshold', () => {
    const reviews = Array.from({ length: MIN_REVIEWS_TO_AVERAGE }, () =>
      review({ overall: 4 }),
    )
    expect(summarise(reviews).average).toBe(4)
  })

  it('rounds to one decimal and no further', () => {
    const summary = summarise([
      review({ overall: 5 }),
      review({ overall: 4 }),
      review({ overall: 4 }),
    ])
    // 4.333… — shown as 4.3, not as 4.333333333333333.
    expect(summary.average).toBe(4.3)
  })
})

describe('dimensions average over the guests who answered them', () => {
  it('does not count a skipped dimension as a zero', () => {
    const reviews = [
      review({ dimensions: { cleanliness: 5, location: 3 } }),
      review({ dimensions: { cleanliness: 5 } }),
      review({ dimensions: { cleanliness: 5 } }),
    ]
    const summary = summarise(reviews)
    expect(summary.dimensionAverages.cleanliness).toBe(5)
    // Only one guest rated location, which is below the threshold.
    expect(summary.dimensionAverages.location).toBeUndefined()
  })

  it('reports nothing for a dimension nobody rated', () => {
    const summary = summarise([review(), review(), review()])
    expect(summary.dimensionAverages).toEqual({})
  })
})

describe('an empty pile', () => {
  it('is not zero stars', () => {
    const summary = summarise([])
    expect(summary.average).toBeNull()
    expect(summary.counted).toBe(0)
    expect(summary.hidden).toBe(0)
    expect(summary.awaitingReply).toBe(0)
  })
})

describe('what to answer first', () => {
  it('is the worst unanswered review, then the oldest', () => {
    // An unanswered one star from last week costs bookings today. An
    // unanswered five star from March is a courtesy. Sorting by date alone
    // buries the first behind the second.
    const reviews = [
      review({ id: 'kind', overall: 5, stayedAt: '2026-03-01' }),
      review({ id: 'harsh', overall: 1, stayedAt: '2026-08-01' }),
      review({ id: 'older-harsh', overall: 1, stayedAt: '2026-02-01' }),
      review({ id: 'answered', overall: 1, hostReply: 'מצטערים' }),
    ]

    expect(needsReplyFirst(reviews).map((r) => r.id)).toEqual([
      'older-harsh',
      'harsh',
      'kind',
    ])
  })

  it('never proposes a hidden review', () => {
    const reviews = [review({ overall: 1, status: 'hidden' })]
    expect(needsReplyFirst(reviews)).toEqual([])
    expect(summarise(reviews).awaitingReply).toBe(0)
  })
})
