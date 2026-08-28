/**
 * Laying the party out.
 *
 * Four situations, all of which happen in a real week: the permanent beds hold
 * everyone with room to spare, they nearly hold everyone, they fall well short
 * and storage covers it, and they fall short and it has to be mattresses. The
 * fourth is the specification's example; the first three are the ones that
 * quietly produce a wrong linen order when the allocation is naive.
 */

import { describe, expect, it } from 'vitest'
import { allocateSleeping, permanentCapacityOf } from './sleeping'
import type { PropertyConfiguration } from './types'
import { BED_TYPES, PROPERTY } from './testing/example-configuration'

function property(
  overrides: Partial<PropertyConfiguration>,
): PropertyConfiguration {
  return { ...PROPERTY, ...overrides }
}

function allocate(guests: number, configuration = PROPERTY) {
  return allocateSleeping({ guests, configuration, bedTypes: BED_TYPES })
}

// ── Capacity in excess ────────────────────────────────────────────────────

describe('when the permanent beds hold more than the party', () => {
  it('uses only the beds it needs and leaves the rest made up', () => {
    const allocation = allocate(4)

    expect(allocation.permanentCapacity).toBe(10)
    expect(allocation.lines).toEqual([
      {
        bedTypeId: 'jewish_bed',
        label: 'מיטה יהודית',
        source: 'permanent',
        count: 2,
        capacity: 4,
      },
    ])
    expect(allocation.extraBeds).toBe(0)
  })

  it('rounds a bed up rather than sleeping half a guest on the floor', () => {
    // Five people across beds that sleep two: three beds, six places. The
    // sixth place is real — the bed is made — and the linen count follows it.
    const allocation = allocate(5)

    expect(allocation.lines[0].count).toBe(3)
    expect(allocation.sleepingPlaces).toBe(6)
    expect(allocation.extraBeds).toBe(0)
    expect(allocation.unplacedGuests).toBe(0)
  })

  it('places nobody for a booking of nobody', () => {
    const allocation = allocate(0)

    expect(allocation.lines).toEqual([])
    expect(allocation.sleepingPlaces).toBe(0)
  })
})

// ── Capacity short ────────────────────────────────────────────────────────

describe('when the permanent beds fall short', () => {
  it('makes the difference up with floor mattresses', () => {
    const allocation = allocate(25)

    expect(allocation.lines.map((line) => line.source)).toEqual([
      'permanent',
      'added',
    ])
    expect(allocation.extraBeds).toBe(15)
    expect(allocation.sleepingPlaces).toBe(25)
  })

  it('empties storage before conjuring anything new', () => {
    const configuration = property({
      beds: [
        { bedTypeId: 'jewish_bed', permanent: 5, storage: 0, missing: 0 },
        { bedTypeId: 'folding_bed', permanent: 0, storage: 6, missing: 0 },
      ],
    })

    const allocation = allocate(25, configuration)

    expect(allocation.lines).toEqual([
      {
        bedTypeId: 'jewish_bed',
        label: 'מיטה יהודית',
        source: 'permanent',
        count: 5,
        capacity: 10,
      },
      {
        bedTypeId: 'folding_bed',
        label: 'מיטה מתקפלת',
        source: 'storage',
        count: 6,
        capacity: 6,
      },
      {
        bedTypeId: 'floor_mattress',
        label: 'מזרן רצפה',
        source: 'added',
        count: 9,
        capacity: 9,
      },
    ])
    // Storage beds and mattresses are both extra work.
    expect(allocation.extraBeds).toBe(15)
  })

  it('will not press a crib into service as an adult bed', () => {
    const configuration = property({
      beds: [
        { bedTypeId: 'jewish_bed', permanent: 1, storage: 0, missing: 0 },
        { bedTypeId: 'crib', permanent: 0, storage: 4, missing: 0 },
      ],
    })

    const allocation = allocate(6, configuration)

    expect(allocation.lines.some((line) => line.bedTypeId === 'crib')).toBe(
      false,
    )
    expect(allocation.extraBeds).toBe(4)
  })
})

// ── Mixed catalogues ──────────────────────────────────────────────────────

describe('across mixed bed types', () => {
  it('takes the largest beds first, deterministically', () => {
    const configuration = property({
      beds: [
        { bedTypeId: 'single_bed', permanent: 4, storage: 0, missing: 0 },
        { bedTypeId: 'jewish_bed', permanent: 2, storage: 0, missing: 0 },
        { bedTypeId: 'double_bed', permanent: 1, storage: 0, missing: 0 },
      ],
    })

    const allocation = allocate(7, configuration)

    // Capacity two first: double and Jewish tie on capacity and break on id.
    expect(allocation.lines.map((line) => line.bedTypeId)).toEqual([
      'double_bed',
      'jewish_bed',
      'single_bed',
    ])
    expect(allocation.sleepingPlaces).toBe(7)
    expect(allocation.extraBeds).toBe(0)
  })

  it('gives an identical answer on a second run', () => {
    const configuration = property({
      beds: [
        { bedTypeId: 'single_bed', permanent: 4, storage: 0, missing: 0 },
        { bedTypeId: 'jewish_bed', permanent: 2, storage: 0, missing: 0 },
      ],
    })

    expect(allocate(7, configuration)).toEqual(allocate(7, configuration))
  })

  it('ignores a bed type the catalogue does not describe', () => {
    const configuration = property({
      beds: [{ bedTypeId: 'hammock', permanent: 9, storage: 0, missing: 0 }],
    })

    expect(permanentCapacityOf(configuration, BED_TYPES)).toBe(0)
    expect(allocate(4, configuration).extraBeds).toBe(4)
  })
})

// ── The property's own ceiling ────────────────────────────────────────────

describe("the property's licensed maximum", () => {
  it('wins over the number typed into the booking', () => {
    const allocation = allocate(25, property({ maximumSleepingPlaces: 18 }))

    expect(allocation.sleepingPlaces).toBe(18)
    expect(allocation.unplacedGuests).toBe(7)
  })

  it('reports guests it could not place rather than throwing', () => {
    const configuration = property({
      beds: [{ bedTypeId: 'jewish_bed', permanent: 1, storage: 0, missing: 0 }],
      extraSleepingBedTypeId: 'crib',
    })

    const allocation = allocate(9, configuration)

    expect(allocation.sleepingPlaces).toBe(2)
    expect(allocation.unplacedGuests).toBe(7)
  })
})
