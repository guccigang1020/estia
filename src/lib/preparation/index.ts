/**
 * Preparation and event costing, in one import.
 *
 * Two engines over one booking: the rules that turn it into a countable work
 * plan, and the costing that turns the same booking into a profit figure. They
 * share the measurement — `PreparationFacts` — so the plan and the statement
 * can never disagree about how big the booking was.
 *
 * The load-bearing constraint is in `snapshot.ts`: nothing here computes from
 * live configuration except `captureSnapshot`, so changing a rule today cannot
 * move a booking from last month.
 */

export * from './types'

export {
  applyBuffer,
  effectiveOn,
  evaluateCondition,
  factValue,
  resolveQuantity,
  type EffectiveDated,
} from './rules'

export {
  allocateSleeping,
  bedTypeIndex,
  permanentCapacityOf,
  type SleepingAllocationInput,
} from './sleeping'

export {
  applicableRules,
  categoryQuantity,
  computeRequirements,
  measureFacts,
  requirementQuantity,
  sectionRequirements,
  templateSections,
} from './requirements'

export {
  LINEN_TRANSITIONS,
  assertLinenTransition,
  canTransitionLinen,
  checkInventory,
  type InventoryCheckInput,
} from './inventory'

export {
  SECTION_DEPENDENCIES,
  assessTurnover,
  buildWorkPlan,
  completeSection,
  criticalPath,
  criticalPathMinutes,
  outstandingItems,
  recordProgress,
  type CompleteSectionInput,
  type CompletionOutcome,
  type OutstandingItem,
  type ProgressInput,
  type TurnoverAssessment,
  type WorkPlanInput,
} from './work-plan'

export {
  carryProgress,
  computeDelta,
  describeDelta,
  versionPlan,
  type VersionInput,
} from './delta'

export {
  estimateStaffing,
  labourCostOf,
  type StaffingInput,
} from './complexity'

export { computeReadiness, hoursUntil, type ReadinessInput } from './readiness'

export {
  accommodationRevenue,
  allocateFixedCosts,
  basisPointsToPercent,
  commissionBaseAmount,
  commissionLine,
  computeEventPnL,
  computeVariableCosts,
  costLines,
  evaluateCostFormula,
  group,
  reconcile,
  revenueLines,
  share,
  shareForProperty,
  type CommissionInput,
  type CostFacts,
  type EventPnLInput,
  type FixedAllocationInput,
} from './costing'

export {
  captureSnapshot,
  deepFreeze,
  resnapshot,
  resolveCatalogue,
  verifySnapshot,
  type CaptureInput,
  type ResolvedCatalogue,
} from './snapshot'

export {
  containsFinancialField,
  toCleanerView,
  type CleanerItemView,
  type CleanerPlanView,
  type CleanerSectionView,
  type CleanerViewInput,
} from './cleaner-view'

export {
  createPreparationOperations,
  type BuildPlanResult,
  type PreparationOperations,
  type PreparationPorts,
  type RecomputeResult,
  type SectionResult,
} from './operations'

export {
  assemblePlan,
  previewPlan,
  type AssembleInput,
  type AssembledPlan,
  type PreparationPreview,
  type PreviewInput,
} from './preview'

export {
  catalogueFrom,
  catalogueProblems,
  configureInput,
  createCatalogueOperations,
  type CatalogueOperations,
  type ConfigureInput,
  type ConfigureResult,
  type PreparationCataloguePorts,
} from './catalogue'
