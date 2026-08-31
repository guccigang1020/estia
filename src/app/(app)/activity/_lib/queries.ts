/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the activity screen.
 *
 * ── There are two records of what happened, and they are not the same ─────
 *
 * **`audit_events`** is the product's own trail. It is written by
 * `SupabaseAuditWriter` as operations run, it carries `actor_label` so a row
 * still reads as a sentence about a named human after the account is deleted,
 * and its foreign key to `organizations` is `on delete restrict` precisely so
 * that closing an account cannot erase what was done inside it. It is the
 * authoritative answer and it is gated on `audit.view`.
 *
 * **`booking_status_history`** is the booking domain's own append-only log of
 * transitions, written by a trigger together with the status change so that a
 * move and its reason are recorded together or not at all. It is not an audit
 * trail — it knows nothing about sign-ins, exports or settings changes — but
 * every row in it is a real thing a real person did to a real booking, and it
 * is gated on `booking.view`.
 *
 * The screen shows both and labels every row with which one it came from. That
 * labelling is the whole point: merging them into one undifferentiated "feed"
 * would let a reader treat a status change as an audited event, and the two
 * have different guarantees about completeness and different retention.
 *
 * ── What is deliberately never rendered ───────────────────────────────────
 *
 * `audit_events.before` and `audit_events.after` are `jsonb` snapshots of a row
 * as it was and as it became. They can contain any column of any table — a
 * payer's name, a guest's passport number, an invitation's token hash — and
 * there is no field rule that could be written over an open-ended shape.
 * `AUDIT_COLUMNS` therefore does not ask for them. `summary` is the sentence
 * the writer composed for a human to read and is what the screen shows; `reason`
 * is the stated justification where the action required one. Both are `not
 * null`-checked text written for this purpose.
 *
 * ── Empty is a fact here, not a failure ───────────────────────────────────
 *
 * `DEMO_DATASET` carries `audit_events: []` on purpose, and `dataset.ts` says
 * why: seeding it would be seeding the output of the code paths the demo exists
 * to exercise, and an audit trail nobody performed is the one kind of fiction a
 * product like this must never ship. So the screen states that the trail is
 * empty and that the product writes it as it runs — which is different from a
 * failed query, and different again from a reader who may not see it.
 */

import { scopeNarrowings } from '@/app/(app)/preparation/_lib/queries'
import {
  can,
  holdsGrant,
  scopeFor,
  type Actor,
  type Resource,
} from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { BOOKING_STATUSES, type BookingStatus } from '@/lib/booking/types'
import { localDate } from '@/lib/booking/dates'
import {
  asEnum,
  asEnumOrNull,
  asString,
  asStringOrNull,
  asTimestamp,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shared -- */

/** The ceiling on one page. The screen says out loud when it hits it. */
export const ACTIVITY_PAGE_SIZE = 50

/**
 * Either of these opens the screen.
 *
 * Ordered least-privileged first. It lives here rather than beside
 * `requireActivityAccess` because `access.ts` imports the route guard, which
 * imports the Supabase server client, which reads `@/lib/env` at module load —
 * so a test importing the tuple from there would need a Supabase project to
 * exist. `access.ts` imports it from here, and the door and the panels
 * therefore cannot disagree about which grants are in play.
 */
export const ACTIVITY_GRANTS: readonly [Grant, ...Grant[]] = [
  'booking.view',
  'audit.view',
]

export type ActivityArgs = {
  db: Db
  actor: Actor
  organizationId: string
  /** A single property, or null for every property in scope. */
  propertyId: string | null
  limit?: number
}

/**
 * Which record a row came from.
 *
 * Rendered on every row. `audit` is the trail the product writes and keeps;
 * `booking_status` is the booking domain's transition log, which is complete
 * about bookings and silent about everything else.
 */
export type ActivitySource = 'audit' | 'booking_status'

export type ActivityEntry = {
  id: string
  source: ActivitySource
  /** The instant, kept so two rows on the same day still order correctly. */
  occurredAt: string
  /** The property-local day it happened on. Never a UTC slice. */
  occurredOn: string
  /**
   * Who did it, as a name.
   *
   * For an audit row this is `actor_label`, captured at write time and
   * deliberately surviving the account — that is what makes the trail readable
   * after somebody leaves. For a status change it is the profile's `full_name`,
   * and null when the profile is not readable or the account is gone. A null
   * renders as "משתמש שאינו זמין" and never as a uuid.
   */
  actorLabel: string | null
  /** `user`, `system`, `agent` … from `audit_actor_type`. Null for a status row. */
  actorType: string | null
  /** The sentence a human reads. Always present, never composed here. */
  summary: string
  /** Why, when the action required a stated reason. Often null. */
  reason: string | null
  /** Which table the event is about. `bookings` for a status change. */
  resourceType: string
  resourceId: string | null
  propertyId: string | null
  /** Set on a status row: the transition itself, for a badge pair. */
  fromStatus?: BookingStatus | null
  toStatus?: BookingStatus
  /** Set on a status row: the booking's own reference, when readable. */
  bookingReference?: string | null
}

function auditResource(
  organizationId: string,
  propertyId: string | null,
): Resource {
  const resource: Resource = { organizationId }
  if (propertyId !== null) resource.propertyId = propertyId
  return resource
}

/* ---------------------------------------------------------------- audit -- */

/**
 * `before` and `after` are absent from this list, and that is the point.
 *
 * See the header. They are open-ended snapshots of arbitrary rows and no field
 * rule can be written over them, so they are not fetched rather than fetched
 * and hidden — a column that never leaves the database cannot leak through a
 * log line, a cache or a serialisation this file does not control.
 *
 * `ip` and `user_agent` are absent for the same reason in a different
 * direction: they are personal data about the *actor*, they answer no question
 * this screen asks, and a colleague's home IP address is not something a
 * manager needs on a feed.
 */
const AUDIT_COLUMNS =
  'id, actor_user_id, actor_type, actor_label, action, resource_type, ' +
  'resource_id, property_id, summary, reason, occurred_at'

/**
 * The audit trail, newest first.
 *
 * `null` — not an empty array — when the reader does not hold `audit.view`.
 * `audit_events_select` carries the same grant, so the query could not succeed
 * anyway, and "there is no recorded activity" is a very different sentence from
 * "you may not read the trail".
 */
export async function listAuditEvents(
  args: ActivityArgs,
): Promise<readonly ActivityEntry[] | null> {
  const { db, actor, organizationId, propertyId } = args
  const limit = args.limit ?? ACTIVITY_PAGE_SIZE

  if (!holdsGrant(actor, 'audit.view')) return null

  let query = db
    .from('audit_events')
    .select(AUDIT_COLUMNS)
    .eq('organization_id', organizationId)

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { data, error } = await query
    .order('occurred_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  return toRows(data)
    .filter((row) =>
      can(
        actor,
        'audit.view',
        auditResource(organizationId, asStringOrNull(row, 'property_id')),
      ),
    )
    .map((row): ActivityEntry => {
      const occurredAt = asTimestamp(row, 'occurred_at')
      return {
        id: asString(row, 'id'),
        source: 'audit',
        occurredAt,
        occurredOn: localDate(new Date(occurredAt)),
        // `audit_events_actor_label_not_blank` guarantees this is a real
        // string, so it is read as one rather than defended against.
        actorLabel: asString(row, 'actor_label'),
        actorType: asStringOrNull(row, 'actor_type'),
        summary: asString(row, 'summary'),
        reason: asStringOrNull(row, 'reason'),
        resourceType: asString(row, 'resource_type'),
        resourceId: asStringOrNull(row, 'resource_id'),
        propertyId: asStringOrNull(row, 'property_id'),
      }
    })
}

/* ------------------------------------------------------- status history -- */

const HISTORY_COLUMNS =
  'id, booking_id, property_id, from_status, to_status, changed_by, reason, ' +
  'occurred_at'

/**
 * Booking transitions, newest first.
 *
 * `null` without `booking.view`, for the same reason as above. The membership's
 * scope is pushed into the query on `property_id` — the history row carries
 * one, denormalised through the composite foreign key, so a property-scoped
 * manager never reads another property's transitions — and every row is checked
 * again with `can()`.
 *
 * The summary is composed here rather than stored, and that is the one place
 * this file writes a sentence. It is a transcription of two enum values into
 * the Hebrew names `BOOKING_STATUS_LABEL` already gives them, done in the page
 * rather than here: this returns `fromStatus` and `toStatus` and lets the
 * screen render the badges the rest of the product uses for a booking status.
 * `summary` on such a row is the booking's reference, which is the thing a
 * person recognises.
 */
export async function listBookingTransitions(
  args: ActivityArgs,
): Promise<readonly ActivityEntry[] | null> {
  const { db, actor, organizationId, propertyId } = args
  const limit = args.limit ?? ACTIVITY_PAGE_SIZE

  if (!holdsGrant(actor, 'booking.view')) return null

  const narrowings = scopeNarrowings(
    actor,
    scopeFor(actor, { organizationId, family: 'booking' }),
  )

  const results = await Promise.all(
    narrowings.map(async (narrowing) => {
      let query = db
        .from('booking_status_history')
        .select(HISTORY_COLUMNS)
        .eq('organization_id', organizationId)

      if (propertyId !== null) query = query.eq('property_id', propertyId)
      // `own_records` narrows on `assigned_to_user_id` / `created_by`, and this
      // table carries neither — it carries `changed_by`. A narrowing that names
      // a column the table does not have would be a query error rather than a
      // refusal, so an unmatched narrowing reaches nothing instead.
      if (narrowing.kind === 'in' && narrowing.column === 'property_id') {
        query = query.in(narrowing.column, [...narrowing.values])
      } else if (narrowing.kind !== 'none') {
        return [] as Row[]
      }

      const { data, error } = await query
        .order('occurred_at', { ascending: false })
        .limit(limit)

      if (error) throw error
      return toRows(data)
    }),
  )

  const merged = new Map<string, Row>()
  for (const row of results.flat()) merged.set(asString(row, 'id'), row)

  const rows = [...merged.values()].filter((row) =>
    can(actor, 'booking.view', {
      organizationId,
      propertyId: asString(row, 'property_id'),
      family: 'booking',
    }),
  )

  const [references, names] = await Promise.all([
    bookingReferences(
      db,
      organizationId,
      rows.map((row) => asString(row, 'booking_id')),
    ),
    profileNames(
      db,
      holdsGrant(actor, 'user.view')
        ? rows
            .map((row) => asStringOrNull(row, 'changed_by'))
            .filter((id): id is string => id !== null)
        : [],
    ),
  ])

  return rows.map((row): ActivityEntry => {
    const occurredAt = asTimestamp(row, 'occurred_at')
    const bookingId = asString(row, 'booking_id')
    const changedBy = asStringOrNull(row, 'changed_by')
    const reference = references.get(bookingId) ?? null

    return {
      id: asString(row, 'id'),
      source: 'booking_status',
      occurredAt,
      occurredOn: localDate(new Date(occurredAt)),
      actorLabel: changedBy === null ? null : (names.get(changedBy) ?? null),
      actorType: null,
      // The reference, not a composed sentence. The screen renders the two
      // statuses as the badges the rest of the product uses for them.
      summary: reference ?? bookingId,
      reason: asStringOrNull(row, 'reason'),
      resourceType: 'bookings',
      resourceId: bookingId,
      propertyId: asString(row, 'property_id'),
      fromStatus: asEnumOrNull(row, 'from_status', BOOKING_STATUSES),
      toStatus: asEnum(row, 'to_status', BOOKING_STATUSES),
      bookingReference: reference,
    }
  })
}

/* ---------------------------------------------------------------- merge -- */

/**
 * The two records, in one list, newest first.
 *
 * `null` from either source means "withheld" and is dropped from the merge
 * rather than treated as empty — the screen states each refusal separately
 * above the list, so a reader is never left to infer that nothing happened.
 */
export function mergeActivity(
  sources: readonly (readonly ActivityEntry[] | null)[],
  limit = ACTIVITY_PAGE_SIZE,
): readonly ActivityEntry[] {
  return sources
    .filter((entries): entries is readonly ActivityEntry[] => entries !== null)
    .flat()
    .sort((a, b) => {
      const byTime = b.occurredAt.localeCompare(a.occurredAt)
      // A stable tie-break, so two events written in the same transaction do
      // not reorder between renders.
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id)
    })
    .slice(0, limit)
}

/** The entries grouped by the property-local day they happened on. */
export function byDay(
  entries: readonly ActivityEntry[],
): readonly { day: string; entries: readonly ActivityEntry[] }[] {
  const days = new Map<string, ActivityEntry[]>()
  for (const entry of entries) {
    const existing = days.get(entry.occurredOn)
    if (existing) existing.push(entry)
    else days.set(entry.occurredOn, [entry])
  }
  return [...days.entries()].map(([day, group]) => ({ day, entries: group }))
}

/* ------------------------------------------------------------ internals -- */

/**
 * Booking references for the transitions on screen, in one query.
 *
 * Only ever asked for ids that appeared on a history row this reader was
 * already admitted to, and `bookings_select` refuses anything else. A reference
 * that does not come back leaves the row labelled by its booking id, which is
 * not pretty and is true.
 */
async function bookingReferences(
  db: Db,
  organizationId: string,
  bookingIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(bookingIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('bookings')
    .select('id, reference')
    .eq('organization_id', organizationId)
    .in('id', unique)

  if (error) throw error

  const references = new Map<string, string>()
  for (const row of toRows(data)) {
    references.set(asString(row, 'id'), asString(row, 'reference'))
  }
  return references
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
