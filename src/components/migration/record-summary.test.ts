import { describe, expect, it } from 'vitest'

import {
  IMPORT_ENTITIES,
  type ImportRecord,
  type ImportValues,
} from '@/lib/migration/types'

import {
  entityLabel,
  recordFacts,
  recordLabel,
  shekels,
} from './record-summary'

/* ------------------------------------------------------------- fixtures -- */

function wrap(values: ImportValues): ImportRecord {
  return {
    rowNumber: 12,
    entity: values.entity,
    sourceId: null,
    contentHash: 'hash',
    values,
  }
}

const bookingValues: Extract<ImportValues, { entity: 'bookings' }> = {
  entity: 'bookings',
  booking: {
    externalId: 'HMABCD',
    propertyName: 'וילה הגלבוע',
    unitName: 'הצריף',
    guestName: 'משפחת כהן',
    guestPhone: '+972501234567',
    guestEmail: null,
    checkIn: '2023-07-04',
    checkOut: '2023-07-08',
    guestCount: 4,
    adults: 2,
    children: 2,
    infants: null,
    status: 'confirmed',
    source: 'airbnb',
    totalAgorot: 480000,
    depositAgorot: null,
    notes: null,
  },
}

const booking = wrap(bookingValues)

const guestValues: Extract<ImportValues, { entity: 'guests' }> = {
  entity: 'guests',
  guest: {
    externalId: null,
    fullName: 'דנה לוי',
    phone: '+972521111111',
    email: null,
    language: 'he',
    nationality: null,
    city: null,
    tags: [],
    notes: null,
    marketingConsent: false,
  },
}

/** One of every entity, so the exhaustive checks below are genuinely so. */
const ONE_OF_EACH: readonly ImportValues[] = [
  {
    entity: 'organizations',
    organization: {
      externalId: null,
      name: 'הרי הגליל בע״מ',
      legalName: null,
      taxId: null,
      phone: null,
      email: null,
      city: null,
    },
  },
  {
    entity: 'properties',
    property: {
      externalId: null,
      name: 'וילה הגלבוע',
      slug: 'villa-gilboa',
      propertyType: 'villa',
      city: null,
      description: null,
      checkInTime: '16:00',
      checkOutTime: '11:00',
      minNights: 2,
      taxRatePercent: 17,
    },
  },
  {
    entity: 'units',
    unit: {
      externalId: null,
      propertyName: 'וילה הגלבוע',
      name: 'הצריף',
      code: null,
      capacity: 4,
      bedrooms: null,
      nightlyAgorot: null,
      notes: null,
    },
  },
  guestValues,
  bookingValues,
  {
    entity: 'blocked_dates',
    block: {
      externalId: null,
      propertyName: null,
      unitName: 'הצריף',
      fromDate: '2024-01-01',
      toDate: '2024-01-05',
      reason: null,
      notes: null,
    },
  },
  {
    entity: 'pricing',
    pricing: {
      externalId: null,
      propertyName: null,
      unitName: 'הצריף',
      fromDate: '2024-01-01',
      toDate: '2024-01-05',
      nightlyAgorot: 120000,
      minNights: null,
    },
  },
  {
    entity: 'owners',
    owner: {
      externalId: null,
      fullName: 'יוסי בר',
      phone: null,
      email: null,
      propertyName: 'וילה הגלבוע',
      agencyName: null,
      percent: 50,
      notes: null,
    },
  },
  {
    entity: 'agents',
    agent: {
      externalId: null,
      fullName: 'רונית שגב',
      phone: null,
      email: null,
      propertyName: null,
      agencyName: 'סוכנות הצפון',
      percent: 12,
      notes: null,
    },
  },
  {
    entity: 'notes',
    note: {
      externalId: null,
      subject: 'בקשה מיוחדת',
      body: 'מיטת תינוק',
      author: null,
      createdAt: null,
      propertyName: null,
      guestName: null,
    },
  },
]

/* ---------------------------------------------------------------- tests -- */

describe('every entity can be shown', () => {
  it('covers the whole catalogue, so a new entity fails here first', () => {
    const covered = ONE_OF_EACH.map((values) => values.entity)
    expect([...covered].sort()).toEqual([...IMPORT_ENTITIES].sort())
  })

  it('produces a non-empty label and at least one fact for each', () => {
    for (const values of ONE_OF_EACH) {
      expect(recordLabel(wrap(values)).length).toBeGreaterThan(0)
      expect(recordFacts(values).length).toBeGreaterThan(0)
    }
  })

  it('names the entity in Hebrew', () => {
    expect(entityLabel(booking)).toBe('הזמנות')
  })
})

describe('a booking is found by its unit and its dates', () => {
  it('leads with the unit, not the guest', () => {
    // An operator has four families called Cohen and one cabin called הצריף.
    expect(recordLabel(booking)).toBe('הצריף · 2023-07-04 → 2023-07-08')
  })

  it('shows the normalised telephone number, which is the field that changed', () => {
    const facts = recordFacts(bookingValues)
    const phone = facts.find((fact) => fact.label.includes('טלפון'))
    expect(phone?.value).toBe('+972501234567')
  })
})

describe('missing values read as missing', () => {
  it('shows a dash rather than "null" or an empty cell', () => {
    const facts = recordFacts(guestValues)
    const email = facts.find((fact) => fact.label === 'אימייל')
    expect(email?.value).toBe('—')
  })
})

describe('money', () => {
  it('divides agorot into shekels exactly once, here', () => {
    expect(shekels(480000)).toBe('4,800.00 ₪')
    expect(shekels(0)).toBe('0.00 ₪')
    expect(shekels(1)).toBe('0.01 ₪')
  })

  it('shows a booking with no price as a dash, not as zero', () => {
    const free = wrap({
      entity: 'bookings',
      booking: { ...bookingValues.booking, totalAgorot: null },
    })
    const facts = recordFacts(free.values)
    expect(facts.find((fact) => fact.label === 'סכום')?.value).toBe('—')
  })
})
