import { describe, expect, it } from 'vitest'

import {
  ambiguousMappingException,
  listingKey,
  listingsForUnit,
  planMappings,
  refOfListing,
  resolveListing,
  unmappedListingException,
  validateMapping,
  type ListingRef,
} from './mapping'
import { aListing, aMapping, aUnit, ORG, PROPERTY } from './testing'

const REF: ListingRef = {
  channelCode: 'booking_com',
  externalListingId: 'BC-100',
  externalVariantId: null,
}

const CONTEXT = {
  organizationId: ORG,
  connectorId: 'conn-1',
  occurredAt: new Date('2026-02-01T10:00:00Z'),
}

describe('listing keys', () => {
  it('keeps an absent variant distinct from an empty one', () => {
    // Interpolating null would make these one key, and one Booking.com listing
    // selling three rooms would collapse into a single unit.
    expect(listingKey({ ...REF, externalVariantId: null })).not.toBe(
      listingKey({ ...REF, externalVariantId: '' }),
    )
  })

  it('separates the same listing id on two channels', () => {
    expect(listingKey(REF)).not.toBe(
      listingKey({ ...REF, channelCode: 'airbnb' }),
    )
  })
})

describe('resolving a listing', () => {
  it('one property, one listing', () => {
    const resolution = resolveListing([aMapping()], REF)
    expect(resolution.kind).toBe('mapped')
    if (resolution.kind !== 'mapped') return
    expect(resolution.mapping.unitId).toBe('unit-1')
  })

  it('one property, many units — each listing reaches its own unit', () => {
    const mappings = [
      aMapping({ id: 'm1', externalListingId: 'BC-1', unitId: 'cabin-a' }),
      aMapping({ id: 'm2', externalListingId: 'BC-2', unitId: 'cabin-b' }),
      aMapping({ id: 'm3', externalListingId: 'BC-3', unitId: 'cabin-c' }),
    ]

    const b = resolveListing(mappings, { ...REF, externalListingId: 'BC-2' })
    expect(b.kind === 'mapped' && b.mapping.unitId).toBe('cabin-b')
  })

  it('listing variants reach different units', () => {
    const mappings = [
      aMapping({ id: 'm1', externalVariantId: 'room-1', unitId: 'unit-a' }),
      aMapping({ id: 'm2', externalVariantId: 'room-2', unitId: 'unit-b' }),
    ]

    const two = resolveListing(mappings, {
      ...REF,
      externalVariantId: 'room-2',
    })
    expect(two.kind === 'mapped' && two.mapping.unitId).toBe('unit-b')

    // The listing without a variant is a different thing again, and unmapped.
    expect(resolveListing(mappings, REF).kind).toBe('unmapped')
  })

  it('reports an unmapped listing rather than guessing', () => {
    expect(resolveListing([], REF)).toEqual({ kind: 'unmapped', ref: REF })
  })

  it('refuses two active mappings instead of picking one', () => {
    const mappings = [
      aMapping({ id: 'm1', unitId: 'unit-a' }),
      aMapping({ id: 'm2', unitId: 'unit-b' }),
    ]

    const resolution = resolveListing(mappings, REF)
    expect(resolution.kind).toBe('ambiguous')
    if (resolution.kind !== 'ambiguous') return
    expect(resolution.mappings).toHaveLength(2)
  })

  it('does not route through a mapping that was never activated', () => {
    // Otherwise the activate step in the setup flow is decorative.
    for (const state of ['draft', 'validated', 'suspended'] as const) {
      expect(resolveListing([aMapping({ state })], REF).kind).toBe('inactive')
    }
  })

  it('finds every listing a unit is sold through', () => {
    const mappings = [
      aMapping({ id: 'm1', externalListingId: 'BC-1' }),
      aMapping({ id: 'm2', channelCode: 'airbnb', externalListingId: 'AB-1' }),
      aMapping({ id: 'm3', externalListingId: 'BC-9', state: 'suspended' }),
      aMapping({ id: 'm4', externalListingId: 'BC-2', unitId: 'other' }),
    ]

    // A night that sells has to close on both live listings, not just the one
    // the booking came from.
    expect(listingsForUnit(mappings, 'unit-1').map((m) => m.id)).toEqual([
      'm1',
      'm2',
    ])
  })
})

describe('exceptions from mapping', () => {
  it('an unmapped listing produces one exception per listing, not per delivery', () => {
    const first = unmappedListingException(REF, {
      ...CONTEXT,
      externalReservationId: 'R-1',
    })
    const second = unmappedListingException(REF, {
      ...CONTEXT,
      externalReservationId: 'R-2',
    })

    expect(first.kind).toBe('mapping_missing')
    expect(first.severity).toBe('critical')
    expect(first.dedupeKey).toBe(second.dedupeKey)
  })

  it('names the listing when discovery has seen it', () => {
    const exception = unmappedListingException(REF, {
      ...CONTEXT,
      listingName: 'Villa Carmel',
    })
    expect(exception.detail).toContain('Villa Carmel')
  })

  it('says how many mappings collide', () => {
    const exception = ambiguousMappingException(
      REF,
      [aMapping({ id: 'a' }), aMapping({ id: 'b' })],
      CONTEXT,
    )
    expect(exception.kind).toBe('duplicate_mapping')
    expect(exception.detail).toContain('2')
  })
})

describe('validating a match', () => {
  const listings = [aListing()]

  it('accepts a sound match', () => {
    const result = validateMapping({
      draft: {
        channelCode: 'booking_com',
        externalListingId: 'BC-100',
        externalVariantId: null,
        propertyId: PROPERTY,
        unitId: 'unit-1',
      },
      units: [aUnit()],
      listings,
      existing: [],
    })

    expect(result.ok).toBe(true)
    expect(result.problems).toEqual([])
  })

  it('collects every problem rather than the first', () => {
    const result = validateMapping({
      draft: {
        channelCode: 'booking_com',
        externalListingId: 'BC-404',
        externalVariantId: null,
        propertyId: PROPERTY,
        unitId: 'ghost',
      },
      units: [aUnit()],
      listings,
      existing: [],
    })

    expect(result.ok).toBe(false)
    expect(result.problems.map((problem) => problem.kind).sort()).toEqual([
      'unknown_listing',
      'unknown_unit',
    ])
  })

  it('refuses a unit that belongs to another property', () => {
    const result = validateMapping({
      draft: {
        channelCode: 'booking_com',
        externalListingId: 'BC-100',
        externalVariantId: null,
        propertyId: 'prop-other',
        unitId: 'unit-1',
      },
      units: [aUnit()],
      listings,
      existing: [],
    })

    expect(result.ok).toBe(false)
    expect(result.problems[0].kind).toBe('unit_wrong_property')
  })

  it('refuses a unit the availability engine will always reject', () => {
    const result = validateMapping({
      draft: {
        channelCode: 'booking_com',
        externalListingId: 'BC-100',
        externalVariantId: null,
        propertyId: PROPERTY,
        unitId: 'unit-1',
      },
      units: [aUnit({ sellable: false })],
      listings,
      existing: [],
    })

    expect(result.ok).toBe(false)
    expect(result.problems[0].kind).toBe('unit_not_sellable')
  })

  it('refuses a second claim on one listing', () => {
    const result = validateMapping({
      draft: {
        channelCode: 'booking_com',
        externalListingId: 'BC-100',
        externalVariantId: null,
        propertyId: PROPERTY,
        unitId: 'unit-2',
      },
      units: [aUnit({ unitId: 'unit-2' })],
      listings,
      existing: [aMapping()],
    })

    expect(result.ok).toBe(false)
    expect(result.problems.map((p) => p.kind)).toContain('duplicate_listing')
  })

  it('warns without blocking when a unit is sold twice on one channel', () => {
    const result = validateMapping({
      draft: {
        channelCode: 'booking_com',
        externalListingId: 'BC-200',
        externalVariantId: null,
        propertyId: PROPERTY,
        unitId: 'unit-1',
      },
      units: [aUnit()],
      listings: [aListing({ externalListingId: 'BC-200' })],
      existing: [aMapping()],
    })

    // Unusual, legitimate, and not this module's business rule to forbid.
    expect(result.ok).toBe(true)
    expect(result.problems.map((p) => p.kind)).toEqual(['unit_already_listed'])
  })

  it('lets an inactive listing be mapped, and says it will not sell', () => {
    const result = validateMapping({
      draft: {
        channelCode: 'booking_com',
        externalListingId: 'BC-100',
        externalVariantId: null,
        propertyId: PROPERTY,
        unitId: 'unit-1',
      },
      units: [aUnit()],
      listings: [aListing({ active: false })],
      existing: [],
    })

    expect(result.ok).toBe(true)
    expect(result.problems[0].kind).toBe('listing_inactive')
    expect(result.problems[0].blocking).toBe(false)
  })
})

describe('the setup plan', () => {
  it('reports both directions and is not complete while anything is unmatched', () => {
    const plan = planMappings({
      listings: [
        aListing({ id: 'l1', externalListingId: 'BC-1' }),
        aListing({ id: 'l2', externalListingId: 'BC-2' }),
      ],
      mappings: [aMapping({ externalListingId: 'BC-1' })],
      units: [aUnit(), aUnit({ unitId: 'unit-2', name: 'צימר הגליל' })],
    })

    expect(plan.unmatched.map((listing) => listing.id)).toEqual(['l2'])
    expect(plan.unlistedUnits.map((unit) => unit.unitId)).toEqual(['unit-2'])
    expect(plan.complete).toBe(false)
  })

  it('is complete only when every listing has one active mapping', () => {
    const listing = aListing()
    const plan = planMappings({
      listings: [listing],
      mappings: [aMapping()],
      units: [aUnit()],
    })

    expect(plan.complete).toBe(true)
    expect(plan.rows[0].mapping?.id).toBe('mapping-1')
    expect(listingKey(refOfListing(listing))).toBe(listingKey(REF))
  })

  it('marks an ambiguous row rather than silently choosing', () => {
    const plan = planMappings({
      listings: [aListing()],
      mappings: [aMapping({ id: 'a' }), aMapping({ id: 'b', unitId: 'u2' })],
      units: [aUnit()],
    })

    expect(plan.rows[0].ambiguous).toBe(true)
    expect(plan.complete).toBe(false)
  })
})
