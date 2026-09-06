/**
 * EXECUTION CONTEXT — SERVER ONLY. The conversation half of the inbox.
 *
 * Kept beside `queries.ts` rather than inside it. That file reads the three
 * pre-conversation sources — a guest's words on a booking, a request that
 * became a task, an internal note — and its header is a careful argument about
 * why each is not a thread. That argument is still true, and burying it under
 * new code would lose it.
 *
 * ══ WHY THIS ALSO LISTS WHAT HAS NOT BEEN THREADED ══════════════════════════
 *
 * Nothing in this deployment receives a WhatsApp message, so if the only way a
 * conversation could appear were an inbound integration, the inbox would be
 * empty forever and the module would be the "complete but nothing runs it"
 * failure again — one wave after Autopilot was found in exactly that state.
 *
 * Two inbound sources already exist and have always been unthreaded:
 * `site_booking_requests` (a stranger enquiring through the website) and
 * `guest_requests` (a guest asking from the portal). This lists the ones with
 * no thread yet so a person can adopt them, which is what makes the inbox
 * unify something real today rather than wait for an integration.
 */

import { InboxRepository, isMissingSchema } from '@/lib/inbox/repository'
import { byLongestWait, countInbox } from '@/lib/inbox'
import type { Conversation, InboxCounts, ReadMarks } from '@/lib/inbox'
import { toRows, type Db } from '@/lib/persistence'

export interface UnthreadedSource {
  readonly id: string
  readonly kind: 'site_request' | 'guest_request'
  readonly who: string
  readonly words: string
  readonly arrivedAt: Date
}

export type ThreadScreen =
  | { readonly status: 'not_provisioned' }
  | {
      readonly status: 'ready'
      readonly conversations: readonly Conversation[]
      readonly marks: ReadMarks
      readonly counts: InboxCounts
      readonly unthreaded: readonly UnthreadedSource[]
    }

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function loadThreadScreen(
  db: Db,
  organizationId: string,
  readerUserId: string,
): Promise<ThreadScreen> {
  const repository = new InboxRepository(db)

  let conversations: readonly Conversation[]
  let marks: ReadMarks
  let adopted: { site: ReadonlySet<string>; guest: ReadonlySet<string> }

  try {
    ;[conversations, marks, adopted] = await Promise.all([
      repository.conversations(organizationId),
      repository.readMarks(organizationId),
      repository.adoptedOrigins(organizationId),
    ])
  } catch (error) {
    if (isMissingSchema(error)) return { status: 'not_provisioned' }
    throw error
  }

  const unthreaded: UnthreadedSource[] = []

  // Both reads are bounded and both are allowed to fail quietly into "none":
  // a business whose website module was never provisioned still has an inbox,
  // and refusing to render it because one source is absent would be the
  // feature taking itself down over something optional.
  try {
    const site = await db
      .from('site_booking_requests')
      .select('id, contact_name, contact_email, message, created_at')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(25)

    if (!site.error) {
      for (const row of toRows(site.data)) {
        const id = textOf(row.id)
        if (id === '' || adopted.site.has(id)) continue
        unthreaded.push({
          id,
          kind: 'site_request',
          who:
            textOf(row.contact_name) || textOf(row.contact_email) || 'ללא שם',
          words: textOf(row.message),
          arrivedAt: new Date(textOf(row.created_at)),
        })
      }
    }
  } catch (error) {
    if (!isMissingSchema(error)) throw error
  }

  try {
    const guest = await db
      .from('guest_requests')
      .select('id, body, created_at')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(25)

    if (!guest.error) {
      for (const row of toRows(guest.data)) {
        const id = textOf(row.id)
        if (id === '' || adopted.guest.has(id)) continue
        unthreaded.push({
          id,
          kind: 'guest_request',
          who: 'אורח בפורטל',
          words: textOf(row.body),
          arrivedAt: new Date(textOf(row.created_at)),
        })
      }
    }
  } catch (error) {
    if (!isMissingSchema(error)) throw error
  }

  unthreaded.sort((a, b) => b.arrivedAt.getTime() - a.arrivedAt.getTime())

  return {
    status: 'ready',
    // Longest wait first, not newest first — see `unread.ts`.
    conversations: byLongestWait(conversations, new Date()),
    marks,
    counts: countInbox(conversations, marks, readerUserId),
    unthreaded,
  }
}
