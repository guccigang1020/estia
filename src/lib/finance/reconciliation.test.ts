import { describe, expect, it } from 'vitest'

import { createPayment } from './payments'
import type { ProviderTransaction } from './provider'
import { describeReconciliation, reconcile } from './reconciliation'
import { AT, BOOKING, ORG, PROPERTY } from './testing'
import type { Payment } from './types'

const FROM = AT('2026-03-01T00:00:00.000Z')
const TO = AT('2026-04-01T00:00:00.000Z')
const NOW = AT('2026-03-11T10:00:00.000Z')

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    ...createPayment(
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
    ),
    status: 'paid',
    capturedAgorot: 100_000,
    providerRef: 'ref-1',
    ...overrides,
  }
}

function transaction(
  overrides: Partial<ProviderTransaction> = {},
): ProviderTransaction {
  return {
    providerRef: 'ref-1',
    capturedAgorot: 100_000,
    refundedAgorot: 0,
    currency: 'ILS',
    providerStatus: 'captured',
    occurredAt: NOW,
    ...overrides,
  }
}

describe('a clean run', () => {
  it('balances when both ledgers agree to the agora', () => {
    const report = reconcile({
      from: FROM,
      to: TO,
      payments: [payment()],
      providerTransactions: [transaction()],
    })

    expect(report.balanced).toBe(true)
    expect(report.matchedCount).toBe(1)
    expect(report.matchedAgorot).toBe(100_000)
    expect(report.differences).toEqual([])
    expect(describeReconciliation(report)).toContain('ללא הפרשים')
  })

  it('leaves cash and bank transfers out of the comparison', () => {
    // A processor cannot know about money handed over at the desk. Reporting
    // it as missing would make every run red, which is the same as no run.
    const cash = payment({
      id: 'pay-cash',
      method: 'cash',
      channel: 'manual',
      providerId: null,
      providerRef: null,
    })

    const report = reconcile({
      from: FROM,
      to: TO,
      payments: [cash],
      providerTransactions: [],
    })

    expect(report.balanced).toBe(true)
    expect(report.offProviderCount).toBe(1)
    expect(report.offProviderAgorot).toBe(100_000)
  })
})

describe('differences', () => {
  it('reports a payment the provider has no record of', () => {
    const report = reconcile({
      from: FROM,
      to: TO,
      payments: [payment()],
      providerTransactions: [],
    })

    expect(report.differences).toHaveLength(1)
    expect(report.differences[0]).toMatchObject({
      kind: 'missing_at_provider',
      paymentId: 'pay-1',
      internalAgorot: 100_000,
      providerAgorot: 0,
      deltaAgorot: 100_000,
    })
    expect(report.differenceAgorot).toBe(100_000)
  })

  it('reports money the processor took that we never recorded', () => {
    // The dangerous direction: money that reaches no booking and no balance.
    const report = reconcile({
      from: FROM,
      to: TO,
      payments: [],
      providerTransactions: [transaction({ providerRef: 'ref-stray' })],
    })

    expect(report.differences[0]).toMatchObject({
      kind: 'missing_internally',
      providerRef: 'ref-stray',
      internalAgorot: 0,
      providerAgorot: 100_000,
    })
  })

  it('reports an amount that disagrees', () => {
    const report = reconcile({
      from: FROM,
      to: TO,
      payments: [payment()],
      providerTransactions: [transaction({ capturedAgorot: 90_000 })],
    })

    expect(report.differences[0]).toMatchObject({
      kind: 'amount_mismatch',
      internalAgorot: 100_000,
      providerAgorot: 90_000,
      deltaAgorot: 10_000,
    })
  })

  it('compares captures and refunds separately, not only the net', () => {
    // Both ₪200 too high nets to zero. Netting would call it a match, while
    // the guest was charged and refunded twice.
    const report = reconcile({
      from: FROM,
      to: TO,
      payments: [payment({ capturedAgorot: 120_000, refundedAgorot: 20_000 })],
      providerTransactions: [transaction()],
    })

    expect(report.balanced).toBe(false)
    expect(report.differences[0].kind).toBe('amount_mismatch')
  })

  it('reports a refund that disagrees', () => {
    const report = reconcile({
      from: FROM,
      to: TO,
      payments: [payment({ refundedAgorot: 40_000 })],
      providerTransactions: [transaction({ refundedAgorot: 30_000 })],
    })

    expect(report.differences[0]).toMatchObject({
      kind: 'refund_mismatch',
      internalAgorot: 40_000,
      providerAgorot: 30_000,
    })
  })

  it('reports a provider-collected payment with no transaction reference', () => {
    const report = reconcile({
      from: FROM,
      to: TO,
      payments: [payment({ providerRef: null })],
      providerTransactions: [],
    })

    expect(report.differences[0].kind).toBe('unlinked')
  })
})

describe('the unknown queue', () => {
  it('is what a run exists to find', () => {
    const report = reconcile({
      from: FROM,
      to: TO,
      payments: [
        payment({ status: 'unknown', capturedAgorot: 0, providerRef: 'ref-1' }),
      ],
      providerTransactions: [transaction()],
    })

    expect(report.differences).toHaveLength(1)
    expect(report.differences[0]).toMatchObject({
      kind: 'status_unknown',
      internalAgorot: 0,
      providerAgorot: 100_000,
    })
    expect(report.differences[0].message).toContain('לא ידוע')
  })

  it('says plainly when the charge never happened', () => {
    const report = reconcile({
      from: FROM,
      to: TO,
      payments: [
        payment({ status: 'unknown', capturedAgorot: 0, providerRef: 'ref-x' }),
      ],
      providerTransactions: [],
    })

    expect(report.differences[0].kind).toBe('status_unknown')
    expect(report.differences[0].message).toContain('לא בוצע')
  })

  it('does not also report the matched transaction as missing internally', () => {
    // The unknown payment consumed its provider row; reporting it twice would
    // double the money apparently in dispute.
    const report = reconcile({
      from: FROM,
      to: TO,
      payments: [
        payment({ status: 'unknown', capturedAgorot: 0, providerRef: 'ref-1' }),
      ],
      providerTransactions: [transaction()],
    })

    expect(
      report.differences.filter((d) => d.kind === 'missing_internally'),
    ).toHaveLength(0)
  })
})

describe('nothing is repaired', () => {
  it('leaves every payment exactly as it found it', () => {
    const original = payment()
    const before = { ...original }

    reconcile({
      from: FROM,
      to: TO,
      payments: [original],
      providerTransactions: [transaction({ capturedAgorot: 1 })],
    })

    expect(original).toEqual(before)
  })

  it('summarises a run with differences for the notification', () => {
    const report = reconcile({
      from: FROM,
      to: TO,
      payments: [payment()],
      providerTransactions: [transaction({ capturedAgorot: 90_000 })],
    })

    expect(describeReconciliation(report)).toContain('הפרשים')
    expect(report.balanced).toBe(false)
  })
})
