/**
 * EXECUTION CONTEXT — SERVER ONLY. What a person can do to a thread.
 *
 * Six operations through `defineOperation`, so each gets the same
 * authorization, validation, transaction, audit row and idempotency as
 * everything else in the product.
 *
 * ══ THERE IS NO `reply` HERE, AND THAT IS NOT AN OVERSIGHT ══════════════════
 *
 * An outbound message must reference a `guest_messages` row — the CHECK in
 * 0063, the missing `body` on `OutboundMessage`, and the missing method on
 * `InboxRepository` all say so. `guest_messages` is written by
 * `src/lib/messaging`, whose `SendGuestMessageInput` takes `{ bookingId, kind,
 * channel }`: the WORDING comes from `compose()` for one of three templated
 * kinds — `payment_reminder`, `arrival_info`, `review_request`. There is no
 * free-text kind.
 *
 * So a person typing a sentence into this inbox has nothing to send it as.
 * Closing that needs two things this module does not own and will not invent:
 *
 *   1. a `GuestMessageKind` for free correspondence, which is
 *      `src/lib/messaging`'s decision — and its own ownership row says that
 *      module is not to be edited by this work; and
 *   2. a domain event for it. The three existing kinds each raise a name that
 *      already means what it says (`payment.instructions_sent`,
 *      `arrival.instructions_released`, `review.requested`). A free reply
 *      raises none of those, and borrowing one would put a false sentence in
 *      the log — the same refusal `incidents/operations.ts` made before
 *      `incident.evidence_added` existed.
 *
 * `linkSentMessage` is what exists instead: when one of the three templated
 * sends happens, the thread records that it happened, by reference. The thread
 * is therefore complete and honest about outbound today; it simply cannot
 * originate a free one. The screen says so on its face rather than offering a
 * reply box that fails.
 *
 * ══ ADOPTION IS WHY THIS IS USEFUL NOW ══════════════════════════════════════
 *
 * Nothing in this deployment receives a WhatsApp message. But two inbound
 * sources already exist and have always been unthreaded: `site_booking_requests`
 * (a stranger enquiring through the website) and `guest_requests` (a guest
 * asking for something from the portal). `openFromSiteRequest` and
 * `openFromGuestRequest` turn those into threads, which is what makes the
 * inbox unify something real rather than wait for an integration.
 */

import { BusinessRuleError } from '../errors'
import { clientFor, type Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import { CONVERSATION_CHANNELS } from './types'
import { statusAfterMessage } from './threading'
import type { Conversation } from './types'

const CONVERSATIONS = 'conversations'
const MESSAGES = 'conversation_messages'
const READS = 'conversation_reads'

const THREAD_INPUT = s.object({
  conversationId: s.uuid({ label: 'שיחה' }),
})

const ASSIGN_INPUT = s.object({
  conversationId: s.uuid({ label: 'שיחה' }),
  /** Null hands it back to the queue, which must stay possible: an inbox where
   *  only assignment is expressible accumulates threads owned by whoever
   *  touched them first and then went on holiday. */
  assignToUserId: s.nullable(s.uuid({ label: 'אחראי' })),
})

const INBOUND_INPUT = s.object({
  conversationId: s.uuid({ label: 'שיחה' }),
  channel: s.enumOf(CONVERSATION_CHANNELS, { label: 'ערוץ' }),
  body: s.string({ label: 'תוכן', max: 20000 }),
  occurredAt: s.nullable(s.string({ label: 'התקבל', max: 40 })),
})

const LINK_INPUT = s.object({
  conversationId: s.uuid({ label: 'שיחה' }),
  guestMessageId: s.uuid({ label: 'הודעה שנשלחה' }),
  channel: s.enumOf(CONVERSATION_CHANNELS, { label: 'ערוץ' }),
})

const ADOPT_SITE_INPUT = s.object({
  siteRequestId: s.uuid({ label: 'פנייה מהאתר' }),
})

const ADOPT_GUEST_INPUT = s.object({
  guestRequestId: s.uuid({ label: 'בקשת אורח' }),
})

export interface InboxOperations {
  openFromSiteRequest: Operation<
    { siteRequestId: string },
    null,
    { id: string; alreadyOpen: boolean }
  >
  openFromGuestRequest: Operation<
    { guestRequestId: string },
    null,
    { id: string; alreadyOpen: boolean }
  >
  recordInbound: Operation<
    {
      conversationId: string
      channel: string
      body: string
      occurredAt: string | null
    },
    Conversation,
    { id: string }
  >
  linkSentMessage: Operation<
    { conversationId: string; guestMessageId: string; channel: string },
    Conversation,
    { id: string }
  >
  assign: Operation<
    { conversationId: string; assignToUserId: string | null },
    Conversation,
    { id: string }
  >
  close: Operation<{ conversationId: string }, Conversation, { id: string }>
  markRead: Operation<{ conversationId: string }, Conversation, { at: string }>
}

export function defineInboxOperations(options: {
  db: Db
  loadConversation: (
    organizationId: string,
    id: string,
  ) => Promise<Conversation | null>
}): InboxOperations {
  const loadResource = async ({
    input,
    context,
  }: {
    input: { conversationId: string }
    context: { actor: { organizationId: string } }
  }) => {
    const conversation = await options.loadConversation(
      context.actor.organizationId,
      input.conversationId,
    )
    if (conversation === null) return null
    return {
      resource: {
        organizationId: conversation.organizationId,
        propertyId: conversation.propertyId ?? undefined,
      },
      entity: conversation,
      version: conversation.version,
    }
  }

  /* ------------------------------------------------------------ adoption -- */

  const openFromSiteRequest = defineOperation<
    { siteRequestId: string },
    null,
    { id: string; alreadyOpen: boolean }
  >({
    name: 'conversation.open_from_site_request',
    permission: 'message.send',
    resourceType: 'conversation',
    input: ADOPT_SITE_INPUT,

    async execute({ input, context, tx, now }) {
      const db = clientFor(tx, options.db)
      const organizationId = context.actor.organizationId

      const existing = await db
        .from(CONVERSATIONS)
        .select('id')
        .eq('organization_id', organizationId)
        .eq('site_request_id', input.siteRequestId)
        .maybeSingle()

      if (existing.error) throw existing.error
      if (existing.data) {
        // Idempotent by intent rather than by key: adopting twice would split
        // one enquiry across two threads, which is the failure this module
        // exists to prevent.
        return {
          id: String((existing.data as { id: string }).id),
          alreadyOpen: true,
        }
      }

      const request = await db
        .from('site_booking_requests')
        .select(
          'id, property_id, contact_name, contact_phone, contact_email, message, created_at',
        )
        .eq('organization_id', organizationId)
        .eq('id', input.siteRequestId)
        .maybeSingle()

      if (request.error) throw request.error
      if (!request.data) {
        throw new BusinessRuleError({
          code: 'site_request_not_found',
          userMessage: 'הפנייה מהאתר לא נמצאה.',
        })
      }

      const row = request.data as Record<string, unknown>
      const arrivedAt =
        typeof row.created_at === 'string' ? row.created_at : now.toISOString()

      const inserted = await db
        .from(CONVERSATIONS)
        .insert({
          organization_id: organizationId,
          property_id: row.property_id ?? null,
          contact_name: row.contact_name ?? null,
          contact_phone: row.contact_phone ?? null,
          contact_email: row.contact_email ?? null,
          subject: 'פנייה מהאתר',
          status: 'waiting_on_us',
          origin: 'site_request',
          site_request_id: input.siteRequestId,
          last_inbound_at: arrivedAt,
          last_message_at: arrivedAt,
          opened_by: context.actor.userId,
        })
        .select('id')
        .single()

      if (inserted.error) throw inserted.error
      const id = String((inserted.data as { id: string }).id)

      // The enquiry's own words become the first inbound message. Without this
      // the thread would exist and be empty, which reads as "they said nothing".
      const body = typeof row.message === 'string' ? row.message.trim() : ''
      if (body !== '') {
        const message = await db.from(MESSAGES).insert({
          organization_id: organizationId,
          conversation_id: id,
          direction: 'inbound',
          channel: 'site_form',
          body,
          occurred_at: arrivedAt,
        })
        if (message.error) throw message.error
      }

      return { id, alreadyOpen: false }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        summary: result.alreadyOpen
          ? 'פנייה מהאתר כבר הייתה משויכת לשיחה קיימת.'
          : 'פתח שיחה מפנייה שהגיעה מהאתר.',
        after: {
          siteRequestId: input.siteRequestId,
          opened: !result.alreadyOpen,
        },
      }
    },
  })

  const openFromGuestRequest = defineOperation<
    { guestRequestId: string },
    null,
    { id: string; alreadyOpen: boolean }
  >({
    name: 'conversation.open_from_guest_request',
    permission: 'message.send',
    resourceType: 'conversation',
    input: ADOPT_GUEST_INPUT,

    async execute({ input, context, tx, now }) {
      const db = clientFor(tx, options.db)
      const organizationId = context.actor.organizationId

      const existing = await db
        .from(CONVERSATIONS)
        .select('id')
        .eq('organization_id', organizationId)
        .eq('guest_request_id', input.guestRequestId)
        .maybeSingle()

      if (existing.error) throw existing.error
      if (existing.data) {
        return {
          id: String((existing.data as { id: string }).id),
          alreadyOpen: true,
        }
      }

      const request = await db
        .from('guest_requests')
        .select('id, property_id, booking_id, body, created_at')
        .eq('organization_id', organizationId)
        .eq('id', input.guestRequestId)
        .maybeSingle()

      if (request.error) throw request.error
      if (!request.data) {
        throw new BusinessRuleError({
          code: 'guest_request_not_found',
          userMessage: 'בקשת האורח לא נמצאה.',
        })
      }

      const row = request.data as Record<string, unknown>
      const arrivedAt =
        typeof row.created_at === 'string' ? row.created_at : now.toISOString()

      // The guest is reached through the booking rather than named directly:
      // `guest_requests` carries `booking_id` and no `guest_id`, and inventing
      // a link here would be a second answer to who the booking is for.
      const booking = await db
        .from('bookings')
        .select('guest_id')
        .eq('organization_id', organizationId)
        .eq('id', row.booking_id as string)
        .maybeSingle()

      if (booking.error) throw booking.error
      const guestId =
        booking.data &&
        typeof (booking.data as { guest_id?: unknown }).guest_id === 'string'
          ? String((booking.data as { guest_id: string }).guest_id)
          : null

      const inserted = await db
        .from(CONVERSATIONS)
        .insert({
          organization_id: organizationId,
          property_id: row.property_id ?? null,
          guest_id: guestId,
          contact_name: guestId === null ? 'אורח' : null,
          subject: 'בקשה מהפורטל',
          status: 'waiting_on_us',
          origin: 'guest_request',
          guest_request_id: input.guestRequestId,
          last_inbound_at: arrivedAt,
          last_message_at: arrivedAt,
          opened_by: context.actor.userId,
        })
        .select('id')
        .single()

      if (inserted.error) throw inserted.error
      const id = String((inserted.data as { id: string }).id)

      const body = typeof row.body === 'string' ? row.body.trim() : ''
      if (body !== '') {
        const message = await db.from(MESSAGES).insert({
          organization_id: organizationId,
          conversation_id: id,
          direction: 'inbound',
          channel: 'portal',
          body,
          occurred_at: arrivedAt,
        })
        if (message.error) throw message.error
      }

      return { id, alreadyOpen: false }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        summary: result.alreadyOpen
          ? 'בקשת האורח כבר הייתה משויכת לשיחה קיימת.'
          : 'פתח שיחה מבקשת אורח שהגיעה מהפורטל.',
        after: {
          guestRequestId: input.guestRequestId,
          opened: !result.alreadyOpen,
        },
      }
    },
  })

  /* ------------------------------------------------------------ messages -- */

  const recordInbound = defineOperation<
    {
      conversationId: string
      channel: string
      body: string
      occurredAt: string | null
    },
    Conversation,
    { id: string }
  >({
    name: 'conversation.record_inbound',
    permission: 'message.send',
    resourceType: 'conversation',
    input: INBOUND_INPUT,
    requiresVersion: true,
    loadResource,

    rule({ input }) {
      if (input.body.trim() === '') {
        throw new BusinessRuleError({
          code: 'inbound_message_empty',
          userMessage: 'הודעה נכנסת בלי תוכן אינה הודעה.',
        })
      }
    },

    async execute({ input, entity, tx, now }) {
      const db = clientFor(tx, options.db)
      const occurredAt = input.occurredAt ?? now.toISOString()

      const message = await db.from(MESSAGES).insert({
        organization_id: entity.organizationId,
        conversation_id: entity.id,
        direction: 'inbound',
        channel: input.channel,
        body: input.body.trim(),
        occurred_at: occurredAt,
      })
      if (message.error) throw message.error

      const { error } = await db
        .from(CONVERSATIONS)
        .update({
          status: statusAfterMessage(entity.status, 'inbound'),
          last_inbound_at: occurredAt,
          last_message_at: occurredAt,
        })
        .eq('id', entity.id)
        .eq('organization_id', entity.organizationId)

      if (error) throw error
      return { id: entity.id }
    },

    audit({ entity, result }) {
      return {
        resourceId: result.id,
        summary: 'נרשמה הודעה נכנסת בשיחה.',
        before: { status: entity.status },
        after: { status: statusAfterMessage(entity.status, 'inbound') },
      }
    },
  })

  /**
   * Record that one of the three templated sends happened, by reference.
   *
   * No body parameter, and there must never be one. See this file's header.
   */
  const linkSentMessage = defineOperation<
    { conversationId: string; guestMessageId: string; channel: string },
    Conversation,
    { id: string }
  >({
    name: 'conversation.link_sent_message',
    permission: 'message.send',
    resourceType: 'conversation',
    input: LINK_INPUT,
    requiresVersion: true,
    loadResource,

    async execute({ input, entity, context, tx, now }) {
      const db = clientFor(tx, options.db)
      const at = now.toISOString()

      const message = await db.from(MESSAGES).insert({
        organization_id: entity.organizationId,
        conversation_id: entity.id,
        direction: 'outbound',
        channel: input.channel,
        // No `body`. The CHECK refuses one, and the wording lives on the
        // guest_messages row this points at.
        guest_message_id: input.guestMessageId,
        author_user_id: context.actor.userId,
        occurred_at: at,
      })
      if (message.error) throw message.error

      const { error } = await db
        .from(CONVERSATIONS)
        .update({
          status: statusAfterMessage(entity.status, 'outbound'),
          last_message_at: at,
        })
        .eq('id', entity.id)
        .eq('organization_id', entity.organizationId)

      if (error) throw error
      return { id: entity.id }
    },

    audit({ entity, input, result }) {
      return {
        resourceId: result.id,
        summary: 'שויכה לשיחה הודעה שנשלחה לאורח.',
        after: {
          guestMessageId: input.guestMessageId,
          status: statusAfterMessage(entity.status, 'outbound'),
        },
      }
    },
  })

  /* --------------------------------------------------------------- state -- */

  const assign = defineOperation<
    { conversationId: string; assignToUserId: string | null },
    Conversation,
    { id: string }
  >({
    name: 'conversation.assign',
    permission: 'message.assign',
    resourceType: 'conversation',
    input: ASSIGN_INPUT,
    requiresVersion: true,
    loadResource,

    async execute({ input, entity, context, tx }) {
      const db = clientFor(tx, options.db)
      const { error } = await db
        .from(CONVERSATIONS)
        .update({ assigned_to_user_id: input.assignToUserId })
        .eq('id', entity.id)
        .eq('organization_id', entity.organizationId)

      if (error) throw error
      void context
      return { id: entity.id }
    },

    audit({ entity, input, result }) {
      return {
        resourceId: result.id,
        summary:
          input.assignToUserId === null
            ? 'החזיר את השיחה לתור המשותף.'
            : 'הקצה את השיחה לחבר צוות.',
        before: { assignedToUserId: entity.assignedToUserId },
        after: { assignedToUserId: input.assignToUserId },
      }
    },
  })

  const close = defineOperation<
    { conversationId: string },
    Conversation,
    { id: string }
  >({
    name: 'conversation.close',
    permission: 'message.send',
    resourceType: 'conversation',
    input: THREAD_INPUT,
    requiresVersion: true,
    loadResource,

    rule({ entity }) {
      if (entity.status === 'closed') {
        throw new BusinessRuleError({
          code: 'conversation_already_closed',
          userMessage: 'השיחה כבר סגורה.',
        })
      }
    },

    async execute({ entity, tx, now }) {
      const db = clientFor(tx, options.db)
      const { error } = await db
        .from(CONVERSATIONS)
        .update({ status: 'closed', closed_at: now.toISOString() })
        .eq('id', entity.id)
        .eq('organization_id', entity.organizationId)

      if (error) throw error
      return { id: entity.id }
    },

    audit({ entity, result }) {
      return {
        resourceId: result.id,
        summary: 'סגר את השיחה.',
        before: { status: entity.status },
        after: { status: 'closed' },
      }
    },
  })

  /**
   * This reader has seen it. Nobody else's state is touched.
   *
   * The row is keyed by `(conversation_id, user_id)` and the policy pins
   * `user_id = auth.uid()`, so there is no shape of this call that could mark
   * a thread read for a colleague — which is the failure the table exists to
   * prevent.
   *
   * No `requiresVersion`: reading is not an edit of the conversation and must
   * not conflict with somebody replying to it at the same moment.
   */
  const markRead = defineOperation<
    { conversationId: string },
    Conversation,
    { at: string }
  >({
    name: 'conversation.mark_read',
    permission: 'message.view',
    resourceType: 'conversation',
    input: THREAD_INPUT,
    loadResource,

    async execute({ entity, context, tx, now }) {
      const db = clientFor(tx, options.db)
      const at = now.toISOString()

      const { error } = await db.from(READS).upsert(
        {
          conversation_id: entity.id,
          organization_id: entity.organizationId,
          user_id: context.actor.userId,
          last_read_at: at,
        },
        { onConflict: 'conversation_id,user_id' },
      )

      if (error) throw error
      return { at }
    },

    audit({ entity, result }) {
      return {
        resourceId: entity.id,
        summary: 'סימן את השיחה כנקראה עבורו.',
        after: { lastReadAt: result.at },
      }
    },
  })

  return {
    openFromSiteRequest,
    openFromGuestRequest,
    recordInbound,
    linkSentMessage,
    assign,
    close,
    markRead,
  }
}
