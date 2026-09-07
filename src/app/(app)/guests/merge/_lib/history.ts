/**
 * EXECUTION CONTEXT — SERVER ONLY. The merges that have happened, and which of
 * them can still be taken back.
 *
 * `guest_merges` is readable by anybody in the organization holding
 * `guest.view` and writable by nobody at all — `0074` grants `authenticated`
 * SELECT and revokes INSERT, UPDATE and DELETE, because the two SECURITY
 * DEFINER functions own every write. So this file reads a record that cannot
 * have been forged and cannot have been tidied up afterwards, which is most of
 * what makes it worth showing.
 *
 * ⚠️ `undoAvailability` answers whether the window is open. It deliberately
 * does NOT answer whether the undo will succeed: that depends on whether any
 * of the moved rows has been edited since, which is a question about rows this
 * query does not read and which `guest_merge_undo` answers by comparing the
 * version it recorded at the moment of each move. The banner therefore offers
 * an undo and the refusal, if it comes, names exactly what changed.
 */

import { holdsGrant, type Actor } from '@/lib/authz/can'
import { undoAvailability, type UndoAvailability } from '@/lib/leads'
import {
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRows,
  type Db,
} from '@/lib/persistence'

export interface MergeHistoryRow {
  id: string
  survivorGuestId: string
  survivorName: string | null
  mergedGuestId: string
  mergedName: string | null
  reason: string
  performedAt: string
  performedByName: string | null
  availability: UndoAvailability
  /** How many rows moved, by table, straight out of `moved`. */
  moved: readonly { table: string; count: number }[]
}

const RECENT = 20

/** The most recent merges. `null` without `guest.view`. */
export async function listRecentMerges(
  db: Db,
  actor: Actor,
  organizationId: string,
  now: Date,
): Promise<readonly MergeHistoryRow[] | null> {
  if (!holdsGrant(actor, 'guest.view')) return null

  const { data, error } = await db
    .from('guest_merges')
    .select(
      'id, survivor_guest_id, merged_guest_id, reason, performed_at, ' +
        'performed_by, undo_deadline, undone_at, moved',
    )
    .eq('organization_id', organizationId)
    .order('performed_at', { ascending: false })
    .limit(RECENT)

  if (error) throw error
  const rows = toRows(data)
  if (rows.length === 0) return []

  const guestIds = new Set<string>()
  const userIds = new Set<string>()
  for (const row of rows) {
    guestIds.add(asString(row, 'survivor_guest_id'))
    guestIds.add(asString(row, 'merged_guest_id'))
    const by = asStringOrNull(row, 'performed_by')
    if (by !== null) userIds.add(by)
  }

  const [names, people] = await Promise.all([
    // Behind `guest.view_name`, like everywhere else. A merge history that
    // names two people is a list of customers, and the grant that governs a
    // guest's name governs it here too.
    holdsGrant(actor, 'guest.view_name')
      ? lookup(db, 'guests', [...guestIds], organizationId)
      : Promise.resolve(new Map<string, string>()),
    holdsGrant(actor, 'user.view')
      ? lookup(db, 'user_profiles', [...userIds], null)
      : Promise.resolve(new Map<string, string>()),
  ])

  return rows.map((row): MergeHistoryRow => {
    const performedBy = asStringOrNull(row, 'performed_by')
    return {
      id: asString(row, 'id'),
      survivorGuestId: asString(row, 'survivor_guest_id'),
      survivorName: names.get(asString(row, 'survivor_guest_id')) ?? null,
      mergedGuestId: asString(row, 'merged_guest_id'),
      mergedName: names.get(asString(row, 'merged_guest_id')) ?? null,
      reason: asString(row, 'reason'),
      performedAt: asTimestamp(row, 'performed_at'),
      performedByName:
        performedBy === null ? null : (people.get(performedBy) ?? null),
      availability: undoAvailability(
        {
          id: asString(row, 'id'),
          survivorGuestId: asString(row, 'survivor_guest_id'),
          mergedGuestId: asString(row, 'merged_guest_id'),
          performedAt: asTimestamp(row, 'performed_at'),
          undoDeadline: asTimestamp(row, 'undo_deadline'),
          undoneAt: asTimestampOrNull(row, 'undone_at'),
        },
        now,
      ),
      moved: summariseMoved(row.moved),
    }
  })
}

/**
 * `{"bookings":[…],"guests":[…]}` reduced to counts.
 *
 * `guests` is dropped: its entries are the two profiles themselves and any
 * chained pointer, which is bookkeeping rather than "what moved", and counting
 * it beside "4 bookings" would read as four other people.
 */
function summariseMoved(
  value: unknown,
): readonly { table: string; count: number }[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value as Record<string, unknown>)
    .filter(([table]) => table !== 'guests')
    .map(([table, rows]) => ({
      table,
      count: Array.isArray(rows) ? rows.length : 0,
    }))
    .filter((entry) => entry.count > 0)
}

async function lookup(
  db: Db,
  table: 'guests' | 'user_profiles',
  ids: readonly string[],
  organizationId: string | null,
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map()

  let query = db
    .from(table)
    .select('id, full_name')
    .in('id', [...ids])
  if (organizationId !== null) {
    query = query.eq('organization_id', organizationId)
  }

  const { data, error } = await query
  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}

/** Hebrew for the table names in `moved`. */
export const MOVED_TABLE_LABEL: Record<string, string> = {
  bookings: 'הזמנות',
  conversations: 'שיחות',
  guest_messages: 'הודעות שנשלחו',
  guest_reviews: 'ביקורות',
  leads: 'פניות',
  store_orders: 'הזמנות חנות',
}
