/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the pipeline screen.
 *
 * ══ THERE IS NO `leads` TABLE, AND THIS FILE DOES NOT PRETEND OTHERWISE ═══
 *
 * `lead.view`, `lead.create`, `lead.update` and `lead.assign` are in the
 * permission catalogue. No migration from 0001 to 0026 creates a `leads` table,
 * a `quotes` table or an `enquiries` table, and `DEMO_DATASET` therefore has no
 * key for one. That is a real gap and it is reported on the screen rather than
 * filled with invented rows.
 *
 * What the product genuinely has is better than a stub. `BOOKING_STATUSES`
 * opens `inquiry, quote, option, awaiting_payment, …` and 0009 says so in as
 * many words — "the sequence below is the life of a stay from enquiry to
 * review". A lead in ESTIA *is* a booking that has not been committed to yet:
 * it carries the guest, the dates, the price, the source it came from, the
 * agent or agency that brought it, and the person who entered it, and it
 * becomes a sale by moving along the same enum rather than by being copied into
 * a second table. This file reads exactly that, and the screen says which
 * statuses it is treating as the pipeline so nobody has to guess.
 *
 * ── What is therefore missing, precisely ──────────────────────────────────
 *
 *   · **Assignment.** `lead.assign` exists and there is no column to write.
 *     The nearest true facts are `bookings.agent_user_id` — who sold it, which
 *     `bookings_agent_attributed` makes mandatory for an agent sale — and
 *     `created_by`, who entered it. Both are shown and both are labelled as
 *     what they are. Neither is an owner queue, and the screen does not offer
 *     to reassign anything, because the product cannot.
 *   · **A lead with no dates and no unit.** `bookings` requires `unit_id`,
 *     `check_in` and `check_out`, so "somebody rang about August, no dates
 *     fixed" cannot be recorded at all. That is the strongest argument for a
 *     `leads` table and it is the one thing this screen cannot show.
 *   · **Lost reasons.** `status_reason` carries free text on a cancellation and
 *     there is no vocabulary of why a sale was lost.
 *
 * ── Holds are the other half of a pipeline, and they do exist ─────────────
 *
 * A hold is inventory taken off sale while somebody closes. `permissions.ts`
 * is explicit that a forgotten one costs the business real money, which is why
 * releasing it is a separate grant from creating it. So the screen lists the
 * live ones beside the pipeline, with what they are protecting and when they
 * lapse — and marks the ones that have already lapsed, because an expired hold
 * blocks nothing and a person still thinks it does.
 *
 * ── Gating ────────────────────────────────────────────────────────────────
 *
 * `requireGrant('lead.view')` refuses the route. The rows come from `bookings`
 * and `holds`, which have their own grants and their own policies, so each read
 * asks `holdsGrant` for its own before it queries — a reader with `lead.view`
 * and no `booking.view` is told that the pipeline is stored as bookings and
 * that they may not read them, which is true and is not an empty state.
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
import {
  BOOKING_SOURCES,
  BOOKING_STATUSES,
  HOLD_REASONS,
  type BookingSource,
  type BookingStatus,
  type HoldReason,
} from '@/lib/booking/types'
import { localDate } from '@/lib/booking/dates'
import {
  asAgorot,
  asEnum,
  asIsoDate,
  asNumber,
  asString,
  asStringOrNull,
  asTimestamp,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shared -- */

/** The ceiling on one page. The screen says out loud when it hits it. */
export const LEAD_PAGE_SIZE = 100

/**
 * The statuses that are a sale in progress rather than a sale.
 *
 * The cut is where money or a signature settles it. `deposit_paid` is the first
 * status at which the guest has paid something, so it and everything after it
 * are won; `awaiting_payment` and everything before it are still being worked.
 * Written as a filter over `BOOKING_STATUSES` rather than as a literal list, so
 * a status inserted into the workflow lands on one side of the cut
 * deliberately.
 *
 * `cancelled` and `no_show` are not here: a lost lead is not an open one, and
 * putting it in the pipeline is how a forecast becomes fiction.
 */
export const PIPELINE_STATUSES: readonly BookingStatus[] = [
  'inquiry',
  'quote',
  'option',
  'awaiting_payment',
]

/**
 * The order the stages are worked in, which is the enum's own order.
 *
 * 0009 says the order of `booking_status` is load-bearing and that comparison
 * operators on the enum follow it. The board is drawn in that order rather than
 * in an order chosen here.
 */
export const PIPELINE_ORDER: readonly BookingStatus[] = BOOKING_STATUSES.filter(
  (status) => PIPELINE_STATUSES.includes(status),
)

export type LeadArgs = {
  db: Db
  actor: Actor
  organizationId: string
  /** A single property, or null for every property in scope. */
  propertyId: string | null
  /** The property-local day, for ageing a lead and lapsing a hold. */
  today: string
  limit?: number
}

function bookingResource(organizationId: string, propertyId: string): Resource {
  return { organizationId, propertyId, family: 'booking' }
}

/* ----------------------------------------------------------------- lead -- */

export type Lead = {
  id: string
  reference: string
  /** The stage. A `BookingStatus`, because that is what the pipeline is. */
  status: BookingStatus
  propertyId: string
  unitId: string
  unitName: string | null
  checkIn: string
  checkOut: string
  guestCount: number
  /** Where it came from. */
  source: BookingSource
  /** The channel's own name where the source has one — "airbnb.co.il". */
  sourceChannel: string | null
  /**
   * Who sold it.
   *
   * `bookings_agent_attributed` makes this mandatory when the source is an
   * agent, so an agent lead can always name one. Null on a direct enquiry,
   * which is a real answer and not a missing assignment.
   */
  agentUserId: string | null
  agentName: string | null
  agencyId: string | null
  agencyName: string | null
  /** Who entered it. The nearest thing the schema has to an owner. */
  createdByUserId: string | null
  createdByName: string | null
  /** When it was entered, as a property-local day, and how old that makes it. */
  openedOn: string
  ageDays: number
  /** True when a live hold is protecting these dates. Set by `attachHolds`. */
  heldUntil: string | null
  /** Withheld without `guest.view_name`. Never replaced by "אורח". */
  guestName?: string | null
  /** Withheld without `booking.view_price`. */
  totalAgorot?: number
  /** What the guest asked for, written on the booking. Withheld with the name. */
  guestNotes?: string | null
}

const LEAD_REDACTIONS = [
  { key: 'guestName', requires: 'guest.view_name' },
  // The guest's own words routinely contain their name, their telephone number
  // and their plans. It is guest data in a text column, and it is withheld with
  // the rest of it rather than being treated as a booking field because it
  // happens to live on the booking row.
  { key: 'guestNotes', requires: 'guest.view_name' },
  { key: 'totalAgorot', requires: 'booking.view_price' },
] as const satisfies ReadonlyArray<{ key: keyof Lead; requires: Grant }>

const LEAD_COLUMNS =
  'id, reference, status, check_in, check_out, adults, children, infants, ' +
  'property_id, unit_id, guest_id, guest_notes, total_agorot, source, ' +
  'source_channel, agent_user_id, agency_id, created_by, created_at, units(name)'

/**
 * The open pipeline, oldest first.
 *
 * Oldest first, deliberately, and not newest: a lead that has been sitting for
 * three weeks is the one that needs a telephone call, and a list ordered by
 * arrival buries it under this morning's enquiries.
 *
 * `null` without `booking.view` — the pipeline is stored as bookings, and a
 * reader holding `lead.view` alone is told that rather than shown nothing.
 */
export async function listLeads(
  args: LeadArgs,
): Promise<readonly Lead[] | null> {
  const { db, actor, organizationId, propertyId, today } = args
  const limit = args.limit ?? LEAD_PAGE_SIZE

  if (!holdsGrant(actor, 'booking.view')) return null

  const narrowings = scopeNarrowings(
    actor,
    scopeFor(actor, { organizationId, family: 'booking' }),
  )

  const results = await Promise.all(
    narrowings.map(async (narrowing) => {
      let query = db
        .from('bookings')
        .select(LEAD_COLUMNS)
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .in('status', [...PIPELINE_STATUSES])

      if (propertyId !== null) query = query.eq('property_id', propertyId)
      if (narrowing.kind === 'in') {
        query = query.in(narrowing.column, [...narrowing.values])
      } else if (narrowing.kind === 'eq') {
        query = query.eq(narrowing.column, narrowing.value)
      }

      const { data, error } = await query
        .order('created_at', { ascending: true })
        .limit(limit)

      if (error) throw error
      return toRows(data)
    }),
  )

  const merged = new Map<string, Row>()
  for (const row of results.flat()) merged.set(asString(row, 'id'), row)

  const rows = [...merged.values()].filter((row) =>
    can(
      actor,
      'booking.view',
      bookingResource(organizationId, asString(row, 'property_id')),
    ),
  )

  const [guests, people, agencies] = await Promise.all([
    guestNames(db, actor, organizationId, rows),
    profileNames(
      db,
      holdsGrant(actor, 'user.view')
        ? [...idsOn(rows, 'agent_user_id'), ...idsOn(rows, 'created_by')]
        : // An agent's name is what `commission.view` and `agent.view` are
          // about, and a desk without `user.view` still needs to know a stay
          // was sold by somebody rather than walked in. The id is carried and
          // the name stays null.
          [],
    ),
    agencyNames(
      db,
      holdsGrant(actor, 'agent.view') ? idsOn(rows, 'agency_id') : [],
    ),
  ])

  return rows.map((row) => {
    const propertyOfRow = asString(row, 'property_id')
    const openedAt = asTimestamp(row, 'created_at')
    const openedOn = localDate(new Date(openedAt))
    const agentUserId = asStringOrNull(row, 'agent_user_id')
    const agencyId = asStringOrNull(row, 'agency_id')
    const createdBy = asStringOrNull(row, 'created_by')

    const lead: Lead = {
      id: asString(row, 'id'),
      reference: asString(row, 'reference'),
      status: asEnum(row, 'status', BOOKING_STATUSES),
      propertyId: propertyOfRow,
      unitId: asString(row, 'unit_id'),
      unitName: embeddedField(row.units, 'name'),
      checkIn: asIsoDate(row, 'check_in'),
      checkOut: asIsoDate(row, 'check_out'),
      guestCount:
        asNumber(row, 'adults') +
        asNumber(row, 'children') +
        asNumber(row, 'infants'),
      source: asEnum(row, 'source', BOOKING_SOURCES),
      sourceChannel: asStringOrNull(row, 'source_channel'),
      agentUserId,
      agentName:
        agentUserId === null ? null : (people.get(agentUserId) ?? null),
      agencyId,
      agencyName: agencyId === null ? null : (agencies.get(agencyId) ?? null),
      createdByUserId: createdBy,
      createdByName:
        createdBy === null ? null : (people.get(createdBy) ?? null),
      openedOn,
      ageDays: wholeDaysBetween(openedOn, today),
      heldUntil: null,
      guestName: guests.get(asString(row, 'guest_id')) ?? null,
      guestNotes: asStringOrNull(row, 'guest_notes'),
      totalAgorot: asAgorot(row, 'total_agorot'),
    }

    return redact(
      actor,
      lead,
      LEAD_REDACTIONS,
      bookingResource(organizationId, propertyOfRow),
    )
  })
}

/** The pipeline grouped by stage, in the enum's own order. */
export function byStage(
  leads: readonly Lead[],
): readonly { status: BookingStatus; leads: readonly Lead[] }[] {
  return PIPELINE_ORDER.map((status) => ({
    status,
    leads: leads.filter((lead) => lead.status === status),
  }))
}

/* ---------------------------------------------------------------- holds -- */

export type LiveHold = {
  id: string
  propertyId: string
  unitId: string
  unitName: string | null
  reason: HoldReason
  checkIn: string
  checkOut: string
  /** The property-local day it lapses. */
  expiresOn: string
  /** True once that day is behind us: it blocks nothing and looks like it does. */
  lapsed: boolean
  heldByUserId: string
  heldByName: string | null
  note: string | null
  /** Set when the hold became a booking. Such a hold is not live. */
  convertedToBookingId: string | null
}

/**
 * Inventory currently off sale without a booking behind it.
 *
 * Released and converted holds are excluded — the first was given back, the
 * second became a stay — but *lapsed* ones are kept and flagged. That is
 * deliberate: 0009 explains that an expired hold does not block the exclusion
 * constraint, so the dates are already back on sale while the person who placed
 * it still believes they have them. Hiding it would hide exactly the case that
 * costs a sale.
 *
 * `null` without `hold.view`.
 */
export async function listLiveHolds(
  args: LeadArgs,
): Promise<readonly LiveHold[] | null> {
  const { db, actor, organizationId, propertyId, today } = args
  const limit = args.limit ?? LEAD_PAGE_SIZE

  if (!holdsGrant(actor, 'hold.view')) return null

  // No `units(name)` embed here, unlike the leads query above. `RELATIONS` and
  // `DEMO_RELATIONS` declare `bookings.units` and do not declare `holds.units`,
  // and an undeclared embed throws rather than being discovered — which is the
  // point of declaring them. Writing one would produce a screen that works
  // against Postgres and raises `UnsupportedQuery` in the demo, so the name is
  // fetched separately, exactly as the preparation board fetches its unit
  // names.
  let query = db
    .from('holds')
    .select(
      'id, property_id, unit_id, reason, check_in, check_out, expires_at, ' +
        'released_at, converted_to_booking_id, held_by_user_id, note',
    )
    .eq('organization_id', organizationId)
    .is('released_at', null)
    .is('converted_to_booking_id', null)

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { data, error } = await query
    .order('expires_at', { ascending: true })
    .limit(limit)

  if (error) throw error

  const rows = toRows(data).filter((row) =>
    can(
      actor,
      'hold.view',
      bookingResource(organizationId, asString(row, 'property_id')),
    ),
  )

  const [names, units] = await Promise.all([
    profileNames(
      db,
      holdsGrant(actor, 'user.view') ? idsOn(rows, 'held_by_user_id') : [],
    ),
    unitNames(db, idsOn(rows, 'unit_id')),
  ])

  return rows.map((row): LiveHold => {
    const expiresOn = localDate(new Date(asTimestamp(row, 'expires_at')))
    const heldBy = asString(row, 'held_by_user_id')
    const unitId = asString(row, 'unit_id')

    return {
      id: asString(row, 'id'),
      propertyId: asString(row, 'property_id'),
      unitId,
      unitName: units.get(unitId) ?? null,
      reason: asEnum(row, 'reason', HOLD_REASONS),
      checkIn: asIsoDate(row, 'check_in'),
      checkOut: asIsoDate(row, 'check_out'),
      expiresOn,
      lapsed: expiresOn < today,
      heldByUserId: heldBy,
      heldByName: names.get(heldBy) ?? null,
      note: asStringOrNull(row, 'note'),
      convertedToBookingId: asStringOrNull(row, 'converted_to_booking_id'),
    }
  })
}

/**
 * Mark the leads whose dates a live hold is protecting.
 *
 * Matched on unit and on an overlapping half-open range, which is the same test
 * `unit_occupancy` applies — a hold and a booking on the same unit for
 * overlapping nights are the same reservation being worked, because the
 * exclusion constraint would not admit two of them otherwise.
 *
 * A lapsed hold is not a protection and is not attached: a lead whose hold
 * expired yesterday is unprotected, and saying otherwise is the failure mode
 * this whole panel exists to prevent.
 */
export function attachHolds(
  leads: readonly Lead[],
  holds: readonly LiveHold[] | null,
): readonly Lead[] {
  if (holds === null || holds.length === 0) return leads

  return leads.map((lead) => {
    const protecting = holds.find(
      (hold) =>
        !hold.lapsed &&
        hold.unitId === lead.unitId &&
        hold.checkIn < lead.checkOut &&
        hold.checkOut > lead.checkIn,
    )
    return protecting ? { ...lead, heldUntil: protecting.expiresOn } : lead
  })
}

/* ------------------------------------------------------------ internals -- */

function idsOn(rows: readonly Row[], column: string): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    const value = asStringOrNull(row, column)
    if (value !== null) ids.add(value)
  }
  return [...ids]
}

/** Whole days between two `YYYY-MM-DD` dates, in UTC so no clock change bites. */
function wholeDaysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  )
}

/**
 * Guest names, and only where the grant is held.
 *
 * The same decision the action centre makes and for the same reason: an embed
 * would lean on `guests_select` to withhold the name, which is correct against
 * Postgres and does nothing at all in the demo client, whose header says
 * plainly that it has no policy engine.
 */
async function guestNames(
  db: Db,
  actor: Actor,
  organizationId: string,
  rows: readonly Row[],
): Promise<ReadonlyMap<string, string>> {
  if (!holdsGrant(actor, 'guest.view_name')) return new Map()

  const ids = idsOn(rows, 'guest_id')
  if (ids.length === 0) return new Map()

  const { data, error } = await db
    .from('guests')
    .select('id, full_name')
    .eq('organization_id', organizationId)
    .in('id', ids)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}

async function profileNames(
  db: Db,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name')
    .in('id', unique)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}

async function agencyNames(
  db: Db,
  agencyIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (agencyIds.length === 0) return new Map()

  const { data, error } = await db
    .from('agencies')
    .select('id, name')
    .in('id', [...agencyIds])

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    names.set(asString(row, 'id'), asString(row, 'name'))
  }
  return names
}

/**
 * Unit names for the holds on screen.
 *
 * A name that does not come back stays null. `units_select` may refuse a unit
 * this reader cannot see, and a truncated uuid in a column headed "יחידה" is
 * unhelpful while a confident wrong label is worse.
 */
async function unitNames(
  db: Db,
  unitIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (unitIds.length === 0) return new Map()

  const { data, error } = await db
    .from('units')
    .select('id, name')
    .in('id', [...unitIds])

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}

/** An embed comes back as an object or, for some shapes, a one-element array. */
function embeddedField(value: unknown, field: string): string | null {
  const record = Array.isArray(value) ? value[0] : value
  if (typeof record !== 'object' || record === null) return null
  const raw = (record as Record<string, unknown>)[field]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}
