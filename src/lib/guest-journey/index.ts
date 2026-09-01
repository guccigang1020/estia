/**
 * The guest journey, in one import.
 *
 * ── EXECUTION CONTEXT — SERVER ONLY ───────────────────────────────────────
 *
 * This barrel re-exports `journey.ts`, `load.ts`, `collection.ts` and
 * `operations.ts`, which reach `src/lib/persistence`, `src/lib/supabase/server`
 * and the Postgres driver behind it. Importing this file from a Client
 * Component makes Next trace all of that into the browser bundle, and the
 * symptom is a 500 on a route that looks entirely innocent — which is exactly
 * how `/settings/payments` broke earlier today.
 *
 * **From a Client Component, import the leaf.** These four are pure — no
 * database, no Node builtins, no server-only imports — and are the ones a
 * form or a card actually needs:
 *
 *     @/lib/guest-journey/types          the vocabularies and the labels
 *     @/lib/guest-journey/steps          the progress list and the next action
 *     @/lib/guest-journey/reconfirmation the delta and its wording
 *     @/lib/guest-journey/link           the URL and the message
 *
 * ── What lives where ──────────────────────────────────────────────────────
 *
 *   types.ts           the vocabulary, mirroring migration 0034's enums
 *   journey.ts         the six guest-facing RPCs, and their refusals
 *   load.ts            one resolution of the journey per request
 *   collection.ts      the seam to the payment-collection module's resolver
 *   steps.ts           what is left to do, and the one thing to do first
 *   reconfirmation.ts  what changed since the guest said yes
 *   link.ts            the link, and the message it travels in
 *   operations.ts      what the BUSINESS does — send, rotate, revoke, release
 *   ports.ts           what is still owed by modules not yet written
 */

export {
  GUEST_JOURNEY_REFUSAL_CODES,
  GuestJourneyRefusedError,
  confirmBooking,
  declareCheckout,
  guestJourney,
  parseGuestJourney,
  saveDetails,
  signContract,
  submitRequest,
  type GuestConfirmResult,
  type GuestRequestResult,
  type GuestSignResult,
  type GuestWriteContext,
} from './journey'

export { loadGuestJourney } from './load'

export { guestCollection, type GuestCollection } from './collection'

export {
  GUEST_ACTION_IDS,
  GUEST_STEP_IDS,
  buildJourneyView,
  buildSteps,
  nextAction,
  type GuestActionId,
  type GuestJourneyView,
  type GuestNextAction,
  type GuestStep,
  type GuestStepId,
  type GuestStepStatus,
} from './steps'

export {
  compareTerms,
  describeParty,
  reconfirmationHeadline,
  type GuestTermsChange,
  type ReconfirmationVerdict,
} from './reconfirmation'

export {
  GUEST_PORTAL_PREFIX,
  channelHref,
  composeGuestMessage,
  guestLinkUrl,
  maskRecipient,
  type GuestMessage,
  type GuestMessageInput,
  type GuestMessagePurpose,
} from './link'

export {
  GuestLinkNotRevokedError,
  GuestLinkRevokedError,
  defineGuestJourneyOperations,
  mintGuestToken,
  type GuestJourneyOperations,
  type GuestLinkSendInput,
  type GuestLinkSendResult,
} from './operations'

export {
  COPY_ONLY_MESSAGING_PORT,
  NO_REBOOK_PORT,
  NO_STORE_PORT,
  NULL_GUEST_JOURNEY_PORTS,
  type GuestJourneyPorts,
  type GuestMessagingPort,
  type GuestOpenRange,
  type GuestRebookPort,
  type GuestStorePort,
  type GuestStoreSummary,
} from './ports'

export {
  GUEST_ARRIVAL_RELEASES,
  GUEST_ARRIVAL_RELEASE_LABEL,
  GUEST_CONTRACT_MODES,
  GUEST_DETAIL_FIELDS,
  GUEST_DETAIL_FIELD_KIND,
  GUEST_DETAIL_FIELD_LABEL,
  GUEST_LINK_CHANNELS,
  GUEST_LINK_CHANNEL_LABEL,
  GUEST_REQUEST_CATEGORIES,
  GUEST_REQUEST_CATEGORY_LABEL,
  GUEST_REQUEST_STATES,
  GUEST_REQUEST_STATE_LABEL,
  RECONFIRMATION_TRIGGERS,
  isGuestDetailField,
  type GuestArrival,
  type GuestArrivalRelease,
  type GuestCheckout,
  type GuestConfirmation,
  type GuestConfirmationSnapshot,
  type GuestContract,
  type GuestContractMode,
  type GuestDetailField,
  type GuestDetails,
  type GuestJourney,
  type GuestJourneySettings,
  type GuestJourneyTerms,
  type GuestLinkChannel,
  type GuestRequest,
  type GuestRequestCategory,
  type GuestRequestState,
  type GuestStay,
  type ReconfirmationTrigger,
} from './types'
