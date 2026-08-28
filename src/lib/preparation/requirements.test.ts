/**
 * The worked example, and the proof that it is an output.
 *
 * Everyone who has heard the specification can recite the figures: twenty-five
 * guests, five double-width beds, twenty-five sleeping places, twenty-five
 * linen sets, twenty-five pillows, fifteen mattresses, and towels of
 * 25 / 25 / 13 / 25. This file asserts every one of them — and then changes
 * the property and the party and asserts that every one of them moves, which
 * is the part that actually proves anything.
 *
 * `no-hardcoded-numbers.test.ts` closes the loop by scanning the source.
 */

import { describe, expect, it } from 'vitest'
import { computeRequirements, requirementQuantity } from './requirements'
import { captureSnapshot } from './snapshot'
import type { PreparationBooking, PreparationCatalogue } from './types'
import {
  BED_TYPES,
  exampleBooking,
  exampleCatalogue,
} from './testing/example-configuration'

const CAPTURED_AT = '2026-08-27T08:00:00.000Z'

function plan(
  booking: PreparationBooking = exampleBooking(),
  catalogue: PreparationCatalogue = exampleCatalogue(),
) {
  return computeRequirements(
    booking,
    captureSnapshot({ catalogue, booking, capturedAt: CAPTURED_AT }),
  )
}

// ── The example itself ────────────────────────────────────────────────────

describe('twenty-five guests in a house with five double-width beds', () => {
  it('sleeps ten on the permanent beds and finds fifteen more places', () => {
    const { allocation } = plan()

    expect(allocation.permanentCapacity).toBe(10)
    expect(allocation.sleepingPlaces).toBe(25)
    expect(allocation.extraBeds).toBe(15)
    expect(allocation.unplacedGuests).toBe(0)
  })

  it('uses five beds and fifteen floor mattresses, and says which is which', () => {
    const { allocation } = plan()

    expect(allocation.lines).toEqual([
      {
        bedTypeId: 'jewish_bed',
        label: 'מיטה יהודית',
        source: 'permanent',
        count: 5,
        capacity: 10,
      },
      {
        bedTypeId: 'floor_mattress',
        label: 'מזרן רצפה',
        source: 'added',
        count: 15,
        capacity: 15,
      },
    ])
  })

  it('needs twenty-five single linen sets and twenty-five pillows', () => {
    const { requirements } = plan()

    // Ten from the five made-up beds, fifteen from the mattresses. The bed
    // type says two singles each; nothing in the engine knows that.
    expect(requirementQuantity(requirements, 'single_fitted_sheet')).toBe(25)
    expect(requirementQuantity(requirements, 'single_duvet_cover')).toBe(25)
    expect(requirementQuantity(requirements, 'pillow')).toBe(25)
  })

  it('needs fifteen extra mattresses', () => {
    const { requirements } = plan()

    expect(requirementQuantity(requirements, 'floor_mattress')).toBe(15)
  })

  it('produces towels of 25 / 25 / 13 / 25 from four ordinary rules', () => {
    const { requirements } = plan()

    expect(requirementQuantity(requirements, 'bath_towel')).toBe(25)
    expect(requirementQuantity(requirements, 'face_towel')).toBe(25)
    // One per couple: twelve and a half is thirteen.
    expect(requirementQuantity(requirements, 'hand_towel')).toBe(13)
    expect(requirementQuantity(requirements, 'pool_towel')).toBe(25)
  })

  it('shows where each number came from', () => {
    const { requirements } = plan()
    const sheets = requirements.find(
      (requirement) => requirement.itemId === 'single_fitted_sheet',
    )

    expect(sheets?.sources).toEqual([
      {
        ruleId: 'bed:jewish_bed:permanent:single_fitted_sheet',
        origin: 'bed',
        section: 'bedrooms',
        base: 10,
        buffered: 10,
        minutes: 0,
      },
      {
        ruleId: 'bed:floor_mattress:added:single_fitted_sheet',
        origin: 'bed',
        section: 'extra_sleeping',
        base: 15,
        buffered: 15,
        minutes: 0,
      },
    ])
  })
})

// ── The same rules, different answers ─────────────────────────────────────

describe('the same configuration against a different booking', () => {
  it('gives a smaller party fewer of everything', () => {
    const { allocation, requirements } = plan(exampleBooking({ guests: 12 }))

    expect(allocation.sleepingPlaces).toBe(12)
    expect(allocation.extraBeds).toBe(2)
    expect(requirementQuantity(requirements, 'pillow')).toBe(12)
    expect(requirementQuantity(requirements, 'bath_towel')).toBe(12)
    expect(requirementQuantity(requirements, 'hand_towel')).toBe(6)
  })

  it('gives a house with double beds a completely different linen list', () => {
    const catalogue = exampleCatalogue({
      propertyConfiguration: {
        ...exampleCatalogue().propertyConfiguration,
        beds: [
          { bedTypeId: 'double_bed', permanent: 5, storage: 0, missing: 0 },
        ],
      },
    })

    const { requirements } = plan(exampleBooking(), catalogue)

    // Five double beds: five double sheets, ten pillows from the beds plus
    // fifteen from the mattresses. Not one number here is in the source.
    expect(requirementQuantity(requirements, 'double_fitted_sheet')).toBe(5)
    expect(requirementQuantity(requirements, 'single_fitted_sheet')).toBe(15)
    expect(requirementQuantity(requirements, 'pillow')).toBe(25)
  })

  it('changes the towel arithmetic when the divisor changes', () => {
    const base = exampleCatalogue()
    const catalogue = exampleCatalogue({
      rules: base.rules.map((existing) =>
        existing.id === 'towel_hand'
          ? { ...existing, quantity: { basis: 'guests' as const, divisor: 4 } }
          : existing,
      ),
    })

    const { requirements } = plan(exampleBooking(), catalogue)

    expect(requirementQuantity(requirements, 'hand_towel')).toBe(7)
  })
})

// ── Event templates ───────────────────────────────────────────────────────

describe('the event template', () => {
  it('adds the Shabbat requirements and merges the second urn into the first', () => {
    const { requirements } = plan()

    expect(requirementQuantity(requirements, 'urn')).toBe(2)
    expect(requirementQuantity(requirements, 'hotplate')).toBe(2)
    expect(requirementQuantity(requirements, 'candle')).toBe(2)
    expect(requirementQuantity(requirements, 'table')).toBe(4)
    expect(requirementQuantity(requirements, 'chair')).toBe(25)
    expect(requirementQuantity(requirements, 'kiddush_cup')).toBe(1)
    expect(requirementQuantity(requirements, 'tablecloth')).toBe(4)
  })

  it('adds none of it to a booking that is not a Shabbat', () => {
    const { requirements } = plan(
      exampleBooking({ eventType: 'accommodation' }),
    )

    expect(requirementQuantity(requirements, 'urn')).toBe(0)
    expect(requirementQuantity(requirements, 'hotplate')).toBe(0)
  })
})

// ── Extras and merging ────────────────────────────────────────────────────

describe('what the guest asked for by name', () => {
  it('merges an extra with the rule that already produced the item', () => {
    const { requirements } = plan(
      exampleBooking({
        extras: [
          {
            itemId: 'bath_towel',
            label: 'מגבת רחצה',
            quantity: 4,
            category: 'towels',
            section: 'towels',
            unit: 'piece',
            minutesPerUnit: 1,
          },
        ],
      }),
    )

    expect(requirementQuantity(requirements, 'bath_towel')).toBe(29)

    const towels = requirements.find(
      (requirement) => requirement.itemId === 'bath_towel',
    )
    expect(towels?.sources.map((source) => source.origin)).toEqual([
      'rule',
      'extra',
    ])
  })
})

// ── Determinism ───────────────────────────────────────────────────────────

describe('recomputation', () => {
  it('produces an identical list for an unchanged booking', () => {
    expect(plan().requirements).toEqual(plan().requirements)
  })

  it('sorts by category and item, whatever order the rules were written in', () => {
    const base = exampleCatalogue()
    const reversed = exampleCatalogue({ rules: [...base.rules].reverse() })

    expect(plan(exampleBooking(), reversed).requirements).toEqual(
      plan().requirements,
    )
  })
})

// ── The bed catalogue is data too ─────────────────────────────────────────

describe('the bed catalogue', () => {
  it('keeps capacity and physical positions separate', () => {
    const jewish = BED_TYPES.find((type) => type.id === 'jewish_bed')
    const double = BED_TYPES.find((type) => type.id === 'double_bed')

    // Both sleep two. Only one of them is two mattresses, and that is the
    // whole reason the linen lists differ.
    expect(jewish?.capacity).toBe(double?.capacity)
    expect(jewish?.positions).not.toBe(double?.positions)
  })
})
