/**
 * EXECUTION CONTEXT — SERVER ONLY. Rows in, threads out.
 *
 * ══ IT CANNOT WRITE AN OUTBOUND MESSAGE'S WORDS ═════════════════════════════
 *
 * `linkSentMessage` takes a `guestMessageId` and nothing that resembles a
 * body, because `conversation_messages_outbound_is_a_reference` refuses a row
 * that carries one. This adapter therefore has no method that could compose an
 * outward message even by accident: the wording belongs to `guest_messages`,
 * written by `src/lib/messaging`, and read back from there.
 *
 * That is the module's central rule expressed a third time — once as a CHECK,
 * once as a type with no `body` field, and once here as a missing method.
 *
 * ══ THE TABLES MAY BE ABSENT ════════════════════════════════════════════════
 *
 * `42P01` from Postgres and `PGRST205` from PostgREST mean "not provisioned".
 * Everything else is rethrown, because a `catch` that swallowed the rest would
 * turn a row-level-security refusal into "this feature is not built" — the
 * most misleading sentence a screen can produce.
 */

import { toRow, toRows, type Db, type Row } from '../persistence'
import type {
  Conversation,
  ConversationChannel,
  ConversationMessage,
  ConversationOrigin,
  ConversationStatus,
} from './types'
import type { ReadMarks } from './unread'

const CONVERSATIONS = 'conversations'
const MESSAGES = 'conversation_messages'
const READS = 'conversation_reads'

const CONVERSATION_COLUMNS =
  'id, organization_id, property_id, guest_id, contact_name, contact_phone, ' +
  'contact_email, subject, status, origin, site_request_id, guest_request_id, ' +
  'assigned_to_user_id, last_message_at, last_inbound_at, opened_at, ' +
  'closed_at, version'

const MESSAGE_COLUMNS =
  'id, organization_id, conversation_id, direction, channel, body, ' +
  'guest_message_id, author_user_id, occurred_at'

export function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '42P01' || code === 'PGRST205'
}

function text(row: Row, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`${column} is not text`)
  return value
}

function optionalText(row: Row, column: string): string | null {
  const value = row[column]
  return typeof value === 'string' ? value : null
}

function optionalDate(row: Row, column: string): Date | null {
  const value = row[column]
  return typeof value === 'string' ? new Date(value) : null
}

function toConversation(row: Row): Conversation {
  return {
    id: text(row, 'id'),
    organizationId: text(row, 'organization_id'),
    propertyId: optionalText(row, 'property_id'),
    party: {
      guestId: optionalText(row, 'guest_id'),
      contactName: optionalText(row, 'contact_name'),
      contactPhone: optionalText(row, 'contact_phone'),
      contactEmail: optionalText(row, 'contact_email'),
    },
    subject: optionalText(row, 'subject'),
    status: text(row, 'status') as ConversationStatus,
    origin: text(row, 'origin') as ConversationOrigin,
    siteRequestId: optionalText(row, 'site_request_id'),
    guestRequestId: optionalText(row, 'guest_request_id'),
    assignedToUserId: optionalText(row, 'assigned_to_user_id'),
    lastMessageAt: optionalDate(row, 'last_message_at'),
    lastInboundAt: optionalDate(row, 'last_inbound_at'),
    openedAt: new Date(text(row, 'opened_at')),
    closedAt: optionalDate(row, 'closed_at'),
    version: typeof row.version === 'number' ? row.version : 1,
  }
}

function toMessage(row: Row): ConversationMessage {
  const direction = text(row, 'direction')
  const shared = {
    id: text(row, 'id'),
    conversationId: text(row, 'conversation_id'),
    channel: text(row, 'channel') as ConversationChannel,
    occurredAt: new Date(text(row, 'occurred_at')),
  }

  if (direction === 'outbound') {
    return {
      ...shared,
      direction: 'outbound',
      // Not optional in practice — the CHECK guarantees it — but read
      // defensively rather than asserted, because a `!` here would be a lie
      // the day somebody loosens the constraint.
      guestMessageId: text(row, 'guest_message_id'),
      authorUserId: optionalText(row, 'author_user_id'),
    }
  }

  return {
    ...shared,
    direction: 'inbound',
    body: text(row, 'body'),
  }
}

export class InboxRepository {
  constructor(private readonly db: Db) {}

  /**
   * The open threads, newest activity first.
   *
   * Ordering is done again in the domain by `byLongestWait`, which is what the
   * screen actually shows. This order exists only so `limit` takes the rows
   * most likely to matter rather than an arbitrary page.
   */
  async conversations(
    organizationId: string,
    options: { includeClosed?: boolean; limit?: number } = {},
  ): Promise<readonly Conversation[]> {
    let query = this.db
      .from(CONVERSATIONS)
      .select(CONVERSATION_COLUMNS)
      .eq('organization_id', organizationId)

    if (options.includeClosed !== true) query = query.neq('status', 'closed')

    const { data, error } = await query
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(options.limit ?? 100)

    if (error) throw error
    return toRows(data).map(toConversation)
  }

  async conversation(
    organizationId: string,
    id: string,
  ): Promise<Conversation | null> {
    const { data, error } = await this.db
      .from(CONVERSATIONS)
      .select(CONVERSATION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    return data ? toConversation(toRow(data)) : null
  }

  async messages(
    organizationId: string,
    conversationId: string,
  ): Promise<readonly ConversationMessage[]> {
    const { data, error } = await this.db
      .from(MESSAGES)
      .select(MESSAGE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('conversation_id', conversationId)
      .order('occurred_at', { ascending: true })

    if (error) throw error
    return toRows(data).map(toMessage)
  }

  /**
   * This reader's own marks.
   *
   * No `userId` argument, and that is deliberate: `conversation_reads`'s policy
   * pins `user_id = auth.uid()`, so the session decides whose marks come back
   * and the caller cannot ask for a colleague's. A parameter here would imply
   * it could.
   */
  async readMarks(organizationId: string): Promise<ReadMarks> {
    const { data, error } = await this.db
      .from(READS)
      .select('conversation_id, last_read_at')
      .eq('organization_id', organizationId)

    if (error) throw error

    const marks = new Map<string, Date>()
    for (const row of toRows(data)) {
      const id = optionalText(row, 'conversation_id')
      const at = optionalDate(row, 'last_read_at')
      if (id !== null && at !== null) marks.set(id, at)
    }
    return marks
  }

  /** Threads already opened from these sources, so nothing is adopted twice. */
  async adoptedOrigins(
    organizationId: string,
  ): Promise<{ site: ReadonlySet<string>; guest: ReadonlySet<string> }> {
    const { data, error } = await this.db
      .from(CONVERSATIONS)
      .select('site_request_id, guest_request_id')
      .eq('organization_id', organizationId)

    if (error) throw error

    const site = new Set<string>()
    const guest = new Set<string>()
    for (const row of toRows(data)) {
      const s = optionalText(row, 'site_request_id')
      const g = optionalText(row, 'guest_request_id')
      if (s !== null) site.add(s)
      if (g !== null) guest.add(g)
    }
    return { site, guest }
  }
}
