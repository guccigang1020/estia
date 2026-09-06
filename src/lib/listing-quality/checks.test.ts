import { describe, expect, it } from 'vitest'

import {
  GUESTS_PER_BED,
  MIN_AMENITIES,
  MIN_DESCRIPTION_CHARS,
  MIN_PHOTOS,
  checkProperty,
  checkUnit,
} from './checks'
import type { ListingProperty, ListingUnit } from './types'

const property = (over: Partial<ListingProperty> = {}): ListingProperty => ({
  id: 'p-1',
  name: 'אחוזת הגליל',
  description: 'א'.repeat(700),
  city: 'ראש פינה',
  region: 'הגליל העליון',
  latitude: 32.97,
  longitude: 35.54,
  houseRules: 'אין מסיבות',
  cancellationPolicyText: 'ביטול עד 14 יום',
  coverImageUrl: 'https://example.com/cover.jpg',
  amenityCount: 12,
  photoCount: 9,
  ...over,
})

const unit = (over: Partial<ListingUnit> = {}): ListingUnit => ({
  id: 'u-1',
  propertyId: 'p-1',
  name: 'סוויטת הכרם',
  description: 'א'.repeat(400),
  maxGuests: 4,
  bedrooms: 2,
  bathrooms: 1,
  beds: 2,
  sizeSqm: 60,
  basePriceAgorot: 90_000,
  cleaningFeeAgorot: 15_000,
  depositAgorot: 0,
  minNights: 2,
  coverImageUrl: 'https://example.com/unit.jpg',
  amenityCount: 10,
  photoCount: 7,
  ...over,
})

const statusOf = (
  checks: readonly { code: string; status: string }[],
  code: string,
) => checks.find((check) => check.code === code)?.status

describe('a complete property', () => {
  it('passes everything that can be assessed', () => {
    const checks = checkProperty(property())
    const failures = checks.filter((check) => check.status === 'warn')
    expect(failures).toEqual([])
  })

  it('still reports what it cannot judge', () => {
    // `review.view` and `review.manage` are in the permission catalogue and
    // there is no reviews table in any migration. The grants point at nothing.
    const checks = checkProperty(property())
    expect(statusOf(checks, 'property.guest_rating')).toBe('not_assessed')
    expect(
      checks.find((check) => check.code === 'property.guest_rating')?.weight,
    ).toBe(0)
  })
})

describe('what a property is marked down for', () => {
  it('a description that reads as a placeholder', () => {
    const checks = checkProperty(
      property({
        description: 'בית יפה'.padEnd(MIN_DESCRIPTION_CHARS - 1, ' '),
      }),
    )
    expect(statusOf(checks, 'property.description_present')).toBe('warn')
  })

  it('no cover image, which is the heaviest single photo check', () => {
    const checks = checkProperty(property({ coverImageUrl: null }))
    const cover = checks.find((c) => c.code === 'property.cover_image')
    expect(cover?.status).toBe('warn')
    expect(cover?.weight).toBe(3)
  })

  it('too few photos to picture the place', () => {
    const checks = checkProperty(property({ photoCount: MIN_PHOTOS - 1 }))
    expect(statusOf(checks, 'property.photo_count')).toBe('warn')
  })

  it('a short amenity list, which usually means unfilled rather than sparse', () => {
    const checks = checkProperty(property({ amenityCount: MIN_AMENITIES - 1 }))
    expect(statusOf(checks, 'property.amenities')).toBe('warn')
  })

  it('no coordinates — an address a guest cannot put in a map', () => {
    expect(
      statusOf(
        checkProperty(property({ latitude: null })),
        'property.coordinates',
      ),
    ).toBe('warn')
    expect(
      statusOf(
        checkProperty(property({ longitude: null })),
        'property.coordinates',
      ),
    ).toBe('warn')
  })

  it('no cancellation policy in words', () => {
    const checks = checkProperty(property({ cancellationPolicyText: null }))
    const policy = checks.find((c) => c.code === 'property.cancellation_policy')
    expect(policy?.status).toBe('warn')
    expect(policy?.weight).toBe(3)
  })
})

describe('capacity has to add up, not merely be filled in', () => {
  it('passes when the beds could plausibly hold the guests', () => {
    const checks = checkUnit(unit({ maxGuests: 4, beds: 2 }))
    expect(statusOf(checks, 'unit.capacity_plausible')).toBe('pass')
  })

  it('flags "sleeps eight" on two beds', () => {
    // The single most common cause of a guest arriving to find the place is
    // not what they booked, and of the argument that follows.
    const checks = checkUnit(unit({ maxGuests: 8, beds: 2 }))
    const plausible = checks.find((c) => c.code === 'unit.capacity_plausible')
    expect(plausible?.status).toBe('warn')
    expect(plausible?.observed).toBe('8 אורחים על 2 מיטות')
  })

  it('sits exactly on the boundary without complaining', () => {
    const checks = checkUnit(unit({ maxGuests: 2 * GUESTS_PER_BED, beds: 2 }))
    expect(statusOf(checks, 'unit.capacity_plausible')).toBe('pass')
  })

  it('does not judge plausibility with no bed count, rather than guessing', () => {
    const checks = checkUnit(unit({ beds: null }))
    expect(statusOf(checks, 'unit.capacity_plausible')).toBe('not_assessed')
  })

  it('and does not judge it on zero beds either', () => {
    const checks = checkUnit(unit({ beds: 0 }))
    expect(statusOf(checks, 'unit.capacity_plausible')).toBe('not_assessed')
  })
})

describe('pricing', () => {
  it('wants a base price that is actually a price', () => {
    expect(
      statusOf(checkUnit(unit({ basePriceAgorot: null })), 'unit.base_price'),
    ).toBe('warn')
    expect(
      statusOf(checkUnit(unit({ basePriceAgorot: 0 })), 'unit.base_price'),
    ).toBe('warn')
  })

  it('treats an explicit zero fee as decided, because it is', () => {
    // A business that charges no cleaning fee has answered the question. Only
    // null means nobody decided, and a guest meeting an unstated fee at
    // checkout is the complaint that follows.
    const decided = checkUnit(unit({ cleaningFeeAgorot: 0, depositAgorot: 0 }))
    expect(statusOf(decided, 'unit.fees_decided')).toBe('pass')

    const undecided = checkUnit(unit({ cleaningFeeAgorot: null }))
    expect(statusOf(undecided, 'unit.fees_decided')).toBe('warn')
  })

  it('does not claim a market position it has no data for', () => {
    expect(statusOf(checkUnit(unit()), 'unit.market_position')).toBe(
      'not_assessed',
    )
    expect(statusOf(checkUnit(unit()), 'unit.conversion_rate')).toBe(
      'not_assessed',
    )
  })
})

describe('every unmeasurable check weighs nothing', () => {
  it('so it can neither drag a score down nor prop it up', () => {
    for (const check of [...checkProperty(property()), ...checkUnit(unit())]) {
      if (check.status === 'not_assessed') {
        expect(check.weight, check.code).toBe(0)
        expect(check.observed, check.code).toBeNull()
      }
    }
  })
})
