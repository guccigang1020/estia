import { describe, expect, it } from 'vitest'

import { sumLines } from '../booking/pricing'
import { sumAgorot } from './money'
import {
  bookingPnl,
  commissionFromRule,
  propertyPnl,
  revenueBreakdown,
} from './pnl'
import { captureFinanceSnapshot, detectRuleDrift, resnapshot } from './snapshot'
import {
  AT,
  BOOKING,
  ORG,
  PROPERTY,
  UNIT,
  fixedRule,
  snapshotFor,
} from './testing'
import type { CommissionRule } from './types'
import type { OwnerShareRule } from './snapshot'

const COMMISSION: CommissionRule = {
  basis: 'net_revenue',
  kind: 'percent',
  value: 10,
  label: 'עמלת סוכן',
}

const OWNER: OwnerShareRule = {
  basis: 'net_profit',
  kind: 'percent',
  value: 50,
  label: 'חלק הבעלים',
}

/**
 * The worked example.
 *
 * Three nights at ₪1,000, a ₪250 cleaning fee, 10% off, 18% VAT:
 *
 *   gross    3,000 + 250            =  3,250.00
 *   discount 10% of 3,250           =   −325.00
 *   net                             =  2,925.00
 *   VAT      18% of 2,925           =    526.50  (not revenue)
 */
function worked() {
  return snapshotFor({
    discountPercent: 10,
    taxRatePercent: 18,
    commissionRule: COMMISSION,
    ownerShareRule: OWNER,
  })
}

describe('revenueBreakdown', () => {
  it('partitions the price lines so gross − discount = net', () => {
    const revenue = revenueBreakdown(worked().lines)

    expect(revenue.grossAgorot).toBe(325_000)
    expect(revenue.discountAgorot).toBe(32_500)
    expect(revenue.netAgorot).toBe(292_500)
    expect(revenue.taxAgorot).toBe(52_650)
    expect(revenue.grossAgorot - revenue.discountAgorot).toBe(revenue.netAgorot)
  })

  it('keeps VAT and the refundable deposit out of revenue', () => {
    const snapshot = snapshotFor({ taxRatePercent: 18, depositAgorot: 100_000 })
    const revenue = revenueBreakdown(snapshot.lines)

    expect(revenue.depositAgorot).toBe(100_000)
    // The guest paid all of it, and the invoice total says so — but neither
    // the tax nor the deposit is the business's revenue.
    expect(sumLines(snapshot.lines)).toBe(
      revenue.netAgorot + revenue.taxAgorot + revenue.depositAgorot,
    )
  })
})

describe('bookingPnl', () => {
  const pnl = () =>
    bookingPnl({
      snapshot: worked(),
      variableCosts: [
        { ruleId: 'rule-laundry', label: 'כביסה', amountAgorot: 20_000 },
      ],
      fixedCosts: [
        { ruleId: 'rule-cleaning', label: 'ניקיון', amountAgorot: 45_000 },
      ],
    })

  it('walks the chain in order', () => {
    const result = pnl()

    expect(result.grossRevenueAgorot).toBe(325_000)
    expect(result.discountAgorot).toBe(32_500)
    expect(result.netRevenueAgorot).toBe(292_500)
    expect(result.variableCostAgorot).toBe(20_000)
    expect(result.allocatedFixedCostAgorot).toBe(45_000)
    // 10% of the net revenue.
    expect(result.agentCommissionAgorot).toBe(29_250)
    // 50% of what is left: 292,500 − 20,000 − 45,000 − 29,250 = 198,250.
    expect(result.ownerShareAgorot).toBe(99_125)
    expect(result.netProfitAgorot).toBe(99_125)
  })

  it('reports a margin at display precision', () => {
    // 99,125 ÷ 292,500 = 33.888…%
    expect(pnl().marginPercent).toBe(33.9)
  })

  it('has no margin, rather than a zero one, with no revenue', () => {
    const empty = bookingPnl({
      snapshot: snapshotFor({ baseNightlyAgorot: 0, cleaningFeeAgorot: 0 }),
    })
    expect(empty.netRevenueAgorot).toBe(0)
    expect(empty.marginPercent).toBeNull()
  })

  it('never returns a number without its parts', () => {
    const result = pnl()
    expect(result.lines.map((line) => line.key)).toEqual([
      'gross_revenue',
      'discount',
      'net_revenue',
      'variable_cost',
      'fixed_cost',
      'agent_commission',
      'owner_share',
      'net_profit',
    ])
    expect(result.variableCosts).toHaveLength(1)
    expect(result.fixedCosts).toHaveLength(1)
  })

  it('has parts that sum to the total, exactly', () => {
    const result = pnl()
    const contributing = result.lines
      .filter((line) => line.kind !== 'result')
      .map((line) => line.amountAgorot)

    expect(sumAgorot(contributing)).toBe(result.netProfitAgorot)
  })

  it('sums exactly across many night counts and rates', () => {
    // The margin moves; the identity does not.
    for (let nights = 1; nights <= 40; nights += 1) {
      const checkOut = new Date(Date.UTC(2026, 2, 1 + nights))
        .toISOString()
        .slice(0, 10)

      const result = bookingPnl({
        snapshot: snapshotFor({
          range: { checkIn: '2026-03-01', checkOut },
          baseNightlyAgorot: 33_333 + nights,
          cleaningFeeAgorot: 7 * nights,
          discountPercent: 7,
          taxRatePercent: 18,
          commissionRule: COMMISSION,
          ownerShareRule: OWNER,
        }),
        variableCosts: [
          { ruleId: 'v', label: 'v', amountAgorot: 1_111 * nights },
        ],
        fixedCosts: [{ ruleId: 'f', label: 'f', amountAgorot: 999 * nights }],
      })

      expect(
        result.netRevenueAgorot -
          result.variableCostAgorot -
          result.allocatedFixedCostAgorot -
          result.agentCommissionAgorot -
          result.ownerShareAgorot,
      ).toBe(result.netProfitAgorot)

      expect(result.grossRevenueAgorot - result.discountAgorot).toBe(
        result.netRevenueAgorot,
      )
    }
  })

  it('prefers the recorded commission over the snapshotted estimate', () => {
    // Once a commission row exists, the agent will be paid that figure. A P&L
    // that recomputed it could disagree with a statement already sent.
    const result = bookingPnl({
      snapshot: worked(),
      agentCommissionAgorot: 12_345,
    })
    expect(result.agentCommissionAgorot).toBe(12_345)
  })

  it('treats a booking with no agent as costing no commission', () => {
    // The agent network is an add-on. Most organizations have none, and a
    // missing commission is zero rather than an error.
    const result = bookingPnl({ snapshot: snapshotFor() })
    expect(result.agentCommissionAgorot).toBe(0)
    expect(result.ownerShareAgorot).toBe(0)
  })

  it('computes each commission basis differently, as agreed', () => {
    const snapshot = snapshotFor({ discountPercent: 10 })
    const revenue = revenueBreakdown(snapshot.lines)

    expect(
      commissionFromRule({ ...COMMISSION, basis: 'gross_revenue' }, 325_000),
    ).toBe(32_500)
    expect(
      commissionFromRule(
        { ...COMMISSION, basis: 'net_revenue' },
        revenue.netAgorot,
      ),
    ).toBe(29_250)
    expect(
      commissionFromRule(
        { basis: 'stay_total', kind: 'fixed', value: 15_000, label: 'קבוע' },
        999,
      ),
    ).toBe(15_000)
  })
})

describe('propertyPnl', () => {
  it('is the sum of its bookings, plus what reached none of them', () => {
    const one = bookingPnl({ snapshot: worked() })
    const two = bookingPnl({
      snapshot: snapshotFor({
        bookingId: 'booking-2',
        discountPercent: 10,
        taxRatePercent: 18,
        commissionRule: COMMISSION,
        ownerShareRule: OWNER,
      }),
    })

    const property = propertyPnl({
      propertyId: PROPERTY,
      periodStart: '2026-03-01',
      periodEnd: '2026-04-01',
      bookings: [one, two],
      unallocatedFixedCostAgorot: 100_000,
    })

    expect(property.bookingCount).toBe(2)
    expect(property.netRevenueAgorot).toBe(
      one.netRevenueAgorot + two.netRevenueAgorot,
    )
    expect(property.netProfitAgorot).toBe(
      one.netProfitAgorot + two.netProfitAgorot - 100_000,
    )
  })

  it('shows the unallocated cost rather than hiding it in a booking', () => {
    const property = propertyPnl({
      propertyId: PROPERTY,
      periodStart: '2026-03-01',
      periodEnd: '2026-04-01',
      bookings: [],
      unallocatedFixedCostAgorot: 300_000,
    })

    expect(property.unallocatedFixedCostAgorot).toBe(300_000)
    expect(property.netProfitAgorot).toBe(-300_000)
    expect(
      property.lines.find((line) => line.key === 'unallocated_fixed_cost')
        ?.amountAgorot,
    ).toBe(-300_000)
  })

  it('has parts that sum to the total, exactly', () => {
    const property = propertyPnl({
      propertyId: PROPERTY,
      periodStart: '2026-03-01',
      periodEnd: '2026-04-01',
      bookings: [bookingPnl({ snapshot: worked() })],
      unallocatedFixedCostAgorot: 77_777,
    })

    const contributing = property.lines
      .filter((line) => line.kind !== 'result')
      .map((line) => line.amountAgorot)

    expect(sumAgorot(contributing)).toBe(property.netProfitAgorot)
  })
})

describe('no historical drift', () => {
  const marchRule = fixedRule({ amountAgorot: 300_000, version: 1 })

  const marchSnapshot = () =>
    captureFinanceSnapshot({
      bookingId: BOOKING,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitId: UNIT,
      capturedAt: AT('2026-03-01T08:00:00.000Z'),
      capturedByUserId: 'user-a',
      reason: 'ההזמנה אושרה',
      range: { checkIn: '2026-03-10', checkOut: '2026-03-13' },
      nights: 3,
      guests: 2,
      lines: worked().lines,
      stayTotalAgorot: 292_500,
      depositAgorot: 0,
      taxAgorot: 52_650,
      taxRatePercent: 18,
      currency: 'ILS',
      commissionRule: COMMISSION,
      ownerShareRule: null,
      expenseRules: [marchRule],
    })

  it('freezes a copy of the rule, not a pointer to it', () => {
    const snapshot = marchSnapshot()
    expect(snapshot.expenseRules).toHaveLength(1)
    expect(snapshot.expenseRules[0]).toMatchObject({
      ruleId: 'rule-cleaning',
      ruleVersion: 1,
      amountAgorot: 300_000,
    })
  })

  it('produces the same P&L after the catalogue is renegotiated', () => {
    const snapshot = marchSnapshot()
    const before = bookingPnl({ snapshot })

    // June: the cleaning contract doubles. The catalogue changes; the March
    // booking's basis does not, because the P&L cannot see the catalogue.
    const renegotiated = fixedRule({ amountAgorot: 600_000, version: 2 })
    const after = bookingPnl({ snapshot })

    expect(after).toEqual(before)
    expect(snapshot.expenseRules[0].amountAgorot).toBe(300_000)
    expect(renegotiated.amountAgorot).toBe(600_000)
  })

  it('reports the drift instead of applying it', () => {
    const snapshot = marchSnapshot()
    const drift = detectRuleDrift(snapshot, [
      fixedRule({ amountAgorot: 600_000, version: 2 }),
      fixedRule({ id: 'rule-new', label: 'ביטוח', version: 1 }),
    ])

    expect(drift).toContainEqual({
      kind: 'edited',
      ruleId: 'rule-cleaning',
      label: 'חוזה ניקיון חודשי',
      snapshotVersion: 1,
      currentVersion: 2,
    })
    expect(drift.map((entry) => entry.kind)).toContain('added')
    // Reporting changed nothing.
    expect(snapshot.expenseRules[0].ruleVersion).toBe(1)
  })

  it('reports a rule that has been withdrawn', () => {
    expect(detectRuleDrift(marchSnapshot(), [])).toEqual([
      {
        kind: 'withdrawn',
        ruleId: 'rule-cleaning',
        label: 'חוזה ניקיון חודשי',
        snapshotVersion: 1,
        currentVersion: null,
      },
    ])
  })

  it('changes the basis only through a deliberate, reasoned re-snapshot', () => {
    const previous = marchSnapshot()
    const next = resnapshot({
      previous,
      bookingId: BOOKING,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitId: UNIT,
      capturedAt: AT('2026-06-01T08:00:00.000Z'),
      capturedByUserId: 'user-b',
      reason: 'תיקון חוזה הניקיון בהסכמת הבעלים',
      range: previous.range,
      nights: previous.nights,
      guests: previous.guests,
      lines: previous.lines,
      stayTotalAgorot: previous.stayTotalAgorot,
      depositAgorot: previous.depositAgorot,
      taxAgorot: previous.taxAgorot,
      taxRatePercent: previous.taxRatePercent,
      currency: 'ILS',
      commissionRule: previous.commissionRule,
      ownerShareRule: previous.ownerShareRule,
      expenseRules: [fixedRule({ amountAgorot: 600_000, version: 2 })],
    })

    expect(next.revision).toBe(2)
    expect(next.supersedesCapturedAt).toBe(previous.capturedAt)
    expect(next.expenseRules[0].amountAgorot).toBe(600_000)
    // The superseded capture is untouched — it is the evidence for the
    // statement that was already sent.
    expect(previous.expenseRules[0].amountAgorot).toBe(300_000)
  })
})
