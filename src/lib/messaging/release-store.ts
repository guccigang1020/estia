/**
 * EXECUTION CONTEXT — SERVER ONLY. The one read and one write the guest
 * message sweep needs, over `guest_messages`.
 *
 * ══ WHAT THIS FILE IS ═══════════════════════════════════════════════════════
 *
 * `release.ts` decides. This fetches and writes. Not one gate is re-stated
 * here: no staleness bound, no consent check, no quiet-hours arithmetic. A
 * store that made a decision would be a second opinion about whether a guest
 * may be messaged at midnight, and the failure mode of two opinions about
 * silence is a message neither layer thinks it dropped.
 *
 * It is a separate file from `repository.ts` for the reason `release.ts` gives
 * about its own port: a sweep that could reach `recordGuestMessage` is a sweep
 * that could compose a new message to a guest. `GuestMessageReleaseStore` is
 * two methods wide, and this class implements those two and nothing else.
 *
 * ══ `.eq('outcome', from)` IS THE WHOLE SAFETY PROPERTY ═════════════════════
 *
 * `transitionGuestMessage` issues
 *
 *     update guest_messages
 *        set … where id = ? and organization_id = ? and outcome = ?
 *
 * and reports whether exactly one row came back. That predicate is not
 * defensive tidiness — it IS the claim that two overlapping sweeps cannot both
 * send. Both plan `attempt` for the same row, both issue the conditional
 * update, Postgres serialises them, and the second matches zero rows, is told
 * `false`, and moves on having sent nothing.
 *
 * Delete the `.eq('outcome', from)` and every one of those becomes a guest who
 * gets the same payment reminder twice — with nothing in the code that looks
 * wrong, because the JavaScript above it would still read as a careful
 * two-phase claim. There is no advisory lock behind this; the row's own
 * outcome is the lock, the same argument `repository.ts` makes about
 * `guest_messages_dedupe_key`. `release-store.test.ts` asserts the predicate is
 * in the statement rather than trusting this comment.
 *
 * ══ EVERY TRANSITION OUT OF `deferred` MUST NULL `scheduled_for` ════════════
 *
 * `guest_messages_scheduled_only_when_deferred` refuses any row that is not
 * `deferred` and still carries a time. `GuestMessagePatch.scheduledFor` is
 * typed `null` rather than `Date | null` so the typechecker says so first, and
 * the column is written explicitly below rather than left out of the update —
 * an omitted column keeps its old value, so a patch that merely failed to
 * mention it would be refused by the database on every single row.
 *
 * ══ THE `organization_id` FILTER IS THE TENANT BOUNDARY HERE ════════════════
 *
 * Every method takes an `organizationId` and puts it in the statement. That is
 * not belt-and-braces on top of row level security, as it is in
 * `repository.ts` — the sweep runs with NO USER, and `guest_messages`'s update
 * policy asks `has_permission(…, 'message.send')`, which no sweep holds. So it
 * is handed the ADMIN client, and under the admin client there is no policy
 * underneath these queries at all. The filter in each statement is the only
 * thing between one guesthouse's held messages and another's; forgetting it is
 * a cross-tenant read, and under `transitionGuestMessage` a cross-tenant WRITE.
 *
 * ══ A MISSING TABLE SOFTENS THE READ AND FAILS THE WRITE ════════════════════
 *
 * The same asymmetry `repository.ts` states, through the same `isMissingSchema`
 * — imported from there rather than re-derived, so the two codes (`42P01` from
 * Postgres, `PGRST205` from PostgREST's schema cache) are recognised in one
 * place.
 *
 * A READ against a table that does not exist means there is nothing due, and
 * `[]` is a true answer that lets the sweep run on a deployment where 0053 has
 * not been applied. A WRITE against a table that does not exist means the row
 * did not move — and `false` is reserved for "another sweep got there first",
 * which is a completely different fact. Returning `false` would tell the runner
 * it lost a race it never entered, so the write throws
 * `MessagingNotProvisionedError` instead. It is unreachable in practice, since
 * a list that returned nothing produces no writes; it is written down because
 * the day it is reachable is the day the table is dropped underneath a running
 * sweep, and silence there would be indistinguishable from a busy Tuesday.
 */

import {
  asDate,
  asDateOrNull,
  asEnum,
  asString,
  asStringOrNull,
  type Db,
  type Row,
} from '../persistence'
import { NOTIFICATION_DELIVERY_STATUSES } from '../notifications/types'

import type {
  DueGuestMessage,
  GuestMessagePatch,
  GuestMessageReleaseStore,
} from './release'
import { isMissingSchema, MessagingNotProvisionedError } from './repository'
import {
  GUEST_CHANNELS,
  GUEST_MESSAGE_KINDS,
  type GuestChannel,
  type GuestMessageKind,
  type MessageOutcome,
} from './types'

/* --------------------------------------------------------------- columns -- */

/**
 * Every column `DueGuestMessage` carries.
 *
 * The body is among them, and that is not an oversight: `release.ts` hands it
 * to the provider unchanged, because a message composed at 22:10 about a
 * booking since cancelled must still say what it said. It travels because it
 * is about to be sent — it is never logged, never counted and never returned
 * to a caller, which is what the sweep's summary shape enforces.
 *
 * Kept as its own constant rather than imported from `repository.ts`, where
 * the identical list is a private `COLUMNS`. That duplication is deliberate
 * and reported: two column lists over one table is exactly how two files end
 * up with two opinions about a column, and the fix is one export, not a second
 * copy that drifts. See the module report.
 */
const DUE_COLUMNS = `
  id, organization_id, property_id, booking_id, guest_id,
  kind, channel, subject, body, recipient_masked,
  outcome, outcome_detail, provider, provider_message_id,
  scheduled_for, correlation_id, dedupe_key,
  created_by, created_at, settled_at
`

/**
 * One due row, as `release.ts` reads it.
 *
 * `outcome` is asserted to be `deferred` rather than mapped loosely: the query
 * filters on it, and a row that came back as anything else would mean the
 * filter did not apply — which under the admin client is the shape of mistake
 * that ends with a sent message being re-sent. `scheduled_for` is mapped with
 * `asDate` because `guest_messages_deferred_has_time` refuses a deferral
 * without one, and a `null` here would make every staleness comparison `NaN`.
 */
function dueFromRow(row: Row): DueGuestMessage {
  const outcome = asEnum<MessageOutcome>(
    row,
    'outcome',
    NOTIFICATION_DELIVERY_STATUSES,
  )
  if (outcome !== 'deferred') {
    throw new Error(
      `The due query returned a guest message with outcome ${outcome}; ` +
        'only deferred rows may be released',
    )
  }

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    bookingId: asString(row, 'booking_id'),
    guestId: asString(row, 'guest_id'),
    kind: asEnum<GuestMessageKind>(row, 'kind', GUEST_MESSAGE_KINDS),
    channel: asEnum<GuestChannel>(row, 'channel', GUEST_CHANNELS),
    subject: asStringOrNull(row, 'subject'),
    body: asString(row, 'body'),
    recipientMasked: asStringOrNull(row, 'recipient_masked'),
    outcome,
    outcomeDetail: asStringOrNull(row, 'outcome_detail'),
    provider: asStringOrNull(row, 'provider'),
    providerMessageId: asStringOrNull(row, 'provider_message_id'),
    scheduledFor: asDate(row, 'scheduled_for'),
    correlationId: asStringOrNull(row, 'correlation_id'),
    dedupeKey: asString(row, 'dedupe_key'),
    createdBy: asStringOrNull(row, 'created_by'),
    createdAt: asDate(row, 'created_at'),
    settledAt: asDateOrNull(row, 'settled_at'),
  }
}

/** What a release may change, as columns. */
function patchColumns(patch: GuestMessagePatch): Record<string, unknown> {
  return {
    outcome: patch.outcome,
    outcome_detail: patch.outcomeDetail,
    provider: patch.provider,
    provider_message_id: patch.providerMessageId,
    // Explicit, and required. An omitted column keeps its value, and a row
    // leaving `deferred` while still carrying a time is refused by
    // `guest_messages_scheduled_only_when_deferred`. See the header.
    scheduled_for: null,
    settled_at: patch.settledAt?.toISOString() ?? null,
  }
}

/* --------------------------------------------------------------- adapter -- */

export class SupabaseGuestMessageReleaseStore implements GuestMessageReleaseStore {
  constructor(private readonly db: Db) {}

  /**
   * Deferred rows whose time has passed, oldest first, at most `limit`.
   *
   * The filters are `(organization_id, scheduled_for)` plus an outcome the
   * partial index covers, which is `guest_messages_due_idx` as 0054 rebuilt it.
   * Ordering by `scheduled_for` ascending is the index's own order and is also
   * the fair one: the arrival instructions that have waited longest go first,
   * so a backlog bigger than `limit` drains in the order it formed rather than
   * starving its oldest rows on every pass.
   */
  async listDueMessages(args: {
    organizationId: string
    dueBefore: Date
    limit: number
  }): Promise<readonly DueGuestMessage[]> {
    const { organizationId, dueBefore, limit } = args

    // A pass with no room does no work and asks the database nothing. Guarded
    // here because PostgREST reads `limit(0)` as an unbounded request, which
    // would turn a caller's off-by-one into a full-table scan.
    if (limit <= 0) return []

    const { data, error } = await this.db
      .from('guest_messages')
      .select(DUE_COLUMNS)
      // The tenant boundary. See the header — under the admin client this
      // filter is the only one there is.
      .eq('organization_id', organizationId)
      .eq('outcome', 'deferred')
      .lte('scheduled_for', dueBefore.toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(limit)

    if (error) {
      // Nothing to release, because there is nowhere for a deferral to live.
      // A true answer, not a swallowed failure — see the header.
      if (isMissingSchema(error)) return []
      throw error
    }

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
   * actually touched, and `id` alone travels because there is no reason for a
   * Hebrew message body to come back over the wire to report that one row
   * changed.
   */
  async transitionGuestMessage(args: {
    organizationId: string
    messageId: string
    from: MessageOutcome
    patch: GuestMessagePatch
  }): Promise<boolean> {
    const { organizationId, messageId, from, patch } = args

    const { data, error } = await this.db
      .from('guest_messages')
      .update(patchColumns(patch))
      .eq('organization_id', organizationId)
      .eq('id', messageId)
      // ── THE SAFETY PROPERTY. Do not remove. See the header. ──────────────
      // Without this predicate two concurrent sweeps both claim the same row
      // and the guest gets the same reminder twice.
      .eq('outcome', from)
      .select('id')

    if (error) {
      // A write that did not happen, and must not be reported as a lost race.
      if (isMissingSchema(error)) {
        throw new MessagingNotProvisionedError('transitionGuestMessage')
      }
      throw error
    }

    // Exactly one, not "at least one". `id` is the primary key and the filter
    // names it, so two rows would mean the statement matched something this
    // file cannot explain — and a sweep that shrugged at that would be a sweep
    // that silently mass-updated a tenant's messages.
    return toRowList(data).length === 1
  }
}

/**
 * PostgREST's `data`, as rows.
 *
 * `toRows` from `../persistence` would do and is not used, so that this file's
 * two methods narrow their answers the same way and a malformed row fails
 * inside `dueFromRow` with the offending column named.
 */
function toRowList(data: unknown): Row[] {
  if (data === null || data === undefined) return []
  if (!Array.isArray(data)) {
    throw new Error('Expected a list of rows from guest_messages')
  }
  return data.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Expected a row object from guest_messages')
    }
    return entry as Row
  })
}
