/**
 * The inbox module, in one import.
 *
 * Everything here is pure — vocabulary, threading, counting — so a Client
 * Component can import this barrel. The repository and the operations reach
 * PostgREST and are imported by path from server code, which is the rule
 * `messaging/index.ts` sets out and `scripts/client-bundle.mjs` enforces.
 *
 * `src/lib/messaging` is not re-exported and not wrapped. This module sits
 * above it: a thread REFERENCES a `guest_messages` row and never restates it.
 */

export {
  CONVERSATION_CHANNELS,
  CONVERSATION_ORIGINS,
  CONVERSATION_STATUSES,
  isOutbound,
  type Conversation,
  type ConversationChannel,
  type ConversationMessage,
  type ConversationOrigin,
  type ConversationParty,
  type ConversationStatus,
  type InboundMessage,
  type MessageDirection,
  type OutboundMessage,
} from './types'

export {
  findThread,
  normaliseEmail,
  normalisePhone,
  statusAfterMessage,
  type ThreadingOptions,
} from './threading'

export {
  byLongestWait,
  countInbox,
  hoursWaiting,
  isUnreadFor,
  type InboxCounts,
  type ReadMarks,
} from './unread'
