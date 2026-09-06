/**
 * Messaging, in one import.
 *
 * ── What this module is ───────────────────────────────────────────────────
 *
 * The DOMAIN COMMAND layer for telling somebody something: three operations
 * built with `defineOperation`, so Autopilot deciding that a guest should be
 * reminded runs the same code path as a person clicking the button, with the
 * same permission gate, the same validation, the same transaction and the same
 * audit event.
 *
 * ── What it deliberately is not ───────────────────────────────────────────
 *
 * It is **not** a second notification system. Who inside the business is told
 * about what, on which channel, and whether now, is decided entirely by
 * `src/lib/notifications` — routing, preferences, quiet hours, escalation,
 * dedupe and the transport port. Two of the three operations here are that
 * engine plus a permission gate and an audit event.
 *
 * It is **not** a WhatsApp, SMS or e-mail client. `provider.ts` declares the
 * port; `null-provider.ts` is what ships. With nothing configured a guest
 * message is composed, recorded with `outcome: 'not_configured'`, and reported
 * as exactly that — never as sent, and with no domain event raised, because an
 * event is the past tense of something the business did.
 *
 * ── Where to start reading ────────────────────────────────────────────────
 *
 *   `types.ts`         the vocabulary, all of it borrowed rather than minted
 *   `delivery.ts`      the two gates, in order, with the reasons
 *   `null-provider.ts` the honest gap, and why it is an argument
 *   `operations.ts`    the three commands, and what each one reuses
 *
 * ── `repository.ts` is not exported from here ─────────────────────────────
 *
 * It reaches PostgREST, and a barrel that carries a database adapter is how a
 * Client Component ends up resolving `fs` — the failure `scripts/
 * client-bundle.mjs` exists to catch, which took this application down three
 * times in one day. A server module that needs the adapter imports
 * `@/lib/messaging/repository` directly, by name, where a reviewer can see it.
 */

export {
  compose,
  isUsableAddress,
  maskRecipient,
  recipientAddress,
  type ComposedMessage,
} from './compose'

export {
  planOutward,
  quietHoursHold,
  type MessageDirection,
  type OutwardPlan,
} from './delivery'

export {
  defaultMessageProviderRegistry,
  NULL_PROVIDER_NAME,
  NullMessageProvider,
  nullProviderFor,
} from './null-provider'

export {
  defineMessagingOperations,
  type GuestMessageSource,
  type MessagingOperationDeps,
  type MessagingOperations,
  type NotifyResult,
  type SendGuestMessageInput,
  type SendGuestMessageResult,
  type StaffRecipientSource,
} from './operations'

export {
  MessageProviderRegistry,
  type MessageProvider,
  type OutboundGuestMessage,
  type ProviderResult,
} from './provider'

export {
  claimsDelivery,
  EVENT_FOR_KIND,
  GUEST_CHANNELS,
  GUEST_MESSAGE_KINDS,
  isGuestChannel,
  KIND_CATEGORY,
  KIND_LABEL,
  KIND_SEVERITY,
  requiresMarketingConsent,
  type GuestChannel,
  type GuestMessageDraft,
  type GuestMessageKind,
  type GuestMessageRecord,
  type GuestMessageSubject,
  type GuestRecipient,
  type MessageOutcome,
  type OutcomeTally,
} from './types'
