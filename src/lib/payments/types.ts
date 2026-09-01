/**
 * The records this module owns, and nothing else.
 *
 * Every state vocabulary here is imported from `src/lib/contracts/states.ts`
 * and none is redefined. The one new list — `MANUAL_PAYMENT_CHANNELS` — lives
 * in `channels.ts` beside the argument for why it is a separate list rather
 * than a widening of a frozen one.
 */

import type { Agorot } from '../booking/types'
import type {
  ConfirmationRequirement,
  PaymentCollectionPolicy,
} from '../contracts/states'

import type { ManualPaymentChannel } from './channels'

/* ------------------------------------------------------------- settings -- */

/**
 * What the organization asks of every guest by default.
 *
 * The absence of a row means these values. That is stated as a constant rather
 * than left to each caller, because "no settings row yet" and "settings that
 * say `none`" must be the same thing everywhere — a screen that treats the
 * first as an unfinished setup is a screen nagging the majority of this
 * product's customers to configure something they have already decided.
 */
export interface CollectionSettings {
  policy: PaymentCollectionPolicy
  requirements: readonly ConfirmationRequirement[]
  /** Basis points. 3000 is 30%, never 30. Mutually exclusive with the fixed sum. */
  depositPercentBps: number | null
  depositFixedAgorot: Agorot | null
  /** Days before arrival the remainder is expected. `null` is no stated deadline. */
  balanceDueDaysBefore: number | null
  /**
   * Whether a live-payment call to action may be rendered at all.
   *
   * Read, never assumed. A guest page that offers "pay now" to a business with
   * no processor sends somebody to a dead end while holding their money's
   * worth of goodwill.
   */
  livePaymentsEnabled: boolean
  /** The provider's name, and never a credential. */
  liveProvider: string | null
  guestInstructions: string | null
}

export const DEFAULT_COLLECTION_SETTINGS: CollectionSettings = {
  policy: 'none',
  requirements: [],
  depositPercentBps: null,
  depositFixedAgorot: null,
  balanceDueDaysBefore: null,
  livePaymentsEnabled: false,
  liveProvider: null,
  guestInstructions: null,
}

/* ------------------------------------------------------------ overrides -- */

/**
 * What this one booking asks, when it is not what everybody is asked.
 *
 * `reason` is not optional, in the type and in the column. The default might
 * be a 30% deposit and this booking might be "no deposit, manual approval";
 * that is ordinary, and the only thing that makes it accountable is that
 * somebody said why.
 */
export interface CollectionOverride {
  id: string
  bookingId: string
  policy: PaymentCollectionPolicy
  requirements: readonly ConfirmationRequirement[]
  depositPercentBps: number | null
  depositFixedAgorot: Agorot | null
  balanceDueDaysBefore: number | null
  reason: string
  setByUserId: string | null
  setAt: Date
  version: number
}

/* --------------------------------------------------------------- channel - */

export interface ManualChannel {
  id: string
  channel: ManualPaymentChannel
  enabled: boolean
  /** `null` falls back to `MANUAL_CHANNEL_LABEL`. Not copied into every row. */
  displayName: string | null
  instructions: string | null
  sortOrder: number
}

/** What a guest is shown. A subset on purpose — see `guest-action.ts`. */
export interface GuestChannel {
  channel: ManualPaymentChannel
  label: string
  instructions: string | null
}

/* ----------------------------------------------------------------- proof - */

export const PAYMENT_PROOF_REVIEWS = [
  'pending',
  'accepted',
  'rejected',
] as const

export type PaymentProofReview = (typeof PAYMENT_PROOF_REVIEWS)[number]

export const PAYMENT_PROOF_REVIEW_LABEL: Record<PaymentProofReview, string> = {
  pending: 'ממתין לבדיקה',
  accepted: 'אושר',
  rejected: 'נדחה',
}

export interface PaymentProof {
  id: string
  organizationId: string
  propertyId: string
  bookingId: string
  /** Opaque. Interpreted only by the `ProofStorage` port — see `storage.ts`. */
  storageKey: string
  fileName: string
  contentType: string
  byteSize: number
  checksumSha256: string | null
  submittedByGuest: boolean
  submittedByUserId: string | null
  submittedAt: Date
  note: string | null
  review: PaymentProofReview
  reviewedAt: Date | null
  reviewedByUserId: string | null
  reviewNote: string | null
  paymentId: string | null
}

/* ----------------------------------------------------------------- facts - */

/**
 * What is actually true of this booking right now.
 *
 * Deliberately not a booking record. The resolver must be answerable from
 * facts a guest portal, a booking screen and a unit test can all produce, and
 * a resolver that took a `Booking` would be a resolver only the booking module
 * could call.
 *
 * The two deposit figures are separate because `deposit_recorded` and
 * `deposit_paid_live` are separate requirements. A business that demands the
 * money be taken on a card is not satisfied by a bank transfer somebody says
 * they made, and collapsing the two would silently satisfy the stricter rule
 * with the weaker evidence.
 */
export interface CollectionFacts {
  /** The booking's own total. The basis a percentage deposit is taken of. */
  bookingTotalAgorot: Agorot
  /** Captured less refunded, all channels. */
  settledAgorot: Agorot
  /** Captured less refunded, through a payment provider only. */
  settledLiveAgorot: Agorot
  managerApproved: boolean
  guestConfirmed: boolean
  contractSigned: boolean
  /** At least one receipt has been uploaded and not rejected. */
  proofSubmitted: boolean
}

export const NO_COLLECTION_FACTS: CollectionFacts = {
  bookingTotalAgorot: 0,
  settledAgorot: 0,
  settledLiveAgorot: 0,
  managerApproved: false,
  guestConfirmed: false,
  contractSigned: false,
  proofSubmitted: false,
}
