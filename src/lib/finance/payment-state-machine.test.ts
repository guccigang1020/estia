import { describe, expect, it } from 'vitest'

import { AuthorizationError } from '../authz/can'
import { PAYMENT_STATUSES, type PaymentStatus } from '../contracts/states'
import { BusinessRuleError } from '../errors'
import { createPayment } from './payments'
import {
  PAYMENT_STATUS_LABEL,
  PAYMENT_TRANSITIONS,
  assertPaymentTransition,
  evaluatePaymentTransition,
  findPaymentTransition,
  legalNextPaymentStatuses,
  type PaymentTransitionCheck,
  paymentEventFor,
} from './payment-state-machine'
import {
  AT,
  BOOKING,
  ORG,
  PROPERTY,
  cleanerActor,
  financeActor,
} from './testing'
import type { Payment, PaymentAmounts } from './types'

const NOW = AT('2026-03-11T10:00:00.000Z')

function paymentIn(status: PaymentStatus, overrides: Partial<Payment> = {}) {
  const base = createPayment(
    {
      id: 'pay-1',
      organizationId: ORG,
      propertyId: PROPERTY,
      bookingId: BOOKING,
      purpose: 'balance',
      method: 'card',
      channel: 'payment_link',
      amountAgorot: 10_000,
    },
    NOW,
  )
  return { ...base, status, ...overrides }
}

/**
 * Amounts that satisfy the target status's own conditions.
 *
 * The conditions read the amounts a move would *produce*, so a legal-transition
 * sweep has to supply a coherent set for each target. Getting these wrong would
 * make the sweep pass for the wrong reason, which is why each one is the
 * minimal shape the condition actually demands.
 */
function amountsFor(to: PaymentStatus): PaymentAmounts {
  const base = {
    amountAgorot: 10_000,
    authorizedAgorot: 0,
    capturedAgorot: 0,
    refundedAgorot: 0,
  }
  switch (to) {
    case 'authorized':
      return { ...base, authorizedAgorot: 10_000 }
    case 'paid':
      return { ...base, capturedAgorot: 10_000 }
    case 'partially_paid':
      return { ...base, capturedAgorot: 4_000 }
    case 'partially_refunded':
      return { ...base, capturedAgorot: 10_000, refundedAgorot: 3_000 }
    case 'refunded':
      return { ...base, capturedAgorot: 10_000, refundedAgorot: 10_000 }
    default:
      return base
  }
}

/**
 * The refusal's domain code, or `null` when the refusal was about permission.
 *
 * An authorization refusal deliberately carries no code — it carries the
 * authorization engine's own error — so a test asserting on a code has to say
 * which kind of refusal it expected. Collapsing the two would let a permission
 * failure pass as a condition failure.
 */
function refusalCode(check: PaymentTransitionCheck): string | null {
  if (check.ok) return null
  return check.refusal.kind === 'not_permitted' ? null : check.refusal.code
}

describe('the transition table', () => {
  it('names every status in Hebrew', () => {
    for (const status of PAYMENT_STATUSES) {
      expect(PAYMENT_STATUS_LABEL[status]).toBeTruthy()
    }
  })

  it('accepts every legal move it declares', () => {
    const actor = financeActor()
    let checked = 0

    for (const transition of PAYMENT_TRANSITIONS) {
      for (const from of transition.from) {
        const check = evaluatePaymentTransition(actor, transition.to, {
          payment: paymentIn(from),
          next: amountsFor(transition.to),
          now: NOW,
        })
        expect(
          check.ok,
          `${from} → ${transition.to} should be legal but was refused: ` +
            `${check.ok ? '' : JSON.stringify(check.refusal)}`,
        ).toBe(true)
        checked += 1
      }
    }

    // A sweep that silently checked nothing would pass. Assert it did work.
    expect(checked).toBeGreaterThan(25)
  })

  it('declares no move out of a terminal status', () => {
    for (const transition of PAYMENT_TRANSITIONS) {
      expect(transition.from).not.toContain('refunded')
    }
  })
})

describe('illegal moves', () => {
  const actor = financeActor()

  const illegal: ReadonlyArray<[PaymentStatus, PaymentStatus, string]> = [
    ['paid', 'pending', 'money that arrived cannot become a fresh request'],
    ['paid', 'authorized', 'a capture cannot become a mere hold again'],
    ['paid', 'failed', 'a payment that arrived did not fail'],
    ['refunded', 'paid', 'refunded is terminal'],
    ['refunded', 'partially_refunded', 'refunded is terminal'],
    ['cancelled', 'authorized', 'a void cannot be re-held'],
    ['unknown', 'pending', 'retrying an unknown charge is the double charge'],
    ['partially_refunded', 'partially_paid', 'refunds do not run backwards'],
    ['partially_refunded', 'paid', 'refunds do not run backwards'],
    ['failed', 'refunded', 'nothing was captured, so nothing can go back'],
  ]

  for (const [from, to, why] of illegal) {
    it(`refuses ${from} → ${to} (${why})`, () => {
      const check = evaluatePaymentTransition(actor, to, {
        payment: paymentIn(from),
        next: amountsFor(to),
        now: NOW,
      })
      expect(check.ok).toBe(false)
      if (!check.ok) {
        expect(['illegal', 'terminal']).toContain(check.refusal.kind)
      }
    })
  }

  it('refuses a move to the status the payment is already in', () => {
    const check = evaluatePaymentTransition(actor, 'paid', {
      payment: paymentIn('paid'),
      next: amountsFor('paid'),
      now: NOW,
    })
    expect(check.ok).toBe(false)
    expect(refusalCode(check)).toBe('finance.payment_same_status')
  })

  it('throws a BusinessRuleError naming both statuses', () => {
    try {
      assertPaymentTransition(actor, 'authorized', {
        payment: paymentIn('paid'),
        next: amountsFor('authorized'),
        now: NOW,
      })
      expect.unreachable('expected the transition to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessRuleError)
      const failure = error as BusinessRuleError
      expect(failure.publicDetails).toMatchObject({
        from: 'paid',
        to: 'authorized',
      })
      expect(failure.userMessage).toContain(PAYMENT_STATUS_LABEL.paid)
    }
  })
})

describe('conditions', () => {
  const actor = financeActor()

  it('refuses a refund larger than the capture', () => {
    const check = evaluatePaymentTransition(actor, 'refunded', {
      payment: paymentIn('paid', { capturedAgorot: 4_000 }),
      next: {
        amountAgorot: 10_000,
        authorizedAgorot: 0,
        capturedAgorot: 4_000,
        refundedAgorot: 9_000,
      },
      now: NOW,
    })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.refusal.kind).toBe('condition')
    expect(refusalCode(check)).toBe('finance.refund_exceeds_capture')
  })

  it('refuses a cancellation once money has been taken', () => {
    const check = evaluatePaymentTransition(actor, 'cancelled', {
      payment: paymentIn('authorized'),
      next: {
        amountAgorot: 10_000,
        authorizedAgorot: 0,
        capturedAgorot: 10_000,
        refundedAgorot: 0,
      },
      now: NOW,
    })
    expect(check.ok).toBe(false)
    expect(refusalCode(check)).toBe('finance.already_captured')
  })

  it('refuses "paid" when only part of the amount was captured', () => {
    const check = evaluatePaymentTransition(actor, 'paid', {
      payment: paymentIn('pending'),
      next: amountsFor('partially_paid'),
      now: NOW,
    })
    expect(check.ok).toBe(false)
    expect(refusalCode(check)).toBe('finance.not_fully_captured')
  })
})

describe('authorization', () => {
  it('refuses a cleaner before it looks at the money', () => {
    // The refusal must be about the permission, never about the amounts — a
    // cleaner is not entitled to learn what was captured.
    const check = evaluatePaymentTransition(cleanerActor(), 'refunded', {
      payment: paymentIn('paid', { capturedAgorot: 4_000 }),
      next: {
        amountAgorot: 10_000,
        authorizedAgorot: 0,
        capturedAgorot: 4_000,
        refundedAgorot: 9_999,
      },
      now: NOW,
    })

    expect(check.ok).toBe(false)
    if (!check.ok) {
      expect(check.refusal.kind).toBe('not_permitted')
      if (check.refusal.kind === 'not_permitted') {
        expect(check.refusal.permission).toBe('payment.refund')
        expect(check.refusal.error).toBeInstanceOf(AuthorizationError)
      }
    }
  })

  it('throws the authorization error rather than a domain one', () => {
    expect(() =>
      assertPaymentTransition(cleanerActor(), 'paid', {
        payment: paymentIn('pending'),
        next: amountsFor('paid'),
        now: NOW,
      }),
    ).toThrow(AuthorizationError)
  })

  it('offers a cleaner no next status at all', () => {
    expect(
      legalNextPaymentStatuses(cleanerActor(), {
        payment: paymentIn('pending'),
        next: amountsFor('paid'),
        now: NOW,
      }),
    ).toEqual([])
  })
})

describe('events', () => {
  it('finds the ordinary path before the exceptional one', () => {
    const transition = findPaymentTransition('pending', 'paid')
    expect(transition?.anomaly).toBeUndefined()
    expect(transition?.event).toBe('payment.received')
  })

  it('flags a payment that arrives after a cancellation', () => {
    const transition = findPaymentTransition('cancelled', 'paid')
    expect(transition?.anomaly).toBe('payment_after_cancellation')
    // Not swallowed: the money is real and the event still fires.
    expect(transition?.event).toBe('payment.received')
  })

  it('raises deposit events for a security deposit charge', () => {
    const transition = findPaymentTransition('pending', 'paid')
    expect(transition).not.toBeNull()
    if (!transition) return
    expect(
      paymentEventFor(transition, paymentIn('pending', { purpose: 'balance' })),
    ).toBe('payment.received')
    expect(
      paymentEventFor(
        transition,
        paymentIn('pending', { purpose: 'security_deposit' }),
      ),
    ).toBe('deposit.captured')
  })

  it('admits that some moves have no catalogue event yet', () => {
    // Honest `null` rather than an invented name nothing subscribes to.
    expect(findPaymentTransition('pending', 'unknown')?.event).toBeNull()
    expect(findPaymentTransition('pending', 'cancelled')?.event).toBeNull()
  })
})
