import { describe, expect, it } from 'vitest'

import { PAYMENT_METHODS } from '../contracts/states'

import {
  MANUAL_CHANNEL_HINT,
  MANUAL_CHANNEL_LABEL,
  MANUAL_PAYMENT_CHANNELS,
  PAYMENT_METHOD_FOR_CHANNEL,
  requiresInstructions,
} from './channels'
import { manualPaymentInput } from './manual-payment'

describe('the channel vocabulary', () => {
  it('maps every channel onto a method the frozen contract actually has', () => {
    for (const channel of MANUAL_PAYMENT_CHANNELS) {
      const method = PAYMENT_METHOD_FOR_CHANNEL[channel]
      expect(
        (PAYMENT_METHODS as readonly string[]).includes(method),
        `${channel} maps to ${method}, which is not a PAYMENT_METHOD`,
      ).toBe(true)
    }
  })

  it('records the two channels the contract has no name for, honestly', () => {
    // Documented in channels.ts. Asserted so that widening PAYMENT_METHODS
    // later is a deliberate change here rather than a silent divergence.
    expect(PAYMENT_METHOD_FOR_CHANNEL.cheque).toBe('other')
    expect(PAYMENT_METHOD_FOR_CHANNEL.external_terminal).toBe('card')
  })

  it('has a Hebrew label and a hint for every channel', () => {
    for (const channel of MANUAL_PAYMENT_CHANNELS) {
      expect(MANUAL_CHANNEL_LABEL[channel].length).toBeGreaterThan(0)
      expect(MANUAL_CHANNEL_HINT[channel].length).toBeGreaterThan(0)
    }
  })

  it('exempts only cash from needing instructions', () => {
    const exempt = MANUAL_PAYMENT_CHANNELS.filter(
      (channel) => !requiresInstructions(channel),
    )
    expect(exempt).toEqual(['cash'])
  })
})

describe('recording a manual payment goes through the finance operation', () => {
  it('produces the input that operation validates, with channel manual', () => {
    const input = manualPaymentInput({
      paymentId: 'aaaaaaaa-0000-4000-8000-000000000001',
      bookingId: 'booking-1',
      propertyId: 'property-1',
      channel: 'bank_transfer',
      amountAgorot: 250_000,
      purpose: 'deposit',
      reference: 'REF-8891',
    })

    expect(input.method).toBe('bank_transfer')
    expect(input.channel).toBe('manual')
    expect(input.settledAgorot).toBe(250_000)
    // No provider took this money, so no reconciliation queue will wait for it.
    expect(input.providerId).toBeNull()
    expect(input.providerRef).toBe('REF-8891')
  })

  it('passes a partial transfer through rather than rounding it up', () => {
    const input = manualPaymentInput({
      paymentId: 'aaaaaaaa-0000-4000-8000-000000000002',
      bookingId: 'booking-1',
      propertyId: 'property-1',
      channel: 'bit',
      amountAgorot: 250_000,
      settledAgorot: 100_000,
      purpose: 'deposit',
    })

    expect(input.amountAgorot).toBe(250_000)
    expect(input.settledAgorot).toBe(100_000)
    expect(input.method).toBe('bit')
  })
})
