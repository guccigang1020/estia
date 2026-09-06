import { describe, expect, it } from 'vitest'

import { reportForProperty, reportForUnit } from './report'
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
  reviewCount: 0,
  reviewAverage: null,
  reviewsHidden: 0,
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

describe('a property report', () => {
  it('scores a complete property at 100 and still names what it skipped', () => {
    const report = reportForProperty(property())
    expect(report.score.score).toBe(100)
    expect(report.score.notAssessed).toBeGreaterThan(0)
    expect(report.unitId).toBeNull()
  })
})

describe('a unit report', () => {
  it('is judged on its property too', () => {
    // A guest booking a suite is choosing the place it sits in.
    const report = reportForUnit(property(), unit())
    expect(report.checks.some((c) => c.code.startsWith('property.'))).toBe(true)
    expect(report.checks.some((c) => c.code.startsWith('unit.'))).toBe(true)
    expect(report.name).toBe('אחוזת הגליל · סוויטת הכרם')
  })

  it('cannot score 95 for a listing a guest cannot find or cancel', () => {
    // The unit is perfect; the property has no coordinates and no policy.
    const broken = reportForUnit(
      property({
        latitude: null,
        longitude: null,
        cancellationPolicyText: null,
      }),
      unit(),
    )
    const unitOnly = reportForUnit(property(), unit())

    expect(broken.score.score).toBeLessThan(unitOnly.score.score)
    expect(broken.score.score).toBeLessThan(90)
  })

  it('puts the property failures first, because they lift every unit', () => {
    const report = reportForUnit(property(), unit())
    const firstUnitIndex = report.checks.findIndex((c) =>
      c.code.startsWith('unit.'),
    )
    const lastPropertyIndex = report.checks.reduce(
      (last, check, index) =>
        check.code.startsWith('property.') ? index : last,
      -1,
    )
    expect(lastPropertyIndex).toBeLessThan(firstUnitIndex)
  })

  it('carries the ids so a screen can link back to what to edit', () => {
    const report = reportForUnit(property(), unit())
    expect(report.propertyId).toBe('p-1')
    expect(report.unitId).toBe('u-1')
  })
})
