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
  defineLaundryCreation,
  defineLaundryOperations,
  defineLaundryOrderOperations,
  previewOrderMessage,
  type AdjustLineInput,
  type AdvanceOrderInput,
  type CreateOrderInput,
  type LaundryCreationOperations,
  type LaundryOperationPorts,
  type LaundryOperations,
  type LaundryOrderOperations,
  type SendOrderInput,
} from './operations'

export {
  EARLIER_DELIVERY_KEY,
  LaundryAlreadyDeliveredError,
  LaundryEarlierInThePastError,
  LaundryNotEarlierError,
  LaundryOrderNotSentError,
  defineLaundryCommands,
  type EarlierDeliveryRequest,
  type LaundryCommands,
  type RequestEarlierDeliveryInput,
} from './commands'

/**
 * The Postgres adapter behind everything above.
 *
 * Exported here rather than from `src/lib/persistence` deliberately.
 * `repository.ts` imports that barrel, so re-exporting it from there would
 * make a cycle for no gain — and `SupabasePaymentPolicyRepository` already
 * sets the precedent that a module's own adapter is published by the module's
 * own barrel.
 *
 * Reaching this from a `"use client"` file is the outage `client-safety.test.ts`
 * describes. Import the leaf — `@/lib/laundry/mode`, `@/lib/laundry/types` —
 * or use `import type`.
 */
export {
  LaundryLineDoesNotBelongError,
  LaundryLineFrozenError,
  SupabaseLaundryRepository,
  laundryOperationPorts,
  lineFromRow,
  orderFromRow,
  profileFromRow,
  providerFromRow,
  settingsFromRow,
  type AdjustLineWrite,
  type AdvanceOrderWrite,
  type CreatedLaundryOrder,
  type LaundryOrderDraft,
  type LaundryOrderLineDraft,
  type LaundryRepository,
  type ListOrdersOptions,
  type SendOrderWrite,
} from './repository'
