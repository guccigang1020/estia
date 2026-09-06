/**
 * The guest register, in one import.
 *
 * The module claims nothing about what any business is required to record.
 * Every field requirement it exposes is configuration an operator sets, the
 * capability is off until they turn it on, and the responsibility for
 * establishing what their own business must keep is theirs — stated on the
 * screen as well as here. See `types.ts` for why that silence is the honest
 * position rather than an omission.
 *
 * Nothing here reaches a database. The read side lives in
 * `src/app/(app)/guest-book/_lib/queries.ts`.
 */

export {
  GUEST_BOOK_ENTRY_STATUSES,
  GUEST_BOOK_FIELDS,
  type GuestAddress,
  type GuestBookEntry,
  type GuestBookEntryStatus,
  type GuestBookField,
} from './types'

export {
  CONFIGURABLE_FIELDS,
  STRUCTURAL_FIELDS,
  defaultGuestBookConfig,
  effectiveRequiredFields,
  isGuestBookEnabledFor,
  rejectedFieldChoices,
  requiresField,
  type GuestBookConfig,
} from './config'

export {
  BOOKING_LIFECYCLES,
  applyBookingFacts,
  changedFields,
  missingRequiredFields,
  type BookingFacts,
  type BookingLifecycle,
  type GuestBookOutcome,
} from './generation'

export {
  GUEST_BOOK_FIELD_HELP,
  GUEST_BOOK_FIELD_LABEL,
  GUEST_BOOK_STATUS_LABEL,
} from './labels'
