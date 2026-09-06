/**
 * The inbox vocabulary.
 *
 * ══ WHAT THIS MODULE IS ═════════════════════════════════════════════════════
 *
 * A conversation spine. It threads what arrives — a website enquiry, a guest
 * portal request, a reply on WhatsApp — against what was sent, so that
 * "what has this guest been told, and what are they still waiting for" has one
 * answer in one place.
 *
 * ══ WHAT IT IS NOT, AND THIS IS THE LOAD-BEARING PART ═══════════════════════
 *
 * It is **not** a second sending engine. `src/lib/messaging` composes and
 * sends, `guest_messages` records what was sent and what happened to it, and
 * this module does not duplicate a byte of that. An outbound message in a
 * thread is a REFERENCE to a `guest_messages` row — `OutboundMessage` below
 * has no `body` field at all, which is the same refusal the database makes in
 * `conversation_messages_outbound_is_a_reference`.
 *
 * Two answers to "what did we tell this guest" is one answer too many, and
 * they diverge the first time a send fails: the thread would show a message
 * and the truth would be that nothing left the building.
 *
 * It is also **not** a notification system. Who inside the business is told
 * about an arrival is `src/lib/notifications`, exactly as `messaging/index.ts`
 * says of itself.
 */

/** Threads move between these; `closed` is the only terminal one. */
export const CONVERSATION_STATUSES = [
  'open',
  /** We answered; the ball is with them. */
  'waiting_on_guest',
  /** They wrote; nobody has answered. This is the one the screen sorts by. */
  'waiting_on_us',
  'closed',
] as const

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number]

export const CONVERSATION_ORIGINS = [
  'site_request',
  'guest_request',
  'staff',
  'inbound_channel',
] as const

export type ConversationOrigin = (typeof CONVERSATION_ORIGINS)[number]

export const CONVERSATION_CHANNELS = [
  'email',
  'sms',
  'whatsapp',
  'site_form',
  'portal',
  'phone',
  'other',
] as const

export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number]

export type MessageDirection = 'inbound' | 'outbound'

/**
 * Who the thread is with.
 *
 * A guest when there is one, and a bare contact when there is not — a website
 * enquiry arrives from somebody who has never stayed. Refusing to thread that
 * until they become a guest would exclude the conversations with the most
 * money in them, which are the ones before a booking exists.
 */
export interface ConversationParty {
  readonly guestId: string | null
  readonly contactName: string | null
  readonly contactPhone: string | null
  readonly contactEmail: string | null
}

export interface Conversation {
  readonly id: string
  readonly organizationId: string
  readonly propertyId: string | null
  readonly party: ConversationParty
  readonly subject: string | null
  readonly status: ConversationStatus
  readonly origin: ConversationOrigin
  readonly siteRequestId: string | null
  readonly guestRequestId: string | null
  readonly assignedToUserId: string | null
  readonly lastMessageAt: Date | null
  /** When they last wrote. What "waiting on us since" is measured from. */
  readonly lastInboundAt: Date | null
  readonly openedAt: Date
  readonly closedAt: Date | null
  readonly version: number
}

/**
 * An arrival. Carries its own words, because nothing else in the schema
 * records them.
 */
export interface InboundMessage {
  readonly id: string
  readonly conversationId: string
  readonly direction: 'inbound'
  readonly channel: ConversationChannel
  readonly body: string
  readonly occurredAt: Date
}

/**
 * A send, as the thread sees it.
 *
 * **There is no `body` here and there must never be one.** The wording, the
 * channel actually used, and — crucially — whether it was delivered, deferred
 * or refused all live on the `guest_messages` row this points at. A reader
 * resolves them from there, which is why the thread can show "we replied, and
 * it never sent" instead of quietly implying the guest was answered.
 */
export interface OutboundMessage {
  readonly id: string
  readonly conversationId: string
  readonly direction: 'outbound'
  readonly channel: ConversationChannel
  readonly guestMessageId: string
  readonly authorUserId: string | null
  readonly occurredAt: Date
}

export type ConversationMessage = InboundMessage | OutboundMessage

/** True when this message is one the business sent. Narrows the union. */
export function isOutbound(
  message: ConversationMessage,
): message is OutboundMessage {
  return message.direction === 'outbound'
}
