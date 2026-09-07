import { describe, expect, it } from 'vitest'

import type { DiscountBase } from './discount'
import { assessCoupon, isLive, selectPromotions } from './select'
import {
  NO_CONDITION,
  type Coupon,
  type Promotion,
  type PromotionFacts,
} from './types'

const NOW = new Date('2026-06-15T09:00:00Z')

const BASE: DiscountBase = {
  stayTotalAgorot: 556_000,
  accommodationAgorot: 459_000,
}

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

function promotion(over: Partial<Promotion> = {}): Promotion {
  return {
    id: over.code ?? 'p',
    organizationId: 'org',
    code: 'direct',
    name: 'הזמנה ישירה',
    kind: 'direct_booking',
    conditions: NO_CONDITION,
    discountKind: 'percent',
    discountValue: 500,
    appliesTo: 'stay_total',
    stackable: true,
    exclusiveGroup: null,
    priority: 0,
    maxRedemptions: null,
    maxPerGuest: null,
    budgetAgorot: null,
    effectiveFrom: '2026-01-01T00:00:00Z',
    effectiveTo: null,
    isActive: true,
    deactivatedAt: null,
    deactivationReason: null,
    version: 1,
    ...over,
  }
}

function coupon(over: Partial<Coupon> = {}): Coupon {
  return {
    id: 'c',
    organizationId: 'org',
    promotionId: 'p',
    code: 'SUMMER25',
    issuedToGuestId: null,
    conditions: NO_CONDITION,
    discountKind: 'percent',
    discountValue: 1_000,
    appliesTo: 'stay_total',
    singleUse: true,
    maxRedemptions: 1,
    maxPerGuest: null,
    budgetAgorot: null,
    effectiveFrom: '2026-01-01T00:00:00Z',
    effectiveTo: null,
    expiresAt: null,
    isActive: true,
    deactivatedAt: null,
    deactivationReason: null,
    version: 1,
    ...over,
  }
}

describe('the order is the business’s intention, not the best deal for the guest', () => {
  it('takes the higher priority even when the other discount is worth more', () => {
    const result = selectPromotions(
      [
        promotion({
          code: 'generous',
          priority: 0,
          discountValue: 2_000,
          stackable: false,
        }),
        promotion({
          code: 'intended',
          priority: 10,
          discountValue: 500,
          stackable: false,
        }),
      ],
      facts(),
      BASE,
      NOW,
    )
    expect(result.selected.map((s) => s.promotion.code)).toEqual(['intended'])
  })

  it('breaks a tie of priority on the value, and then on the code', () => {
    const result = selectPromotions(
      [
        promotion({ code: 'bbb', priority: 5, discountValue: 500 }),
        promotion({ code: 'aaa', priority: 5, discountValue: 500 }),
        promotion({ code: 'ccc', priority: 5, discountValue: 900 }),
      ],
      facts(),
      BASE,
      NOW,
    )
    expect(result.selected.map((s) => s.promotion.code)).toEqual([
      'ccc',
      'aaa',
      'bbb',
    ])
  })

  it('gives the same answer whatever order the candidates arrived in', () => {
    // The property the tie-breakers exist for: a quote produced today and the
    // same quote produced next year must be the same number.
    const candidates = [
      promotion({ code: 'aaa', priority: 5, discountValue: 500 }),
      promotion({ code: 'bbb', priority: 5, discountValue: 500 }),
      promotion({ code: 'ccc', priority: 5, discountValue: 500 }),
    ]
    const forwards = selectPromotions(candidates, facts(), BASE, NOW)
    const backwards = selectPromotions(
      [...candidates].reverse(),
      facts(),
      BASE,
      NOW,
    )
    expect(forwards.selected.map((s) => s.promotion.code)).toEqual(
      backwards.selected.map((s) => s.promotion.code),
    )
  })

  it('computes every discount against the same pre-discount subtotal', () => {
    // §6 rule 31: two 10% discounts remove 20% and not 19%. Recomputing inside
    // the loop against a falling total is what produces the 19%.
    const result = selectPromotions(
      [
        promotion({ code: 'aaa', discountValue: 1_000 }),
        promotion({ code: 'bbb', discountValue: 1_000 }),
      ],
      facts(),
      BASE,
      NOW,
    )
    expect(result.selected.map((s) => s.amountAgorot)).toEqual([55_600, 55_600])
  })
})

describe('stacking and exclusivity', () => {
  it('stops the list at a non-stackable campaign that was chosen', () => {
    const result = selectPromotions(
      [
        promotion({ code: 'alone', priority: 10, stackable: false }),
        promotion({ code: 'also', priority: 5, stackable: true }),
      ],
      facts(),
      BASE,
      NOW,
    )
    expect(result.selected.map((s) => s.promotion.code)).toEqual(['alone'])
    expect(result.rejected.map((r) => r.because.reason)).toEqual([
      'not_stackable',
    ])
  })

  it('skips a non-stackable campaign that arrives after something was chosen', () => {
    const result = selectPromotions(
      [
        promotion({ code: 'first', priority: 10, stackable: true }),
        promotion({ code: 'alone', priority: 5, stackable: false }),
      ],
      facts(),
      BASE,
      NOW,
    )
    expect(result.selected.map((s) => s.promotion.code)).toEqual(['first'])
  })

  it('lets only one campaign out of an exclusive group through, and names the winner', () => {
    const result = selectPromotions(
      [
        promotion({ code: 'winter', priority: 10, exclusiveGroup: 'seasonal' }),
        promotion({ code: 'spring', priority: 5, exclusiveGroup: 'seasonal' }),
      ],
      facts(),
      BASE,
      NOW,
    )
    expect(result.selected.map((s) => s.promotion.code)).toEqual(['winter'])
    expect(result.rejected[0]?.because).toEqual({
      reason: 'excluded_by',
      code: 'winter',
    })
  })

  it('keeps campaigns in different exclusive groups', () => {
    const result = selectPromotions(
      [
        promotion({ code: 'winter', exclusiveGroup: 'seasonal' }),
        promotion({ code: 'loyal', exclusiveGroup: 'loyalty' }),
      ],
      facts(),
      BASE,
      NOW,
    )
    expect(result.selected).toHaveLength(2)
  })
})

describe('a campaign that does not apply says why', () => {
  it('reports a paused campaign as paused rather than dropping it', () => {
    const result = selectPromotions(
      [promotion({ isActive: false, deactivatedAt: '2026-05-01T00:00:00Z' })],
      facts(),
      BASE,
      NOW,
    )
    expect(result.selected).toHaveLength(0)
    expect(result.rejected[0]?.because.reason).toBe('inactive')
  })

  it('reports a campaign whose window closed', () => {
    const result = selectPromotions(
      [promotion({ effectiveTo: '2026-06-01T00:00:00Z' })],
      facts(),
      BASE,
      NOW,
    )
    expect(result.rejected[0]?.because.reason).toBe('outside_window')
  })

  it('reports the condition that failed, and which fact was missing', () => {
    const result = selectPromotions(
      [
        promotion({
          conditions: {
            kind: 'compare',
            basis: 'nights',
            comparator: 'gte',
            value: 5,
          },
        }),
      ],
      facts({ measures: {} }),
      BASE,
      NOW,
    )
    const because = result.rejected[0]?.because
    expect(because?.reason).toBe('condition')
    expect(because?.reason === 'condition' && because.failure).toEqual({
      reason: 'fact_absent',
      fact: 'nights',
    })
  })

  it('never selects a campaign worth nothing', () => {
    const result = selectPromotions(
      [promotion({ appliesTo: 'accommodation_only' })],
      facts(),
      { stayTotalAgorot: 25_000, accommodationAgorot: 0 },
      NOW,
    )
    expect(result.selected).toHaveLength(0)
    expect(result.rejected[0]?.because.reason).toBe('worth_nothing')
  })
})

describe('the window is half open, because a campaign ends at an instant', () => {
  const window = {
    isActive: true,
    effectiveFrom: '2026-06-01T00:00:00Z',
    effectiveTo: '2026-07-01T00:00:00Z',
  }

  it('includes the first instant', () => {
    expect(isLive(window, new Date('2026-06-01T00:00:00Z'))).toBe(true)
  })

  it('excludes the closing instant itself', () => {
    expect(isLive(window, new Date('2026-07-01T00:00:00Z'))).toBe(false)
    expect(isLive(window, new Date('2026-06-30T23:59:59Z'))).toBe(true)
  })

  it('honours whichever of expiry and window closes first', () => {
    expect(isLive({ ...window, expiresAt: '2026-06-10T00:00:00Z' }, NOW)).toBe(
      false,
    )
  })

  it('treats an unparseable window as closed rather than as open forever', () => {
    expect(isLive({ ...window, effectiveFrom: 'sometime' }, NOW)).toBe(false)
    expect(isLive({ ...window, effectiveTo: 'never' }, NOW)).toBe(false)
  })
})

describe('a coupon is a separate axis and is never suppressed by a campaign', () => {
  it('applies on its own terms even beside a non-stackable promotion', () => {
    // §6 rule 30. A coupon suppressed because a campaign happened to be
    // exclusive is a code the business handed out and then refused to honour.
    const promotions = selectPromotions(
      [promotion({ code: 'alone', stackable: false })],
      facts(),
      BASE,
      NOW,
    )
    expect(promotions.selected).toHaveLength(1)
    expect(assessCoupon(coupon(), facts(), BASE, NOW)).toEqual({
      amountAgorot: 55_600,
    })
  })

  it('refuses an expired card with the reason', () => {
    const result = assessCoupon(
      coupon({ expiresAt: '2026-06-01T00:00:00Z' }),
      facts(),
      BASE,
      NOW,
    )
    expect(result.amountAgorot).toBeNull()
    expect(result.amountAgorot === null && result.because.reason).toBe(
      'outside_window',
    )
  })

  it('refuses a coupon whose condition the booking does not meet', () => {
    const result = assessCoupon(
      coupon({
        conditions: { kind: 'source', anyOf: ['airbnb'] },
      }),
      facts(),
      BASE,
      NOW,
    )
    expect(result.amountAgorot === null && result.because.reason).toBe(
      'condition',
    )
  })
})
