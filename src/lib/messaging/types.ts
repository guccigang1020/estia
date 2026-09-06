/**
 * The vocabulary of a message.
 *
 * ══ WHAT THIS MODULE IS, IN ONE PARAGRAPH ═══════════════════════════════════
 *
 * `src/lib/notifications` already decides who inside the business is told
 * about what, on which channel, and whether now — five gates, a transport
 * port, a null transport and an evidence table. None of that is repeated here.
 *
 * What was missing is the DOMAIN COMMAND layer: three operations Autopilot's
 * catalogue names and its executor records as `command_not_implemented`. Two
 * of them are addressed to staff and are answered by handing the existing
 * notifications engine a candidate list; one of them is addressed to a GUEST,
 * who has no `Actor`, no membership, no preference row and no bell panel, and
 * therefore falls outside that engine entirely. The guest half is the only
 * genuinely new storage in this module.
 *
 * ══ NOTHING HERE MINTS A SECOND VOCABULARY ══════════════════════════════════
 *
 * `GuestChannel` is `Extract`ed from `NotificationChannel` rather than
 * declared, so it is a SUBSET by construction: delete `sms` from
 * `NOTIFICATION_CHANNELS` and the array literal below stops compiling. And
 * `MessageOutcome` is `NotificationDeliveryStatus` unchanged — the seven
 * states 0043 already models are exactly the seven an outward message can be
 * in, and a parallel enum would be a second answer to "what happened to it".
 *
 * The one addition is `GuestMessageKind`, and it is deliberately closed at
 * three: each member maps to a name already in the frozen event catalogue, so
 * a fourth kind cannot be added without somebody first finding an event for
 * it. See `EVENT_FOR_KIND` below.
 */

import type {
  NotificationCategory,
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationSeverity,
} from '../notifications/types'
import type { DomainEventName } from '../contracts/events'

/* --------------------------------------------------------------- channels -- */

/**
 * How a guest can be reached.
 *
 * `in_app` and `push` are absent because a guest has no account and no device
 * registration — the guest portal is a capability URL, not a session. What is
 * left is the three channels that carry text to somebody outside the business,
 * and today none of them has a provider behind it. That is a state, not a
 * silence; see `null-provider.ts`.
 */
export type GuestChannel = Extract<
  NotificationChannel,
  'whatsapp' | 'sms' | 'email'
>

export const GUEST_CHANNELS: readonly GuestChannel[] = [
  'whatsapp',
  'sms',
  'email',
]

export function isGuestChannel(value: string): value is GuestChannel {
  return (GUEST_CHANNELS as readonly string[]).includes(value)
}

/* ---------------------------------------------------------------- outcome -- */

/**
 * What became of a message.
 *
 * Re-exported rather than redefined. The two members that carry the whole
 * honesty argument of this module are already there and already mean the right
 * thing:
 *
 *   · `not_configured` — the BUSINESS is missing a transport. The message was
 *     composed and recorded and nothing left the building.
 *   · `suppressed` — a PERSON said no. Their preference, their severity floor,
 *     or the organization switching the channel off.
 *
 * Merging those two would tell a guesthouse to buy an SMS gateway that its own
 * staff had switched off. They are counted separately everywhere.
 *
 * `delivered` exists in the vocabulary and is never written by this module for
 * an outward message: no provider in this codebase can confirm that a guest
 * received anything, and a status nothing can produce honestly is one nothing
 * here produces at all.
 */
export type MessageOutcome = NotificationDeliveryStatus

/** The outcomes that mean a person was actually reached, or soon will be. */
export function claimsDelivery(outcome: MessageOutcome): boolean {
  return outcome === 'sent' || outcome === 'delivered'
}

/* ------------------------------------------------------------------ kinds -- */

/**
 * Why a guest is being written to.
 *
 * Exactly the three external-communication actions Autopilot's catalogue is
 * blocked on — `guest.send_reminder`, `guest.send_arrival_info` and
 * `guest.request_review` — and no more. A "general message" member would be a
 * hole in the mapping below, because there is no domain event in the frozen
 * catalogue for "somebody typed something at a guest".
 */
export const GUEST_MESSAGE_KINDS = [
  'payment_reminder',
  'arrival_info',
  'review_request',
] as const

export type GuestMessageKind = (typeof GUEST_MESSAGE_KINDS)[number]

/**
 * The frozen event each kind raises.
 *
 * `src/lib/contracts/events.ts` is not editable from here and is not edited.
 * All three of these already exist and already mean what is claimed:
 *
 *   · `payment.instructions_sent` — the collection policy's own event.
 *     `guest-journey/operations.ts` raises it when the guest link goes out,
 *     for the same reason it is raised here: in this product, telling a guest
 *     how to pay IS sending the instructions.
 *   · `arrival.instructions_released` — the door code and the directions.
 *   · `booking.review_requested` — the post-stay ask.
 */
export const EVENT_FOR_KIND: Record<GuestMessageKind, DomainEventName> = {
  payment_reminder: 'payment.instructions_sent',
  arrival_info: 'arrival.instructions_released',
  review_request: 'booking.review_requested',
}

/**
 * Whether the guest has to have agreed to receive this.
 *
 * The distinction is not decoration and it is not a legal opinion: a guest who
 * has switched off marketing has not thereby asked to stop being told the door
 * code of the room they are arriving at tonight. Withholding an arrival
 * instruction on a marketing preference would be a product that locks its own
 * guests out.
 *
 * So consent gates the review request, which is an ask on the business's
 * behalf, and gates neither of the two that are about the stay the guest has
 * already bought.
 */
export function requiresMarketingConsent(kind: GuestMessageKind): boolean {
  return kind === 'review_request'
}

/**
 * How a kind is classified when it is routed like anything else.
 *
 * Same two axes the notification catalogue uses, so a screen counting guest
 * messages beside staff notifications is counting on one scale rather than
 * two.
 */
export const KIND_CATEGORY: Record<GuestMessageKind, NotificationCategory> = {
  payment_reminder: 'money',
  arrival_info: 'guest',
  review_request: 'guest',
}

/**
 * How loud each one is.
 *
 * Only the payment reminder rises to `attention`, and none of them is
 * `urgent`. That matters at exactly one place — `quietHoursVerdict` lets
 * `urgent` and above through the night when the organization allows it — and a
 * review request that woke a guest at two in the morning would be the single
 * worst message this product could send.
 */
export const KIND_SEVERITY: Record<GuestMessageKind, NotificationSeverity> = {
  payment_reminder: 'attention',
  arrival_info: 'info',
  review_request: 'info',
}

/* ----------------------------------------------------------------- labels -- */

/** Hebrew. `CHANNEL_LABEL` and `DELIVERY_STATUS_LABEL` come from notifications. */
export const KIND_LABEL: Record<GuestMessageKind, string> = {
  payment_reminder: 'תזכורת תשלום',
  arrival_info: 'פרטי הגעה',
  review_request: 'בקשת חוות דעת',
}

/* ---------------------------------------------------------------- records -- */

/**
 * Who the message is going to, as this module needs to know them.
 *
 * A flat projection rather than the guest row, because the operation must not
 * become a second place that decides what `guests.marketing_consent` means or
 * which column holds a telephone number. Whoever builds this has already read
 * the row under `guest.view_phone` / `guest.view_email`.
 */
export interface GuestRecipient {
  guestId: string
  /** For the greeting. First name only, matching what 0033 discloses. */
  firstName: string | null
  /** `null` when the guest has none on file. */
  phone: string | null
  email: string | null
  marketingConsent: boolean
  /** Defaults to Hebrew. Nothing here translates; it is recorded. */
  language: string
}

/** What the guest message is about. Composed once and stored, never re-rendered. */
export interface GuestMessageSubject {
  bookingId: string
  propertyId: string | null
  /** The human booking reference, e.g. `B-2026-0141`. */
  reference: string
  organizationName: string
  propertyName: string | null
  /** Already formatted — this module does not own date wording. */
  checkIn: string
  checkOut: string
  /**
   * Where the guest goes. Absolute, and passed in rather than built: the host
   * a GUEST opens is not what a server module knows about itself.
   */
  portalUrl: string | null
  /** Agorot still owed. Only read for `payment_reminder`. */
  outstandingAgorot: number | null
}

/** One outward message, as the product reads it back. */
export interface GuestMessageRecord {
  id: string
  organizationId: string
  propertyId: string | null
  bookingId: string
  guestId: string
  kind: GuestMessageKind
  channel: GuestChannel
  /** Only email has one. */
  subject: string | null
  /** Hebrew, composed at send time and frozen. */
  body: string
  /**
   * Enough to recognise where it went, never enough to be a contact list.
   * `null` when nothing usable was recorded — see `maskRecipient`.
   */
  recipientMasked: string | null
  outcome: MessageOutcome
  /**
   * English, diagnostic, for whoever reads the table. The Hebrew a person sees
   * comes from the label maps — a provider's own words never reach a screen.
   */
  outcomeDetail: string | null
  /** The provider that answered. `none` for the null provider. */
  provider: string | null
  providerMessageId: string | null
  /** Set only for `deferred`. A deferral with no time is a message that never goes. */
  scheduledFor: Date | null
  correlationId: string | null
  /**
   * Stable across retries of the same intent.
   *
   * Derived from the booking, the kind, the channel and the caller's own
   * idempotency key — which `contracts/events.ts` defines as stable across
   * retries and which every Autopilot dispatch carries. The guarantee is a
   * unique index rather than a caller remembering to look first, so a
   * redelivered action is a failed insert instead of a second message to a
   * guest who has already had one.
   */
  dedupeKey: string
  createdBy: string | null
  createdAt: Date
  settledAt: Date | null
}

/** Everything but the identity the database assigns. */
export type GuestMessageDraft = Omit<GuestMessageRecord, 'id' | 'createdAt'>

/** How many outward messages ended in each state, over a window. */
export type OutcomeTally = Record<MessageOutcome, number>
