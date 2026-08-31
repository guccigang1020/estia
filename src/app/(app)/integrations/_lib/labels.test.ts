/**
 * The wording, and the one place it must agree with another screen.
 *
 * `CHANNEL_LABEL` is total over `BookingSource`, so the type already refuses a
 * channel added to the contract without a Hebrew name. What the type cannot
 * check is that the words match the ones the booking detail screen prints for
 * the same enum — two Hebrew names for `booking_com` inside one product is how
 * a person starts wondering whether they are two different things.
 */

import { describe, expect, it } from 'vitest'

import { BOOKING_SOURCES } from '@/lib/booking'

import {
  CHANNEL_LABEL,
  KIND_EVIDENCE,
  KIND_LABEL,
  NOT_A_THIRD_PARTY,
  SERVICE_LABEL,
  labelOr,
} from './labels'

const HEBREW = /[֐-׿]/

describe('channels', () => {
  it('names every booking source in the contract', () => {
    for (const source of BOOKING_SOURCES) {
      expect(CHANNEL_LABEL[source].length).toBeGreaterThan(0)
    }
  })

  it('keeps the Latin brand names Latin', () => {
    // Transliterating Booking.com into Hebrew would make it harder to match
    // against a bank statement, which is what somebody reading this screen is
    // usually holding.
    expect(CHANNEL_LABEL.booking_com).toBe('Booking.com')
    expect(CHANNEL_LABEL.airbnb).toBe('Airbnb')
  })

  it('marks the sources that are not third parties at all', () => {
    // `direct_manual` is a person at a desk and `agent` is a member of this
    // organization. Counting either as a connected service would report a
    // business taking every booking by telephone as integrated.
    expect(NOT_A_THIRD_PARTY.has('direct_manual')).toBe(true)
    expect(NOT_A_THIRD_PARTY.has('agent')).toBe(true)
    expect(NOT_A_THIRD_PARTY.has('booking_com')).toBe(false)
    expect(NOT_A_THIRD_PARTY.has('airbnb')).toBe(false)

    for (const id of NOT_A_THIRD_PARTY) {
      expect(BOOKING_SOURCES).toContain(id)
    }
  })
})

describe('sections', () => {
  it('names each kind and says what it is derived from', () => {
    for (const kind of [
      'payment_provider',
      'invoice_provider',
      'booking_channel',
    ] as const) {
      expect(KIND_LABEL[kind]).toMatch(HEBREW)
      // The evidence sentence is the screen's whole honesty claim, so it has
      // to name the column it read rather than gesture at one.
      expect(KIND_EVIDENCE[kind]).toMatch(HEBREW)
      expect(KIND_EVIDENCE[kind].length).toBeGreaterThan(60)
    }

    expect(KIND_EVIDENCE.payment_provider).toContain('provider')
    expect(KIND_EVIDENCE.booking_channel).toContain('source')
  })
})

describe('services', () => {
  it('renders a provider nobody has named here as its own stored value', () => {
    // The set is open: a business that switches to a processor this file has
    // never heard of gets a screen that says its name, not a blank row.
    expect(labelOr(SERVICE_LABEL, 'stripe')).toBe('stripe')
    expect(labelOr(SERVICE_LABEL, 'cardcom')).toBe('Cardcom')
  })
})
