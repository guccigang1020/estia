import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../../booking/dates'
import type { DetectorContext } from '../facts'
import { ALL_MODULES, NO_MODULES, type EnabledModules } from '../modules'

import { detectInventory, type ShortageFacts } from './inventory'

const NOW = new Date('2026-09-12T10:00:00.000Z')

function context(modules: EnabledModules = ALL_MODULES): DetectorContext {
  return { modules, now: NOW, timeZone: PROPERTY_TIME_ZONE }
}

const COUNTING: EnabledModules = {
  ...ALL_MODULES,
  inventory: { ...NO_MODULES.inventory, enabled: true, counting: true },
}

function shortage(overrides: Partial<ShortageFacts> = {}): ShortageFacts {
  return {
    propertyId: 'villa-1',
    label: 'וילה ים',
    itemId: 'towel-large',
    itemLabel: 'מגבות גדולות',
    required: 24,
    available: 18,
    shortfall: 6,
    neededBy: null,
    bookingId: 'booking-1',
    ...overrides,
  }
}

describe('detectInventory', () => {
  it('says nothing to a business that counts nothing', () => {
    expect(detectInventory([shortage()], context(NO_MODULES))).toHaveLength(0)
  })

  it('says nothing when there is no shortfall', () => {
    expect(
      detectInventory([shortage({ shortfall: 0 })], context()),
    ).toHaveLength(0)
  })

  it('reports the engine numbers rather than adding anything up', () => {
    const signal = detectInventory([shortage()], context())[0]
    const byKey = new Map(
      signal?.evidence.map((item) => [item.key, item.value]),
    )
    expect(byKey.get('stock.required')).toBe(24)
    expect(byKey.get('stock.available')).toBe(18)
    expect(byKey.get('stock.shortfall')).toBe(6)
    expect(signal?.risk).toBe('critical')
  })
})

describe('projection', () => {
  const future = shortage({ neededBy: '2026-09-14T09:00:00.000Z' })

  it('is offered where the module can actually project', () => {
    const signal = detectInventory([future], context())[0]
    expect(signal?.code).toBe('inventory.projected_shortage')
    expect(signal?.risk).toBe('at_risk')
  })

  it('is withheld from a business that only counts', () => {
    // Counting is not reserving, and a forecast over no reservations is a flat
    // line dressed up as an answer.
    expect(detectInventory([future], context(COUNTING))).toHaveLength(0)
  })

  it('still reports a shortage that is real right now', () => {
    expect(detectInventory([shortage()], context(COUNTING))).toHaveLength(1)
  })
})

describe('keys', () => {
  it('are the same for the same shortage six hours apart', () => {
    const facts = shortage()
    const first = detectInventory([facts], context())[0]
    const later = detectInventory([facts], {
      ...context(),
      now: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
    })[0]

    expect(first?.dedupeKey).toBe(later?.dedupeKey)
    expect(first?.dedupeKey).toBe(
      'inventory.shortage:property:villa-1:towel-large',
    )
  })

  it('never collide across items or properties', () => {
    const signals = detectInventory(
      [
        shortage(),
        shortage({ itemId: 'sheet-double', itemLabel: 'סדינים' }),
        shortage({ propertyId: 'villa-2' }),
      ],
      context(),
    )
    expect(new Set(signals.map((signal) => signal.dedupeKey)).size).toBe(3)
  })

  it('do not carry the booking, so an amendment does not open a new row', () => {
    const first = detectInventory([shortage()], context())[0]
    const amended = detectInventory(
      [shortage({ bookingId: 'booking-2' })],
      context(),
    )[0]
    expect(first?.dedupeKey).toBe(amended?.dedupeKey)
  })
})
