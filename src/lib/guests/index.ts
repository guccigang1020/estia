/**
 * The guest domain, in one import.
 *
 * One operation so far — creating a card. Updating, merging and blocking a
 * guest are still done nowhere, and adding them here is how they should be
 * done rather than from a route.
 */

export {
  GuestNotReadableError,
  GuestPhoneTakenError,
  defineGuestOperations,
  normalizeTags,
  type CreatedGuest,
  type GuestCreationOperation,
  type GuestDraft,
  type GuestOperations,
} from './operations'
