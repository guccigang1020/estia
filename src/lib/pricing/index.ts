/**
 * The pricing module, in one import.
 *
 * ══ WHAT IS DELIBERATELY NOT EXPORTED ═══════════════════════════════════════
 *
 * 🔒 Nothing that takes a booking and returns money.
 *
 * `resolveStay` takes a full `PricingContext` and returns a request that
 * `priceStay` turns into lines. `describeSnapshot` takes a stored row and
 * returns what was written on it. There is no third shape, and a function that
 * accepted a booking id and returned a total would be the change that broke
 * the freeze — a stay priced in March would silently become a stay priced
 * today, and the new number would look every bit as plausible as the old one.
 *
 * The money itself lives in `booking_price_lines` and in
 * `bookings.total_agorot`, which the database maintains as a sum of them
 * (0009). This module produces the INPUTS to that and the EXPLANATION of it,
 * and never both a price and a second opinion about a price.
 */

export {
  BPS_PER_UNIT,
  DEFAULT_WEEKEND_WEEKDAYS,
  MAX_DERIVATION_DEPTH,
  MAX_SUGGESTION_BATCH,
  PRICING_ENGINE_VERSION,
  RATE_CALENDAR_SOURCES,
  RATE_MODIFIER_KINDS,
  RATE_PLAN_KINDS,
  RATE_SCOPES,
  RATE_SUGGESTION_STATUSES,
  SPECIFICITY,
  type BookingPriceSnapshot,
  type DynamicPricingPolicy,
  type ModifierTrigger,
  type NightBaseOrigin,
  type NightResolution,
  type PricingContext,
  type PricingRefusal,
  type PricingResolution,
  type RateCalendarEntry,
  type RateCalendarSource,
  type RateDerivation,
  type RateModifier,
  type RateModifierKind,
  type RatePlan,
  type RatePlanKind,
  type RateRule,
  type RateScope,
  type RateSuggestion,
  type RateSuggestionStatus,
} from './types'

export {
  advanceDays,
  computeSpecificity,
  resolveDerivation,
  resolveStay,
  selectRatePlan,
  type ResolvedStay,
} from './resolve'

export {
  buildSnapshot,
  describeSnapshot,
  nightlyFiguresOf,
  snapshotHasDrifted,
  type SnapshotDraft,
  type SnapshotInputs,
  type SnapshotResolution,
} from './snapshot'

export {
  SUGGESTION_TTL_HOURS,
  approvalBlockers,
  autoApplyDecision,
  suggestionDeltaBps,
  suggestionExpiry,
  type AutoApplyBlocker,
  type AutoApplyFacts,
} from './suggestions'

export {
  NIGHT_BASE_ORIGIN_LABEL,
  PRICING_NOTE,
  RATE_CALENDAR_SOURCE_LABEL,
  RATE_MODIFIER_KIND_LABEL,
  RATE_PLAN_KIND_LABEL,
  RATE_SCOPE_LABEL,
  SUGGESTION_STATUS_LABEL,
  UNMEASURABLE_REASON,
  blockerMessage,
  formatAgorotShort,
  formatBps,
  refusalMessage,
} from './labels'

export {
  datesBetween,
  definePricingOperations,
  type PricingOperations,
  type PricingPorts,
  type RateRuleWithProperty,
} from './operations'

export {
  PricingRepository,
  toCalendarEntry,
  toRateModifier,
  toRatePlan,
  toRateRule,
  toSuggestion,
} from './repository'
