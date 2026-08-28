import { describe, expect, it } from 'vitest'

import { AuthorizationError } from '../authz/can'
import { BusinessRuleError } from '../errors'
import { applyWebhook, createPayment } from './payments'
import {
  DEFAULT_REFUND_POLICY,
  approveRefund,
  assertRefundable,
  maxRefundableAgorot,
  refundLedgerDifference,
  refundNeedsApproval,
  rejectRefund,
  requestRefund,
  settleRefund,
} from './refunds'
import {
  AT,
  BOOKING,
  ORG,
  PROPERTY,
  cleanerActor,
  financeActor,
} from './testing'
import type { Payment } from './types'

const NOW = AT('2026-03-11T10:00:00.000Z')
const actor = financeActor()

function paidPayment(overrides: Partial<Payment> = {}): Payment {
  const created = createPayment(
    {
      id: 'pay-1',
      organizationId: ORG,
      propertyId: PROPERTY,
      bookingId: BOOKING,
      purpose: 'full',
      method: 'card',
      channel: 'payment_link',
      amountAgorot: 100_000,
      providerId: 'in_memory',
    },
    NOW,
  )

  const settled = applyWebhook(
    actor,
    created,
    {
      eventId: 'evt-1',
      providerRef: 'ref-1',
      paymentId: 'pay-1',
      type: 'captured',
      amountAgorot: 100_000,
      providerStatus: 'captured',
      occurredAt: NOW,
    },
    NOW,
  ).payment

  return { ...settled, ...overrides }
}

describe('the refund ceiling', () => {
  it('is what was captured, less what has already gone back', () => {
    const payment = paidPayment({ refundedAgorot: 30_000 })
    expect(maxRefundableAgorot(payment)).toBe(70_000)
  })

  it('is measured against the capture, never against the status', () => {
    // A partially captured payment for ₪1,000 that only took ₪300 can return
    // ₪300. A status-based check would offer the whole ₪1,000.
    const partial = paidPayment({
      status: 'partially_paid',
      capturedAgorot: 30_000,
    })
    expect(maxRefundableAgorot(partial)).toBe(30_000)
    expect(() => assertRefundable(partial, 40_000)).toThrow(BusinessRuleError)
  })

  it('refuses a refund above it and says how much is available', () => {
    const payment = paidPayment({ refundedAgorot: 90_000 })
    try {
      assertRefundable(payment, 20_000)
      expect.unreachable('expected the refund to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessRuleError)
      const failure = error as BusinessRuleError
      expect(failure.code).toBe('finance.refund_exceeds_capture')
      expect(failure.publicDetails).toMatchObject({
        requested: 20_000,
        refundable: 10_000,
      })
      // The operator is told the figure they can actually use, or they will
      // guess high and try again.
      expect(failure.userMessage).toContain('₪100')
    }
  })

  it('refuses a refund on a payment that captured nothing', () => {
    const nothing = paidPayment({ capturedAgorot: 0, status: 'failed' })
    expect(() => assertRefundable(nothing, 1)).toThrow(BusinessRuleError)
  })

  it('refuses a zero or fractional amount', () => {
    const payment = paidPayment()
    expect(() => assertRefundable(payment, 0)).toThrow(BusinessRuleError)
    expect(() => assertRefundable(payment, 10.5)).toThrow(BusinessRuleError)
  })
})

describe('approval policy', () => {
  it('lets a small correction through without a second signature', () => {
    expect(refundNeedsApproval(10_000, 'correction')).toBe(false)
  })

  it('demands approval above the threshold', () => {
    expect(
      refundNeedsApproval(
        DEFAULT_REFUND_POLICY.autoApproveUpToAgorot + 1,
        'correction',
      ),
    ).toBe(true)
  })

  it('demands approval for the named reasons whatever the amount', () => {
    expect(refundNeedsApproval(100, 'goodwill')).toBe(true)
    expect(refundNeedsApproval(100, 'business_cancellation')).toBe(true)
  })
})

describe('requesting a refund', () => {
  it('is ready to send when no approval is needed', () => {
    const refund = requestRefund({
      id: 'ref-1',
      payment: paidPayment(),
      amountAgorot: 10_000,
      reason: 'correction',
      reasonText: 'חיוב כפול בטעות',
      requestedByUserId: 'user-a',
      requestedAt: NOW,
    })

    expect(refund.status).toBe('approved')
    expect(refund.approvalStatus).toBe('approved')
  })

  it('waits for a person when the amount is large', () => {
    const refund = requestRefund({
      id: 'ref-2',
      payment: paidPayment(),
      amountAgorot: 80_000,
      reason: 'guest_cancellation',
      reasonText: 'ביטול של האורח',
      requestedByUserId: 'user-a',
      requestedAt: NOW,
    })

    expect(refund.status).toBe('requested')
    expect(refund.approvalStatus).toBe('requested')
    expect(refund.approvedByUserId).toBeNull()
  })

  it('refuses a request with no stated reason', () => {
    expect(() =>
      requestRefund({
        id: 'ref-3',
        payment: paidPayment(),
        amountAgorot: 1_000,
        reason: 'correction',
        reasonText: '   ',
        requestedByUserId: 'user-a',
        requestedAt: NOW,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses a request above the ceiling before a record exists', () => {
    expect(() =>
      requestRefund({
        id: 'ref-4',
        payment: paidPayment({ refundedAgorot: 100_000 }),
        amountAgorot: 1,
        reason: 'correction',
        reasonText: 'תיקון',
        requestedByUserId: 'user-a',
        requestedAt: NOW,
      }),
    ).toThrow(BusinessRuleError)
  })
})

describe('deciding a refund', () => {
  const pendingRefund = () =>
    requestRefund({
      id: 'ref-5',
      payment: paidPayment(),
      amountAgorot: 80_000,
      reason: 'guest_cancellation',
      reasonText: 'ביטול',
      requestedByUserId: 'user-a',
      requestedAt: NOW,
    })

  it('is approved by somebody else', () => {
    const approved = approveRefund(pendingRefund(), 'user-b')
    expect(approved.approvalStatus).toBe('approved')
    expect(approved.approvedByUserId).toBe('user-b')
  })

  it('refuses self-approval', () => {
    // The whole point of a second signature is that it belongs to a second
    // person.
    expect(() => approveRefund(pendingRefund(), 'user-a')).toThrow(
      BusinessRuleError,
    )
  })

  it('can be rejected, which is not the same as failing', () => {
    const rejected = rejectRefund(pendingRefund())
    expect(rejected.status).toBe('rejected')
    expect(rejected.approvalStatus).toBe('rejected')
  })

  it('refuses a second decision', () => {
    const approved = approveRefund(pendingRefund(), 'user-b')
    expect(() => rejectRefund(approved)).toThrow(BusinessRuleError)
  })
})

describe('settling a refund', () => {
  const readyRefund = (amountAgorot = 30_000) =>
    requestRefund({
      id: 'ref-6',
      payment: paidPayment(),
      amountAgorot,
      reason: 'correction',
      reasonText: 'תיקון',
      requestedByUserId: 'user-a',
      requestedAt: NOW,
    })

  it('moves the money once and marks the refund processed', () => {
    const payment = paidPayment()
    const settlement = settleRefund(actor, payment, readyRefund(), {
      now: NOW,
      eventId: 'evt-refund',
    })

    expect(settlement).not.toBeNull()
    if (!settlement) return
    expect(settlement.refund.status).toBe('processed')
    expect(settlement.change.payment.refundedAgorot).toBe(30_000)
    expect(settlement.change.payment.status).toBe('partially_refunded')
    expect(settlement.change.event).toBe('payment.refunded')
  })

  it('does nothing when the refund has already been processed', () => {
    const payment = paidPayment()
    const first = settleRefund(actor, payment, readyRefund(), { now: NOW })
    expect(first).not.toBeNull()
    if (!first) return

    const second = settleRefund(actor, first.change.payment, first.refund, {
      now: NOW,
    })
    expect(second).toBeNull()
  })

  it('refuses to settle a refund awaiting approval', () => {
    const waiting = requestRefund({
      id: 'ref-7',
      payment: paidPayment(),
      amountAgorot: 80_000,
      reason: 'goodwill',
      reasonText: 'פיצוי',
      requestedByUserId: 'user-a',
      requestedAt: NOW,
    })

    expect(() =>
      settleRefund(actor, paidPayment(), waiting, { now: NOW }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses a cleaner outright', () => {
    expect(() =>
      settleRefund(cleanerActor(), paidPayment(), readyRefund(), { now: NOW }),
    ).toThrow(AuthorizationError)
  })

  it('cannot be used to exceed the ceiling in two steps', () => {
    const payment = paidPayment()
    // ₪700 is above the auto-approval threshold, so it takes a second person
    // before any money moves.
    const large = approveRefund(readyRefund(70_000), 'user-b')
    const first = settleRefund(actor, payment, large, { now: NOW })
    expect(first).not.toBeNull()
    if (!first) return

    // ₪700 has gone back, so only ₪300 remains. A second request for ₪400 is
    // refused against the already-reduced ceiling rather than against the
    // original capture.
    expect(maxRefundableAgorot(first.change.payment)).toBe(30_000)
    expect(() =>
      requestRefund({
        id: 'ref-8',
        payment: first.change.payment,
        amountAgorot: 40_000,
        reason: 'correction',
        reasonText: 'תיקון נוסף',
        requestedByUserId: 'user-a',
        requestedAt: NOW,
      }),
    ).toThrow(BusinessRuleError)
  })
})

describe('the refund ledger', () => {
  it('reconciles processed refunds against the payment', () => {
    const payment = paidPayment()
    const settlement = settleRefund(
      actor,
      payment,
      requestRefund({
        id: 'ref-9',
        payment,
        amountAgorot: 20_000,
        reason: 'correction',
        reasonText: 'תיקון',
        requestedByUserId: 'user-a',
        requestedAt: NOW,
      }),
      { now: NOW },
    )
    expect(settlement).not.toBeNull()
    if (!settlement) return

    expect(
      refundLedgerDifference(settlement.change.payment, [settlement.refund]),
    ).toBe(0)
  })

  it('reports the difference a chargeback leaves behind', () => {
    // The bank refunded without a refund record. Reported, not thrown: it is
    // a real event and the reconciliation report is where it belongs.
    const clawed = paidPayment({
      refundedAgorot: 25_000,
      status: 'partially_refunded',
    })
    expect(refundLedgerDifference(clawed, [])).toBe(25_000)
  })
})
