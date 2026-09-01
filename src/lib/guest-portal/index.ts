/**
 * The guest portal's floor, in one import.
 *
 * A guest is the only person who reaches ESTIA without an account. Everything
 * that makes that safe lives here: the capability, the projection it resolves
 * to, and the refusals. Screens under `src/app/g` consume this and never talk
 * to `bookings` themselves — there is no policy that would let them.
 */

export { loadGuestSession } from './load'

export {
  GUEST_LINK_REFUSAL_CODES,
  GuestLinkRefusedError,
  guestSession,
  markGuestPortalOpened,
  nightsBetween,
  totalGuests,
  type GuestSession,
} from './session'
