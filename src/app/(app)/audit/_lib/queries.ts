/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the audit trail.
 *
 * ══ THIS IS EVIDENCE, AND IT IS READ ONLY ════════════════════════════════
 *
 * `public.audit_events` has no `version` column, no `updated_at`, and no
 * UPDATE or DELETE privilege for any role — `audit_events_no_update` and
 * `audit_events_no_delete` are statement-level triggers that refuse both, and
 * the privileges are revoked from `service_role` as well. There is
 * deliberately no write path in this file and no action beside it. A trail
 * that can be edited is not evidence of anything, and a screen that offered
 * to would be claiming a capability the database refuses.
 *
 * ── One column that is not a detail ───────────────────────────────────────
 *
 * `on_behalf_of_user_id` is the difference between "an employee decided" and
 * "ESTIA generated it, and a named employee approved". It was missing from the
 * table for six migrations while `AuditActor` already carried it, and when it
 * was added in 0006 the insert policy had to be rewritten in the same
 * migration — because until then any member could write "ESTIA changed the
 * price, and the owner approved it" and the trail would carry a forged
 * signature that read exactly like a real one. `audit_events_insert` now
 * requires `on_behalf_of_user_id is null or = auth.uid()`.
 *
 * So a delegated action is never rendered as an ordinary one here. It is
 * resolved to a named person and labelled as a delegation, because the whole
 * value of the column is that the reader can tell the two apart.
 *
 * ── Why there is no second field gate ─────────────────────────────────────
 *
 * `before` and `after` are arbitrary changed columns, and they can contain a
 * price or a guest's name. It is tempting to strip them for a reader without
 * `booking.view_price` — and it would be theatre, because `summary` is a
 * sentence built by the caller that routinely spells the same figures out in
 * words ("שינה את סכום ההזמנה מ-₪5,200 ל-₪4,700"). Withholding the payload
 * while printing that sentence is a redaction that redacts nothing; the
 * commission `explanation` field taught this codebase that lesson once already.
 *
 * The trail is therefore one disclosure, and `audit.view` is that disclosure —
 * which is what the database itself decided: `audit_events_select` carries
 * `has_permission(organization_id, 'audit.view')` and nothing else. The
 * consequence is written down rather than worked around: `audit.view` is
 * coarse, and a custom role composed with it alone would read prices and guest
 * names inside the diffs. In the shipped role set nobody holds it without
 * holding every field permission.
 */

import type { Actor } from '@/lib/authz/can'
import type { Db } from '@/lib/persistence'
import {
  asJsonRecord,
  asString,
  asStringOrNull,
  asTimestamp,
  toRows,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shape -- */

/** `public.audit_actor_type`, declared in `0005_audit.sql`. */
export const AUDIT_ACTOR_TYPES = [
  'user',
  'system',
  'ai_agent',
  'platform_staff',
] as const

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number]

export type AuditEventItem = {
  id: string
  /** The instant, as stored. Formatted for display only. */
  occurredAt: string
  actorType: string
  /**
   * How the actor was named at the time.
   *
   * Denormalised on the row on purpose — `actor_user_id` is `on delete set
   * null`, so the trail still reads as a sentence about a named human after
   * the account is gone. It is preferred over the current profile name for
   * exactly that reason: the label is what was true when the action happened.
   */
  actorLabel: string
  actorUserId: string | null
  /**
   * A delegated action: who asked for it or approved it.
   *
   * `null` on the ordinary case, and the screen must render the two
   * differently. See the header.
   */
  onBehalfOfUserId: string | null
  /** The delegate's current display name, when the profile is readable. */
  onBehalfOfName: string | null
  /** The permission that authorised it, so event and model stay aligned. */
  action: string
  resourceType: string
  resourceId: string | null
  propertyId: string | null
  propertyName: string | null
  /** The sentence a person reads. Never a restatement of `action`. */
  summary: string
  /** Present when the action demanded a stated justification. */
  reason: string | null
  /** Only the fields that changed. `diffFields` reduced them before the write. */
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  /** Ties every event produced by one request together. */
  requestId: string | null
}

const AUDIT_COLUMNS =
  'id, occurred_at, actor_type, actor_label, actor_user_id, ' +
  'on_behalf_of_user_id, action, resource_type, resource_id, property_id, ' +
  'summary, reason, before, after, request_id'

/**
 * The ceiling on one page.
 *
 * A hundred, the same as the finance lists, and for the same reason: the query
 * stays honest about paging and the screen says out loud when it has hit the
 * ceiling rather than letting the trail quietly stop. On a trail in particular
 * a silently truncated list is worse than elsewhere — the reader concludes the
 * event they are looking for does not exist.
 */
export const AUDIT_PAGE_SIZE = 100

export type ListAuditEventsArgs = {
  db: Db
  actor: Actor
  organizationId: string
  /** A single property, or null for the whole organization. */
  propertyId: string | null
  limit?: number
}

/**
 * The trail, newest first.
 *
 * No `can()` filter per row, deliberately, and this is the one list screen in
 * the product where that is the right answer. Elsewhere a row carries a
 * property and a per-family scope decides whether the reader reaches it. An
 * audit event's `property_id` is nullable and most consequential actions —
 * a role assigned, a member suspended, an integration changed — have no
 * property at all, so filtering by scope would silently drop exactly the
 * events the trail exists for. The reach question is answered once, by
 * `audit.view` at the route and by `audit_events_select` in the database,
 * which is what both of those grants mean: the whole organization's record.
 *
 * The property filter below is the reader's own narrowing from the shell's
 * property switcher, not an authorization decision.
 */
export async function listAuditEvents(
  args: ListAuditEventsArgs,
): Promise<readonly AuditEventItem[]> {
  const { db, organizationId, propertyId } = args

  let query = db
    .from('audit_events')
    .select(AUDIT_COLUMNS)
    .eq('organization_id', organizationId)

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { data, error } = await query
    .order('occurred_at', { ascending: false })
    .limit(args.limit ?? AUDIT_PAGE_SIZE)

  if (error) throw error

  const rows = toRows(data)
  if (rows.length === 0) return []

  const [delegates, properties] = await Promise.all([
    profileNames(
      db,
      rows
        .map((row) => asStringOrNull(row, 'on_behalf_of_user_id'))
        .filter((id): id is string => id !== null),
    ),
    propertyNames(db, organizationId),
  ])

  return rows.map((row) => {
    const onBehalfOfUserId = asStringOrNull(row, 'on_behalf_of_user_id')
    const propertyOfRow = asStringOrNull(row, 'property_id')

    return {
      id: asString(row, 'id'),
      occurredAt: asTimestamp(row, 'occurred_at'),
      actorType: asString(row, 'actor_type'),
      actorLabel: asString(row, 'actor_label'),
      actorUserId: asStringOrNull(row, 'actor_user_id'),
      onBehalfOfUserId,
      onBehalfOfName:
        onBehalfOfUserId === null
          ? null
          : (delegates.get(onBehalfOfUserId) ?? null),
      action: asString(row, 'action'),
      resourceType: asString(row, 'resource_type'),
      // `text`, not `uuid`: an audited thing is not always a row in this
      // database — a payment at the processor, a reservation at a channel.
      resourceId: asStringOrNull(row, 'resource_id'),
      propertyId: propertyOfRow,
      propertyName:
        propertyOfRow === null ? null : (properties.get(propertyOfRow) ?? null),
      summary: asString(row, 'summary'),
      reason: asStringOrNull(row, 'reason'),
      before: jsonOrNull(row, 'before'),
      after: jsonOrNull(row, 'after'),
      requestId: asStringOrNull(row, 'request_id'),
    }
  })
}

/**
 * The delegated events among the ones on screen.
 *
 * Counted and surfaced above the list rather than left to be spotted, because
 * "who approved this" is the question the column exists to answer and a reader
 * scanning eighty rows will not find four of them by eye.
 */
export function delegatedEvents(
  events: readonly AuditEventItem[],
): readonly AuditEventItem[] {
  return events.filter((event) => event.onBehalfOfUserId !== null)
}

/** How many events exist for this organization, before the property narrowing. */
export async function countAuditEvents(
  db: Db,
  organizationId: string,
): Promise<number> {
  const { count, error } = await db
    .from('audit_events')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)

  if (error) throw error
  return count ?? 0
}

/* ------------------------------------------------------------ internals -- */

/**
 * `before` and `after`, or `null`.
 *
 * Both columns are nullable — an event that created something has no `before`
 * — and `null` is rendered as "nothing changed here", which is different from
 * an empty object. `asJsonRecord` refuses anything that is not a plain object,
 * so a malformed value fails loudly rather than reaching a component.
 */
function jsonOrNull(row: Row, column: string): Record<string, unknown> | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  return asJsonRecord(row, column)
}

/**
 * Display names for the people an action was delegated by.
 *
 * `user_profiles_select` admits anybody who shares an organization with the
 * subject. A name that cannot be resolved stays null and the screen says
 * "delegated by a person whose profile is not readable", which is true — the
 * uuid is deliberately not printed in its place.
 */
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

async function propertyNames(
  db: Db,
  organizationId: string,
): Promise<ReadonlyMap<string, string>> {
  const { data, error } = await db
    .from('properties')
    .select('id, name')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    names.set(asString(row, 'id'), asString(row, 'name'))
  }
  return names
}
