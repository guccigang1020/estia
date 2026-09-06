/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the guest register.
 *
 * ── The register is rows, and every row is a stay that happened ───────────
 *
 * There is no count of anything on this screen and no occupancy figure. A
 * register answers one question — who was here, and when — and a summary of it
 * is not an answer to that question.
 *
 * ── Filtering happens in the query, not after it ──────────────────────────
 *
 * The property, the status and the date window are pushed into Postgres. A
 * screen that read the whole register and filtered in memory would work
 * perfectly on a guesthouse's first season and fall over on its fifth, and the
 * page ceiling would silently truncate *before* the filter rather than after —
 * so the person filtering by last March would get whatever fifty rows the
 * database happened to return first.
 *
 * ── Identity is redacted, not merely hidden ──────────────────────────────
 *
 * The guest's name is gated on `guest.view_name` through `redact()`, the same
 * way the action centre gates it, because a register is a list of named people
 * and the grant that governs a name governs it here too. A cleaner with
 * `guest.view` and no `guest.view_name` sees the stays and not the people.
 *
 * ── The tables may not exist yet ──────────────────────────────────────────
 *
 * They are created by a migration this worker does not write. `readProvisioned`
 * turns that one failure into a state the page renders as a `DomainGap`. Every
 * other failure is rethrown.
 */

import { scopeNarrowings } from '@/app/(app)/preparation/_lib/queries'
import {
  can,
  holdsGrant,
  redact,
  scopeFor,
  type Actor,
  type Resource,
} from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { readProvisioned, type Provisioned } from '@/lib/fiscal/provisioning'
import {
  GUEST_BOOK_ENTRY_STATUSES,
  GUEST_BOOK_FIELDS,
  defaultGuestBookConfig,
  missingRequiredFields,
  type GuestAddress,
  type GuestBookConfig,
  type GuestBookEntry,
  type GuestBookEntryStatus,
  type GuestBookField,
} from '@/lib/guest-book'
import {
  asBoolean,
  asDate,
  asDateOrNull,
  asEnum,
  asIsoDate,
  asIsoDateOrNull,
  asNumber,
  asString,
  asStringArray,
  asStringOrNull,
  toRow,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

/** The storage this screen needs, named as a migration would create it. */
export const GUEST_BOOK_TABLES = [
  'guest_book_settings',
  'guest_book_entries',
] as const

/**
 * The ceiling on one page of the register.
 *
 * Higher than a work queue's, because this is a list somebody reads through
 * rather than a list of things to do today. The screen says out loud when it
 * hits the ceiling.
 */
export const GUEST_BOOK_PAGE_SIZE = 100

/* -------------------------------------------------------------- filters -- */

export type GuestBookFilter = {
  propertyId: string | null
  status: GuestBookEntryStatus | null
  /** `YYYY-MM-DD`, inclusive. Compared against the arrival date. */
  from: string | null
  to: string | null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/**
 * The filter, parsed from the query string and refusing anything it does not
 * understand.
 *
 * An unrecognised status becomes `null` — no filter — rather than an error.
 * The alternative is a screen that refuses to render because somebody edited
 * the address bar, and a register that will not open is worse than one showing
 * more rows than was asked for. It is also why the page states the active
 * filter in words: what was applied is visible, so a silently dropped
 * parameter cannot be mistaken for a filtered result.
 */
export function parseGuestBookFilter(
  params: Record<string, string | string[] | undefined>,
): GuestBookFilter {
  const status = firstParam(params.status)
  const from = firstParam(params.from)
  const to = firstParam(params.to)

  return {
    propertyId: firstParam(params.property),
    status: isStatus(status) ? status : null,
    from: from !== null && ISO_DATE.test(from) ? from : null,
    to: to !== null && ISO_DATE.test(to) ? to : null,
  }
}

function isStatus(value: string | null): value is GuestBookEntryStatus {
  if (value === null) return false
  return (GUEST_BOOK_ENTRY_STATUSES as readonly string[]).includes(value)
}

/* ----------------------------------------------------------------- rows -- */

export type GuestBookRow = Omit<GuestBookEntry, 'primaryGuestName'> & {
  /**
   * Optional because `redact()` removes it entirely for a reader without
   * `guest.view_name`. Typed as absent rather than as null on purpose: null
   * would say "this stay had no named guest", which is a different and false
   * statement about a register entry.
   */
  primaryGuestName?: string | null
  /** The property's name, when it is readable. Never the id in its place. */
  propertyName: string | null
  /** Required fields with no value. Reported on the row, never fatal. */
  missingFields: readonly GuestBookField[]
}

export type GuestBookView = {
  config: GuestBookConfig
  entries: readonly GuestBookRow[]
  /** True when the page ceiling cut the list. Stated on screen. */
  truncated: boolean
  filter: GuestBookFilter
}

const ENTRY_COLUMNS =
  'id, organization_id, property_id, booking_id, booking_reference, ' +
  'primary_guest_name, address_line, address_city, address_postal_code, ' +
  'address_country, arrival_date, arrival_time, departure_date, ' +
  'departure_time, guest_count, financial_document_ref, ' +
  'financial_document_id, notes, status, created_at, updated_at, version, ' +
  'properties(name)'

/**
 * Redacted before it reaches the page, not in the component.
 *
 * The name is the only field on a register row that is gated: an entry's dates
 * and head count are what the register is *for*, and withholding them would
 * leave a reader with a list of blank rows. The address is not separately
 * gated because it is only ever collected when an operator turned that field
 * on, and whoever may read the register at all may read what it was configured
 * to hold.
 */
const ENTRY_REDACTIONS = [
  { key: 'primaryGuestName', requires: 'guest.view_name' },
] as const satisfies ReadonlyArray<{ key: keyof GuestBookRow; requires: Grant }>

function resourceFor(organizationId: string, propertyId: string): Resource {
  return { organizationId, propertyId, family: 'guest' }
}

function addressOf(row: Row): GuestAddress | null {
  const line = asStringOrNull(row, 'address_line')
  const city = asStringOrNull(row, 'address_city')
  // An address with neither a line nor a city is not a partly filled address;
  // it is an absent one, and storing three nulls as an object would make
  // `missingRequiredFields` report it as present.
  if (line === null && city === null) return null
  return {
    line: line ?? '',
    city: city ?? '',
    postalCode: asStringOrNull(row, 'address_postal_code'),
    country: asStringOrNull(row, 'address_country'),
  }
}

function embeddedName(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const record = Array.isArray(value) ? value[0] : value
  if (record === null || typeof record !== 'object') return null
  const name = (record as Record<string, unknown>).name
  return typeof name === 'string' ? name : null
}

function toEntry(row: Row): GuestBookEntry {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    bookingId: asString(row, 'booking_id'),
    bookingReference: asString(row, 'booking_reference'),
    primaryGuestName: asStringOrNull(row, 'primary_guest_name'),
    guestAddress: addressOf(row),
    arrivalDate: asIsoDate(row, 'arrival_date'),
    arrivalTime: asStringOrNull(row, 'arrival_time'),
    departureDate: asIsoDateOrNull(row, 'departure_date'),
    departureTime: asStringOrNull(row, 'departure_time'),
    guestCount: asNumber(row, 'guest_count'),
    financialDocumentRef: asStringOrNull(row, 'financial_document_ref'),
    financialDocumentId: asStringOrNull(row, 'financial_document_id'),
    notes: asStringOrNull(row, 'notes'),
    status: asEnum(row, 'status', GUEST_BOOK_ENTRY_STATUSES),
    createdAt: asDate(row, 'created_at'),
    updatedAt: asDate(row, 'updated_at'),
    version: asNumber(row, 'version'),
  }
}

/* ----------------------------------------------------------------- read -- */

async function loadConfig(
  db: Db,
  organizationId: string,
): Promise<GuestBookConfig> {
  const { data, error } = await db
    .from('guest_book_settings')
    .select(
      'enabled, property_ids, required_fields, fields_reviewed_at, ' +
        'fields_reviewed_by, updated_at',
    )
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (error) throw error
  if (data === null) return defaultGuestBookConfig(organizationId)

  const row = toRow(data)
  const stored = asStringArray(row, 'required_fields')
  const known: readonly string[] = GUEST_BOOK_FIELDS

  return {
    organizationId,
    enabled: asBoolean(row, 'enabled'),
    propertyIds: asStringArray(row, 'property_ids'),
    // A stored field name the vocabulary no longer has is dropped rather than
    // carried: it cannot be rendered, cannot be checked, and would make every
    // entry permanently incomplete against a requirement nobody can satisfy.
    requiredFields: stored.filter((field): field is GuestBookField =>
      known.includes(field),
    ),
    fieldsReviewedAt: asDateOrNull(row, 'fields_reviewed_at'),
    fieldsReviewedByUserId: asStringOrNull(row, 'fields_reviewed_by'),
    updatedAt: asDateOrNull(row, 'updated_at'),
  }
}

function narrowings(actor: Actor): ReturnType<typeof scopeNarrowings> {
  return scopeNarrowings(
    actor,
    scopeFor(actor, { organizationId: actor.organizationId, family: 'guest' }),
  )
}

async function loadEntries(
  db: Db,
  actor: Actor,
  organizationId: string,
  filter: GuestBookFilter,
  config: GuestBookConfig,
): Promise<{ entries: readonly GuestBookRow[]; truncated: boolean }> {
  const results = await Promise.all(
    narrowings(actor).map(async (narrowing) => {
      let query = db
        .from('guest_book_entries')
        .select(ENTRY_COLUMNS)
        .eq('organization_id', organizationId)

      if (filter.propertyId !== null) {
        query = query.eq('property_id', filter.propertyId)
      }
      if (filter.status !== null) query = query.eq('status', filter.status)
      if (filter.from !== null) query = query.gte('arrival_date', filter.from)
      if (filter.to !== null) query = query.lte('arrival_date', filter.to)

      if (narrowing.kind === 'in') {
        query = query.in(narrowing.column, [...narrowing.values])
      } else if (narrowing.kind === 'eq') {
        query = query.eq(narrowing.column, narrowing.value)
      }

      const { data, error } = await query
        .order('arrival_date', { ascending: false })
        .limit(GUEST_BOOK_PAGE_SIZE + 1)

      if (error) throw error
      return toRows(data)
    }),
  )

  const merged = new Map<string, Row>()
  for (const row of results.flat()) merged.set(asString(row, 'id'), row)

  const readable = [...merged.values()].filter((row) =>
    can(
      actor,
      'guest.view',
      resourceFor(organizationId, asString(row, 'property_id')),
    ),
  )

  const truncated = readable.length > GUEST_BOOK_PAGE_SIZE

  const entries = readable
    .map((row) => {
      const entry = toEntry(row)
      const full: GuestBookRow = {
        ...entry,
        propertyName: embeddedName(row.properties),
        missingFields: missingRequiredFields(entry, config),
      }
      return redact(
        actor,
        full,
        ENTRY_REDACTIONS,
        resourceFor(organizationId, entry.propertyId),
      )
    })
    .sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate))
    .slice(0, GUEST_BOOK_PAGE_SIZE)

  return { entries, truncated }
}

/**
 * The register, or the statement that its storage is absent.
 *
 * Takes the client rather than constructing one, the way
 * `finance/_lib/queries.ts` does: a read that builds its own Supabase client
 * cannot be driven by the fake or by the demo dataset, and an untestable read
 * is where a wrong column name lives until production.
 */
export async function loadGuestBook(
  db: Db,
  actor: Actor,
  organizationId: string,
  filter: GuestBookFilter,
): Promise<Provisioned<GuestBookView>> {
  return readProvisioned(GUEST_BOOK_TABLES, async () => {
    const config = await loadConfig(db, organizationId)

    // A register that was never turned on has no entries by construction, and
    // querying for them would be a round trip whose only possible answer is
    // none. The page says the capability is off rather than showing an empty
    // list, which would read as "you have had no guests".
    if (!config.enabled || !holdsGrant(actor, 'guest.view')) {
      return { config, entries: [], truncated: false, filter }
    }

    const { entries, truncated } = await loadEntries(
      db,
      actor,
      organizationId,
      filter,
      config,
    )

    return { config, entries, truncated, filter }
  })
}

/* --------------------------------------------------------------- export -- */

/** One CSV cell, with the quoting a Hebrew register actually needs. */
function cell(value: string | number | null): string {
  if (value === null) return ''
  const text = String(value)
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

/**
 * The register as a spreadsheet.
 *
 * A `﻿` byte order mark, because Excel on Windows opens a UTF-8 CSV
 * without one as mojibake and every Hebrew name in the file becomes
 * unreadable. It is the difference between an export that works and one that
 * a business reports as broken.
 *
 * Redaction has already happened by the time rows reach here: a reader without
 * `guest.view_name` exports a file with no names in it, rather than a file the
 * screen would not have shown them.
 */
export function guestBookCsv(entries: readonly GuestBookRow[]): string {
  const header = [
    'אסמכתה',
    'נכס',
    'אורח ראשי',
    'כתובת',
    'עיר',
    'תאריך הגעה',
    'שעת הגעה',
    'תאריך עזיבה',
    'שעת עזיבה',
    'מספר אורחים',
    'אסמכתה חשבונאית',
    'סטטוס',
    'הערות',
  ]

  const lines = entries.map((entry) =>
    [
      cell(entry.bookingReference),
      cell(entry.propertyName),
      cell(entry.primaryGuestName ?? null),
      cell(entry.guestAddress?.line ?? null),
      cell(entry.guestAddress?.city ?? null),
      cell(entry.arrivalDate),
      cell(entry.arrivalTime),
      cell(entry.departureDate),
      cell(entry.departureTime),
      cell(entry.guestCount),
      cell(entry.financialDocumentRef),
      cell(entry.status),
      cell(entry.notes),
    ].join(','),
  )

  return `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`
}
