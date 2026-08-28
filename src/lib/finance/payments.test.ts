import { describe, expect, it } from 'vitest'

import { BusinessRuleError } from '../errors'
import {
  InMemoryPaymentProvider,
  type ProviderResult,
  type ProviderWebhookEvent,
} from './provider'
import {
  applyProviderResult,
  applyWebhook,
  bookingBalance,
  createPayment,
  planInstalments,
  resolveUnknownPayment,
} from './payments'
import { createDeposit, authorizeDeposit } from './deposits'
import { sumAgorot } from './money'
import { AT, BOOKING, ORG, PROPERTY, financeActor } from './testing'
import type { Payment } from './types'

const NOW = AT('2026-03-11T10:00:00.000Z')
const actor = financeActor()

function pending(overrides: Partial<Payment> = {}): Payment {
  return {
    ...createPayment(
      {
        id: 'pay-1',
        organizationId: ORG,
        propertyId: PROPERTY,
        bookingId: BOOKING,
        purpose: 'balance',
        method: 'card',
        channel: 'payment_link',
        amountAgorot: 10_000,
        providerId: 'in_memory',
      },
      NOW,
    ),
    ...overrides,
  }
}

function event(
  overrides: Partial<ProviderWebhookEvent> = {},
): ProviderWebhookEvent {
  return {
    eventId: 'evt-1',
    providerRef: 'ref-1',
    paymentId: 'pay-1',
    type: 'captured',
    amountAgorot: 10_000,
    providerStatus: 'captured',
    occurredAt: AT('2026-03-11T10:05:00.000Z'),
    ...overrides,
  }
}

describe('createPayment', () => {
  it('is born owing everything and holding nothing', () => {
    const payment = pending()
    expect(payment.status).toBe('pending')
    expect(payment.capturedAgorot).toBe(0)
    expect(payment.authorizedAgorot).toBe(0)
    expect(payment.refundedAgorot).toBe(0)
    expect(payment.appliedEventIds).toEqual([])
  })

  it('refuses an amount that is not whole positive agorot', () => {
    expect(() =>
      createPayment(
        {
          id: 'p',
          organizationId: ORG,
          bookingId: BOOKING,
          purpose: 'full',
          method: 'cash',
          channel: 'manual',
          amountAgorot: 0,
        },
        NOW,
      ),
    ).toThrow(BusinessRuleError)

    expect(() =>
      createPayment(
        {
          id: 'p',
          organizationId: ORG,
          bookingId: BOOKING,
          purpose: 'full',
          method: 'cash',
          channel: 'manual',
          amountAgorot: 100.5,
        },
        NOW,
      ),
    ).toThrow(BusinessRuleError)
  })
})

describe('webhooks', () => {
  it('applies a capture and records the delivery', () => {
    const result = applyWebhook(actor, pending(), event(), NOW)

    expect(result.outcome).toBe('applied')
    expect(result.payment.status).toBe('paid')
    expect(result.payment.capturedAgorot).toBe(10_000)
    expect(result.payment.appliedEventIds).toEqual(['evt-1'])
    expect(result.payment.lastProviderEventAt).toEqual(
      AT('2026-03-11T10:05:00.000Z'),
    )
    expect(result.event).toBe('payment.received')
  })

  it('does nothing at all on a redelivery of the same event', () => {
    const first = applyWebhook(actor, pending(), event(), NOW)
    const second = applyWebhook(actor, first.payment, event(), NOW)

    expect(second.outcome).toBe('duplicate')
    expect(second.payment).toBe(first.payment)
    expect(second.payment.capturedAgorot).toBe(10_000)
    expect(second.event).toBeNull()
  })

  it('never double-refunds on a redelivered refund event', () => {
    const paid = applyWebhook(actor, pending(), event(), NOW).payment
    const refundEvent = event({
      eventId: 'evt-2',
      type: 'refunded',
      amountAgorot: 10_000,
      occurredAt: AT('2026-03-11T11:00:00.000Z'),
    })

    const first = applyWebhook(actor, paid, refundEvent, NOW)
    expect(first.outcome).toBe('applied')
    expect(first.payment.status).toBe('refunded')
    expect(first.payment.refundedAgorot).toBe(10_000)

    const second = applyWebhook(actor, first.payment, refundEvent, NOW)
    expect(second.outcome).toBe('duplicate')
    expect(second.payment.refundedAgorot).toBe(10_000)
  })

  it('records an out-of-order delivery without applying it', () => {
    const paid = applyWebhook(actor, pending(), event(), NOW).payment
    const refunded = applyWebhook(
      actor,
      paid,
      event({
        eventId: 'evt-2',
        type: 'refunded',
        amountAgorot: 10_000,
        occurredAt: AT('2026-03-11T11:00:00.000Z'),
      }),
      NOW,
    ).payment

    // A capture notification that the provider says happened *before* the
    // refund. Applying it would un-refund the payment.
    const late = applyWebhook(
      actor,
      refunded,
      event({
        eventId: 'evt-3',
        type: 'captured',
        amountAgorot: 10_000,
        occurredAt: AT('2026-03-11T10:30:00.000Z'),
      }),
      NOW,
    )

    expect(late.outcome).toBe('stale')
    expect(late.payment.status).toBe('refunded')
    expect(late.payment.refundedAgorot).toBe(10_000)
    // Recorded, so a third delivery of the same stale event is a duplicate
    // rather than looking new again.
    expect(late.payment.appliedEventIds).toContain('evt-3')

    const again = applyWebhook(
      actor,
      late.payment,
      event({
        eventId: 'evt-3',
        type: 'captured',
        amountAgorot: 10_000,
        occurredAt: AT('2026-03-11T10:30:00.000Z'),
      }),
      NOW,
    )
    expect(again.outcome).toBe('duplicate')
  })

  it('refuses an event about a different transaction', () => {
    const linked = { ...pending(), providerRef: 'ref-1' }
    const stray = applyWebhook(
      actor,
      linked,
      event({ providerRef: 'ref-other' }),
      NOW,
    )

    expect(stray.outcome).toBe('mismatched_reference')
    expect(stray.payment.capturedAgorot).toBe(0)
  })

  it('treats webhook amounts as totals, so a repeat is a no-op', () => {
    const partial = applyWebhook(
      actor,
      pending(),
      event({ type: 'partially_captured', amountAgorot: 4_000 }),
      NOW,
    )
    expect(partial.payment.status).toBe('partially_paid')
    expect(partial.payment.capturedAgorot).toBe(4_000)

    // The same total again, as a fresh delivery. Nothing accumulates.
    const repeat = applyWebhook(
      actor,
      partial.payment,
      event({
        eventId: 'evt-9',
        type: 'partially_captured',
        amountAgorot: 4_000,
        occurredAt: AT('2026-03-11T10:06:00.000Z'),
      }),
      NOW,
    )
    expect(repeat.payment.capturedAgorot).toBe(4_000)
  })

  it('records a chargeback as money going back, capped at the capture', () => {
    const paid = applyWebhook(actor, pending(), event(), NOW).payment
    const clawed = applyWebhook(
      actor,
      paid,
      event({
        eventId: 'evt-cb',
        type: 'chargeback',
        amountAgorot: 999_999,
        occurredAt: AT('2026-03-12T09:00:00.000Z'),
      }),
      NOW,
    )

    expect(clawed.outcome).toBe('applied')
    expect(clawed.payment.refundedAgorot).toBe(10_000)
    expect(clawed.payment.status).toBe('refunded')
  })
})

describe('a payment that succeeds after cancellation', () => {
  it('is applied, flagged and reported — never swallowed', () => {
    const cancelled = pending({ status: 'cancelled' })
    const late = applyWebhook(actor, cancelled, event(), NOW)

    expect(late.outcome).toBe('applied')
    expect(late.payment.status).toBe('paid')
    expect(late.payment.capturedAgorot).toBe(10_000)
    expect(late.anomaly).toBe('payment_after_cancellation')
    expect(late.payment.requiresAttention).toBe('refund_after_cancellation')
    expect(late.transition?.sideEffects).toContain('open_reconciliation_task')
  })

  it('keeps the flag when an ordinary event follows', () => {
    const cancelled = pending({ status: 'cancelled' })
    const flagged = applyWebhook(actor, cancelled, event(), NOW).payment
    const later = applyWebhook(
      actor,
      flagged,
      event({
        eventId: 'evt-2',
        type: 'partially_refunded',
        amountAgorot: 2_000,
        occurredAt: AT('2026-03-11T12:00:00.000Z'),
      }),
      NOW,
    )

    // Automation that can clear its own alarms is automation whose alarms
    // mean nothing.
    expect(later.payment.requiresAttention).toBe('refund_after_cancellation')
  })
})

describe('the unknown outcome', () => {
  const timeout: ProviderResult = {
    outcome: 'unknown',
    providerRef: 'ref-1',
    amountAgorot: 10_000,
    providerStatus: 'timeout',
    failureCode: 'gateway_timeout',
    occurredAt: NOW,
  }

  it('is never reported as a failure', () => {
    const change = applyProviderResult(
      actor,
      pending(),
      'capture',
      timeout,
      NOW,
    )

    expect(change.payment.status).toBe('unknown')
    expect(change.payment.status).not.toBe('failed')
    expect(change.payment.requiresAttention).toBe('reconcile_unknown')
    expect(change.payment.unknownSince).toEqual(NOW)
    // Nothing about the amounts changed. We do not know what they are.
    expect(change.payment.capturedAgorot).toBe(0)
    expect(change.transition.sideEffects).toContain('open_reconciliation_task')
  })

  it('is closed by the provider record, not by a retry', () => {
    const unknown = applyProviderResult(
      actor,
      pending(),
      'capture',
      timeout,
      NOW,
    ).payment

    const resolved = resolveUnknownPayment(
      actor,
      unknown,
      {
        providerRef: 'ref-1',
        capturedAgorot: 10_000,
        refundedAgorot: 0,
        currency: 'ILS',
        providerStatus: 'captured',
        occurredAt: NOW,
      },
      NOW,
    )

    expect(resolved.payment.status).toBe('paid')
    expect(resolved.payment.capturedAgorot).toBe(10_000)
    expect(resolved.payment.requiresAttention).toBeNull()
    expect(resolved.payment.unknownSince).toBeNull()
  })

  it('cancels when the provider has no such transaction', () => {
    const unknown = applyProviderResult(
      actor,
      pending(),
      'capture',
      timeout,
      NOW,
    ).payment

    const resolved = resolveUnknownPayment(actor, unknown, null, NOW)
    expect(resolved.payment.status).toBe('cancelled')
    expect(resolved.payment.capturedAgorot).toBe(0)
  })

  it('refuses to reconcile a payment that is not unknown', () => {
    expect(() =>
      resolveUnknownPayment(actor, pending({ status: 'paid' }), null, NOW),
    ).toThrow(BusinessRuleError)
  })

  it('really does model a provider that charged and did not say so', () => {
    // The fake performs the movement and then reports `unknown`, which is the
    // hazard. A stub that politely did nothing would make the reconciliation
    // test pass for the wrong reason.
    const provider = new InMemoryPaymentProvider('secret', () => NOW)
    return (async () => {
      const page = await provider.createHostedPage({
        organizationId: ORG,
        paymentId: 'pay-1',
        amountAgorot: 10_000,
        currency: 'ILS',
        description: 'יתרה',
        returnUrl: 'https://example.test/done',
        idempotencyKey: 'key-1',
        intent: 'authorize_only',
      })
      provider.authorizeHostedPage(page.providerRef, 10_000)

      provider.behaviour = 'timeout'
      const result = await provider.capture({
        providerRef: page.providerRef,
        amountAgorot: 10_000,
        idempotencyKey: 'key-capture',
      })
      expect(result.outcome).toBe('unknown')

      const truth = await provider.listTransactions({
        from: AT('2026-03-01T00:00:00.000Z'),
        to: AT('2026-04-01T00:00:00.000Z'),
      })
      expect(truth[0].capturedAgorot).toBe(10_000)
    })()
  })
})

describe('overpayment', () => {
  it('is flagged rather than truncated', () => {
    const over = applyWebhook(
      actor,
      pending(),
      event({ amountAgorot: 15_000 }),
      NOW,
    )
    expect(over.payment.capturedAgorot).toBe(15_000)
    expect(over.payment.requiresAttention).toBe('overpaid')
    expect(over.anomaly).toBe('captured_more_than_requested')
  })
})

describe('provider signature verification', () => {
  const provider = new InMemoryPaymentProvider('secret', () => NOW)

  const payload = JSON.stringify({
    eventId: 'evt-1',
    providerRef: 'ref-1',
    type: 'captured',
    amountAgorot: 10_000,
    occurredAt: NOW.toISOString(),
  })

  it('accepts a correctly signed delivery', () => {
    const verified = provider.verifyWebhook(payload, provider.sign(payload))
    expect(verified.valid).toBe(true)
    if (verified.valid) expect(verified.event.type).toBe('captured')
  })

  it('refuses an unsigned or wrongly signed delivery', () => {
    expect(provider.verifyWebhook(payload, 'nonsense')).toEqual({
      valid: false,
      reason: 'bad_signature',
    })
  })

  it('refuses a payload it cannot read', () => {
    const junk = 'not json'
    expect(provider.verifyWebhook(junk, provider.sign(junk))).toEqual({
      valid: false,
      reason: 'malformed',
    })
  })

  it('refuses an event type it does not know', () => {
    const odd = JSON.stringify({
      eventId: 'e',
      providerRef: 'r',
      type: 'invented',
      amountAgorot: 1,
      occurredAt: NOW.toISOString(),
    })
    expect(provider.verifyWebhook(odd, provider.sign(odd))).toEqual({
      valid: false,
      reason: 'unknown_type',
    })
  })
})

describe('instalment plans', () => {
  it('splits a total so the parts add back to it', () => {
    const plan = planInstalments({
      scheduleId: 'sch-1',
      organizationId: ORG,
      bookingId: BOOKING,
      totalAgorot: 100_000,
      count: 3,
      firstDueOn: '2026-01-15',
      cadence: 'monthly',
    })

    expect(plan.instalments.map((i) => i.amountAgorot)).toEqual([
      33_334, 33_333, 33_333,
    ])
    expect(sumAgorot(plan.instalments.map((i) => i.amountAgorot))).toBe(100_000)
  })

  it('takes the deposit off the top and splits the rest', () => {
    const plan = planInstalments({
      scheduleId: 'sch-2',
      organizationId: ORG,
      bookingId: BOOKING,
      totalAgorot: 100_000,
      count: 3,
      firstDueOn: '2026-01-15',
      cadence: 'monthly',
      depositAgorot: 30_000,
    })

    expect(plan.instalments.map((i) => i.amountAgorot)).toEqual([
      30_000, 35_000, 35_000,
    ])
    expect(plan.instalments[0].purpose).toBe('deposit')
    expect(plan.instalments[2].purpose).toBe('balance')
  })

  it('sums exactly for every count and every awkward total', () => {
    for (const total of [1, 999, 100_001, 7_777_777]) {
      for (let count = 1; count <= 12; count += 1) {
        const plan = planInstalments({
          scheduleId: 's',
          organizationId: ORG,
          bookingId: BOOKING,
          totalAgorot: total,
          count,
          firstDueOn: '2026-01-31',
          cadence: 'monthly',
        })
        expect(sumAgorot(plan.instalments.map((i) => i.amountAgorot))).toBe(
          total,
        )
      }
    }
  })

  it('clamps a monthly plan to the end of a short month', () => {
    const plan = planInstalments({
      scheduleId: 's',
      organizationId: ORG,
      bookingId: BOOKING,
      totalAgorot: 90_000,
      count: 3,
      firstDueOn: '2026-01-31',
      cadence: 'monthly',
    })
    expect(plan.instalments.map((i) => i.dueOn)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ])
  })

  it('steps weekly plans by seven days', () => {
    const plan = planInstalments({
      scheduleId: 's',
      organizationId: ORG,
      bookingId: BOOKING,
      totalAgorot: 30_000,
      count: 3,
      firstDueOn: '2026-01-01',
      cadence: 'weekly',
    })
    expect(plan.instalments.map((i) => i.dueOn)).toEqual([
      '2026-01-01',
      '2026-01-08',
      '2026-01-15',
    ])
  })

  it('refuses a deposit plan with only one instalment', () => {
    expect(() =>
      planInstalments({
        scheduleId: 's',
        organizationId: ORG,
        bookingId: BOOKING,
        totalAgorot: 10_000,
        count: 1,
        firstDueOn: '2026-01-01',
        cadence: 'monthly',
        depositAgorot: 5_000,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses a deposit larger than the booking', () => {
    expect(() =>
      planInstalments({
        scheduleId: 's',
        organizationId: ORG,
        bookingId: BOOKING,
        totalAgorot: 10_000,
        count: 2,
        firstDueOn: '2026-01-01',
        cadence: 'monthly',
        depositAgorot: 20_000,
      }),
    ).toThrow(BusinessRuleError)
  })
})

describe('bookingBalance', () => {
  it('counts money in an unknown state as neither paid nor outstanding', () => {
    const settled = applyWebhook(
      actor,
      pending(),
      event({ amountAgorot: 4_000, type: 'partially_captured' }),
      NOW,
    ).payment

    const inFlight = pending({
      id: 'pay-2',
      status: 'unknown',
      amountAgorot: 6_000,
    })

    const balance = bookingBalance(10_000, [settled, inFlight])

    expect(balance.settledAgorot).toBe(4_000)
    expect(balance.outstandingAgorot).toBe(6_000)
    expect(balance.unknownAgorot).toBe(6_000)
  })

  it('reads the deposit from the deposit record, not from the payments', () => {
    const deposit = authorizeDeposit(
      actor,
      createDeposit(
        {
          id: 'dep-1',
          organizationId: ORG,
          propertyId: PROPERTY,
          bookingId: BOOKING,
          requiredAgorot: 100_000,
        },
        NOW,
      ),
      100_000,
      { now: NOW },
    ).deposit

    const balance = bookingBalance(10_000, [], deposit)
    expect(balance.depositHeldAgorot).toBe(100_000)
    // A held deposit is not revenue and does not reduce what is owed.
    expect(balance.outstandingAgorot).toBe(10_000)
  })
})
