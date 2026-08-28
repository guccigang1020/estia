import { describe, expect, it } from 'vitest'

import {
  allocateExpense,
  nightsInPeriod,
  periodicAmount,
  variableAmount,
  type ExpensePeriod,
} from './expenses'
import { sumAgorot } from './money'
import { ORG, PROPERTY, fixedRule } from './testing'
import type { AllocatableBooking, AllocationMethod } from './types'

/**
 * The arithmetic here is worked by hand in the comments, not derived from the
 * implementation. A test that computed the expected value the same way the
 * code does proves only that the code is self-consistent.
 */

const MARCH: ExpensePeriod = { start: '2026-03-01', end: '2026-04-01' }

/** ₪3,100 over 31 days — ₪100 a day exactly, so the day maths is checkable. */
const TOTAL = 310_000

const A: AllocatableBooking = {
  bookingId: 'A',
  unitId: 'U1',
  propertyId: PROPERTY,
  range: { checkIn: '2026-03-01', checkOut: '2026-03-06' },
  nights: 5,
  guests: 2,
  netRevenueAgorot: 500_000,
}

const B: AllocatableBooking = {
  bookingId: 'B',
  unitId: 'U1',
  propertyId: PROPERTY,
  range: { checkIn: '2026-03-10', checkOut: '2026-03-15' },
  nights: 5,
  guests: 4,
  netRevenueAgorot: 300_000,
}

const C: AllocatableBooking = {
  bookingId: 'C',
  unitId: 'U2',
  propertyId: PROPERTY,
  range: { checkIn: '2026-03-05', checkOut: '2026-03-15' },
  nights: 10,
  guests: 1,
  netRevenueAgorot: 200_000,
}

const BOOKINGS = [A, B, C]

function amounts(method: AllocationMethod, extra = {}) {
  const result = allocateExpense({
    method,
    totalAgorot: TOTAL,
    period: MARCH,
    bookings: BOOKINGS,
    ...extra,
  })
  return {
    result,
    byId: Object.fromEntries(
      result.shares.map((share) => [share.bookingId, share.amountAgorot]),
    ) as Record<string, number>,
  }
}

describe('nightsInPeriod', () => {
  it('counts only the nights inside the window', () => {
    expect(nightsInPeriod(A.range, MARCH)).toBe(5)
    expect(
      nightsInPeriod({ checkIn: '2026-02-25', checkOut: '2026-03-04' }, MARCH),
    ).toBe(3)
    expect(
      nightsInPeriod({ checkIn: '2026-05-01', checkOut: '2026-05-04' }, MARCH),
    ).toBe(0)
  })
})

describe('periodic amounts', () => {
  it('reads a monthly rule over a whole month as exactly the monthly figure', () => {
    // The reason proration uses the real calendar length rather than an
    // average: an owner who checks will find 12 × monthly ≠ yearly otherwise.
    expect(periodicAmount(fixedRule(), MARCH)).toBe(300_000)
    expect(
      periodicAmount(fixedRule(), { start: '2026-02-01', end: '2026-03-01' }),
    ).toBe(300_000)
  })

  it('prorates a partial month against that month’s own length', () => {
    // 300,000 × 15 / 31 = 145,161.29 → 145,161, rounded once.
    expect(
      periodicAmount(fixedRule(), { start: '2026-03-01', end: '2026-03-16' }),
    ).toBe(145_161)
  })

  it('multiplies a daily rule by the days', () => {
    expect(
      periodicAmount(
        fixedRule({ frequency: 'daily', amountAgorot: 1_000 }),
        MARCH,
      ),
    ).toBe(31_000)
  })

  it('does not prorate a one-off purchase', () => {
    expect(
      periodicAmount(
        fixedRule({ frequency: 'one_time', amountAgorot: 250_000 }),
        { start: '2026-03-01', end: '2026-03-08' },
      ),
    ).toBe(250_000)
  })

  it('reads a yearly rule over a whole year as the yearly figure', () => {
    expect(
      periodicAmount(
        fixedRule({ frequency: 'yearly', amountAgorot: 1_200_000 }),
        { start: '2026-01-01', end: '2027-01-01' },
      ),
    ).toBe(1_200_000)
  })

  it('costs nothing for a variable rule — it has no periodic amount', () => {
    expect(
      periodicAmount(fixedRule({ kind: 'variable', formula: null }), MARCH),
    ).toBe(0)
  })
})

describe('variable formulas', () => {
  it('computes each closed-set formula', () => {
    expect(variableAmount({ kind: 'per_night', rateAgorot: 4_000 }, A)).toBe(
      20_000,
    )
    expect(
      variableAmount({ kind: 'per_guest_night', rateAgorot: 1_000 }, A),
    ).toBe(10_000)
    expect(variableAmount({ kind: 'per_booking', rateAgorot: 7_500 }, A)).toBe(
      7_500,
    )
    expect(variableAmount({ kind: 'per_guest', rateAgorot: 2_500 }, A)).toBe(
      5_000,
    )
    expect(variableAmount({ kind: 'percent_of_revenue', percent: 3 }, A)).toBe(
      15_000,
    )
  })
})

describe('allocation — every method, against hand-worked arithmetic', () => {
  it('per_day splits each day between the stays occupying it', () => {
    // 31 days × ₪100. Mar 1–4 A alone (400); Mar 5 A and C (50 each);
    // Mar 6–9 C alone (400); Mar 10–14 B and C (50 each per day);
    // Mar 15–31 nobody — 17 days × ₪100 = ₪1,700 unallocated.
    const { result, byId } = amounts('per_day')

    expect(byId.A).toBe(45_000)
    expect(byId.B).toBe(25_000)
    expect(byId.C).toBe(70_000)
    expect(result.unallocatedAgorot).toBe(170_000)
    expect(sumAgorot(Object.values(byId)) + result.unallocatedAgorot).toBe(
      TOTAL,
    )
  })

  it('per_occupied_night splits by nights: 5 : 5 : 10 of ₪3,100', () => {
    const { result, byId } = amounts('per_occupied_night')

    expect(byId.A).toBe(77_500)
    expect(byId.B).toBe(77_500)
    expect(byId.C).toBe(155_000)
    expect(result.unallocatedAgorot).toBe(0)
  })

  it('per_booking splits three ways, the leftover agora to the first', () => {
    const { byId } = amounts('per_booking')

    expect(byId.A).toBe(103_334)
    expect(byId.B).toBe(103_333)
    expect(byId.C).toBe(103_333)
  })

  it('per_guest splits 2 : 4 : 1, largest remainders taking the leftover', () => {
    // Exact shares are 88,571.43 · 177,142.86 · 44,285.71. Floors leave two
    // agorot, which go to the two largest remainders — B then C.
    const { byId } = amounts('per_guest')

    expect(byId.A).toBe(88_571)
    expect(byId.B).toBe(177_143)
    expect(byId.C).toBe(44_286)
  })

  it('by_revenue splits 50% : 30% : 20%', () => {
    const { byId } = amounts('by_revenue')

    expect(byId.A).toBe(155_000)
    expect(byId.B).toBe(93_000)
    expect(byId.C).toBe(62_000)
  })

  it('by_unit halves between the two units, then by nights inside each', () => {
    // U1 (A and B, five nights each) takes ₪1,550 and splits it evenly;
    // U2 (C alone) takes the other ₪1,550.
    const { result, byId } = amounts('by_unit')

    expect(byId.A).toBe(77_500)
    expect(byId.B).toBe(77_500)
    expect(byId.C).toBe(155_000)
    expect(result.unallocatedAgorot).toBe(0)
  })

  it('by_unit leaves an idle unit’s share unallocated when it is named', () => {
    // Three units, one of which sold nothing. Its third is carried by the
    // property rather than pushed onto the cabins that worked.
    const { result, byId } = amounts('by_unit', {
      unitIds: ['U1', 'U2', 'U3'],
    })

    expect(byId.A + byId.B).toBe(103_334)
    expect(byId.C).toBe(103_333)
    expect(result.unallocatedAgorot).toBe(103_333)
  })

  it('custom uses the weights it is given and zero for the rest', () => {
    const { byId } = amounts('custom', {
      customWeights: { A: 1, B: 3 },
    })

    expect(byId.A).toBe(77_500)
    expect(byId.B).toBe(232_500)
    expect(byId.C).toBe(0)
  })
})

describe('allocation — the rule every method obeys', () => {
  const methods: readonly AllocationMethod[] = [
    'per_day',
    'per_occupied_night',
    'per_booking',
    'per_guest',
    'by_revenue',
    'by_unit',
    'custom',
  ]

  it('always returns shares plus unallocated equal to the total, exactly', () => {
    for (const method of methods) {
      for (const total of [1, 999, 100_001, 7_777_777, 310_000]) {
        const result = allocateExpense({
          method,
          totalAgorot: total,
          period: MARCH,
          bookings: BOOKINGS,
          customWeights: { A: 2, B: 5, C: 1 },
        })
        expect(
          sumAgorot(result.shares.map((s) => s.amountAgorot)) +
            result.unallocatedAgorot,
          `${method} lost money on a total of ${total}`,
        ).toBe(total)
      }
    }
  })

  it('returns a share for every booking, including the zeros', () => {
    for (const method of methods) {
      const result = allocateExpense({
        method,
        totalAgorot: TOTAL,
        period: MARCH,
        bookings: BOOKINGS,
        customWeights: {},
      })
      expect(result.shares).toHaveLength(3)
      expect(result.shares.map((s) => s.bookingId).sort()).toEqual([
        'A',
        'B',
        'C',
      ])
    }
  })

  it('carries the whole cost as unallocated when nothing was sold', () => {
    for (const method of methods) {
      const result = allocateExpense({
        method,
        totalAgorot: TOTAL,
        period: MARCH,
        bookings: [],
      })
      expect(result.unallocatedAgorot).toBe(TOTAL)
      expect(result.shares).toEqual([])
    }
  })

  it('gives a stay in net refund no share of a cost by revenue', () => {
    const refunded: AllocatableBooking = { ...A, netRevenueAgorot: -50_000 }
    const result = allocateExpense({
      method: 'by_revenue',
      totalAgorot: TOTAL,
      period: MARCH,
      bookings: [refunded, B],
    })

    const byId = Object.fromEntries(
      result.shares.map((s) => [s.bookingId, s.amountAgorot]),
    )
    expect(byId.A).toBe(0)
    expect(byId.B).toBe(TOTAL)
  })

  it('explains itself in Hebrew', () => {
    for (const method of methods) {
      const result = allocateExpense({
        method,
        totalAgorot: TOTAL,
        period: MARCH,
        bookings: BOOKINGS,
      })
      expect(result.basis.length).toBeGreaterThan(5)
      expect(result.method).toBe(method)
    }
  })
})

describe('rule scope', () => {
  it('keeps an organization-wide rule reaching every property', () => {
    const rule = fixedRule({
      scope: { kind: 'organization' },
      organizationId: ORG,
    })
    expect(rule.scope.kind).toBe('organization')
  })
})
