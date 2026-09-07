/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of `public.leads`.
 *
 * ══ WHY THIS SITS BESIDE `queries.ts` RATHER THAN REPLACING IT ══════════════
 *
 * `queries.ts` reads pre-commit `bookings` and its header says, honestly, that
 * there was no `leads` table and what that cost — "somebody rang about August,
 * no dates fixed" could not be written down at all, because `bookings`
 * requires a unit and two dates. `0074_leads_and_guest_merges.sql` created the
 * table. It did NOT migrate those bookings into it, and this file is the other
 * half of that decision.
 *
 * Two different things are being counted and both are real:
 *
 *     a lead     an enquiry. There is no stay. Nothing is held, nothing is
 *                priced, and the unit may not have been chosen.
 *     a booking  in `inquiry`/`quote`/`option` — a stay being opened. A unit
 *                and dates exist; the money has not settled.
 *
 * Copying today's pre-commit bookings into `leads` would invent an enquiry
 * nobody recorded and give every one of those stays two rows in the funnel.
 *
 * 🔒 **So the screen de-duplicates instead.** `convertedBookingIds` below reads
 * every `leads.booking_id` in range, and the pipeline panel drops those
 * bookings: a stay that is a lead's outcome is shown once, as that outcome.
 * `src/lib/revenue/stays.ts` already keeps `inquiry`/`quote`/`option` out of
 * occupancy for the same reason, and nothing here restates its list.
 *
 * ══ AN ENQUIRY THAT NAMES NO PROPERTY ═══════════════════════════════════════
 *
 * ⚠️ Worth reading before assuming this is a bug.
 *
 * `leads_select` in 0074 admits a row whose `property_id` is null to anybody in
 * the organization holding `lead.view`, because an enquiry that names no
 * property is the ordinary case and dropping it would hide most of the table.
 * `can()` cannot say the same thing: `scopeReaches` refuses a resource with no
 * `propertyId` under a `properties` scope, deliberately and by default.
 *
 * Rather than route around `can()` — which would be a screen quietly widening
 * an authorization decision — the two are reconciled the strict way: a reader
 * whose lead scope is not organization-wide is not shown property-less
 * enquiries, **and the screen says so**, so a property manager who is missing
 * the queue knows to ask rather than assuming it is empty. The product fix is
 * to give the enquiry a property, which is one field.
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
  LEAD_LOST_REASONS,
  LEAD_SOURCES,
  LEAD_STATUSES,
  OPEN_LEAD_STATUSES,
  type LeadLostReason,
  type LeadSource,
  type LeadStatus,
} from '@/lib/leads'
import {
  asEnum,
  asEnumOrNull,
  asIsoDateOrNull,
  asNumber,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

export const ENQUIRY_PAGE_SIZE = 100

export type Enquiry = {
  id: string
  status: LeadStatus
  source: LeadSource
  sourceDetail: string | null
  propertyId: string | null
  guestId: string | null
  requestedCheckIn: string | null
  requestedCheckOut: string | null
  partySize: number
  budgetAgorot: number | null
  assignedToUserId: string | null
  assignedToName: string | null
  createdByUserId: string | null
  nextActionAt: string | null
  firstResponseAt: string | null
  statusChangedAt: string
  createdAt: string
  /** Days since it arrived, so "nobody has touched this for three weeks" is visible. */
  ageDays: number
  lostReason: LeadLostReason | null
  bookingId: string | null
  version: number
  /** Withheld without `guest.view_name`. Never replaced by "אורח". */
  rawName?: string | null
  /** Withheld without `guest.view_phone`. */
  rawPhone?: string | null
  /** Withheld without `guest.view_email`. */
  rawEmail?: string | null
  /**
   * What the person wrote.
   *
   * Withheld with the name rather than shown, exactly as `queries.ts` withholds
   * `guest_notes`: a guest's own words routinely contain their name, their
   * telephone number and their plans, and it is guest data in a text column
   * whichever table it sits in.
   */
  message?: string | null
}

const ENQUIRY_REDACTIONS = [
  { key: 'rawName', requires: 'guest.view_name' },
  { key: 'message', requires: 'guest.view_name' },
  { key: 'rawPhone', requires: 'guest.view_phone' },
  { key: 'rawEmail', requires: 'guest.view_email' },
] as const satisfies ReadonlyArray<{ key: keyof Enquiry; requires: Grant }>

const COLUMNS =
  'id, status, source, source_detail, property_id, guest_id, raw_name, ' +
  'raw_phone, raw_email, requested_check_in, requested_check_out, ' +
  'party_adults, party_children, party_infants, budget_agorot, message, ' +
  'assigned_to_user_id, created_by, next_action_at, first_response_at, ' +
  'status_changed_at, lost_reason, booking_id, created_at, version'

export type EnquiryArgs = {
  db: Db
  actor: Actor
  organizationId: string
  /** A single property, or null for every property in scope. */
  propertyId: string | null
  /** The property-local day, for ageing an enquiry. */
  today: string
  /** Closed and converted enquiries are excluded unless this is true. */
  includeSettled?: boolean
  limit?: number
}

function leadResource(
  organizationId: string,
  row: Row,
  propertyId: string | null,
): Resource {
  return {
    organizationId,
    // `undefined`, not `null`: `Resource.propertyId` is optional and a scope
    // narrowing reads its absence, not a null.
    propertyId: propertyId ?? undefined,
    assignedToUserId: asStringOrNull(row, 'assigned_to_user_id') ?? undefined,
    createdByUserId: asStringOrNull(row, 'created_by') ?? undefined,
    family: 'booking',
  }
}

/** True when this reader's lead scope reaches the whole organization. */
export function seesUnassignedEnquiries(
  actor: Actor,
  organizationId: string,
): boolean {
  if (actor.isPlatformStaff) return true
  return (
    scopeFor(actor, { organizationId, family: 'booking' }).kind ===
    'all_organization'
  )
}

/**
 * The open pipeline, oldest first.
 *
 * Oldest first and not newest, for the same reason `queries.ts` orders that
 * way: the enquiry that has been sitting for three weeks is the one that needs
 * a telephone call, and a list ordered by arrival buries it under this
 * morning's.
 */
export async function listEnquiries(
  args: EnquiryArgs,
): Promise<readonly Enquiry[]> {
  const { db, actor, organizationId, propertyId, today } = args
  const limit = args.limit ?? ENQUIRY_PAGE_SIZE

  const narrowings = scopeNarrowings(
    actor,
    scopeFor(actor, { organizationId, family: 'booking' }),
  )

  const results = await Promise.all(
    narrowings.map(async (narrowing) => {
      let query = db
        .from('leads')
        .select(COLUMNS)
        .eq('organization_id', organizationId)
        .is('deleted_at', null)

      if (!args.includeSettled) {
        query = query.in('status', [...OPEN_LEAD_STATUSES])
      }
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

  // `own_records` produces two narrowings — assigned to me, entered by me —
  // and a lead can satisfy both. Keyed by id so it appears once.
  const merged = new Map<string, Row>()
  for (const row of results.flat()) merged.set(asString(row, 'id'), row)

  const rows = [...merged.values()].filter((row) => {
    const rowProperty = asStringOrNull(row, 'property_id')
    // See the header: an enquiry with no property is shown only where the
    // reader's scope reaches the whole organization, because `can()` treats an
    // absent property under a `properties` scope as out of reach — and the
    // strict reading is the one this codebase takes everywhere else.
    if (rowProperty === null) {
      return seesUnassignedEnquiries(actor, organizationId)
    }
    return can(
      actor,
      'lead.view',
      leadResource(organizationId, row, rowProperty),
    )
  })

  const names = await profileNames(
    db,
    holdsGrant(actor, 'user.view')
      ? [
          ...new Set(
            rows
              .map((row) => asStringOrNull(row, 'assigned_to_user_id'))
              .filter((id): id is string => id !== null),
          ),
        ]
      : [],
  )

  return rows.map((row) => {
    const rowProperty = asStringOrNull(row, 'property_id')
    const createdAt = asTimestamp(row, 'created_at')
    const assignee = asStringOrNull(row, 'assigned_to_user_id')

    const enquiry: Enquiry = {
      id: asString(row, 'id'),
      status: asEnum(row, 'status', LEAD_STATUSES),
      source: asEnum(row, 'source', LEAD_SOURCES),
      sourceDetail: asStringOrNull(row, 'source_detail'),
      propertyId: rowProperty,
      guestId: asStringOrNull(row, 'guest_id'),
      requestedCheckIn: asIsoDateOrNull(row, 'requested_check_in'),
      requestedCheckOut: asIsoDateOrNull(row, 'requested_check_out'),
      // Infants are not counted, matching `{{אורחים}}` in §9.2 of the
      // specification — a cot is not a bed and the figure is used to pick one.
      partySize:
        asNumber(row, 'party_adults') + asNumber(row, 'party_children'),
      budgetAgorot: numberOrNull(row, 'budget_agorot'),
      assignedToUserId: assignee,
      assignedToName: assignee === null ? null : (names.get(assignee) ?? null),
      createdByUserId: asStringOrNull(row, 'created_by'),
      nextActionAt: asTimestampOrNull(row, 'next_action_at'),
      firstResponseAt: asTimestampOrNull(row, 'first_response_at'),
      statusChangedAt: asTimestamp(row, 'status_changed_at'),
      createdAt,
      ageDays: wholeDaysBetween(createdAt.slice(0, 10), today),
      lostReason: asEnumOrNull(row, 'lost_reason', LEAD_LOST_REASONS),
      bookingId: asStringOrNull(row, 'booking_id'),
      version: asNumber(row, 'version'),
      rawName: asStringOrNull(row, 'raw_name'),
      rawPhone: asStringOrNull(row, 'raw_phone'),
      rawEmail: asStringOrNull(row, 'raw_email'),
      message: asStringOrNull(row, 'message'),
    }

    return redact(
      actor,
      enquiry,
      ENQUIRY_REDACTIONS,
      leadResource(organizationId, row, rowProperty),
    )
  })
}

/**
 * The bookings that are already accounted for as an enquiry's outcome.
 *
 * Read separately and cheaply — one column, no scope narrowing — because it is
 * used to REMOVE rows from a list the reader has already been authorised to
 * see. Filtering something out never needs the grant that would let somebody
 * see it.
 */
export async function convertedBookingIds(
  db: Db,
  organizationId: string,
): Promise<ReadonlySet<string>> {
  const { data, error } = await db
    .from('leads')
    .select('booking_id')
    .eq('organization_id', organizationId)
    .not('booking_id', 'is', null)

  if (error) throw error

  const ids = new Set<string>()
  for (const row of toRows(data)) {
    const id = asStringOrNull(row, 'booking_id')
    if (id !== null) ids.add(id)
  }
  return ids
}

/** Grouped by stage, in the enum's own order. Empty stages are kept. */
export function byLeadStage(
  enquiries: readonly Enquiry[],
): readonly { status: LeadStatus; enquiries: readonly Enquiry[] }[] {
  return OPEN_LEAD_STATUSES.map((status) => ({
    status,
    enquiries: enquiries.filter((enquiry) => enquiry.status === status),
  }))
}

/* ------------------------------------------------------------ internals -- */

function numberOrNull(row: Row, column: string): number | null {
  const raw = row[column]
  return typeof raw === 'number' ? raw : null
}

/** Whole days between two `YYYY-MM-DD` dates, in UTC so no clock change bites. */
function wholeDaysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  )
}

async function profileNames(
  db: Db,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (userIds.length === 0) return new Map()

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name')
    .in('id', [...userIds])

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}
