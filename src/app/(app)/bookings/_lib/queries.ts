/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the bookings screens.
 *
 * Writes go through `defineBookingOperations` and there is no second path.
 * Reads are different in kind — there is no rule to enforce, no version to
 * check and nothing to audit — so they are plain queries here, and every one
 * of them runs on the request-scoped client under row level security. That is
 * the tenant boundary: `bookings_select` is
 * `organization_id in (select my_organizations())`, so a wrong id in this file
 * returns nothing rather than another business's calendar.
 *
 * ── Two embeds that must not become inner joins ───────────────────────────
 *
 * `guests(full_name)` and `units(name)` are written without `!inner`
 * deliberately, the same way `src/lib/persistence/booking.ts` writes them. An
 * inner embed turns the join into a filter, and a reader holding `booking.view`
 * but not `guest.view` — a cleaner, by design — would then see *no bookings at
 * all* rather than bookings with the name withheld. Losing a name is a privacy
 * rule working; losing the calendar is an outage.
 *
 * The one place an inner join is correct is searching by guest name, and it is
 * used there for precisely that reason: somebody who may not read the name
 * cannot search by it either, and the two queries are unioned so the reference
 * search still works for them.
 */

import { BOOKING_STATUSES, type BookingStatus } from '@/lib/booking'
import {
  asAgorot,
  asIsoDate,
  asNumber,
  asString,
  asStringOrNull,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

import type { BookingFilters } from './filters'

/* ------------------------------------------------------------- the row -- */

/**
 * One line of the list.
 *
 * Deliberately not a `BookingSnapshot`. A snapshot costs two extra round trips
 * per booking — price lines and the held deposit — and the list shows neither.
 * Everything here is a column on the row or a name from an embed; nothing is
 * derived, and nothing is a placeholder.
 */
export type BookingListItem = {
  id: string
  reference: string
  status: BookingStatus
  checkIn: string
  checkOut: string
  /** Null when this reader may not see guest records. Never "אורח". */
  guestName: string | null
  unitId: string
  /** Null when the unit row is not readable. The id is not shown in its place. */
  unitName: string | null
  propertyId: string | null
  totalAgorot: number
  guestCount: number
}

const LIST_COLUMNS =
  'id, reference, status, check_in, check_out, unit_id, property_id, ' +
  'total_agorot, adults, children, infants, guests(full_name), units(name)'

/** An embed comes back as an object or, for some shapes, a one-element array. */
function embeddedField(value: unknown, field: string): string | null {
  const record = Array.isArray(value) ? value[0] : value
  if (typeof record !== 'object' || record === null) return null
  const raw = (record as Record<string, unknown>)[field]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function toListItem(row: Row): BookingListItem {
  return {
    id: asString(row, 'id'),
    reference: asString(row, 'reference'),
    status: readStatus(row),
    checkIn: asIsoDate(row, 'check_in'),
    checkOut: asIsoDate(row, 'check_out'),
    guestName: embeddedField(row.guests, 'full_name'),
    unitId: asString(row, 'unit_id'),
    unitName: embeddedField(row.units, 'name'),
    propertyId: asStringOrNull(row, 'property_id'),
    totalAgorot: asAgorot(row, 'total_agorot'),
    guestCount:
      asNumber(row, 'adults') +
      asNumber(row, 'children') +
      asNumber(row, 'infants'),
  }
}

const STATUS_SET = new Set<string>(BOOKING_STATUSES)

/**
 * A status the enum does not contain would be a migration this build has not
 * seen. Throwing beats rendering a raw value where a Hebrew label belongs.
 */
function readStatus(row: Row): BookingStatus {
  const value = asString(row, 'status')
  if (!STATUS_SET.has(value)) {
    throw new Error(`Unknown booking status from the database: ${value}`)
  }
  return value as BookingStatus
}

/* ------------------------------------------------------------ the list -- */

export type ListBookingsArgs = {
  organizationId: string
  /** A single property, or null for every property in scope. */
  propertyId: string | null
  filters: BookingFilters
  limit?: number
}

/** The ceiling on one page. Chosen so the query stays honest about paging. */
export const BOOKING_PAGE_SIZE = 100

/**
 * The bookings this reader may see, narrowed by the filter.
 *
 * The date filter is an overlap test, not a containment test: a stay that
 * started in August and ends in September belongs in September's list, and a
 * `check_in between` filter would silently drop exactly the bookings a
 * September arrival cares about. Half-open, matching `rangesOverlap`.
 */
export async function listBookings(
  db: Db,
  args: ListBookingsArgs,
): Promise<readonly BookingListItem[]> {
  const search = args.filters.search

  const limit = args.limit ?? BOOKING_PAGE_SIZE

  if (search.length === 0) {
    const { data, error } = await filtered(db, args, LIST_COLUMNS)
      .order('check_in', { ascending: false })
      .limit(limit)

    if (error) throw error
    return toRows(data).map(toListItem)
  }

  // Two queries rather than one `or`, because matching the guest's name means
  // filtering on an embedded table, and PostgREST only lets a filter on an
  // embed narrow the parent when the embed is `!inner`. Making the whole list
  // query inner would hide every booking from a reader without `guest.view`,
  // so the inner join lives here alone and is unioned with the reference
  // match — which is exactly the search that still works for such a reader.
  const pattern = `%${escapeLike(search)}%`

  const [byReference, byGuest] = await Promise.all([
    filtered(db, args, LIST_COLUMNS)
      .ilike('reference', pattern)
      .order('check_in', { ascending: false })
      .limit(limit),
    filtered(
      db,
      args,
      LIST_COLUMNS.replace('guests(full_name)', 'guests!inner(full_name)'),
    )
      .ilike('guests.full_name', pattern)
      .order('check_in', { ascending: false })
      .limit(limit),
  ])

  if (byReference.error) throw byReference.error
  if (byGuest.error) throw byGuest.error

  const merged = new Map<string, BookingListItem>()
  for (const row of [...toRows(byReference.data), ...toRows(byGuest.data)]) {
    const item = toListItem(row)
    merged.set(item.id, item)
  }

  return [...merged.values()]
    .sort((a, b) => b.checkIn.localeCompare(a.checkIn))
    .slice(0, limit)
}

/**
 * `%` and `_` are wildcards in `ilike`. A guest called "100%" must match
 * themselves rather than every guest in the business.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

/**
 * The tenant, property and column filters every variant of the query shares.
 *
 * The query is *built* here rather than passed in, so the builder's type stays
 * inferred from the expression that created it. Taking a builder as a
 * parameter needs a self-referential generic (`T extends Filterable<T>`), which
 * PostgREST's deeply-nested types blow the instantiation depth on — and an
 * `any` in the one function that applies the organization filter is not a
 * trade worth making.
 *
 * `columns` varies so the guest-name search can ask for the same shape with an
 * inner embed. Everything else is identical by construction.
 */
function filtered(db: Db, args: ListBookingsArgs, columns: string) {
  let query = db
    .from('bookings')
    .select(columns)
    .eq('organization_id', args.organizationId)
    .is('deleted_at', null)

  if (args.propertyId !== null) {
    query = query.eq('property_id', args.propertyId)
  }
  if (args.filters.status !== null) {
    query = query.eq('status', args.filters.status)
  }
  // Overlap, half-open: a stay is in the window if it starts before the window
  // ends and ends after the window starts. A `check_in between` filter would
  // silently drop the August stay that runs into September, which is exactly
  // the booking somebody looking at September needs to see.
  if (args.filters.to !== null) {
    query = query.lte('check_in', args.filters.to)
  }
  if (args.filters.from !== null) {
    query = query.gt('check_out', args.filters.from)
  }

  return query
}

/**
 * How many bookings exist for this organization and property, before any
 * filter.
 *
 * This is the number `resolveEmptyReason` needs to tell "you have never made a
 * booking" apart from "your filter hid all four hundred of them". Asked as a
 * `head` count so it costs no rows.
 */
export async function countBookings(
  db: Db,
  organizationId: string,
  propertyId: string | null,
): Promise<number> {
  let query = db
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .is('deleted_at', null)

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { count, error } = await query
  if (error) throw error
  return count ?? 0
}

/* --------------------------------------------------------------- units -- */

/**
 * A unit that can actually be sold, with the money that belongs to it.
 *
 * The prices are columns on `units`. They are read rather than typed by the
 * person creating the booking, because a nightly rate invented in a form is a
 * number nobody can reconcile against the unit's own price list — and because
 * `priceStay` needs a real base rate to produce a real quote.
 */
export type BookableUnit = {
  id: string
  name: string
  code: string
  propertyId: string
  propertyName: string | null
  maxGuests: number
  standardGuests: number
  minNights: number
  baseNightlyAgorot: number
  extraGuestNightlyAgorot: number
  cleaningFeeAgorot: number
  depositAgorot: number
}

export async function listBookableUnits(
  db: Db,
  organizationId: string,
  propertyId: string | null,
): Promise<readonly BookableUnit[]> {
  let query = db
    .from('units')
    .select(
      'id, name, code, property_id, max_guests, standard_guests, min_nights, ' +
        'base_price_agorot, extra_guest_price_agorot, cleaning_fee_agorot, ' +
        'deposit_agorot, properties(name)',
    )
    .eq('organization_id', organizationId)
    // `checkAvailability` refuses a unit that is not active anyway — see
    // `loadRules` — so offering one in the form would be offering a choice the
    // server is guaranteed to reject.
    .eq('status', 'active')
    .is('deleted_at', null)
    .order('sort_order')

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { data, error } = await query
  if (error) throw error

  return toRows(data).map((row) => ({
    id: asString(row, 'id'),
    name: asString(row, 'name'),
    code: asString(row, 'code'),
    propertyId: asString(row, 'property_id'),
    propertyName: embeddedField(row.properties, 'name'),
    maxGuests: asNumber(row, 'max_guests'),
    standardGuests: asNumber(row, 'standard_guests'),
    minNights: asNumber(row, 'min_nights'),
    baseNightlyAgorot: asAgorot(row, 'base_price_agorot'),
    extraGuestNightlyAgorot: asAgorot(row, 'extra_guest_price_agorot'),
    cleaningFeeAgorot: asAgorot(row, 'cleaning_fee_agorot'),
    depositAgorot: asAgorot(row, 'deposit_agorot'),
  }))
}
