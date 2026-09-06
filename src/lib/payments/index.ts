/**
 * What a guest must do before a booking is confirmed, in one import.
 *
 * The rule this module exists to hold: **`resolveCollectionPolicy` is the only
 * function in the product that answers it.** Every screen, the guest portal
 * and the booking flow call it. Nothing recomputes a shortfall, re-derives a
 * requirement or decides on its own whether a deposit has landed.
 *
 * Payment state and booking state stay two machines — see the header of
 * `resolver.ts`. Nothing here reads or writes a booking status.
 *
 * ── SERVER ONLY ───────────────────────────────────────────────────────────
 *
 * This barrel re-exports `repository.ts`, which imports `src/lib/persistence`
 * and through it the `postgres` driver. Next traces that into any client
 * bundle that touches this file and the build fails with a module-not-found
 * for `perf_hooks` — which is what the settings screen did before its two
 * forms were narrowed. A `'use client'` component imports the leaf it needs
 * (`./channels`, `./types`, `./resolver`, `./guest-action`), never this file.
 */

export {
  MANUAL_CHANNEL_HINT,
  MANUAL_CHANNEL_LABEL,
  MANUAL_PAYMENT_CHANNELS,
  PAYMENT_METHOD_FOR_CHANNEL,
  isManualPaymentChannel,
  requiresInstructions,
  type ManualPaymentChannel,
} from './channels'

export {
  ALL_CONFIRMATION_REQUIREMENTS,
  COLLECTION_POLICY_DESCRIPTION,
  COLLECTION_POLICY_LABEL,
  REQUIREMENT_DESCRIPTION,
  REQUIREMENT_LABEL,
  formatAgorot,
  resolveCollectionPolicy,
  type CollectionDecision,
  type PolicySource,
  type RequirementCheck,
  type ResolveInput,
} from './resolver'

export {
  GUEST_ACTION_KINDS,
  guestChannels,
  nextGuestAction,
  type GuestAction,
  type GuestActionInput,
  type GuestActionKind,
} from './guest-action'

export {
  DEFAULT_COLLECTION_SETTINGS,
  NO_COLLECTION_FACTS,
  PAYMENT_PROOF_REVIEWS,
  PAYMENT_PROOF_REVIEW_LABEL,
  type CollectionFacts,
  type CollectionOverride,
  type CollectionSettings,
  type GuestChannel,
  type ManualChannel,
  type PaymentProof,
  type PaymentProofReview,
} from './types'

export {
  InMemoryPaymentPolicyRepository,
  SupabasePaymentPolicyRepository,
  channelFromRow,
  overrideFromRow,
  proofFromRow,
  settingsFromRow,
  type CollectionOverrideDraft,
  type CollectionSettingsDraft,
  type ManualChannelDraft,
  type PaymentPolicyRepository,
  type PaymentProofDraft,
} from './repository'

export {
  definePaymentPolicyOperations,
  type PaymentPolicyOperations,
  type PaymentPolicyOperationsDeps,
} from './operations'

export {
  manualPaymentInput,
  type ManualPaymentRequest,
  type RecordPaymentInput,
} from './manual-payment'

export {
  NO_PROOF_STORAGE,
  NoProofStorageError,
  proofStorageAvailable,
  type ProofStorage,
  type StoredProof,
  type UploadTicket,
} from './storage'

export {
  definePaymentRequestCommands,
  type PaymentRequestCommands,
  type PaymentRequestDeps,
  type PaymentRequestInput,
  type RequestedPayment,
} from './requests'
