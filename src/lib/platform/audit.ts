/**
 * EXECUTION CONTEXT — SERVER ONLY. The platform's own trail.
 *
 * ══ ONE TABLE, NOT TWO ════════════════════════════════════════════════════
 *
 * A platform action against a customer is written into THAT CUSTOMER'S
 * `audit_events`, signed `actor_type = 'platform_staff'`. The consequence is
 * the reason for the choice: the customer sees it. It appears in their own
 * audit screen, beside their own employees' rows, labelled as ESTIA — and a
 * separate platform-only table would have been the version where somebody at
 * ESTIA suspends an account and the customer's trail says nothing happened.
 *
 * "Separate from any customer's" is then a filter rather than a second table,
 * and the database enforces the filter rather than this query:
 * `audit_events_platform_select` (0041) admits a platform staff member to rows
 * where `actor_type = 'platform_staff'` and to no others. The `.eq()` below is
 * the second statement of the same rule — remove it and the result set does
 * not change, because the policy has already decided.
 *
 * ── What this cannot show ─────────────────────────────────────────────────
 *
 * A customer's own actions. Not because they are filtered out here, but
 * because no policy in this database returns them to a caller who is not a
 * member of that organization and does not hold `audit.view` there. The
 * console can prove what ESTIA did. It cannot read what a customer's staff
 * did, and that asymmetry is deliberate.
 */

import type { Db, Row } from '@/lib/persistence'
import {
  asJsonRecord,
  asString,
  asStringOrNull,
  asTimestamp,
  toRows,
} from '@/lib/persistence'

/** How many rows one page of the platform trail carries. */
export const PLATFORM_AUDIT_PAGE_SIZE = 100

export interface PlatformAuditEvent {
  id: string
  occurredAt: string
  organizationId: string
  /** Filled in from `organizations` when the row is readable; else the id. */
  organizationName: string
  actorLabel: string
  actorUserId: string | null
  action: string
  resourceType: string
  resourceId: string | null
  summary: string
  reason: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

/**
 * What ESTIA did, newest first, across every customer.
 *
 * `organizationId` is optional: passing it narrows the trail to one account,
 * which is what the account screen shows, and omitting it is the console-wide
 * view. Both are the same query with the same policy behind it.
 */
export async function listPlatformAuditEvents(
  db: Db,
  options: { organizationId?: string } = {},
): Promise<readonly PlatformAuditEvent[]> {
  let query = db
    .from('audit_events')
    .select(
      'id, occurred_at, organization_id, actor_label, actor_user_id, action, ' +
        'resource_type, resource_id, summary, reason, before, after',
    )
    .eq('actor_type', 'platform_staff')
    .order('occurred_at', { ascending: false })
    .limit(PLATFORM_AUDIT_PAGE_SIZE)

  if (options.organizationId) {
    query = query.eq('organization_id', options.organizationId)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const rows = toRows(data)
  const names = await organizationNames(
    db,
    rows.map((row) => asString(row, 'organization_id')),
  )

  return rows.map((row) => toEvent(row, names))
}

function toEvent(row: Row, names: Map<string, string>): PlatformAuditEvent {
  const organizationId = asString(row, 'organization_id')

  return {
    id: asString(row, 'id'),
    occurredAt: asTimestamp(row, 'occurred_at'),
    organizationId,
    // The id, never a placeholder. "ארגון לא ידוע" beside an action ESTIA took
    // is the one line in this table nobody could act on.
    organizationName: names.get(organizationId) ?? organizationId,
    actorLabel: asString(row, 'actor_label'),
    actorUserId: asStringOrNull(row, 'actor_user_id'),
    action: asString(row, 'action'),
    resourceType: asString(row, 'resource_type'),
    resourceId: asStringOrNull(row, 'resource_id'),
    summary: asString(row, 'summary'),
    reason: asStringOrNull(row, 'reason'),
    before: row['before'] === null ? null : asJsonRecord(row, 'before'),
    after: row['after'] === null ? null : asJsonRecord(row, 'after'),
  }
}

async function organizationNames(
  db: Db,
  organizationIds: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const unique = [...new Set(organizationIds)]
  if (unique.length === 0) return result

  const { data, error } = await db
    .from('organizations')
    .select('id, name')
    .in('id', unique)

  if (error) return result

  for (const row of toRows(data)) {
    result.set(asString(row, 'id'), asString(row, 'name'))
  }

  return result
}
