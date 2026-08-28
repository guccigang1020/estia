/**
 * The booking domain, in one import.
 *
 * The contract in `types.ts` is re-exported alongside the logic so that a
 * caller never has to know whether `BookingStatus` came from the shared shape
 * or from the state machine. There is one booking vocabulary.
 */

export * from './types'

export {
  PROPERTY_TIME_ZONE,
  addDays,
  describeDateChange,
  eachNight,
  formatDayMonth,
  formatDayMonthYear,
  formatRange,
  isIsoDate,
  localDate,
  parseIsoDate,
} from './dates'

export {
  BOOKING_SIDE_EFFECTS,
  BOOKING_STATUS_LABEL,
  BOOKING_TRANSITIONS,
  assertTransition,
  bookingResource,
  evaluateTransition,
  findTransition,
  legalNextStatuses,
  type BookingSideEffect,
  type BookingSnapshot,
  type BookingTransition,
  type TransitionCheck,
  type TransitionCondition,
  type TransitionContext,
  type TransitionRefusal,
} from './state-machine'

export {
  availabilityCalendar,
  checkAvailability,
  isOccupying,
  minimumNightsFor,
  type AvailabilityBlocker,
  type AvailabilityBlockerKind,
  type AvailabilityOptions,
  type AvailabilityResult,
  type AvailabilitySource,
  type AvailabilityWindow,
  type DayAvailability,
  type DayState,
  type OccupyingBooking,
  type UnitAvailabilityRules,
} from './availability'

export {
  HOLD_POLICY,
  HOLD_REASON_LABEL,
  assertHoldCovers,
  assertHoldIsLive,
  convertHold,
  countLiveHoldsBy,
  expiryFrom,
  extendHold,
  holdCovers,
  holdOverlaps,
  holdPolicyFor,
  isHoldLive,
  liveHolds,
  planHold,
  releaseHold,
  type HoldDraft,
  type HoldPolicy,
  type PlanHoldInput,
} from './holds'

export {
  agentCommissionLine,
  linesOfKind,
  priceStay,
  roundAgorot,
  sumLines,
  taxIncludedIn,
  type AddonRequest,
  type DiscountRequest,
  type StayPricingRequest,
  type StayQuote,
} from './pricing'

export type {
  BookingDraft,
  BookingPatch,
  BookingRepository,
  BookingStore,
  HoldStore,
} from './repository'

export {
  defineBookingOperations,
  type BookingOperations,
  type PricingInput,
} from './operations'
