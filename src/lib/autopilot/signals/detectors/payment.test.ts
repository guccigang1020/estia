import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../../booking/dates'
import type { DetectorContext } from '../facts'
import { ALL_MODULES, NO_MODULES } from '../modules'

import { detectPayment, type PaymentFacts } from './payment'

const NOW = new Date('2026-09-10T09:00:00.000Z')

function context(overrides: Partial<DetectorContext> = {}): DetectorContext {
  return {
    modules: ALL_MODULES,
    now: NOW,
    timeZone: PROPERTY_TIME_ZONE,
    ...overrides,
  }
}

function booking(overrides: Partial<PaymentFacts> = {}): PaymentFacts {
  return {
    bookingId: 'booking-1',
    propertyId: 'villa-1',
    label: 'וילה ים · משפחת כהן',
    outstanding: [],
    shortfallAgorot: 0,
    balanceDueAt: null,
    requestSentAt: null,
    ...overrides,
  }
}

const DEPOSIT = {
  requirement: 'deposit_recorded',
  label: 'מקדמה שנרשמה',
  detail: 'טרם נרשמה מקדמה — חסרים ₪2,500 מתוך ₪2,500.',
}

describe('detectPayment', () => {
  it('says nothing for a business with no payments module', () => {
    expect(
      detectPayment(
        [booking({ outstanding: [DEPOSIT] })],
        context({ modules: NO_MODULES }),
      ),
    ).toHaveLength(0)
  })

  it('says nothing when the policy asks for nothing', () => {
    expect(detectPayment([booking()], context())).toHaveLength(0)
  })

  it('quotes the resolver rather than recomputing the shortfall', () => {
    const signal = detectPayment(
      [booking({ outstanding: [DEPOSIT], shortfallAgorot: 250_000 })],
      context(),
    )[0]

    expect(signal?.detail).toBe(DEPOSIT.detail)
    expect(signal?.domain).toBe('payment_risk')
    expect(
      signal?.evidence.find((item) => item.key === 'payment.shortfall_agorot')
        ?.value,
    ).toBe(250_000)
    // Agorot, undivided. Nothing here turns money into a float.
    expect(
      signal?.evidence.every(
        (item) =>
          typeof item.value !== 'number' || Number.isInteger(item.value),
      ),
    ).toBe(true)
  })

  it('leaves the contract to the contract detector', () => {
    const signals = detectPayment(
      [
        booking({
          outstanding: [
            DEPOSIT,
            {
              requirement: 'contract_signed',
              label: 'חתימה על החוזה',
              detail: 'החוזה טרם נחתם.',
            },
          ],
        }),
      ],
      context(),
    )
    expect(signals).toHaveLength(1)
    expect(signals[0]?.dedupeKey).toContain('deposit_recorded')
  })

  it('gives each outstanding requirement its own key', () => {
    const signals = detectPayment(
      [
        booking({
          outstanding: [
            DEPOSIT,
            {
              requirement: 'guest_confirmation',
              label: 'אישור האורח',
              detail: 'האורח טרם אישר.',
            },
          ],
        }),
      ],
      context(),
    )
    expect(signals).toHaveLength(2)
    expect(new Set(signals.map((signal) => signal.dedupeKey)).size).toBe(2)
  })

  it('raises the overdue balance only once the date has passed', () => {
    const notYet = detectPayment(
      [
        booking({
          shortfallAgorot: 250_000,
          balanceDueAt: '2026-09-11T09:00:00.000Z',
        }),
      ],
      context(),
    )
    expect(notYet).toHaveLength(0)

    const overdue = detectPayment(
      [
        booking({
          shortfallAgorot: 250_000,
          balanceDueAt: '2026-09-09T09:00:00.000Z',
        }),
      ],
      context(),
    )
    expect(overdue[0]?.code).toBe('payment.balance_overdue')
    expect(overdue[0]?.risk).toBe('critical')
  })

  it('does not call a paid balance overdue', () => {
    expect(
      detectPayment(
        [
          booking({
            shortfallAgorot: 0,
            balanceDueAt: '2026-09-09T09:00:00.000Z',
          }),
        ],
        context(),
      ),
    ).toHaveLength(0)
  })

  it('keeps one key for one ongoing problem across passes', () => {
    const facts = booking({ outstanding: [DEPOSIT] })
    const first = detectPayment([facts], context())
    const later = detectPayment(
      [facts],
      context({ now: new Date(NOW.getTime() + 5 * 60 * 1000) }),
    )
    expect(first[0]?.dedupeKey).toBe(later[0]?.dedupeKey)
    expect(first[0]?.dedupeKey).toBe(
      'payment.requirement_unmet:booking:booking-1:deposit_recorded',
    )
  })
})
