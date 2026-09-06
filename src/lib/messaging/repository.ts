/**
 * EXECUTION CONTEXT — SERVER ONLY. Reading and writing `guest_messages`.
 *
 * ══ THE TABLE DOES NOT EXIST YET, AND THAT IS A STATE RATHER THAN A CRASH ═══
 *
 * This file is written against a schema that has been PROPOSED and not yet
 * applied — agents here do not write migrations, the coordinator does, and the
 * proposal is stated in full in this module's report. Writing the adapter
 * first is deliberate rather than premature: every column name below is a
 * claim about the schema, and a claim written as code is one the typecheck and
 * the in-memory double can be held against, where a claim written as a
 * paragraph in a document drifts within the week.
 *
 * So a "relation does not exist" is recognised and named, exactly as
 * `src/app/(app)/channels/_lib/manager.ts` does it. Two codes, because the two
 * layers report the same fact differently: Postgres raises `42P01` for an
 * unknown relation and PostgREST answers `PGRST205` when the table is not in
 * its schema cache at all. Everything else is rethrown — swallowing every
 * error here would turn a broken RLS policy into a screen that says "not
 * installed", which is the most misleading sentence this module could produce.
 *
 * ══ A MISSING TABLE FAILS A WRITE AND SOFTENS A READ, AND THE ASYMMETRY IS THE
 *    WHOLE POINT ═══════════════════════════════════════════════════════════
 *
 * A READ against a table that does not exist means there is nothing to show,
 * and `{ kind: 'not_provisioned' }` is a sentence a screen can print.
 *
 * A WRITE against a table that does not exist means the message was NOT
 * recorded. Returning quietly would leave the operation free to report that a
 * guest had been written to when no trace of it exists anywhere — the exact
 * dishonesty this whole module was built to remove. So a write throws
 * `MessagingNotProvisionedError`, the operation fails, its audit event is
 * rolled back with it, and Autopilot records `failed` rather than `executed`.
 *
 * ── Why the adapter lives here and not in `src/lib/persistence` ───────────
 *
 * That directory belongs to another owner, and the same argument
 * `notifications/repository.ts`, `payments/repository.ts` and
 * `channels/repository.ts` all make applies unchanged: the adapter for a
 * module's own tables lives beside the module that reads them.
 *
 * Every read filters on `organization_id` as well as being covered by row
 * level security. The policy is the enforcement; the filter is what stops a
 * mistake in this file from becoming a cross-tenant read the first time
 * somebody runs it as `service_role`.
 */

import {
  asDate,
  asDateOrNull,
  asEnum,
  asString,
  asStringOrNull,
  clientFor,
  recordWrite,
  toRow,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import { AppError } from '../errors'
import { NOTIFICATION_DELIVERY_STATUSES } from '../notifications/types'
import type { TransactionHandle } from '../service'

import {
  GUEST_CHANNELS,
  GUEST_MESSAGE_KINDS,
  type GuestChannel,
  type GuestMessageDraft,
  type GuestMessageKind,
  type GuestMessageRecord,
  type MessageOutcome,
  type OutcomeTally,
} from './types'

/* ------------------------------------------------------- not provisioned -- */

const UNKNOWN_RELATION = '42P01'
const POSTGREST_UNKNOWN_TABLE = 'PGRST205'
const UNIQUE_VIOLATION = '23505'

/** Is this the database telling us the messaging tables were never installed? */
export function isMissingSchema(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === UNKNOWN_RELATION || code === POSTGREST_UNKNOWN_TABLE
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === UNIQUE_VIOLATION
}

/**
 * The write could not be recorded because the table is not there.
 *
 * A 500 and not a 4xx: the caller did nothing wrong, the deployment is
 * incomplete, and `dataOutcome: 'not_saved'` is what tells every surface above
 * that nothing happened — which is the fact that matters, because the guest
 * was not written to either.
 */
export class MessagingNotProvisionedError extends AppError {
  constructor(operation: string) {
    super({
      code: 'messaging_not_provisioned',
      status: 500,
      message: `guest_messages is not provisioned; ${operation} was not recorded`,
      userMessage:
        'שליחת הודעות לאורחים לא הותקנה בהתקנה הזו, ולכן ההודעה לא נשמרה ולא נשלחה. פנו למי שמתחזק את המערכת.',
      retryable: false,
      dataOutcome: 'not_saved',
    })
  }
}

/** What a read returns when there is nothing to read from. */
export type MessagingReadState<T> =
  { kind: 'not_provisioned' } | { kind: 'ready'; value: T }

/* ------------------------------------------------------------------ port -- */

export interface GuestMessageQuery {
  bookingId?: string
  guestId?: string
  /** Defaults to 50. The inbox is a queue, not a report. */
  limit?: number
}

export interface MessagingRepository {
  /**
   * Write one outward message, or discover it is already there.
   *
   * `created: false` means the dedupe constraint held — the ordinary outcome
   * of a retried Autopilot action, and not a failure. The guarantee is the
   * unique index rather than a caller remembering to look first: two dispatches
   * of the same planned action eight milliseconds apart both reach the insert
   * and exactly one leaves it having created a row.
   */
  recordGuestMessage(
    draft: GuestMessageDraft,
    tx?: TransactionHandle,
  ): Promise<{ record: GuestMessageRecord; created: boolean }>

  listGuestMessages(
    organizationId: string,
    query?: GuestMessageQuery,
  ): Promise<MessagingReadState<readonly GuestMessageRecord[]>>

  /**
   * How outward messages ended, over a window.
   *
   * The read behind "היינו שולחים 14 הודעות לאורחים ואין ערוץ מחובר". Every
   * outcome is counted, including the ones that never left the building — a
   * tally that showed successes only would show an empty screen to the business
   * with the biggest problem.
   */
  tallyOutcomes(
    organizationId: string,
    sinceDays: number,
  ): Promise<MessagingReadState<OutcomeTally>>
}

export function emptyTally(): OutcomeTally {
  return Object.fromEntries(
    NOTIFICATION_DELIVERY_STATUSES.map((status) => [status, 0]),
  ) as OutcomeTally
}

/* -------------------------------------------------------------- supabase -- */

const COLUMNS = `
  id, organization_id, property_id, booking_id, guest_id,
  kind, channel, subject, body, recipient_masked,
  outcome, outcome_detail, provider, provider_message_id,
  scheduled_for, correlation_id, dedupe_key,
  created_by, created_at, settled_at
`

function fromRow(row: Row): GuestMessageRecord {
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
    outcome: asEnum<MessageOutcome>(
      row,
      'outcome',
      NOTIFICATION_DELIVERY_STATUSES,
    ),
    outcomeDetail: asStringOrNull(row, 'outcome_detail'),
    provider: asStringOrNull(row, 'provider'),
    providerMessageId: asStringOrNull(row, 'provider_message_id'),
    scheduledFor: asDateOrNull(row, 'scheduled_for'),
    correlationId: asStringOrNull(row, 'correlation_id'),
    dedupeKey: asString(row, 'dedupe_key'),
    createdBy: asStringOrNull(row, 'created_by'),
    createdAt: asDate(row, 'created_at'),
    settledAt: asDateOrNull(row, 'settled_at'),
  }
}

export class SupabaseMessagingRepository implements MessagingRepository {
  constructor(private readonly db: Db) {}

  async recordGuestMessage(
    draft: GuestMessageDraft,
    tx?: TransactionHandle,
  ): Promise<{ record: GuestMessageRecord; created: boolean }> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('guest_messages')
      .insert({
        organization_id: draft.organizationId,
        property_id: draft.propertyId,
        booking_id: draft.bookingId,
        guest_id: draft.guestId,
        kind: draft.kind,
        channel: draft.channel,
        subject: draft.subject,
        body: draft.body,
        recipient_masked: draft.recipientMasked,
        outcome: draft.outcome,
        outcome_detail: draft.outcomeDetail,
        provider: draft.provider,
        provider_message_id: draft.providerMessageId,
        scheduled_for: draft.scheduledFor?.toISOString() ?? null,
        correlation_id: draft.correlationId,
        dedupe_key: draft.dedupeKey,
        created_by: draft.createdBy,
        settled_at: draft.settledAt?.toISOString() ?? null,
      })
      .select(COLUMNS)
      .single()

    if (error) {
      if (isMissingSchema(error)) {
        throw new MessagingNotProvisionedError('recordGuestMessage')
      }
      // The dedupe constraint held. This module working, not failing — see the
      // port — so the row that was already there is read back rather than a
      // 23505 being thrown at a caller who would have to know the constraint's
      // name to interpret it.
      if (isUniqueViolation(error)) {
        const existing = await this.findByDedupeKey(
          draft.organizationId,
          draft.dedupeKey,
        )
        if (existing) return { record: existing, created: false }
      }
      throw error
    }

    if (tx) recordWrite(tx, 'guest_messages.insert')
    return { record: fromRow(toRow(data)), created: true }
  }

  private async findByDedupeKey(
    organizationId: string,
    dedupeKey: string,
  ): Promise<GuestMessageRecord | null> {
    const { data, error } = await this.db
      .from('guest_messages')
      .select(COLUMNS)
      .eq('organization_id', organizationId)
      .eq('dedupe_key', dedupeKey)
      .maybeSingle()

    if (error) throw error
    return data ? fromRow(toRow(data)) : null
  }

  async listGuestMessages(
    organizationId: string,
    query: GuestMessageQuery = {},
  ): Promise<MessagingReadState<readonly GuestMessageRecord[]>> {
    let builder = this.db
      .from('guest_messages')
      .select(COLUMNS)
      .eq('organization_id', organizationId)

    if (query.bookingId) builder = builder.eq('booking_id', query.bookingId)
    if (query.guestId) builder = builder.eq('guest_id', query.guestId)

    const { data, error } = await builder
      .order('created_at', { ascending: false })
      .limit(query.limit ?? 50)

    if (error) {
      if (isMissingSchema(error)) return { kind: 'not_provisioned' }
      throw error
    }

    return { kind: 'ready', value: toRows(data).map(fromRow) }
  }

  async tallyOutcomes(
    organizationId: string,
    sinceDays: number,
  ): Promise<MessagingReadState<OutcomeTally>> {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)

    // `outcome` alone, not the whole row. The tally is read by a settings
    // screen and there is no reason for a Hebrew message body or a masked
    // telephone number to travel for a count.
    const { data, error } = await this.db
      .from('guest_messages')
      .select('outcome')
      .eq('organization_id', organizationId)
      .gte('created_at', since.toISOString())

    if (error) {
      if (isMissingSchema(error)) return { kind: 'not_provisioned' }
      throw error
    }

    const tally = emptyTally()
    for (const row of toRows(data)) {
      const outcome = asEnum<MessageOutcome>(
        row,
        'outcome',
        NOTIFICATION_DELIVERY_STATUSES,
      )
      tally[outcome] += 1
    }

    return { kind: 'ready', value: tally }
  }
}

/* -------------------------------------------------------------- in memory -- */

/**
 * The double every test in this module runs against.
 *
 * It enforces the dedupe constraint, because a double that did not would let a
 * test prove idempotency that the database would not honour — and passing for
 * the wrong reason is the same as not testing it.
 */
export class InMemoryMessagingRepository implements MessagingRepository {
  readonly messages: GuestMessageRecord[] = []
  private sequence = 0

  /** Flip off to rehearse a deployment where the migration has not run. */
  provisioned = true

  /**
   * What the database's `default now()` would have written.
   *
   * Injected rather than read, so a test that asserts on ordering does not
   * depend on how fast the machine running it is.
   */
  constructor(private readonly now: Date = new Date(0)) {}

  async recordGuestMessage(
    draft: GuestMessageDraft,
  ): Promise<{ record: GuestMessageRecord; created: boolean }> {
    if (!this.provisioned) {
      throw new MessagingNotProvisionedError('recordGuestMessage')
    }

    const existing = this.messages.find(
      (message) =>
        message.organizationId === draft.organizationId &&
        message.dedupeKey === draft.dedupeKey,
    )
    if (existing) return { record: existing, created: false }

    this.sequence += 1
    const record: GuestMessageRecord = {
      ...draft,
      id: `guest-message-${this.sequence}`,
      createdAt: this.now,
    }
    this.messages.push(record)
    return { record, created: true }
  }

  async listGuestMessages(
    organizationId: string,
    query: GuestMessageQuery = {},
  ): Promise<MessagingReadState<readonly GuestMessageRecord[]>> {
    if (!this.provisioned) return { kind: 'not_provisioned' }

    const value = this.messages.filter(
      (message) =>
        message.organizationId === organizationId &&
        (query.bookingId === undefined ||
          message.bookingId === query.bookingId) &&
        (query.guestId === undefined || message.guestId === query.guestId),
    )

    return { kind: 'ready', value: value.slice(0, query.limit ?? 50) }
  }

  async tallyOutcomes(
    organizationId: string,
    sinceDays: number,
  ): Promise<MessagingReadState<OutcomeTally>> {
    if (!this.provisioned) return { kind: 'not_provisioned' }

    // The window is honoured rather than ignored. A double that counted
    // everything would let a test prove a figure the database would not
    // produce, and passing for the wrong reason is the same as not testing it.
    const from = this.now.getTime() - sinceDays * 24 * 60 * 60 * 1000

    const tally = emptyTally()
    for (const message of this.messages) {
      if (
        message.organizationId === organizationId &&
        message.createdAt.getTime() >= from
      ) {
        tally[message.outcome] += 1
      }
    }
    return { kind: 'ready', value: tally }
  }
}
