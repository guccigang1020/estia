/**
 * The onboarding rules, tested without a database.
 *
 * Everything asserted here is a rule the server re-runs on input it did not
 * generate, so these are not tests of a convenience layer — they are tests of
 * the only thing standing between a crafted POST and a row that violates a
 * CHECK constraint. Each case names the constraint or the failure it exists
 * to prevent.
 */

import { describe, expect, it } from 'vitest'

import {
  agorotToShekels,
  parseUnitDraft,
  safeNextPath,
  shekelsToAgorot,
  slugify,
  validateOrganization,
  validateProperty,
  validateUnit,
  type OrganizationDraft,
  type PropertyDraft,
  type UnitDraft,
} from './schema'

const fieldsOf = (issues: readonly { field: string }[]) =>
  issues.map((issue) => issue.field).sort()

/* ------------------------------------------------------------------ slug -- */

describe('slugify', () => {
  it('turns a Latin name into a slug that satisfies organizations_slug_format', () => {
    expect(slugify('Galilee Cabins')).toBe('galilee-cabins')
    expect(slugify('  Bee & Bee  ')).toBe('bee-bee')
    expect(slugify('Villa 42')).toBe('villa-42')
  })

  it('strips accents rather than dropping the letters that carry them', () => {
    expect(slugify('Café Nord')).toBe('cafe-nord')
  })

  it('suggests NOTHING for a Hebrew name', () => {
    // The whole reason the slug field is required and separately editable.
    // A transliteration invented here would put a word nobody chose on the
    // business's public address.
    expect(slugify('וילה הגליל')).toBe('')
    expect(slugify('צימר בכפר')).toBe('')
  })

  it('never produces a leading or trailing separator', () => {
    expect(slugify('---hello---')).toBe('hello')
    expect(slugify('!!!')).toBe('')
  })

  it('stays inside the 63 character limit the constraint imposes', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(63)
  })
})

/* ----------------------------------------------------------------- money -- */

describe('shekelsToAgorot', () => {
  it('converts without going through a float', () => {
    // 139.90 * 100 is 13989.999999999998 in IEEE 754. A product that rounds
    // that once has a price nobody can reconcile against an invoice.
    expect(shekelsToAgorot('139.90')).toBe(13990)
    expect(shekelsToAgorot('0.10')).toBe(10)
    expect(shekelsToAgorot('1.05')).toBe(105)
    expect(shekelsToAgorot('0')).toBe(0)
    expect(shekelsToAgorot('1200')).toBe(120000)
  })

  it('pads a single decimal digit rather than reading it as agorot', () => {
    expect(shekelsToAgorot('12.5')).toBe(1250)
  })

  it('refuses anything that is not a plain non-negative amount', () => {
    expect(shekelsToAgorot('')).toBeNull()
    expect(shekelsToAgorot('-5')).toBeNull()
    expect(shekelsToAgorot('1e3')).toBeNull()
    expect(shekelsToAgorot('12.345')).toBeNull()
    expect(shekelsToAgorot('abc')).toBeNull()
    expect(shekelsToAgorot('1,200')).toBe(120000)
  })

  it('round-trips through the display form', () => {
    expect(agorotToShekels(13990)).toBe('139.90')
    expect(shekelsToAgorot(agorotToShekels(13990))).toBe(13990)
  })
})

/* ---------------------------------------------------------- organization -- */

const organization = (over: Partial<OrganizationDraft> = {}) =>
  ({
    name: 'Galilee Cabins',
    slug: 'galilee-cabins',
    businessType: 'zimmer',
    timezone: 'Asia/Jerusalem',
    ...over,
  }) satisfies OrganizationDraft

describe('validateOrganization', () => {
  it('accepts a complete draft', () => {
    expect(validateOrganization(organization())).toEqual([])
  })

  it('requires a name and a slug', () => {
    const issues = validateOrganization(organization({ name: '   ', slug: '' }))
    expect(fieldsOf(issues)).toEqual(['name', 'slug'])
  })

  it('refuses a slug the database CHECK would refuse', () => {
    // organizations_slug_format: lowercase, digits and hyphens, and it may
    // neither start nor end with a hyphen.
    for (const slug of [
      '-leading',
      'trailing-',
      'Upper',
      'has space',
      'שלום',
    ]) {
      expect(fieldsOf(validateOrganization(organization({ slug })))).toContain(
        'slug',
      )
    }
  })

  it('refuses a slug outside the length the constraint allows', () => {
    expect(
      fieldsOf(validateOrganization(organization({ slug: 'a' }))),
    ).toContain('slug')
    expect(
      fieldsOf(validateOrganization(organization({ slug: 'a'.repeat(64) }))),
    ).toContain('slug')
  })

  it('refuses a business type that is not in the enum', () => {
    expect(
      fieldsOf(validateOrganization(organization({ businessType: 'hotel' }))),
    ).toContain('businessType')
  })

  it('reports every offending field, not the first', () => {
    const issues = validateOrganization({
      name: '',
      slug: 'Bad Slug',
      businessType: 'nope',
      timezone: '',
    })
    expect(fieldsOf(issues)).toEqual([
      'businessType',
      'name',
      'slug',
      'timezone',
    ])
  })

  it('gives every issue a Hebrew message and a Hebrew label', () => {
    for (const issue of validateOrganization({
      name: '',
      slug: '',
      businessType: '',
      timezone: '',
    })) {
      expect(issue.message).toMatch(/[֐-׿]/)
      expect(issue.label).toMatch(/[֐-׿]/)
    }
  })
})

/* -------------------------------------------------------------- property -- */

const property = (over: Partial<PropertyDraft> = {}) =>
  ({
    name: 'הבית בכרם',
    propertyType: 'zimmer',
    addressLine1: 'הגפן 4',
    city: 'כפר תבור',
    checkInTime: '15:00',
    checkOutTime: '11:00',
    cancellationPolicyText: 'ביטול עד 14 יום לפני ההגעה — החזר מלא.',
    ...over,
  }) satisfies PropertyDraft

describe('validateProperty', () => {
  it('accepts a complete draft', () => {
    expect(validateProperty(property())).toEqual([])
  })

  it('requires the cancellation policy to be written by a person', () => {
    // It is the text a guest agrees to. Nothing may pre-fill it.
    expect(
      fieldsOf(validateProperty(property({ cancellationPolicyText: '  ' }))),
    ).toEqual(['cancellationPolicyText'])
  })

  it('refuses a time that is not a real time of day', () => {
    for (const time of ['24:00', '9:00', '15:60', '', 'noon']) {
      expect(
        fieldsOf(validateProperty(property({ checkInTime: time }))),
      ).toContain('checkInTime')
    }
  })

  it('does NOT require check-out to be later than check-in', () => {
    // They are times on two different days. 15:00 in and 11:00 out is the
    // normal case, and a rule ordering them would refuse every correct entry.
    expect(
      validateProperty(
        property({ checkInTime: '15:00', checkOutTime: '11:00' }),
      ),
    ).toEqual([])
  })

  it('requires an address and a city', () => {
    expect(
      fieldsOf(validateProperty(property({ addressLine1: '', city: '' }))),
    ).toEqual(['addressLine1', 'city'])
  })
})

/* ------------------------------------------------------------------ unit -- */

const unit = (over: Partial<UnitDraft> = {}) =>
  ({
    name: 'הבקתה הצפונית',
    unitType: 'cabin',
    capacity: '4',
    bedrooms: '2',
    bathrooms: '1.5',
    basePrice: '850.00',
    deposit: '500',
    ...over,
  }) satisfies UnitDraft

describe('validateUnit', () => {
  it('accepts a complete draft', () => {
    expect(validateUnit(unit())).toEqual([])
  })

  it('refuses a capacity below one, which units_max_guests_positive forbids', () => {
    expect(fieldsOf(validateUnit(unit({ capacity: '0' })))).toContain(
      'capacity',
    )
    expect(fieldsOf(validateUnit(unit({ capacity: '-1' })))).toContain(
      'capacity',
    )
    expect(fieldsOf(validateUnit(unit({ capacity: '2.5' })))).toContain(
      'capacity',
    )
  })

  it('allows zero bedrooms, because a studio has none', () => {
    expect(validateUnit(unit({ bedrooms: '0' }))).toEqual([])
  })

  it('allows a half bathroom and refuses a second decimal place', () => {
    // units.bathrooms is numeric(3,1); 1.55 would be silently rounded.
    expect(validateUnit(unit({ bathrooms: '1.5' }))).toEqual([])
    expect(fieldsOf(validateUnit(unit({ bathrooms: '1.55' })))).toContain(
      'bathrooms',
    )
  })

  it('requires the deposit to be present, with zero as the explicit answer', () => {
    expect(validateUnit(unit({ deposit: '0' }))).toEqual([])
    expect(fieldsOf(validateUnit(unit({ deposit: '' })))).toContain('deposit')
  })

  it('refuses a price with a misplaced decimal point', () => {
    expect(
      fieldsOf(validateUnit(unit({ basePrice: '99999999999' }))),
    ).toContain('basePrice')
  })
})

describe('parseUnitDraft', () => {
  it('parses a valid draft into the columns the insert writes', () => {
    expect(parseUnitDraft(unit())).toEqual({
      maxGuests: 4,
      bedrooms: 2,
      bathrooms: 1.5,
      basePriceAgorot: 85000,
      depositAgorot: 50000,
    })
  })

  it('refuses to parse a draft the validator would reject', () => {
    // So a caller cannot get halfway through a write on refused input.
    expect(parseUnitDraft(unit({ capacity: '0' }))).toBeNull()
    expect(parseUnitDraft(unit({ basePrice: '-1' }))).toBeNull()
  })
})

/* ------------------------------------------------------------------ next -- */

describe('safeNextPath', () => {
  it('keeps a path inside this application', () => {
    expect(safeNextPath('/bookings/123')).toBe('/bookings/123')
    expect(safeNextPath('/properties?tab=units')).toBe('/properties?tab=units')
  })

  it('refuses anything that could leave the origin', () => {
    // An open redirect here would borrow the product's credibility to land
    // somebody on a phishing page.
    expect(safeNextPath('//evil.example')).toBeNull()
    expect(safeNextPath('/\\evil.example')).toBeNull()
    expect(safeNextPath('https://evil.example')).toBeNull()
    expect(safeNextPath('javascript:alert(1)')).toBeNull()
    expect(safeNextPath('bookings')).toBeNull()
  })

  it('treats absent and empty as no destination', () => {
    expect(safeNextPath(null)).toBeNull()
    expect(safeNextPath(undefined)).toBeNull()
    expect(safeNextPath('')).toBeNull()
  })
})
