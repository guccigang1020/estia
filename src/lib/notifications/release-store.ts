/**
 * EXECUTION CONTEXT — SERVER ONLY. The two reads and one write the delivery
 * sweep needs, over `notification_deliveries`.
 *
 * ══ WHAT THIS FILE IS ═══════════════════════════════════════════════════════
 *
 * `release.ts` decides. This fetches and writes. Not one gate is re-stated
 * here: no staleness bound, no preference resolution, no quiet-hours
 * arithmetic. A store that made a decision would be a second opinion about
 * whether somebody may be woken at 03:00, and the failure mode of two opinions
 * about silence is a message neither layer thinks it dropped.
 *
 * It is a separate file from `repository.ts` for the reason `release.ts` gives
 * about its own port: a sweep that could reach `insertNotification` is a sweep
 * that could invent a notification. `DeliveryReleaseStore` is two methods
 * wide, and this class implements those two and nothing else. `repository.ts`
 * is the module's general adapter and is unchanged.
 *
 * ══ `.eq('status', from)` IS THE WHOLE SAFETY PROPERTY ══════════════════════
 *
 * `transitionDelivery` issues
 *
 *     update notification_deliveries
 *        set … where id = ? and organization_id = ? and status = ?
 *
 * and reports whether exactly one row came back. That predicate is not
 * defensive tidiness — it IS the claim that two overlapping sweeps cannot both
 * send. A slow pass still running when the next one fires, or two instances of
 * the same process, both plan `attempt` for the same row; both issue the
 * conditional update; Postgres serialises them; the second matches zero rows,
 * is told `false`, and moves on having sent nothing.
 *
 * Delete the `.eq('status', from)` and every one of those turns into a
 * colleague paged twice at three in the morning and a guest billed twice —
 * with nothing in the code that looks wrong, because the JavaScript above it
 * would still read as a careful two-phase claim. There is no advisory lock and
 * no queue table behind this; the row's own status is the lock, exactly as
 * `dispatch.ts` argues about `notifications.dedupe_key`. `release-store.test.ts`
 * asserts the predicate is in the statement rather than trusting this comment.
 *
 * ══ THE `organization_id` FILTER IS THE TENANT BOUNDARY HERE ════════════════
 *
 * Every method takes an `organizationId` and puts it in the statement. That is
 * not belt-and-braces on top of row level security, as it is in
 * `repository.ts` — the sweep runs with NO USER and is therefore handed the
 * ADMIN client, which bypasses every policy in `0004_rls.sql` including
 * `organization_id in (select public.my_organizations())`.
 *
 * So under the sweep there is no policy underneath these queries. The filter in
 * each statement is the only thing standing between one guesthouse's deferred
 * alerts and another's. A forgotten `.eq('organization_id', …)` here is not a
 * missing optimisation; it is a cross-tenant read, and under `transitionDelivery`
 * a cross-tenant WRITE. Nothing in this file may query without it.
 *
 * ── Why the whole notification is not read ────────────────────────────────
 *
 * The select names seven columns of the parent row and no others.
 * `DueDelivery` is a projection for exactly this reason: a sweep has business
 * with who, which category, how loud and what to say, and no business at all
 * with `required_grant`, `dedupe_key` or the read/dismissed timestamps. A
 * `select('*')` here would let a future rule reach for a field this pass should
 * never have loaded.
 */

import {
  asDate,
  asEnum,
  asString,
  asStringOrNull,
  type Db,
  type Row,
} from '../persistence'

import type {
  DeliveryPatch,
  DeliveryReleaseStore,
  DueDelivery,
} from './release'
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_SEVERITIES,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationDeliveryStatus,
  type NotificationSeverity,
} from './types'

/* --------------------------------------------------------------- columns -- */

/**
 * The delivery, and the seven fields of its notification the gates need.
 *
 * `notifications!inner(…)` is an embedded resource rather than a second query:
 * `notification_deliveries.notification_id` has exactly one foreign key to
 * `notifications`, so PostgREST resolves the relationship without a hint, and
 * one round trip per pass beats one per row. `!inner` matters — a delivery
 * whose parent is unreadable is a row this sweep cannot judge, and dropping it
 * is better than releasing it against a half-known notification.
 */
const DUE_COLUMNS =
  'id, organization_id, notification_id, channel, scheduled_for, ' +
  'notifications!inner(recipient_user_id, category, severity, title, body, ' +
  'action_href, correlation_id)'

/**
 * The embedded parent, whichever shape PostgREST hands back.
 *
 * A to-one embed comes back as an object, but the wire format is not something
 * this file can prove, and supabase-js is untyped in the generics slot here on
 * purpose (see `persistence/client.ts`). Accepting a one-element array as well
 * costs three lines and removes a class of runtime break that would only ever
 * appear in production, where the sweep runs and the unit suite does not.
 */
function embedded(row: Row, key: string): Row {
  const value = row[key]
  const first = Array.isArray(value) ? value[0] : value

  if (typeof first !== 'object' || first === null) {
    throw new Error(`Expected an embedded ${key} row on the delivery`)
  }
  return first as Row
}

/**
 * One due row, as `release.ts` reads it.
 *
 * `scheduled_for` is mapped with `asDate` and not `asDateOrNull` because the
 * query filters on `status = 'deferred'` and
 * `notification_deliveries_deferred_has_time` refuses a deferral without one.
 * A null here would mean the constraint is gone, and failing loudly at the
 * mapping boundary is better than a staleness calculation against `NaN`.
 */
function dueFromRow(row: Row): DueDelivery {
  const notification = embedded(row, 'notifications')

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    notificationId: asString(row, 'notification_id'),
    channel: asEnum<NotificationChannel>(row, 'channel', NOTIFICATION_CHANNELS),
    scheduledFor: asDate(row, 'scheduled_for'),
    recipientUserId: asString(notification, 'recipient_user_id'),
    category: asEnum<NotificationCategory>(
      notification,
      'category',
      NOTIFICATION_CATEGORIES,
    ),
    severity: asEnum<NotificationSeverity>(
      notification,
      'severity',
      NOTIFICATION_SEVERITIES,
    ),
    title: asString(notification, 'title'),
    body: asString(notification, 'body'),
    actionHref: asStringOrNull(notification, 'action_href'),
    correlationId: asStringOrNull(notification, 'correlation_id'),
  }
}

/** What a release may change, as columns. */
function patchColumns(patch: DeliveryPatch): Record<string, unknown> {
  return {
    status: patch.status,
    provider: patch.provider,
    provider_message_id: patch.providerMessageId,
    error_code: patch.errorCode,
    error_detail: patch.errorDetail,
    suppressed_reason: patch.suppressedReason,
    attempted_at: patch.attemptedAt?.toISOString() ?? null,
    settled_at: patch.settledAt?.toISOString() ?? null,
    // `scheduled_for` is deliberately absent. It records when the deferral
    // said the row became sendable, a released row is the same delivery
    // happening later, and 0043 has no constraint forbidding a settled row
    // from carrying one — so clearing it would destroy the only evidence of
    // how late the sweep was, to tidy a column nothing complains about.
  }
}

/* --------------------------------------------------------------- adapter -- */

export class SupabaseDeliveryReleaseStore implements DeliveryReleaseStore {
  constructor(private readonly db: Db) {}

  /**
   * Deferred rows whose time has passed, oldest first, at most `limit`.
   *
   * The filters are `(organization_id, scheduled_for)` plus a status the
   * partial index covers, which is `notification_deliveries_due_idx` exactly.
   * Ordering by `scheduled_for` ascending is the index's own order and is also
   * the fair one: the alert that has waited longest goes first, so a backlog
   * bigger than `limit` drains in the order it formed rather than starving its
   * oldest rows on every pass.
   */
  async listDueDeliveries(args: {
    organizationId: string
    dueBefore: Date
    limit: number
  }): Promise<readonly DueDelivery[]> {
    const { organizationId, dueBefore, limit } = args

    // A pass with no room does no work and asks the database nothing. Guarded
    // here because PostgREST reads `limit(0)` as an unbounded request, which
    // would turn a caller's off-by-one into a full-table scan.
    if (limit <= 0) return []

    const { data, error } = await this.db
      .from('notification_deliveries')
      .select(DUE_COLUMNS)
      // The tenant boundary. See the header — under the admin client this
      // filter is the only one there is.
      .eq('organization_id', organizationId)
      .eq('status', 'deferred')
      .lte('scheduled_for', dueBefore.toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(limit)

    if (error) throw error
    return toRowList(data).map(dueFromRow)
  }

  /**
   * Move one row, and only if it is still where the caller thinks it is.
   *
   * `false` is the ordinary outcome of two overlapping sweeps, not a failure —
   * so it is returned rather than thrown, and the runner counts it as `lost`.
   *
   * The row count is read from the returned representation rather than from a
   * `count` option: `.select('id')` asks PostgREST for the rows the statement
   * actually touched, and `id` alone travels because a sweep has no reason to
   * pull a title back over the wire to learn that one row changed.
   */
  async transitionDelivery(args: {
    organizationId: string
    deliveryId: string
    from: NotificationDeliveryStatus
    patch: DeliveryPatch
  }): Promise<boolean> {
    const { organizationId, deliveryId, from, patch } = args

    const { data, error } = await this.db
      .from('notification_deliveries')
      .update(patchColumns(patch))
      .eq('organization_id', organizationId)
      .eq('id', deliveryId)
      // ── THE SAFETY PROPERTY. Do not remove. See the header. ──────────────
      // Without this predicate two concurrent sweeps both claim the same row
      // and the recipient is paged twice.
      .eq('status', from)
      .select('id')

    if (error) throw error

    // Exactly one, not "at least one". `id` is the primary key and the filter
    // names it, so two rows would mean the statement matched something this
    // file cannot explain — and a sweep that shrugged at that would be a sweep
    // that silently mass-updated a tenant.
    return toRowList(data).length === 1
  }
}

/**
 * PostgREST's `data`, as rows.
 *
 * `toRows` from `../persistence` would do, and is not used: it throws on a
 * shape it does not recognise, and an embedded resource makes each row a
 * nested object rather than the flat one that helper is written for. This
 * narrows without asserting, so a malformed answer fails inside `dueFromRow`
 * with the column name in the message.
 */
function toRowList(data: unknown): Row[] {
  if (data === null || data === undefined) return []
  if (!Array.isArray(data)) {
    throw new Error('Expected a list of rows from notification_deliveries')
  }
  return data.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Expected a row object from notification_deliveries')
    }
    return entry as Row
  })
}
