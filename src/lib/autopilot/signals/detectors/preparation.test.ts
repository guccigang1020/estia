import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../../booking/dates'
import { zonedInstant } from '../deadlines'
import type { DetectorContext } from '../facts'
import { ALL_MODULES, NO_MODULES, type EnabledModules } from '../modules'

import { detectPreparation, type PreparationFacts } from './preparation'

const ARRIVAL_AT = zonedInstant('2026-09-12', '15:00', PROPERTY_TIME_ZONE)
const NOW = zonedInstant('2026-09-12', '13:42', PROPERTY_TIME_ZONE)

function context(modules: EnabledModules = ALL_MODULES): DetectorContext {
  return { modules, now: NOW, timeZone: PROPERTY_TIME_ZONE }
}

function changeover(
  overrides: Partial<PreparationFacts> = {},
): PreparationFacts {
  return {
    bookingId: 'booking-1',
    propertyId: 'villa-1',
    label: 'וילה ים · משפחת כהן',
    planGenerated: true,
    planPublished: true,
    percentComplete: 100,
    typicalMinutes: 105,
    arrivalAt: ARRIVAL_AT.toISOString(),
    startedAt: '2026-09-12T09:00:00.000Z',
    additionalItems: [],
    ...overrides,
  }
}

describe('detectPreparation', () => {
  it('says nothing for a business with no preparation module', () => {
    expect(detectPreparation([changeover()], context(NO_MODULES))).toHaveLength(
      0,
    )
  })

  it('says nothing when the plan is done and on time', () => {
    expect(detectPreparation([changeover()], context())).toHaveLength(0)
  })

  it('raises a missing plan and stops there', () => {
    const signals = detectPreparation(
      [
        changeover({
          planGenerated: false,
          planPublished: false,
          percentComplete: null,
        }),
      ],
      context(),
    )
    // One absence, one signal — not also "behind schedule" for work that was
    // never described.
    expect(signals).toHaveLength(1)
    expect(signals[0]?.code).toBe('preparation.plan_missing')
  })

  it('raises an unpublished plan the team cannot see', () => {
    const signals = detectPreparation(
      [changeover({ planPublished: false })],
      context(),
    )
    expect(signals.map((signal) => signal.code)).toContain(
      'preparation.plan_unpublished',
    )
  })
})

describe('behind schedule', () => {
  it('compares the work left against the time left', () => {
    const signal = detectPreparation(
      [changeover({ percentComplete: 0, startedAt: null })],
      context(),
    )[0]

    expect(signal?.code).toBe('preparation.behind_schedule')
    const byKey = new Map(
      signal?.evidence.map((item) => [item.key, item.value]),
    )
    expect(byKey.get('preparation.typical_minutes')).toBe(105)
    expect(byKey.get('preparation.remaining_minutes')).toBe(105)
    expect(byKey.get('arrival.at')).toBe('15:00')
    expect(byKey.get('arrival.now')).toBe('13:42')
    expect(byKey.get('preparation.started')).toBe(false)
  })

  it('stays quiet while there is still enough time', () => {
    expect(
      detectPreparation([changeover({ percentComplete: 90 })], context()),
    ).toHaveLength(0)
  })

  it('is critical once the arrival has passed', () => {
    const signal = detectPreparation([changeover({ percentComplete: 20 })], {
      ...context(),
      now: zonedInstant('2026-09-12', '15:30', PROPERTY_TIME_ZONE),
    })[0]
    expect(signal?.risk).toBe('critical')
  })

  it('says nothing without a duration from the preparation engine', () => {
    expect(
      detectPreparation(
        [changeover({ percentComplete: 0, typicalMinutes: null })],
        context(),
      ),
    ).toHaveLength(0)
  })
})

describe('module awareness: the additional items', () => {
  const withItems = changeover({
    additionalItems: [{ itemId: 'towel-large', label: 'מגבות', quantity: 6 }],
  })

  it('states the requirement without stock language when there is no stock', () => {
    const signal = detectPreparation(
      [withItems],
      context({ ...ALL_MODULES, inventory: NO_MODULES.inventory }),
    )[0]

    expect(signal?.detail).toBe('ההכנה דורשת בנוסף: 6 מגבות.')
    expect(signal?.detail).not.toContain('מלאי')
    expect(signal?.detail).not.toContain('לשריין')
  })

  it('says the same thing to a business that only counts', () => {
    const counting = {
      ...ALL_MODULES,
      inventory: {
        ...NO_MODULES.inventory,
        enabled: true,
        counting: true,
      },
    }
    const signal = detectPreparation([withItems], context(counting))[0]
    expect(signal?.detail).not.toContain('מלאי')
  })

  it('offers the reservation only where the module can reserve', () => {
    const signal = detectPreparation([withItems], context())[0]
    expect(signal?.detail).toBe('אפשר לשריין מהמלאי: 6 מגבות.')
  })

  it('keeps the same key whichever sentence it used', () => {
    const withStock = detectPreparation([withItems], context())[0]
    const withoutStock = detectPreparation(
      [withItems],
      context({ ...ALL_MODULES, inventory: NO_MODULES.inventory }),
    )[0]
    expect(withStock?.dedupeKey).toBe(withoutStock?.dedupeKey)
  })
})

describe('keys', () => {
  it('are stable across passes and never carry the clock', () => {
    const facts = changeover({ percentComplete: 0 })
    const first = detectPreparation([facts], context())[0]
    const second = detectPreparation([facts], {
      ...context(),
      now: new Date(NOW.getTime() + 300_000),
    })[0]

    expect(first?.dedupeKey).toBe(second?.dedupeKey)
    expect(first?.dedupeKey).toBe(
      'preparation.behind_schedule:booking:booking-1',
    )
  })

  it('never collide across codes', () => {
    const signals = detectPreparation(
      [
        changeover({
          planPublished: false,
          percentComplete: 0,
          additionalItems: [
            { itemId: 'towel-large', label: 'מגבות', quantity: 6 },
          ],
        }),
      ],
      context(),
    )
    expect(signals.length).toBeGreaterThan(1)
    expect(new Set(signals.map((signal) => signal.dedupeKey)).size).toBe(
      signals.length,
    )
  })
})
