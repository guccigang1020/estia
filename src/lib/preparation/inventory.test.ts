/**
 * Counting the cupboard.
 *
 * The specification's own case: twenty-five pillows required, twenty-two
 * available, a shortage of three, an alert, and a procurement task. Plus the
 * cases that decide whether the check is usable in a business with more than
 * one property — reservation, the safety floor, and moving stock rather than
 * buying it.
 */

import { describe, expect, it } from 'vitest'
import {
  LINEN_TRANSITIONS,
  assertLinenTransition,
  canTransitionLinen,
  checkInventory,
} from './inventory'
import { INVENTORY_STATES, type InventoryState } from '../contracts/states'
import { computeRequirements } from './requirements'
import { captureSnapshot } from './snapshot'
import type { Requirement, StockLevel } from './types'
import {
  OTHER_PROPERTY_ID,
  PROPERTY_ID,
  exampleBooking,
  exampleCatalogue,
} from './testing/example-configuration'

const HERE = { kind: 'property' as const, propertyId: PROPERTY_ID }
const NEEDED_BY = '2026-09-04'

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    category: 'linen',
    itemId: 'pillow',
    label: 'כרית',
    unit: 'piece',
    quantity: 25,
    section: 'bedrooms',
    requiresPhoto: false,
    instructions: null,
    minutes: 0,
    sources: [],
    ...overrides,
  }
}

function stock(overrides: Partial<StockLevel> = {}): StockLevel {
  return {
    itemId: 'pillow',
    label: 'כרית',
    location: HERE,
    onHand: 22,
    reserved: 0,
    safetyStock: 0,
    ...overrides,
  }
}

// ── The specification's case ──────────────────────────────────────────────

describe('twenty-five required against twenty-two available', () => {
  const check = checkInventory({
    requirements: [requirement()],
    stock: [stock()],
    destination: HERE,
    neededBy: NEEDED_BY,
  })

  it('reports a shortage of three', () => {
    expect(check.lines).toEqual([
      {
        itemId: 'pillow',
        label: 'כרית',
        required: 25,
        available: 22,
        shortage: 3,
        safetyStock: 0,
        breachesSafetyStock: false,
      },
    ])
  })

  it('raises a critical alert naming the numbers', () => {
    expect(check.alerts).toHaveLength(1)
    expect(check.alerts[0].severity).toBe('critical')
    expect(check.alerts[0].shortage).toBe(3)
    expect(check.alerts[0].message).toContain('25')
    expect(check.alerts[0].message).toContain('22')
  })

  it('opens a procurement task for the difference', () => {
    expect(check.procurement).toEqual([
      { itemId: 'pillow', label: 'כרית', quantity: 3, neededBy: NEEDED_BY },
    ])
    expect(check.satisfied).toBe(false)
  })
})

// ── Reservation ───────────────────────────────────────────────────────────

describe('stock promised to another booking', () => {
  it('is not available to this one', () => {
    const check = checkInventory({
      requirements: [requirement({ quantity: 20 })],
      stock: [stock({ onHand: 30, reserved: 15 })],
      destination: HERE,
      neededBy: NEEDED_BY,
    })

    expect(check.lines[0].available).toBe(15)
    expect(check.lines[0].shortage).toBe(5)
  })

  it('adds several cupboards of the same item together', () => {
    const check = checkInventory({
      requirements: [requirement({ quantity: 25 })],
      stock: [stock({ onHand: 12 }), stock({ onHand: 13 })],
      destination: HERE,
      neededBy: NEEDED_BY,
    })

    expect(check.lines[0].available).toBe(25)
    expect(check.lines[0].shortage).toBe(0)
  })
})

// ── Safety stock ──────────────────────────────────────────────────────────

describe('the safety floor', () => {
  it('warns without blocking when fulfilling the plan breaches it', () => {
    const check = checkInventory({
      requirements: [requirement({ quantity: 25 })],
      stock: [stock({ onHand: 28, safetyStock: 6 })],
      destination: HERE,
      neededBy: NEEDED_BY,
    })

    expect(check.lines[0].shortage).toBe(0)
    expect(check.lines[0].breachesSafetyStock).toBe(true)
    expect(check.alerts[0].severity).toBe('warning')
    expect(check.procurement).toEqual([])
  })

  it('stays quiet when the floor survives', () => {
    const check = checkInventory({
      requirements: [requirement({ quantity: 25 })],
      stock: [stock({ onHand: 40, safetyStock: 6 })],
      destination: HERE,
      neededBy: NEEDED_BY,
    })

    expect(check.alerts).toEqual([])
    expect(check.satisfied).toBe(true)
  })
})

// ── Transfers ─────────────────────────────────────────────────────────────

describe('stock held elsewhere', () => {
  const elsewhere: readonly StockLevel[] = [
    {
      itemId: 'pillow',
      label: 'כרית',
      location: { kind: 'property', propertyId: OTHER_PROPERTY_ID },
      onHand: 10,
      reserved: 0,
      safetyStock: 8,
    },
    {
      itemId: 'pillow',
      label: 'כרית',
      location: { kind: 'warehouse', warehouseId: 'central' },
      onHand: 50,
      reserved: 0,
      safetyStock: 40,
    },
  ]

  it('is drawn from the warehouse before another property', () => {
    const check = checkInventory({
      requirements: [requirement({ quantity: 25 })],
      stock: [stock({ onHand: 22 })],
      elsewhere,
      destination: HERE,
      neededBy: NEEDED_BY,
    })

    expect(check.transfers).toEqual([
      {
        itemId: 'pillow',
        from: { kind: 'warehouse', warehouseId: 'central' },
        to: HERE,
        quantity: 3,
      },
    ])
    expect(check.procurement).toEqual([])
  })

  it('never offers stock that would breach the source floor', () => {
    const check = checkInventory({
      requirements: [requirement({ quantity: 60 })],
      stock: [stock({ onHand: 22 })],
      elsewhere,
      destination: HERE,
      neededBy: NEEDED_BY,
    })

    // Warehouse can spare ten, the other property two: twelve of a
    // thirty-eight shortage, and the remaining twenty-six are bought.
    expect(
      check.transfers.reduce((total, transfer) => total + transfer.quantity, 0),
    ).toBe(12)
    expect(check.procurement[0].quantity).toBe(26)
  })
})

// ── People are not stock ──────────────────────────────────────────────────

describe('requirements measured in people and hours', () => {
  it('are left out of the stock check entirely', () => {
    const check = checkInventory({
      requirements: [
        requirement({
          category: 'cleaning',
          itemId: 'cleaning_staff',
          unit: 'person',
          quantity: 2,
        }),
        requirement({
          category: 'cleaning',
          itemId: 'deep_clean',
          unit: 'hour',
          quantity: 5,
        }),
      ],
      stock: [],
      destination: HERE,
      neededBy: NEEDED_BY,
    })

    expect(check.lines).toEqual([])
    expect(check.satisfied).toBe(true)
  })
})

// ── Against the real plan ─────────────────────────────────────────────────

describe('the real twenty-five guest plan', () => {
  it('finds the pillow shortage the specification describes', () => {
    const booking = exampleBooking()
    const snapshot = captureSnapshot({
      catalogue: exampleCatalogue(),
      booking,
      capturedAt: '2026-08-27T08:00:00.000Z',
    })
    const { requirements } = computeRequirements(booking, snapshot)

    const check = checkInventory({
      requirements: requirements.filter(
        (entry) => entry.itemId === 'pillow' || entry.itemId === 'bath_towel',
      ),
      stock: [
        stock({ onHand: 22, safetyStock: 4 }),
        stock({
          itemId: 'bath_towel',
          label: 'מגבת רחצה',
          onHand: 30,
          safetyStock: 4,
        }),
      ],
      destination: HERE,
      neededBy: NEEDED_BY,
    })

    const pillows = check.lines.find((line) => line.itemId === 'pillow')
    expect(pillows?.required).toBe(25)
    expect(pillows?.shortage).toBe(3)
  })
})

// ── The linen lifecycle ───────────────────────────────────────────────────

describe('the linen lifecycle', () => {
  it('closes the loop, in the product’s shared inventory vocabulary', () => {
    const loop: readonly InventoryState[] = [
      'available',
      'reserved',
      'in_use',
      'dirty',
      'laundry',
      'available',
    ]

    for (let index = 0; index + 1 < loop.length; index += 1) {
      expect(
        canTransitionLinen(loop[index], loop[index + 1]),
        `${loop[index]} → ${loop[index + 1]}`,
      ).toBe(true)
    }
  })

  it('refuses to hand a used sheet to the next guest', () => {
    expect(canTransitionLinen('in_use', 'available')).toBe(false)
    expect(canTransitionLinen('dirty', 'available')).toBe(false)
    expect(() => assertLinenTransition('in_use', 'available')).toThrow(/linen/i)
  })

  it('lets a reserved set be released untouched', () => {
    expect(canTransitionLinen('reserved', 'available')).toBe(true)
  })

  it('never lets damaged linen wash its way back into the cycle', () => {
    expect(canTransitionLinen('damaged', 'laundry')).toBe(false)
    expect(canTransitionLinen('damaged', 'available')).toBe(false)
    expect(canTransitionLinen('damaged', 'out_of_service')).toBe(true)
    expect(LINEN_TRANSITIONS.out_of_service).toEqual([])
  })

  it('describes every state the frozen contract names', () => {
    expect(Object.keys(LINEN_TRANSITIONS).sort()).toEqual(
      [...INVENTORY_STATES].sort(),
    )
  })
})
