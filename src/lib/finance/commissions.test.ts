import { describe, expect, it } from 'vitest'

import { AuthorizationError } from '../authz/can'
import { BusinessRuleError } from '../errors'
import {
  DEFAULT_ELIGIBILITY_POLICY,
  applyBookingRefundToCommission,
  buildPayoutBatch,
  buildStatement,
  createCommission,
  evaluateEligibility,
  isEligible,
  moveCommission,
  payPayoutBatch,
  payeeKey,
} from './commissions'
import {
  AT,
  BOOKING,
  ORG,
  PROPERTY,
  cleanerActor,
  financeActor,
  managerActor,
} from './testing'
import type { Commission, CommissionRule } from './types'

const NOW = AT('2026-03-20T10:00:00.000Z')
const AGENT = 'agent-user-1'

const RULE: CommissionRule = {
  basis: 'stay_total',
  kind: 'percent',
  value: 12,
  label: 'עמלת סוכן',
}

/** Sets the commercial terms and cancels; may not release money. */
const commercial = managerActor()
/** Approves and pays; may not write the agreement. */
const finance = financeActor()

function estimated(overrides: Partial<Commission> = {}): Commission {
  return {
    ...createCommission(
      {
        id: 'com-1',
        organizationId: ORG,
        propertyId: PROPERTY,
        bookingId: BOOKING,
        agentUserId: AGENT,
        rule: RULE,
        basisAgorot: 300_000,
      },
      NOW,
    ),
    ...overrides,
  }
}

function at(status: Commission['status'], overrides: Partial<Commission> = {}) {
  return estimated({
    status,
    becameEligibleAt:
      status === 'estimated' || status === 'pending' ? null : NOW,
    ...overrides,
  })
}

describe('creating a commission', () => {
  it('is born an estimate, never eligible', () => {
    const commission = estimated()
    expect(commission.status).toBe('estimated')
    expect(commission.becameEligibleAt).toBeNull()
    expect(commission.paidAt).toBeNull()
  })

  it('keeps the basis and rate beside the amount', () => {
    // A commission nobody can recompute is a commission nobody can defend
    // when the agreement has been renegotiated twice.
    const commission = estimated()
    expect(commission.basisAgorot).toBe(300_000)
    expect(commission.rateBps).toBe(1_200)
    expect(commission.amountAgorot).toBe(36_000)
  })

  it('records a fixed commission with no rate', () => {
    const fixed = createCommission(
      {
        id: 'com-2',
        organizationId: ORG,
        propertyId: PROPERTY,
        bookingId: BOOKING,
        agentUserId: AGENT,
        rule: {
          basis: 'stay_total',
          kind: 'fixed',
          value: 25_000,
          label: 'קבוע',
        },
        basisAgorot: 300_000,
      },
      NOW,
    )
    expect(fixed.rateBps).toBeNull()
    expect(fixed.amountAgorot).toBe(25_000)
  })

  it('refuses a commission owed to nobody', () => {
    expect(() =>
      createCommission(
        {
          id: 'com-3',
          organizationId: ORG,
          propertyId: PROPERTY,
          bookingId: BOOKING,
          agentUserId: null,
          rule: RULE,
          basisAgorot: 1,
        },
        NOW,
      ),
    ).toThrow(BusinessRuleError)
  })

  it('allows an agency with no named person', () => {
    const agency = createCommission(
      {
        id: 'com-4',
        organizationId: ORG,
        propertyId: PROPERTY,
        bookingId: BOOKING,
        agentUserId: null,
        agencyId: 'agency-7',
        rule: RULE,
        basisAgorot: 100_000,
      },
      NOW,
    )
    expect(payeeKey(agency)).toBe('agency:agency-7')
  })
})

describe('eligibility', () => {
  const met = {
    bookingStatus: 'completed' as const,
    settledAgorot: 300_000,
    billedAgorot: 300_000,
    freeCancellationUntil: AT('2026-03-01T00:00:00.000Z'),
    now: NOW,
  }

  it('holds only when every stated condition holds', () => {
    expect(isEligible(met)).toBe(true)
    expect(evaluateEligibility(met)).toEqual([])
  })

  it('names the condition that is unmet, in Hebrew', () => {
    const unpaid = evaluateEligibility({ ...met, settledAgorot: 100_000 })
    expect(unpaid).toHaveLength(1)
    expect(unpaid[0].code).toBe('payment_received')
    expect(unpaid[0].message).toContain('₪1,000')
  })

  it('refuses while the free-cancellation window is open', () => {
    const early = evaluateEligibility({
      ...met,
      freeCancellationUntil: AT('2026-04-01T00:00:00.000Z'),
    })
    expect(early.map((entry) => entry.code)).toEqual([
      'cancellation_window_passed',
    ])
  })

  it('refuses while the stay has not happened', () => {
    const future = evaluateEligibility({ ...met, bookingStatus: 'confirmed' })
    expect(future.map((entry) => entry.code)).toEqual(['stay_completed'])
  })

  it('lists every unmet condition at once, not one at a time', () => {
    const nothing = evaluateEligibility({
      ...met,
      bookingStatus: 'confirmed',
      settledAgorot: 0,
      freeCancellationUntil: AT('2026-04-01T00:00:00.000Z'),
    })
    expect(nothing).toHaveLength(3)
  })

  it('honours a business that pays on the deposit', () => {
    const onDeposit = {
      ...DEFAULT_ELIGIBILITY_POLICY,
      settledPercentRequired: 30,
    }
    expect(isEligible({ ...met, settledAgorot: 90_000 }, onDeposit)).toBe(true)
    expect(isEligible({ ...met, settledAgorot: 89_999 }, onDeposit)).toBe(false)
  })

  it('is unaffected by a condition the business does not require', () => {
    expect(
      isEligible(
        { ...met, bookingStatus: 'confirmed' },
        { requires: ['payment_received'], settledPercentRequired: 100 },
      ),
    ).toBe(true)
  })
})

describe('the ladder', () => {
  it('walks estimated → pending → eligible → approved → paid', () => {
    const pending = moveCommission(commercial, estimated(), 'pending', {
      now: NOW,
      reason: 'ההזמנה נסגרה',
    }).commission
    expect(pending.status).toBe('pending')

    const eligible = moveCommission(commercial, pending, 'eligible', {
      now: NOW,
      reason: 'התנאים התקיימו',
    }).commission
    expect(eligible.status).toBe('eligible')
    expect(eligible.becameEligibleAt).toEqual(NOW)

    const approved = moveCommission(finance, eligible, 'approved', {
      now: NOW,
      reason: 'אושר לתשלום',
    }).commission
    expect(approved.status).toBe('approved')
    expect(approved.approvedByUserId).toBe(finance.userId)

    const paid = moveCommission(finance, approved, 'paid', {
      now: NOW,
      reason: 'שולם',
    })
    expect(paid.commission.status).toBe('paid')
    expect(paid.commission.paidAt).toEqual(NOW)
    expect(paid.event).toBe('commission.paid')
  })

  it('refuses to skip the approval', () => {
    expect(() =>
      moveCommission(finance, at('eligible'), 'paid', {
        now: NOW,
        reason: 'קיצור דרך',
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses to approve an estimate', () => {
    // Paying on `estimated` means paying for stays that never happened.
    expect(() =>
      moveCommission(finance, estimated(), 'approved', {
        now: NOW,
        reason: 'מוקדם מדי',
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses any move out of paid', () => {
    expect(() =>
      moveCommission(commercial, at('paid'), 'cancelled', {
        now: NOW,
        reason: 'ההזמנה בוטלה',
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses any move out of cancelled', () => {
    expect(() =>
      moveCommission(commercial, at('cancelled'), 'eligible', {
        now: NOW,
        reason: 'בעצם כן',
      }),
    ).toThrow(BusinessRuleError)
  })

  it('requires a reason to cancel', () => {
    expect(() =>
      moveCommission(commercial, at('eligible'), 'cancelled', {
        now: NOW,
        reason: '   ',
      }),
    ).toThrow(BusinessRuleError)
  })
})

describe('separation of duties', () => {
  it('does not let whoever writes the rule release the money', () => {
    // A general manager owns the commercial relationship and is deliberately
    // not given `commission.approve` or `commission.payout`.
    expect(() =>
      moveCommission(commercial, at('eligible'), 'approved', {
        now: NOW,
        reason: 'אישור',
      }),
    ).toThrow(AuthorizationError)
  })

  it('does not let whoever releases the money rewrite the terms', () => {
    expect(() =>
      moveCommission(finance, estimated(), 'pending', {
        now: NOW,
        reason: 'שינוי',
      }),
    ).toThrow(AuthorizationError)
  })

  it('refuses a cleaner at every rung', () => {
    for (const [from, to] of [
      ['estimated', 'pending'],
      ['pending', 'eligible'],
      ['eligible', 'approved'],
      ['approved', 'paid'],
    ] as const) {
      expect(() =>
        moveCommission(cleanerActor(), at(from), to, {
          now: NOW,
          reason: 'ניסיון',
        }),
      ).toThrow(AuthorizationError)
    }
  })
})

describe('a refunded booking', () => {
  it('cancels a commission that has not been paid', () => {
    const effect = applyBookingRefundToCommission(commercial, at('eligible'), {
      now: NOW,
      reason: 'ההזמנה הוחזרה במלואה',
    })

    expect(effect.commission.status).toBe('cancelled')
    expect(effect.commission.cancelledReason).toContain('הוחזרה')
    expect(effect.clawbackRequired).toBe(false)
    expect(effect.change?.event).toBe('commission.cancelled')
  })

  it('flags a paid commission for clawback rather than pretending', () => {
    // The money has left the business. A status change would make the ledger
    // disagree with the bank.
    const effect = applyBookingRefundToCommission(commercial, at('paid'), {
      now: NOW,
      reason: 'ההזמנה הוחזרה',
    })

    expect(effect.commission.status).toBe('paid')
    expect(effect.clawbackRequired).toBe(true)
    expect(effect.commission.clawbackRequired).toBe(true)
    expect(effect.change).toBeNull()
  })

  it('leaves an already-cancelled commission alone', () => {
    const effect = applyBookingRefundToCommission(
      commercial,
      at('cancelled', { cancelledReason: 'בוטל קודם' }),
      { now: NOW, reason: 'שוב' },
    )
    expect(effect.change).toBeNull()
    expect(effect.commission.cancelledReason).toBe('בוטל קודם')
  })
})

describe('statements', () => {
  const inWindow = at('eligible', {
    id: 'c-in',
    becameEligibleAt: AT('2026-03-15T00:00:00.000Z'),
  })
  const alsoIn = at('paid', {
    id: 'c-paid',
    becameEligibleAt: AT('2026-03-31T23:00:00.000Z'),
  })
  const outOfWindow = at('eligible', {
    id: 'c-out',
    becameEligibleAt: AT('2026-04-02T00:00:00.000Z'),
  })
  const notEarned = at('pending', { id: 'c-pending' })

  it('lists what was earned in the window, whatever happened since', () => {
    const statement = buildStatement({
      id: 'st-1',
      organizationId: ORG,
      agentUserId: AGENT,
      periodStart: '2026-03-01',
      periodEnd: '2026-04-01',
      commissions: [inWindow, alsoIn, outOfWindow, notEarned],
      issuedAt: NOW,
    })

    expect(statement.commissionIds).toEqual(['c-in', 'c-paid'])
    expect(statement.totalAgorot).toBe(72_000)
  })

  it('excludes another agent’s commissions', () => {
    const statement = buildStatement({
      id: 'st-2',
      organizationId: ORG,
      agentUserId: 'someone-else',
      periodStart: '2026-03-01',
      periodEnd: '2026-04-01',
      commissions: [inWindow, alsoIn],
      issuedAt: NOW,
    })
    expect(statement.commissionIds).toEqual([])
    expect(statement.totalAgorot).toBe(0)
  })
})

describe('payout batches', () => {
  it('groups approved commissions and totals them', () => {
    const batch = buildPayoutBatch(finance, {
      id: 'batch-1',
      organizationId: ORG,
      commissions: [
        at('approved', { id: 'c-1' }),
        at('approved', { id: 'c-2' }),
      ],
      createdAt: NOW,
    })

    expect(batch.commissionIds).toEqual(['c-1', 'c-2'])
    expect(batch.totalAgorot).toBe(72_000)
    expect(batch.approvedByUserId).toBe(finance.userId)
    expect(batch.paidAt).toBeNull()
  })

  it('refuses a commission that has not been approved', () => {
    // Otherwise the approval step could be skipped by choosing the right
    // screen, which is the same as not having one.
    expect(() =>
      buildPayoutBatch(finance, {
        id: 'batch-2',
        organizationId: ORG,
        commissions: [at('eligible')],
        createdAt: NOW,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses an empty run', () => {
    expect(() =>
      buildPayoutBatch(finance, {
        id: 'batch-3',
        organizationId: ORG,
        commissions: [],
        createdAt: NOW,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses a cleaner', () => {
    expect(() =>
      buildPayoutBatch(cleanerActor(), {
        id: 'batch-4',
        organizationId: ORG,
        commissions: [at('approved')],
        createdAt: NOW,
      }),
    ).toThrow(AuthorizationError)
  })

  it('moves every member to paid when the run goes out', () => {
    const commissions = [
      at('approved', { id: 'c-1' }),
      at('approved', { id: 'c-2' }),
    ]
    const batch = buildPayoutBatch(finance, {
      id: 'batch-5',
      organizationId: ORG,
      commissions,
      createdAt: NOW,
    })

    const paid = payPayoutBatch(finance, batch, commissions, NOW)
    expect(paid.batch.paidAt).toEqual(NOW)
    expect(paid.changes).toHaveLength(2)
    for (const change of paid.changes) {
      expect(change.commission.status).toBe('paid')
      expect(change.event).toBe('commission.paid')
    }
  })
})
