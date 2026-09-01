/**
 * The laundry module, in one import.
 *
 * The load-bearing constraint is in `requirements.ts`: nothing here computes a
 * quantity. Every figure this module produces is a canonical preparation
 * requirement plus the item's own spare, rounded up to whole bundles — and
 * `no-hardcoded-numbers.test.ts` scans the directory to keep that true.
 *
 * `ports.ts` is the other one worth knowing about before reading anything
 * else: this module never imports the stock engine, and the reason is written
 * out in full at the top of that file.
 */

export * from './types'

export {
  addDays,
  addHours,
  earliest,
  hoursBetween,
  isAfter,
  isoDay,
  startOfDay,
} from './dates'

export {
  FORBIDDEN_IN_SIMPLE,
  LAUNDRY_SECTIONS,
  SECTIONS_BY_MODE,
  VOCABULARY,
  forbiddenSimpleWords,
  hasSection,
  isLaundryActive,
  producesInternalWork,
  routeFor,
  sectionsFor,
  sendsToProvider,
  vocabularyFor,
  type LaundrySection,
  type LaundryVocabulary,
} from './mode'

export {
  defaultSettings,
  laundryManagedItems,
  profileIndex,
  resolveSettings,
  sharesOperation,
  turnaroundFor,
  type ResolvedSettings,
} from './settings'

export {
  buildLaundryRequirements,
  mergeRequirements,
  type LaundryRequirementInput,
} from './requirements'

export {
  assessOne,
  assessTurnaround,
  atRisk,
  deadlineRiskPayload,
  latestPickupFor,
  type DeadlineRiskPayload,
  type TurnaroundInput,
} from './turnaround'

export { consolidate, meetsMinimum, runKey, totalsFrom } from './consolidation'

export {
  buildForecast,
  busiestDay,
  headlineFor,
  type ForecastInput,
} from './forecast'

export {
  FORBIDDEN_IN_PROVIDER_MESSAGE,
  containsProviderForbiddenField,
  renderOrderMessage,
  toMessageView,
  type MessageLine,
  type MessageProperty,
  type MessageViewInput,
  type OrderMessageView,
} from './message'

export {
  adjustmentStep,
  applyAdjustment,
  calculatedOnly,
  explainQuantity,
  isAdjusted,
  type AdjustmentInput,
} from './override'

export {
  buildOrder,
  isCommitted,
  orderReference,
  orderRequirementKey,
  orderUnits,
  type BuildOrderInput,
} from './orders'

export {
  assessStock,
  nullStockPort,
  shortagesOnly,
  type LaundryShortage,
  type LaundryStockLevel,
  type LaundryStockPort,
} from './ports'

export {
  LaundryOrderAlreadyExistsError,
  LaundryOrderClosedError,
  LaundryOrderHasNoProviderError,
  defineLaundryOperations,
  previewOrderMessage,
  type AdjustLineInput,
  type AdvanceOrderInput,
  type CreateOrderInput,
  type LaundryOperationPorts,
  type LaundryOperations,
  type SendOrderInput,
} from './operations'
