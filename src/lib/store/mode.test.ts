/**
 * The three modes, and the vocabulary a business never has to meet.
 *
 * §5 and §6 in one file. The two claims worth the most:
 *
 *   · a business on `simple` never meets supplier or margin vocabulary;
 *   · live payment is never required, and on `simple` it is not even
 *     reachable.
 */

import { describe, expect, it } from 'vitest'

import {
  offerablePaymentModes,
  showsVocabulary,
  storeCapabilities,
} from './mode'
import {
  manualPaymentPort,
  paymentInstructionFor,
  paymentStatusFor,
} from './payment'
import { STORE_MODES, STORE_PAYMENT_MODES } from '../contracts/states'

describe('`off` is a real answer and the default', () => {
  it('makes the store invisible entirely', () => {
    const capabilities = storeCapabilities('off')
    expect(capabilities.visible).toBe(false)
    expect(capabilities.catalogue).toBe(false)
    expect(capabilities.orders).toBe(false)
    expect(capabilities.guestStore).toBe(false)
  })
})

describe('A BUSINESS ON `simple` NEVER MEETS SUPPLIER OR MARGIN VOCABULARY', () => {
  it.each(['cost', 'supplier', 'margin'] as const)(
    'hides the word %s',
    (word) => {
      expect(showsVocabulary('simple', word)).toBe(false)
      expect(showsVocabulary('commerce', word)).toBe(false)
      expect(showsVocabulary('advanced', word)).toBe(true)
    },
  )

  it('hides stock until advanced', () => {
    expect(showsVocabulary('simple', 'stock')).toBe(false)
    expect(showsVocabulary('commerce', 'stock')).toBe(false)
    expect(showsVocabulary('advanced', 'stock')).toBe(true)
  })

  /**
   * Providers ARE available on `simple`, deliberately.
   *
   * "Ring the DJ" is a telephone call and needs no commerce whatsoever. A
   * villa owner selling a שולחן שוק still has somebody who brings the table,
   * and the artefact that goes to them is a WhatsApp message rather than a
   * purchase order.
   */
  it('still lets a simple business send a request to an outside provider', () => {
    expect(showsVocabulary('simple', 'provider')).toBe(true)
    expect(storeCapabilities('simple').externalProviders).toBe(true)
  })
})

describe('LIVE PAYMENT IS NEVER REQUIRED', () => {
  it('is not reachable at all on `simple`', () => {
    expect(storeCapabilities('simple').livePayment).toBe(false)

    const offered = offerablePaymentModes({
      mode: 'simple',
      defaultPaymentMode: 'with_booking',
      // Even asked for explicitly, it is filtered out.
      enabled: ['manual', 'on_arrival', 'pay_now'],
    })

    expect(offered).not.toContain('pay_now')
    expect(offered).toContain('manual')
    expect(offered).toContain('on_arrival')
  })

  it('is available but never compulsory on `commerce`', () => {
    expect(storeCapabilities('commerce').livePayment).toBe(true)

    // An organization on `commerce` that chose `with_booking` and enabled
    // nothing else meets no payment provider either.
    expect(
      offerablePaymentModes({
        mode: 'commerce',
        defaultPaymentMode: 'with_booking',
        enabled: [],
      }),
    ).toEqual(['with_booking'])
  })

  it('always offers at least the default, so checkout is never impossible', () => {
    for (const mode of STORE_MODES) {
      const offered = offerablePaymentModes({
        mode,
        defaultPaymentMode: 'on_arrival',
        enabled: [],
      })
      expect(offered).toEqual(['on_arrival'])
    }
  })

  it('never repeats a mode that is both the default and enabled', () => {
    expect(
      offerablePaymentModes({
        mode: 'commerce',
        defaultPaymentMode: 'manual',
        enabled: ['manual', 'on_arrival'],
      }),
    ).toEqual(['manual', 'on_arrival'])
  })
})

describe('the checkout call to action is whatever the mode actually requires', () => {
  it('never says "pay" for a mode that takes no payment', () => {
    for (const mode of [
      'with_booking',
      'on_arrival',
      'pay_later',
      'approval_first',
    ] as const) {
      const instruction = paymentInstructionFor(mode)
      expect(instruction.requiresLiveProvider).toBe(false)
      expect(instruction.callToAction).not.toContain('שלם עכשיו')
    }
  })

  it('says "send a request" when the business approves first', () => {
    const instruction = paymentInstructionFor('approval_first')
    expect(instruction.callToAction).toBe('שלח בקשה')
    expect(instruction.explanation).toContain('לא יחויב')
  })

  it('sends the amount to the booking balance for the default mode', () => {
    expect(paymentInstructionFor('with_booking').settlement).toBe(
      'booking_balance',
    )
  })

  it('has a complete instruction for every frozen mode', () => {
    for (const mode of STORE_PAYMENT_MODES) {
      const instruction = paymentInstructionFor(mode)
      expect(instruction.callToAction.length).toBeGreaterThan(0)
      expect(instruction.explanation.length).toBeGreaterThan(0)
      expect(instruction.initialPaymentStatus).toBe('unpaid')
    }
  })
})

describe('the null payment port', () => {
  it('records a manual payment as paid, because a person looked at the bank', async () => {
    const recorded = await manualPaymentPort.record({
      organizationId: 'org-1',
      orderId: 'order-1',
      mode: 'manual',
      method: 'bank_transfer',
      amountAgorot: 150_000,
      reference: '4471',
      notes: null,
      recordedAt: new Date('2026-03-02T10:00:00.000Z'),
    })

    expect(recorded.status).toBe('paid')
  })

  it('records a negative amount as a refund rather than deleting anything', async () => {
    const recorded = await manualPaymentPort.record({
      organizationId: 'org-1',
      orderId: 'order-1',
      mode: 'manual',
      method: 'bank_transfer',
      amountAgorot: -150_000,
      reference: null,
      notes: null,
      recordedAt: new Date(),
    })

    expect(recorded.status).toBe('refunded')
  })

  /**
   * The third net. `mode.ts` and `store_settings_no_live_payment_in_simple`
   * both prevent an organization on `simple` from choosing `pay_now`, so this
   * should never fire — which is exactly the property a net should have.
   */
  it('refuses live payment loudly rather than confirming an unpaid order', async () => {
    await expect(
      manualPaymentPort.prepare({
        organizationId: 'org-1',
        orderId: 'order-1',
        bookingId: null,
        mode: 'pay_now',
        amountAgorot: 150_000,
        currency: 'ILS',
      }),
    ).rejects.toThrowError(/live payment implementation/)
  })
})

describe('a payment status is derived from the money, never typed', () => {
  it('is unpaid when nothing has arrived', () => {
    expect(
      paymentStatusFor({
        totalAgorot: 150_000,
        recordedAgorot: 0,
        hasRefund: false,
      }),
    ).toBe('unpaid')
  })

  it('is partially paid for a deposit', () => {
    expect(
      paymentStatusFor({
        totalAgorot: 150_000,
        recordedAgorot: 50_000,
        hasRefund: false,
      }),
    ).toBe('partially_paid')
  })

  it('is paid once the whole amount is in', () => {
    expect(
      paymentStatusFor({
        totalAgorot: 150_000,
        recordedAgorot: 150_000,
        hasRefund: false,
      }),
    ).toBe('paid')
  })

  it('is refunded once the money has gone back out', () => {
    expect(
      paymentStatusFor({
        totalAgorot: 150_000,
        recordedAgorot: 0,
        hasRefund: true,
      }),
    ).toBe('refunded')
  })
})
