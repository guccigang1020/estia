/**
 * The money.
 *
 * Two properties are load-bearing and are tested against arithmetic worked by
 * hand rather than against whatever the code happens to produce:
 *
 *   1. **Every allocation method divides the way it says it does.** The five
 *      methods are five different accounting decisions, and a business that
 *      picks "per occupied night" and gets "per calendar day" is being told a
 *      margin that is wrong in a direction nobody will notice.
 *
 *   2. **The breakdown sums to the total, exactly.** No rounding drift. The
 *      first person to add the column up by hand decides whether the screen is
 *      trustworthy, and they only do it once.
 */

import { describe, expect, it } from 'vitest'
import { estimateStaffing } from './complexity'
import {
  allocateFixedCosts,
  commissionBaseAmount,
  commissionLine,
  computeEventPnL,
  computeVariableCosts,
  costLines,
  evaluateCostFormula,
  group,
  reconcile,
  revenueLines,
  share,
  shareForProperty,
} from './costing'
import { computeRequirements } from './requirements'
import { captureSnapshot } from './snapshot'
import type {
  AllocationContext,
  CommissionRule,
  CostFrequency,
  EventPnL,
  FixedCost,
  PreparationSnapshot,
  SharingRule,
} from './types'
import {
  OTHER_PROPERTY_ID,
  PROPERTY_ID,
  UNIT_ID,
  exampleBooking,
  exampleCatalogue,
} from './testing/example-configuration'

const CAPTURED_AT = '2026-08-27T08:00:00.000Z'
const BOOKING = exampleBooking()
const SNAPSHOT: PreparationSnapshot = captureSnapshot({
  catalogue: exampleCatalogue(),
  booking: BOOKING,
  capturedAt: CAPTURED_AT,
})

const { facts, requirements } = computeRequirements(BOOKING, SNAPSHOT)
const STAFFING = estimateStaffing({
  facts,
  configuration: SNAPSHOT.complexity,
  extraItems: BOOKING.extras.length,
})

/**
 * The measured windows the booking's month and year sit in.
 *
 * Supplied rather than computed: nothing in the engine believes a month is
 * thirty days, and these are the figures an accountant would look up.
 */
const MONTH: AllocationContext = {
  propertyId: PROPERTY_ID,
  periodDays: 30,
  periodOccupiedNights: 22,
  periodBookings: 8,
  periodGuests: 120,
  periodRevenue: 4_000_000,
  periodUnits: 1,
}

const YEAR: AllocationContext = {
  propertyId: PROPERTY_ID,
  periodDays: 365,
  periodOccupiedNights: 260,
  periodBookings: 96,
  periodGuests: 1_440,
  periodRevenue: 48_000_000,
  periodUnits: 1,
}

const CONTEXTS: Readonly<Partial<Record<CostFrequency, AllocationContext>>> = {
  monthly: MONTH,
  annual: YEAR,
}

function amountOf(
  lines: readonly { key: string; amount: number }[],
  key: string,
) {
  return lines.find((line) => line.key === key)?.amount
}

// ── Variable formulas ─────────────────────────────────────────────────────

describe('the variable cost formulas', () => {
  const lines = computeVariableCosts(SNAPSHOT.variableCosts, {
    facts,
    requirements,
  })

  it('computes cleaning as base plus over-threshold guests plus mattresses', () => {
    // ₪350 + (25 − 10) × ₪15 + 15 × ₪20 = 350 + 225 + 300 = ₪875
    expect(amountOf(lines, 'cleaning')).toBe(87_500)
  })

  it('binds laundry to the linen the plan actually requires', () => {
    // Twenty-five single sheets at ₪12. Not re-derived from the guest count.
    expect(amountOf(lines, 'laundry')).toBe(30_000)
  })

  it('bills towels per towel across the whole towel category', () => {
    // 25 + 25 + 13 + 25 = 88 towels at ₪4.
    expect(amountOf(lines, 'towels')).toBe(35_200)
  })

  it('bills consumables per guest', () => {
    expect(amountOf(lines, 'consumables')).toBe(20_000)
  })

  it('charges pool heating once per event, and only where there is a pool', () => {
    expect(amountOf(lines, 'pool_heating')).toBe(35_000)

    const dryFacts = { ...facts, flags: { ...facts.flags, pool: false } }
    const dry = computeVariableCosts(SNAPSHOT.variableCosts, {
      facts: dryFacts,
      requirements,
    })

    expect(amountOf(dry, 'pool_heating')).toBeUndefined()
  })

  it('shows its working in Hebrew', () => {
    const cleaning = lines.find((line) => line.key === 'cleaning')

    expect(cleaning?.explain).toContain('₪350')
    expect(cleaning?.explain).toContain('25')
  })

  it('leaves out a line that came to nothing', () => {
    const nothing = computeVariableCosts(
      [
        {
          ...SNAPSHOT.variableCosts[0],
          id: 'zero',
          key: 'zero',
          formula: { kind: 'fixed', amount: 0 },
        },
      ],
      { facts, requirements },
    )

    expect(nothing).toEqual([])
  })

  it('sums a nested formula', () => {
    expect(
      evaluateCostFormula(
        {
          kind: 'sum',
          of: [
            { kind: 'fixed', amount: 1_000 },
            { kind: 'per_unit', basis: 'nights', unitAmount: 500 },
          ],
        },
        { facts, requirements },
      ),
    ).toBe(2_000)
  })

  it('treats an under-threshold measurement as zero, not as a credit', () => {
    expect(
      evaluateCostFormula(
        {
          kind: 'above_threshold',
          basis: 'guests',
          threshold: 99,
          unitAmount: 1_500,
        },
        { facts, requirements },
      ),
    ).toBe(0)
  })
})

// ── Allocation, method by method ──────────────────────────────────────────

describe('allocating a fixed cost to a booking', () => {
  function allocateOne(overrides: Partial<FixedCost>) {
    return allocateFixedCosts({
      costs: [
        {
          id: 'fc',
          organizationId: SNAPSHOT.organizationId,
          key: 'test',
          label: 'בדיקה',
          scope: { kind: 'property', propertyId: PROPERTY_ID },
          amount: 1_200_000,
          frequency: 'monthly',
          allocation: 'per_calendar_day',
          sharing: null,
          effectiveFrom: '2020-01-01',
          effectiveTo: null,
          ...overrides,
        },
      ],
      contexts: CONTEXTS,
      facts,
      bookingRevenue: 640_000,
      propertyId: PROPERTY_ID,
      unitId: UNIT_ID,
    })
  }

  it('per calendar day: ₪12,000 × 2 nights ÷ 30 days = ₪800', () => {
    expect(
      amountOf(allocateOne({ allocation: 'per_calendar_day' }), 'test'),
    ).toBe(80_000)
  })

  it('per occupied night: ₪12,000 × 2 ÷ 22 = ₪1,090.91 → 109,091 agorot', () => {
    expect(
      amountOf(allocateOne({ allocation: 'per_occupied_night' }), 'test'),
    ).toBe(109_091)
  })

  it('per booking: ₪12,000 ÷ 8 bookings = ₪1,500', () => {
    expect(amountOf(allocateOne({ allocation: 'per_booking' }), 'test')).toBe(
      150_000,
    )
  })

  it('per guest: ₪12,000 × 25 ÷ 120 = ₪2,500', () => {
    expect(amountOf(allocateOne({ allocation: 'per_guest' }), 'test')).toBe(
      250_000,
    )
  })

  it('per property share: ₪12,000 × ₪6,400 ÷ ₪40,000 = ₪1,920', () => {
    expect(
      amountOf(allocateOne({ allocation: 'per_property_share' }), 'test'),
    ).toBe(192_000)
  })

  it('divides an annual cost over the year it was measured against', () => {
    // ₪12,000 ÷ 96 bookings in the year = ₪125.
    expect(
      amountOf(
        allocateOne({ frequency: 'annual', allocation: 'per_booking' }),
        'test',
      ),
    ).toBe(12_500)
  })

  it('allocates nothing rather than dividing by an empty period', () => {
    const lines = allocateFixedCosts({
      costs: [
        {
          id: 'fc',
          organizationId: SNAPSHOT.organizationId,
          key: 'test',
          label: 'בדיקה',
          scope: { kind: 'property', propertyId: PROPERTY_ID },
          amount: 1_200_000,
          frequency: 'monthly',
          allocation: 'per_booking',
          sharing: null,
          effectiveFrom: '2020-01-01',
          effectiveTo: null,
        },
      ],
      contexts: { monthly: { ...MONTH, periodBookings: 0 } },
      facts,
      bookingRevenue: 640_000,
      propertyId: PROPERTY_ID,
      unitId: UNIT_ID,
    })

    expect(lines).toEqual([])
  })

  it('ignores a cost scoped to another property or another unit', () => {
    expect(
      allocateOne({
        scope: { kind: 'property', propertyId: OTHER_PROPERTY_ID },
      }),
    ).toEqual([])
    expect(
      allocateOne({ scope: { kind: 'unit', unitId: 'other-unit' } }),
    ).toEqual([])
    expect(
      allocateOne({ scope: { kind: 'unit', unitId: UNIT_ID } }),
    ).toHaveLength(1)
  })

  it('skips a cost whose period was never measured', () => {
    const lines = allocateFixedCosts({
      costs: [
        {
          id: 'fc',
          organizationId: SNAPSHOT.organizationId,
          key: 'test',
          label: 'בדיקה',
          scope: { kind: 'property', propertyId: PROPERTY_ID },
          amount: 1_200_000,
          frequency: 'quarterly',
          allocation: 'per_booking',
          sharing: null,
          effectiveFrom: '2020-01-01',
          effectiveTo: null,
        },
      ],
      contexts: CONTEXTS,
      facts,
      bookingRevenue: 640_000,
      propertyId: PROPERTY_ID,
      unitId: UNIT_ID,
    })

    expect(lines).toEqual([])
  })

  it('explains which division it did', () => {
    const line = allocateOne({ allocation: 'per_occupied_night' })[0]

    expect(line.explain).toContain('22')
    expect(line.explain).toContain('לילות תפוסים')
  })
})

// ── Sharing across properties ─────────────────────────────────────────────

describe('splitting a cost held above one property', () => {
  const shares = [
    { propertyId: PROPERTY_ID, weight: 3 },
    { propertyId: OTHER_PROPERTY_ID, weight: 1 },
  ]

  function split(method: SharingRule['method']) {
    return shareForProperty(400_000, { method, shares }, PROPERTY_ID)
  }

  it('splits equally, ignoring whatever weights were supplied', () => {
    expect(split('equal')).toBe(200_000)
  })

  it('splits by revenue, by units and by custom percent on the weights', () => {
    expect(split('by_revenue')).toBe(300_000)
    expect(split('by_units')).toBe(300_000)
    expect(split('custom_percent')).toBe(300_000)
  })

  it('normalises custom percentages that do not add to a hundred', () => {
    // Somebody typed 60 and 30. The intent is two thirds, not sixty percent
    // of the cost with ten percent unallocated.
    expect(
      shareForProperty(
        900_000,
        {
          method: 'custom_percent',
          shares: [
            { propertyId: PROPERTY_ID, weight: 60 },
            { propertyId: OTHER_PROPERTY_ID, weight: 30 },
          ],
        },
        PROPERTY_ID,
      ),
    ).toBe(600_000)
  })

  it('gives nothing to a property that is not in the split', () => {
    expect(
      shareForProperty(400_000, { method: 'equal', shares }, 'unknown'),
    ).toBe(0)
  })

  it('gives nothing when the weights are all zero', () => {
    expect(
      shareForProperty(
        400_000,
        {
          method: 'by_revenue',
          shares: [{ propertyId: PROPERTY_ID, weight: 0 }],
        },
        PROPERTY_ID,
      ),
    ).toBe(0)
  })
})

// ── Commission ────────────────────────────────────────────────────────────

describe('commission', () => {
  const inputs = {
    revenue: 640_000,
    accommodation: 600_000,
    directCosts: 312_475,
    allocatedFixedCosts: 123_639,
  }

  it.each([
    ['gross_revenue', 640_000],
    ['accommodation_only', 600_000],
    ['net_of_direct_costs', 327_525],
    ['net_contribution', 203_886],
  ] as const)('takes %s as the base', (basis, expected) => {
    expect(commissionBaseAmount({ basis, ...inputs })).toBe(expected)
  })

  it('applies the rate in basis points, so no float creeps in', () => {
    const rule: CommissionRule = {
      id: 'c',
      organizationId: SNAPSHOT.organizationId,
      basis: 'gross_revenue',
      rateBasisPoints: 1_000,
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
    }

    expect(
      commissionLine(rule, { basis: 'gross_revenue', ...inputs }),
    ).toMatchObject({ amount: 64_000 })
  })

  it('never pays commission on a loss', () => {
    const rule: CommissionRule = {
      id: 'c',
      organizationId: SNAPSHOT.organizationId,
      basis: 'net_contribution',
      rateBasisPoints: 1_000,
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
    }

    expect(
      commissionLine(rule, {
        basis: 'net_contribution',
        revenue: 100_000,
        accommodation: 100_000,
        directCosts: 300_000,
        allocatedFixedCosts: 0,
      }).amount,
    ).toBe(0)
  })
})

// ── The statement ─────────────────────────────────────────────────────────

describe('the event profit statement', () => {
  const pnl: EventPnL = computeEventPnL({
    booking: BOOKING,
    snapshot: SNAPSHOT,
    facts,
    requirements,
    staffing: STAFFING,
    contexts: CONTEXTS,
  })

  it('counts revenue from the price lines, excluding deposits and commission', () => {
    expect(pnl.revenue.total).toBe(640_000)
  })

  it('puts labour in with the direct costs', () => {
    expect(amountOf(pnl.directCosts.lines, 'labour')).toBe(STAFFING.labourCost)
    expect(pnl.directCosts.total).toBe(312_475)
  })

  it('allocates every fixed cost that applies', () => {
    expect(amountOf(pnl.allocatedFixedCosts.lines, 'rent')).toBe(80_000)
    expect(amountOf(pnl.allocatedFixedCosts.lines, 'municipal_tax')).toBe(
      16_364,
    )
    expect(amountOf(pnl.allocatedFixedCosts.lines, 'water')).toBe(18_750)
    expect(amountOf(pnl.allocatedFixedCosts.lines, 'insurance')).toBe(3_125)
    expect(amountOf(pnl.allocatedFixedCosts.lines, 'software')).toBe(5_400)
    expect(pnl.allocatedFixedCosts.total).toBe(123_639)
  })

  it('reaches a net contribution and a margin', () => {
    expect(pnl.commission.total).toBe(64_000)
    expect(pnl.netContribution).toBe(139_886)
    // 139,886 ÷ 640,000 = 21.86%.
    expect(pnl.marginBasisPoints).toBe(2_186)
  })

  it('has a total in every group that is exactly the sum of its lines', () => {
    for (const [name, entry] of Object.entries({
      revenue: pnl.revenue,
      directCosts: pnl.directCosts,
      allocatedFixedCosts: pnl.allocatedFixedCosts,
      commission: pnl.commission,
    })) {
      const sum = entry.lines.reduce((total, line) => total + line.amount, 0)
      expect(sum, `${name} does not sum to its total`).toBe(entry.total)
    }
  })

  it('has a bottom line that is exactly the groups, with no drift', () => {
    expect(pnl.netContribution).toBe(
      pnl.revenue.total -
        pnl.directCosts.total -
        pnl.allocatedFixedCosts.total -
        pnl.commission.total,
    )
  })

  it('carries an integer number of agorot on every single line', () => {
    for (const line of [...pnl.revenue.lines, ...costLines(pnl)]) {
      expect(
        Number.isInteger(line.amount),
        `${line.key} is not an integer`,
      ).toBe(true)
    }
  })

  it('explains every line rather than presenting a black box', () => {
    for (const line of costLines(pnl)) {
      expect(
        line.explain.length,
        `${line.key} has no explanation`,
      ).toBeGreaterThan(0)
    }
  })

  it('reports a zero margin rather than dividing by no revenue', () => {
    const free = computeEventPnL({
      booking: { ...BOOKING, priceLines: [] },
      snapshot: SNAPSHOT,
      facts,
      requirements,
      staffing: STAFFING,
      contexts: CONTEXTS,
    })

    expect(free.revenue.total).toBe(0)
    expect(free.marginBasisPoints).toBe(0)
    expect(free.netContribution).toBeLessThan(0)
  })

  it('leaves out commission entirely when there is no agreement', () => {
    const direct = computeEventPnL({
      booking: BOOKING,
      snapshot: { ...SNAPSHOT, commissionRule: null },
      facts,
      requirements,
      staffing: STAFFING,
      contexts: CONTEXTS,
    })

    expect(direct.commission.lines).toEqual([])
    expect(direct.commission.total).toBe(0)
  })
})

// ── Estimate against actual ───────────────────────────────────────────────

describe('reconciling against what it really cost', () => {
  const pnl = computeEventPnL({
    booking: BOOKING,
    snapshot: SNAPSHOT,
    facts,
    requirements,
    staffing: STAFFING,
    contexts: CONTEXTS,
  })

  it('reports the variance line by line, signed', () => {
    const report = reconcile(pnl, [
      { key: 'cleaning', amount: 95_000 },
      { key: 'laundry', amount: 27_000 },
    ])

    const cleaning = report.lines.find((line) => line.key === 'cleaning')
    const laundry = report.lines.find((line) => line.key === 'laundry')

    expect(cleaning).toMatchObject({
      estimated: 87_500,
      actual: 95_000,
      variance: 7_500,
    })
    expect(laundry?.variance).toBe(-3_000)
  })

  it('surfaces a cost nobody budgeted for', () => {
    const report = reconcile(pnl, [
      { key: 'emergency_plumber', amount: 45_000 },
    ])
    const surprise = report.lines.find(
      (line) => line.key === 'emergency_plumber',
    )

    expect(surprise).toMatchObject({ estimated: 0, actual: 45_000 })
  })

  it('adds several actuals recorded against the same line', () => {
    const report = reconcile(pnl, [
      { key: 'laundry', amount: 10_000 },
      { key: 'laundry', amount: 12_000 },
    ])

    expect(report.lines.find((line) => line.key === 'laundry')?.actual).toBe(
      22_000,
    )
  })

  it('keeps its own totals consistent', () => {
    const report = reconcile(pnl, [{ key: 'cleaning', amount: 95_000 }])

    expect(report.totalVariance).toBe(
      report.totalActual - report.totalEstimated,
    )
    expect(report.totalEstimated).toBe(
      costLines(pnl).reduce((total, line) => total + line.amount, 0),
    )
  })
})

// ── The primitives ────────────────────────────────────────────────────────

describe('the share primitive', () => {
  it('rounds once, to whole agorot', () => {
    expect(share(100, 1, 3)).toBe(33)
    expect(share(100, 2, 3)).toBe(67)
  })

  it('is zero on a zero denominator rather than NaN', () => {
    expect(share(100, 1, 0)).toBe(0)
  })
})

describe('a group', () => {
  it('cannot have a total that disagrees with its lines', () => {
    const built = group([
      { key: 'a', label: 'א', amount: 7, explain: '' },
      { key: 'b', label: 'ב', amount: 11, explain: '' },
    ])

    expect(built.total).toBe(18)
  })

  it('is zero when empty', () => {
    expect(group([]).total).toBe(0)
  })
})

describe('revenue lines', () => {
  it('drop a deposit, which is money held rather than earned', () => {
    const lines = revenueLines({
      ...BOOKING,
      priceLines: [
        ...BOOKING.priceLines,
        {
          kind: 'deposit',
          label: 'פיקדון',
          amount: 200_000,
          quantity: 1,
          date: null,
        },
      ],
    })

    expect(lines.reduce((total, line) => total + line.amount, 0)).toBe(640_000)
  })
})
