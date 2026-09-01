/**
 * The store, in one import.
 *
 * The rule this barrel is written to keep visible: **there is exactly one
 * function that turns a catalogue price into an order figure**, and it is
 * `snapshotLine`. Everything else here reads a snapshot or reads a catalogue,
 * and nothing crosses between the two.
 */

export type {
  BookingFacts,
  CatalogueItem,
  OrderLineOptionSnapshot,
  OrderLineSnapshot,
  StoreAmendmentStatus,
  StoreAudience,
  StoreAvailabilityRule,
  StoreAvailabilityRuleKind,
  StoreCancellationPolicy,
  StoreCategory,
  StoreFulfilmentRecipe,
  StoreItemAddon,
  StoreItemOption,
  StoreItemOptionValue,
  StoreItemPropertyOverride,
  StoreItemQuestion,
  StoreOrder,
  StoreOrderAmendment,
  StoreOrderPayment,
  StoreOrderSource,
  StorePackage,
  StorePriceSource,
  StorePromoCode,
  StoreProvider,
  StoreProviderRequest,
  StoreSettings,
} from './types'
export { partySize } from './types'

export {
  STORE_MODE_LABEL,
  STORE_MODE_SUMMARY,
  offerablePaymentModes,
  showsVocabulary,
  storeCapabilities,
  type StoreCapabilities,
} from './mode'

export {
  addonsTotalAgorot,
  evaluatePromoCode,
  nightsBetween,
  optionsTotalAgorot,
  priceSourceFor,
  quantityFor,
  quantityIsChosenByGuest,
  resolveAddons,
  resolveOptions,
  unitPriceFor,
  type ChosenAddon,
  type ChosenOption,
  type PromoOutcome,
  type PromoRefusal,
  type ResolvedAddon,
  type ResolvedOption,
} from './pricing'

export {
  draftSubtotalAgorot,
  snapshotLine,
  type LineSnapshotDraft,
  type SnapshotRequest,
} from './snapshot'

export {
  defaultServiceAt,
  evaluateEligibility,
  nullOccupancy,
  type EligibilityCaveat,
  type EligibilityInput,
  type EligibilityReason,
  type EligibilityVerdict,
  type OccupancyAnswer,
  type OccupancyFacts,
  type OccupancyPort,
} from './eligibility'

export {
  assertAmendable,
  assertTransition,
  canTransition,
  draftOrderTotals,
  initialStatusFor,
  isCommitted,
  isOverdue,
  isTerminal,
  orderAttention,
  orderTotalAgorot,
  proposeAmendment,
  type AmendmentProposal,
  type OrderAttention,
} from './orders'

export {
  manualPaymentPort,
  paymentInstructionFor,
  paymentStatusFor,
  type PaymentInstruction,
  type PaymentPort,
  type PaymentPreparation,
  type PaymentRecord,
  type RecordedPayment,
} from './payment'

export {
  linesNeedingProvider,
  tasksForLine,
  tasksForOrder,
  type TaskDraft,
} from './fulfilment'

export {
  canReach,
  mintProviderReference,
  providerBriefFor,
  renderProviderRequest,
  type ProviderBrief,
} from './provider-request'

export {
  partyShapeOf,
  relevanceScore,
  sectionsFor,
  type PartyShape,
  type StoreSection,
} from './personalization'

export {
  planForCancelledBooking,
  planForGuestCountChange,
  planForMovedDates,
  type CancellationOutcome,
  type DateChangeException,
  type DateChangePlan,
  type GuestCountAmendment,
  type OrderCancellationPlan,
} from './propagation'

export {
  EMPTY_CART,
  cartCount,
  isCartExpired,
  revalidateCart,
  type Cart,
  type CartChange,
  type CartChangeKind,
  type CartLine,
  type CartRevalidation,
  type RevalidatedLine,
} from './cart'

export {
  operationIdempotencyKey,
  submissionFingerprint,
  submissionKey,
  type SubmissionInput,
  type SubmissionLine,
} from './idempotency'

export * from './labels'

export { StoreRepository } from './repository'

export {
  defineStoreOperations,
  type CreatedOrder,
  type CreatedProduct,
  type OrderDraft,
  type ProductDraft,
  type SettingsDraft,
  type StoreOperations,
} from './operations'

export {
  bookingFactsFrom,
  guestStoreView,
  propertyCapabilities,
  type GuestOrderSubmission,
  type GuestOrderWriter,
  type GuestStoreCard,
  type GuestStoreView,
} from './portal'
