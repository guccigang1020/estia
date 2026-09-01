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

// ── Couples, and the beds they do or do not share ─────────────────────────

/**
 * A house of double beds: one mattress, sleeps two.
 *
 * The example property is all Jewish beds, where capacity and positions are
 * the same number and the distinction this section is about cannot appear.
 * Doubles are where it bites.
 */
const DOUBLES: PropertyConfiguration = property({
  beds: [{ bedTypeId: 'double_bed', permanent: 4, storage: 0, missing: 0 }],
})

describe('two couples and four colleagues', () => {
  it('are the same six people and a different set of beds', () => {
    // The whole point of recording couples at the desk. Capacity alone cannot
    // tell these apart, and the linen order that follows is three double
    // sheets against six single ones.
    const couples = allocateSleeping({
      guests: 4,
      couples: 2,
      configuration: DOUBLES,
      bedTypes: BED_TYPES,
    })

    const colleagues = allocateSleeping({
      guests: 4,
      couples: 0,
      configuration: DOUBLES,
      bedTypes: BED_TYPES,
    })

    // Two couples take two mattresses.
    expect(couples.positions).toBe(2)
    expect(couples.lines[0].count).toBe(2)

    // Four colleagues need four, and the house has to open all of them.
    expect(colleagues.positions).toBe(4)
    expect(colleagues.lines[0].count).toBe(4)
  })

  it('gives everybody who is not in a couple their own mattress', () => {
    // One couple and two singles: three mattresses, not two.
    const allocation = allocateSleeping({
      guests: 4,
      couples: 1,
      configuration: DOUBLES,
      bedTypes: BED_TYPES,
    })

    expect(allocation.positions).toBe(3)
    expect(allocation.unplacedGuests).toBe(0)
  })
})

describe('a party whose couples were never recorded', () => {
  it('is allocated exactly as it was before couples existed', () => {
    // The regression that matters. Absent must not be read as zero: a family
    // of eight in a house of four doubles would otherwise stop being four
    // made-up beds and become four beds plus four floor mattresses, doubling
    // the linen order on no new information.
    const unasked = allocateSleeping({
      guests: 8,
      configuration: DOUBLES,
      bedTypes: BED_TYPES,
    })

    expect(unasked.lines).toEqual([
      {
        bedTypeId: 'double_bed',
        label: 'מיטה זוגית',
        source: 'permanent',
        count: 4,
        capacity: 8,
      },
    ])
    expect(unasked.extraBeds).toBe(0)
  })

  it('is not the same as a party that said nobody shares', () => {
    // Zero is an answer and is honoured; absent is not an answer at all.
    const stated = allocateSleeping({
      guests: 8,
      couples: 0,
      configuration: DOUBLES,
      bedTypes: BED_TYPES,
    })

    expect(stated.positions).toBe(8)
    expect(stated.extraBeds).toBeGreaterThan(0)
  })
})

// ── The baby ──────────────────────────────────────────────────────────────

describe('an infant is a head and not a bed', () => {
  it('is left out of the allocation entirely', () => {
    // Seven heads, six of whom need laying down. Handing the allocator seven
    // makes up a fourth bed nobody sleeps in and washes its linen.
    const withBaby = allocateSleeping({
      guests: 7,
      sleepingGuests: 6,
      configuration: PROPERTY,
      bedTypes: BED_TYPES,
    })

    expect(withBaby.sleepingPlaces).toBe(6)
    expect(withBaby.lines[0].count).toBe(3)
    // And nobody is reported stranded: the baby is in a cot, which is an item
    // on the plan rather than a bed on this list.
    expect(withBaby.unplacedGuests).toBe(0)
  })

  it('still counts as a guest, because they eat and generate laundry', () => {
    const withBaby = allocateSleeping({
      guests: 7,
      sleepingGuests: 6,
      configuration: PROPERTY,
      bedTypes: BED_TYPES,
    })

    expect(withBaby.guests).toBe(7)
  })

  it('changes nothing when the sleeping party is not stated', () => {
    const unstated = allocateSleeping({
      guests: 7,
      configuration: PROPERTY,
      bedTypes: BED_TYPES,
    })

    expect(unstated.sleepingPlaces).toBe(8)
  })
})

describe('a party the house is licensed too small for', () => {
  it('still reports the people it could not place', () => {
    // The ceiling clamps what is laid out; it must not clamp the count of who
    // was left over, or a licence running out would read as a full house.
    const allocation = allocateSleeping({
      guests: 25,
      sleepingGuests: 25,
      configuration: property({ maximumSleepingPlaces: 18 }),
      bedTypes: BED_TYPES,
    })

    expect(allocation.sleepingPlaces).toBe(18)
    expect(allocation.unplacedGuests).toBe(7)
  })
})
