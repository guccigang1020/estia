import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../../booking/dates'
import { FORBIDDEN_IN_SIMPLE } from '../../../laundry/mode'
import type { DetectorContext } from '../facts'
import { ALL_MODULES, NO_MODULES, type EnabledModules } from '../modules'

import { detectLaundry, type LaundryFacts } from './laundry'

const NOW = new Date('2026-09-12T10:00:00.000Z')

function context(modules: EnabledModules = ALL_MODULES): DetectorContext {
  return { modules, now: NOW, timeZone: PROPERTY_TIME_ZONE }
}

function batch(overrides: Partial<LaundryFacts> = {}): LaundryFacts {
  return {
    orderId: 'order-1',
    propertyId: 'villa-1',
    label: 'וילה ים',
    bookingId: 'booking-1',
    status: 'washing',
    requiredBy: '2026-09-12T12:00:00.000Z',
    confirmedAt: '2026-09-11T09:00:00.000Z',
    expectedBackAt: '2026-09-12T11:00:00.000Z',
    providerName: 'מכבסת הצפון',
    ...overrides,
  }
}

describe('detectLaundry', () => {
  it('says nothing for a business with no laundry module', () => {
    expect(
      detectLaundry([batch({ confirmedAt: null })], context(NO_MODULES)),
    ).toHaveLength(0)
  })

  it('says nothing when everything is on schedule', () => {
    expect(detectLaundry([batch()], context())).toHaveLength(0)
  })

  it('ignores a batch that is finished or cancelled', () => {
    expect(
      detectLaundry(
        [
          batch({
            status: 'completed',
            expectedBackAt: '2026-09-13T09:00:00.000Z',
          }),
        ],
        context(),
      ),
    ).toHaveLength(0)
  })
})

describe('nothing was ever raised', () => {
  it('is a problem of its own', () => {
    const signal = detectLaundry(
      [batch({ orderId: null, status: null, confirmedAt: null })],
      context(),
    )[0]
    expect(signal?.code).toBe('laundry.not_started')
  })

  it('is keyed on the property, so two properties do not collapse into one', () => {
    const signals = detectLaundry(
      [
        batch({ orderId: null, status: null, propertyId: 'villa-1' }),
        batch({ orderId: null, status: null, propertyId: 'villa-2' }),
      ],
      context(),
    )
    expect(new Set(signals.map((signal) => signal.dedupeKey)).size).toBe(2)
  })
})

describe('confirmation', () => {
  it('is chased where there is an outside party', () => {
    const signal = detectLaundry([batch({ confirmedAt: null })], context())[0]
    expect(signal?.code).toBe('laundry.unconfirmed')
    expect(signal?.detail).toContain('מכבסת הצפון')
  })

  it('is never asked of a one-person operation', () => {
    const signals = detectLaundry(
      [batch({ confirmedAt: null, providerName: null })],
      context({ ...ALL_MODULES, laundry: 'simple' }),
    )
    expect(
      signals.some((signal) => signal.code === 'laundry.unconfirmed'),
    ).toBe(false)
  })
})

describe('late', () => {
  it('is at risk when the expected return is after the required time', () => {
    const signal = detectLaundry(
      [batch({ expectedBackAt: '2026-09-12T14:00:00.000Z' })],
      context(),
    )[0]
    expect(signal?.code).toBe('laundry.delivery_late')
    expect(signal?.risk).toBe('at_risk')
  })

  it('is critical once the required time has passed and it is not back', () => {
    const signal = detectLaundry(
      [batch({ requiredBy: '2026-09-12T09:00:00.000Z' })],
      context(),
    )[0]
    expect(signal?.risk).toBe('critical')
  })

  it('is not raised once the linen is at the property', () => {
    expect(
      detectLaundry(
        [
          batch({
            status: 'delivered_to_property',
            requiredBy: '2026-09-12T09:00:00.000Z',
          }),
        ],
        context(),
      ),
    ).toHaveLength(0)
  })
})

describe('the words a simple operation is shown', () => {
  it('contain none that imply an operation it does not have', () => {
    const simple = context({ ...ALL_MODULES, laundry: 'simple' })
    const signals = [
      ...detectLaundry(
        [batch({ orderId: null, status: null, providerName: null })],
        simple,
      ),
      ...detectLaundry(
        [
          batch({
            providerName: null,
            requiredBy: '2026-09-12T09:00:00.000Z',
          }),
        ],
        simple,
      ),
    ]
    expect(signals.length).toBeGreaterThan(0)

    const text = signals
      .map((signal) => `${signal.title} ${signal.detail}`)
      .join(' ')
    for (const forbidden of FORBIDDEN_IN_SIMPLE) {
      expect(text).not.toContain(forbidden)
    }
  })
})

describe('keys', () => {
  it('are stable across passes', () => {
    const facts = batch({ requiredBy: '2026-09-12T09:00:00.000Z' })
    const first = detectLaundry([facts], context())[0]
    const second = detectLaundry([facts], {
      ...context(),
      now: new Date(NOW.getTime() + 300_000),
    })[0]
    expect(first?.dedupeKey).toBe(second?.dedupeKey)
    expect(first?.dedupeKey).toBe('laundry.delivery_late:laundry_order:order-1')
  })
})
