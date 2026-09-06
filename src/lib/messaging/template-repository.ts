/**
 * EXECUTION CONTEXT — SERVER ONLY. Reading and resolving message templates.
 *
 * ══ RESOLUTION IS THE ONLY INTERESTING PART ═════════════════════════════════
 *
 * A business may write one wording for a kind and optionally override a single
 * channel. So a send asks: is there a row for this kind AND this channel? If
 * not, is there a row for this kind with no channel? If not, no template — and
 * `compose.ts` writes the built-in Hebrew.
 *
 * `resolveTemplate` is the ONLY function that answers that, and every send path
 * calls it. Two places deciding which template wins is two places that will
 * eventually disagree, and the symptom would be a guest receiving the wrong
 * wording on one channel only — the hardest kind of report to reproduce.
 *
 * ══ AN INACTIVE TEMPLATE IS NOT A TEMPLATE ═════════════════════════════════
 *
 * `is_active = false` resolves as though the row were absent, which means the
 * built-in text. That is the whole point of the flag: a business can switch
 * its own wording off and get working Hebrew back without losing what it
 * wrote. A row that resolved while inactive would make the flag decorative.
 */

import { toRow, toRows, type Db, type Row } from '../persistence'
import type { GuestChannel, GuestMessageKind } from './types'

const TABLE = 'message_templates'

const COLUMNS = 'id, kind, channel, subject, body, is_active'

export type MessageTemplate = {
  readonly id: string
  readonly kind: GuestMessageKind
  /** `null` means every channel. */
  readonly channel: GuestChannel | null
  readonly subject: string | null
  readonly body: string
  readonly isActive: boolean
}

const str = (row: Row, key: string): string | null =>
  typeof row[key] === 'string' && row[key].trim() !== ''
    ? (row[key] as string)
    : null

function toTemplate(row: Row): MessageTemplate | null {
  const id = str(row, 'id')
  const kind = str(row, 'kind')
  const body = typeof row.body === 'string' ? row.body : null
  if (id === null || kind === null || body === null) return null

  const channel = str(row, 'channel')

  return {
    id,
    kind: kind as GuestMessageKind,
    // `in_app` and `push` are refused by a CHECK constraint, so anything here
    // is a guest channel. Narrowed rather than cast blindly all the same.
    channel:
      channel === 'email' || channel === 'sms' || channel === 'whatsapp'
        ? channel
        : null,
    subject: str(row, 'subject'),
    body,
    isActive: row.is_active !== false,
  }
}

export class MessageTemplateRepository {
  constructor(private readonly db: Db) {}

  async all(organizationId: string): Promise<readonly MessageTemplate[]> {
    const { data, error } = await this.db
      .from(TABLE)
      .select(COLUMNS)
      .eq('organization_id', organizationId)
      .order('kind')

    if (error) throw error
    return toRows(data)
      .map(toTemplate)
      .filter((template): template is MessageTemplate => template !== null)
  }

  async byId(
    organizationId: string,
    id: string,
  ): Promise<MessageTemplate | null> {
    const { data, error } = await this.db
      .from(TABLE)
      .select(COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    return data ? toTemplate(toRow(data)) : null
  }
}

/**
 * Which template a send should use, if any.
 *
 * Pure, so the precedence rule can be tested without a database — which is the
 * point, because the rule is the part that will be got wrong.
 */
export function resolveTemplate(
  templates: readonly MessageTemplate[],
  kind: GuestMessageKind,
  channel: GuestChannel,
): MessageTemplate | null {
  const usable = templates.filter((t) => t.isActive && t.kind === kind)
  return (
    usable.find((t) => t.channel === channel) ??
    usable.find((t) => t.channel === null) ??
    null
  )
}
