/**
 * The metric dictionary, in one import.
 *
 * Every screen that shows a business figure goes through here. If a component,
 * a report, an export or a job divides revenue by nights on its own, it has
 * invented a second definition of ADR — and the day a customer notices the two
 * screens disagree is the day they stop believing the rest of the product.
 */

export {
  ALL_METRICS,
  METRIC_IDS,
  METRICS,
  NOT_APPLICABLE,
  formatMetricValue,
  isMetricId,
  sourceMix,
  type MetricDefinition,
  type MetricId,
  type SourceShare,
} from './dictionary'

export {
  MATERIAL_CHANGE_PERCENT,
  SEVERE_CHANGE_PERCENT,
  computeDashboard,
  evaluateState,
  type DashboardArgs,
  type DashboardRequest,
  type DashboardResponse,
  type MetricResult,
} from './dashboard'

export { aggregateFacts, type FactInput, type MetricFacts } from './facts'

export {
  addMonths,
  compareValues,
  comparisonRange,
  isWholeCalendarMonth,
  previousPeriod,
  previousYear,
  type CompareInput,
  type ComparisonBasis,
  type ComparisonMode,
  type MetricComparison,
} from './periods'

export {
  PERCENT_DECIMALS,
  agorotPer,
  allocateEvenly,
  allocateShares,
  averagePer,
  percentOf,
  roundAgorot,
  roundForUnit,
  roundPercent,
  roundTo,
  safeDivide,
} from './rounding'

export {
  DIRECT_SOURCES,
  POST_STAY_STATUSES,
  REALISED_STATUSES,
  isDirectSource,
  isSoldStatus,
  type BookingFactRow,
  type OutOfServiceRow,
  type UnitInventoryRow,
} from './rows'

export {
  MetricScopeError,
  describeScope,
  filterToScope,
  isRowInScope,
  resolveMetricScope,
  type ResolvedScope,
  type ScopeRefusal,
  type ScopeRequest,
} from './scope'

export {
  accessFingerprint,
  metricCacheKey,
  type CacheKeyInput,
} from './cache-key'

export type { MetricSource } from './source'

export {
  InMemoryMetricSource,
  makeBooking,
  makeUnit,
  type MetricSourceCalls,
  type MetricWorld,
} from './memory-source'

export {
  InvalidRangeError,
  METRIC_UNITS,
  assertValidRange,
  containsDate,
  isValidRange,
  rangeNights,
  toDateRange,
  type MetricRange,
  type MetricSentiment,
  type MetricState,
  type MetricThresholds,
  type MetricUnit,
  type MetricValue,
  type TrendDirection,
} from './types'
