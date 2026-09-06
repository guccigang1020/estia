/**
 * The lifecycle writes the register, and only when the capability is on.
 *
 * The first block is the one that matters most: no entry is produced for an
 * organization that has not turned the register on, or for a property it
 * excluded. Everything after it walks the four moments in order.
 */

import { describe, expect, it } from 'vitest'

import { defaultGuestBookConfig, type GuestBookConfig } from './config'
import { applyBookingFacts, type BookingFacts } from './generation'
import type { GuestBookEntry } from './types'

const NOW = new Date('2026-03-02T10:00:00.000Z')

function config(overrides: Partial<GuestBookConfig> = {}): GuestBookConfig {
  return { ...defaultGuestBookConfig('org-1'), enabled: true, ...overrides }
}

function facts(overrides: Partial<BookingFacts> = {}): BookingFacts {
  return {
    bookingId: 'booking-1',
    organizationId: 'org-1',
    propertyId: 'prop-1',
    reference: 'BK-2026-0184',
    lifecycle: 'confirmed',
    guestName: null,
    guestAddress: null,
    checkIn: '2026-03-10',
    checkOut: '2026-03-13',
    arrivedAt: null,
    departedAt: null,
    guestCount: 2,
    financialDocumentRef: null,
    financialDocumentId: null,
    notes: null,
    ...overrides,
  }
}

describe('the capability gate', () => {
  it('creates NO entry when the register is off', () => {
    const result = applyBookingFacts({
      facts: facts(),
      config: defaultGuestBookConfig('org-1'),
      existing: null,
      now: NOW,
    })

    expect(result.outcome).toBe('skipped')
    if (result.outcome !== 'skipped') return
    expect(result.reason).toContain('אינו פעיל')
    expect(result).not.toHaveProperty('entry')
  })

  it('creates NO entry for a property the operator excluded', () => {
    const result = applyBookingFacts({
      facts: facts({ propertyId: 'prop-2' }),
      config: config({ propertyIds: ['prop-1'] }),
      existing: null,
      now: NOW,
    })

    expect(result.outcome).toBe('skipped')
    if (result.outcome !== 'skipped') return
    expect(result.reason).toContain('בנכס')
  })

  it('creates NO entry for a booking that was never confirmed', () => {
    const result = applyBookingFacts({
      facts: facts({ lifecycle: 'unconfirmed' }),
      config: config(),
      existing: null,
      now: NOW,
    })

    expect(result.outcome).toBe('skipped')
  })
})

describe('1 · confirmed creates the entry', () => {
  const result = applyBookingFacts({
    facts: facts(),
    config: config(),
    existing: null,
    now: NOW,
  })

  it('is created, expected, and incomplete without being refused', () => {
    expect(result.outcome).toBe('created')
    if (result.outcome === 'skipped') return

    expect(result.entry.status).toBe('expected')
    expect(result.entry.bookingReference).toBe('BK-2026-0184')
    expect(result.entry.arrivalDate).toBe('2026-03-10')
    // The stay is committed and the guest has no name on the booking yet.
    // The entry is written anyway and says what is outstanding.
    expect(result.missingFields).toContain('primary_guest_name')
  })

  it('does not record an arrival time from a stated intention', () => {
    if (result.outcome === 'skipped') return
    expect(result.entry.arrivalTime).toBeNull()
  })

  it('invents no id', () => {
    if (result.outcome === 'skipped') return
    expect(result.entry.id).toBe('')
  })
})

describe('2 · guest details fill the entry in', () => {
  const created = applyBookingFacts({
    facts: facts(),
    config: config(),
    existing: null,
    now: NOW,
  })

  it('records a name and an address that arrive later', () => {
    if (created.outcome === 'skipped') return
    const existing: GuestBookEntry = { ...created.entry, id: 'e-1', version: 1 }

    const result = applyBookingFacts({
      facts: facts({
        guestName: 'דנה כהן',
        guestAddress: {
          line: 'הרצל 12',
          city: 'חיפה',
          postalCode: null,
          country: null,
        },
      }),
      config: config(),
      existing,
      now: NOW,
    })

    expect(result.outcome).toBe('updated')
    if (result.outcome === 'skipped') return
    expect(result.entry.primaryGuestName).toBe('דנה כהן')
    expect(result.entry.guestAddress?.city).toBe('חיפה')
    expect(result.entry.version).toBe(2)
    expect(result.missingFields).not.toContain('primary_guest_name')
  })

  it('keeps a recorded name when the booking later carries none', () => {
    // The register records what was true at the stay. A booking edited months
    // afterwards does not change who was in the building.
    if (created.outcome === 'skipped') return
    const existing: GuestBookEntry = {
      ...created.entry,
      id: 'e-1',
      primaryGuestName: 'דנה כהן',
      version: 1,
    }

    const result = applyBookingFacts({
      facts: facts({ guestName: null }),
      config: config(),
      existing,
      now: NOW,
    })

    if (result.outcome === 'skipped') return
    expect(result.entry.primaryGuestName).toBe('דנה כהן')
    expect(result.outcome).toBe('unchanged')
  })

  it('reports unchanged rather than bumping a version for nothing', () => {
    if (created.outcome === 'skipped') return
    const existing: GuestBookEntry = { ...created.entry, id: 'e-1', version: 4 }

    const result = applyBookingFacts({
      facts: facts(),
      config: config(),
      existing,
      now: NOW,
    })

    expect(result.outcome).toBe('unchanged')
    if (result.outcome === 'skipped') return
    expect(result.entry.version).toBe(4)
  })
})

describe('3 · arrival records the hour it actually happened', () => {
  it('writes the arrival time and moves the entry to arrived', () => {
    const result = applyBookingFacts({
      facts: facts({
        lifecycle: 'in_house',
        guestName: 'דנה כהן',
        arrivedAt: '15:40',
      }),
      config: config(),
      existing: null,
      now: NOW,
    })

    if (result.outcome === 'skipped') return
    expect(result.entry.status).toBe('arrived')
    expect(result.entry.arrivalTime).toBe('15:40')
  })
})

describe('4 · departure closes the entry', () => {
  it('records the departure and the financial document reference', () => {
    const result = applyBookingFacts({
      facts: facts({
        lifecycle: 'departed',
        guestName: 'דנה כהן',
        arrivedAt: '15:40',
        departedAt: '10:05',
        financialDocumentRef: '2026-000184',
        financialDocumentId: 'inv-1',
      }),
      config: config({
        requiredFields: [
          'booking_reference',
          'property',
          'primary_guest_name',
          'arrival',
          'departure',
          'guest_count',
          'financial_document',
        ],
      }),
      existing: null,
      now: NOW,
    })

    if (result.outcome === 'skipped') return
    expect(result.entry.status).toBe('departed')
    expect(result.entry.departureTime).toBe('10:05')
    expect(result.entry.financialDocumentRef).toBe('2026-000184')
    expect(result.missingFields).toEqual([])
  })
})

describe('a cancelled booking keeps its row', () => {
  it('marks the entry cancelled rather than removing it', () => {
    const result = applyBookingFacts({
      facts: facts({ lifecycle: 'cancelled', guestName: 'דנה כהן' }),
      config: config(),
      existing: null,
      now: NOW,
    })

    if (result.outcome === 'skipped') return
    expect(result.entry.status).toBe('cancelled')
  })
})

describe('missing fields follow the configuration, not a fixed list', () => {
  it('reports an address only when the operator required one', () => {
    const withoutAddress = applyBookingFacts({
      facts: facts({ guestName: 'דנה כהן' }),
      config: config(),
      existing: null,
      now: NOW,
    })
    if (withoutAddress.outcome === 'skipped') return
    expect(withoutAddress.missingFields).not.toContain('guest_address')

    const requiringAddress = applyBookingFacts({
      facts: facts({ guestName: 'דנה כהן' }),
      config: config({
        requiredFields: [
          'booking_reference',
          'property',
          'primary_guest_name',
          'guest_address',
          'arrival',
        ],
      }),
      existing: null,
      now: NOW,
    })
    if (requiringAddress.outcome === 'skipped') return
    expect(requiringAddress.missingFields).toContain('guest_address')
  })

  it('counts a head count of zero as missing', () => {
    const result = applyBookingFacts({
      facts: facts({ guestName: 'דנה כהן', guestCount: 0 }),
      config: config(),
      existing: null,
      now: NOW,
    })
    if (result.outcome === 'skipped') return
    expect(result.missingFields).toContain('guest_count')
  })
})
