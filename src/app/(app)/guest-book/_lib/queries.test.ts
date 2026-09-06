/**
 * The register read, driven the way the screen and the export drive it.
 *
 * The four claims worth making without a database: a missing table becomes a
 * stated gap rather than an empty register; a register that is off is never
 * queried at all; the guest's name is withheld from a reader without
 * `guest.view_name` and the CSV that reader downloads has no names in it; and
 * every read is scoped to the organization.
 *
 * `fake-client.ts` states its own limit and it applies: this cannot prove a
 * column name against Postgres.
 */

import { describe, expect, it } from 'vitest'

import type { Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { FakeSupabaseClient, hasFilter } from '@/lib/persistence/fake-client'

import { guestBookCsv, loadGuestBook, parseGuestBookFilter } from './queries'

const ORG = 'org-1'

function actorWith(grants: readonly Grant[]): Actor {
  return {
    userId: 'user-1',
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set(),
  }
}

const NO_FILTER = parseGuestBookFilter({})

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    property_ids: [],
    required_fields: [
      'booking_reference',
      'property',
      'primary_guest_name',
      'arrival',
      'departure',
      'guest_count',
    ],
    fields_reviewed_at: null,
    fields_reviewed_by: null,
    updated_at: '2026-03-01T09:00:00.000Z',
    ...overrides,
  }
}

function entryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e-1',
    organization_id: ORG,
    property_id: 'prop-1',
    booking_id: 'booking-1',
    booking_reference: 'BK-2026-0184',
    primary_guest_name: 'דנה כהן',
    address_line: null,
    address_city: null,
    address_postal_code: null,
    address_country: null,
    arrival_date: '2026-03-10',
    arrival_time: '15:40',
    departure_date: '2026-03-13',
    departure_time: '10:05',
    guest_count: 2,
    financial_document_ref: '2026-000184',
    financial_document_id: 'inv-1',
    notes: null,
    status: 'departed',
    created_at: '2026-03-01T09:00:00.000Z',
    updated_at: '2026-03-13T10:05:00.000Z',
    version: 3,
    properties: { name: 'סוויטת הגליל' },
    ...overrides,
  }
}

describe('parseGuestBookFilter', () => {
  it('drops a status that is not in the vocabulary rather than refusing', () => {
    expect(parseGuestBookFilter({ status: 'reconciled' }).status).toBeNull()
  })

  it('drops a date that is not a date', () => {
    expect(parseGuestBookFilter({ from: 'last-march' }).from).toBeNull()
    expect(parseGuestBookFilter({ from: '2026-03-01' }).from).toBe('2026-03-01')
  })

  it('takes the first value when a parameter repeats', () => {
    expect(
      parseGuestBookFilter({ status: ['arrived', 'departed'] }).status,
    ).toBe('arrived')
  })
})

describe('when the storage does not exist yet', () => {
  it('reports a gap and names the tables', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        guest_book_settings: {
          error: { code: '42P01', message: 'relation does not exist' },
        },
      },
    })

    const screen = await loadGuestBook(
      client.asDb(),
      actorWith(['guest.view']),
      ORG,
      NO_FILTER,
    )

    expect(screen.state).toBe('not_provisioned')
    if (screen.state !== 'not_provisioned') return
    expect(screen.tables).toContain('guest_book_entries')
  })
})

describe('when the register is off', () => {
  it('never queries the entries at all', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        guest_book_settings: { data: settingsRow({ enabled: false }) },
      },
    })

    const screen = await loadGuestBook(
      client.asDb(),
      actorWith(['guest.view']),
      ORG,
      NO_FILTER,
    )

    if (screen.state !== 'ready') throw new Error('expected ready')
    expect(screen.data.config.enabled).toBe(false)
    expect(screen.data.entries).toEqual([])
    expect(client.queriesFor('guest_book_entries')).toHaveLength(0)
  })

  it('gives an organization with no settings row the OFF default', async () => {
    const client = new FakeSupabaseClient({
      responses: { guest_book_settings: { data: null } },
    })

    const screen = await loadGuestBook(
      client.asDb(),
      actorWith(['guest.view']),
      ORG,
      NO_FILTER,
    )

    if (screen.state !== 'ready') throw new Error('expected ready')
    expect(screen.data.config.enabled).toBe(false)
  })
})

describe('when the register is on', () => {
  async function load(grants: readonly Grant[], filter = NO_FILTER) {
    const client = new FakeSupabaseClient({
      responses: {
        guest_book_settings: { data: settingsRow() },
        guest_book_entries: { data: [entryRow()] },
      },
    })
    const screen = await loadGuestBook(
      client.asDb(),
      actorWith(grants),
      ORG,
      filter,
    )
    return { client, screen }
  }

  it('scopes the read to the organization and pushes the filter into the query', async () => {
    const { client } = await load(
      ['guest.view'],
      parseGuestBookFilter({ status: 'departed', from: '2026-03-01' }),
    )

    const [query] = client.queriesFor('guest_book_entries')
    expect(hasFilter(query, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(query, 'eq', 'status', 'departed')).toBe(true)
    expect(hasFilter(query, 'gte', 'arrival_date', '2026-03-01')).toBe(true)
  })

  it('gives a reader with guest.view_name the name', async () => {
    const { screen } = await load(['guest.view', 'guest.view_name'])
    if (screen.state !== 'ready') throw new Error('expected ready')

    const [entry] = screen.data.entries
    expect(entry.primaryGuestName).toBe('דנה כהן')
    expect(entry.propertyName).toBe('סוויטת הגליל')
    expect(entry.missingFields).toEqual([])
  })

  it('WITHHOLDS the name from a reader without it, absent rather than null', async () => {
    const { screen } = await load(['guest.view'])
    if (screen.state !== 'ready') throw new Error('expected ready')

    const [entry] = screen.data.entries
    // Absent, not null. Null would say the stay had no named guest.
    expect('primaryGuestName' in entry).toBe(false)
  })

  it('exports what the reader may see, and no more', async () => {
    const withName = await load(['guest.view', 'guest.view_name'])
    const withoutName = await load(['guest.view'])
    if (withName.screen.state !== 'ready') throw new Error('expected ready')
    if (withoutName.screen.state !== 'ready') throw new Error('expected ready')

    expect(guestBookCsv(withName.screen.data.entries)).toContain('דנה כהן')
    expect(guestBookCsv(withoutName.screen.data.entries)).not.toContain(
      'דנה כהן',
    )
  })

  it('reports a required field the entry has no value for', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        guest_book_settings: {
          data: settingsRow({
            required_fields: [
              'booking_reference',
              'property',
              'primary_guest_name',
              'guest_address',
              'arrival',
            ],
          }),
        },
        guest_book_entries: { data: [entryRow()] },
      },
    })

    const screen = await loadGuestBook(
      client.asDb(),
      actorWith(['guest.view', 'guest.view_name']),
      ORG,
      NO_FILTER,
    )
    if (screen.state !== 'ready') throw new Error('expected ready')
    expect(screen.data.entries[0].missingFields).toEqual(['guest_address'])
  })

  it('drops a stored field name the vocabulary no longer has', async () => {
    // Otherwise every entry is permanently incomplete against a requirement
    // nothing can satisfy and no screen can name.
    const client = new FakeSupabaseClient({
      responses: {
        guest_book_settings: {
          data: settingsRow({
            required_fields: ['booking_reference', 'passport_scan'],
          }),
        },
        guest_book_entries: { data: [entryRow()] },
      },
    })

    const screen = await loadGuestBook(
      client.asDb(),
      actorWith(['guest.view']),
      ORG,
      NO_FILTER,
    )
    if (screen.state !== 'ready') throw new Error('expected ready')
    expect(screen.data.config.requiredFields).toEqual(['booking_reference'])
  })
})

describe('guestBookCsv', () => {
  it('starts with a byte order mark, so Excel reads Hebrew', () => {
    expect(guestBookCsv([]).startsWith('﻿')).toBe(true)
  })

  it('quotes a value containing a comma rather than splitting the row', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        guest_book_settings: { data: settingsRow() },
        guest_book_entries: {
          data: [entryRow({ notes: 'הגיעו מאוחר, ביקשו מיטה נוספת' })],
        },
      },
    })

    const screen = await loadGuestBook(
      client.asDb(),
      actorWith(['guest.view', 'guest.view_name']),
      ORG,
      NO_FILTER,
    )
    if (screen.state !== 'ready') throw new Error('expected ready')

    const csv = guestBookCsv(screen.data.entries)
    expect(csv).toContain('"הגיעו מאוחר, ביקשו מיטה נוספת"')
    // Header plus one row plus the trailing newline.
    expect(csv.trimEnd().split('\r\n')).toHaveLength(2)
  })
})
