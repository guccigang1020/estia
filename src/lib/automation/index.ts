/**
 * The automation domain, in one import.
 *
 * WHEN comes from the frozen event catalogue, IF is data, THEN is a closed set
 * of actions each naming the permission a person would have needed. Nothing
 * here opens a connection; the engine's every collaborator is injected.
 */

export {
  AUTOMATION_ACTIONS,
  AUTOMATION_ACTION_KINDS,
  AUTOMATION_ENTITLEMENT,
  actionGrant,
  type AutomationAction,
  type AutomationActionKind,
  type AutomationActionMeta,
  type AutomationCondition,
  type AutomationFacts,
  type AutomationRule,
  type FactValue,
} from './types'

export {
  describeCondition,
  evaluateConditions,
  type ConditionFailure,
  type ConditionResult,
} from './conditions'

export {
  DEFAULT_RETRY,
  InMemoryAutomationLedger,
  executedActions,
  executionKey,
  needsAttention,
  runAutomations,
  type ActionOutcome,
  type ActionResult,
  type AutomationLedger,
  type AutomationPerformer,
  type AutomationRun,
  type AutomationRunOutcome,
  type PerformInput,
  type RetryPolicy,
  type RuleOutcome,
  type RuleResult,
  type RunAutomationsInput,
} from './engine'

export {
  AUTOMATION_TEMPLATES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABEL,
  libraryTriggers,
  requiredFacts,
  templateById,
  templatesFor,
  type AutomationTemplate,
  type TemplateCategory,
} from './library'

export {
  READINESS_LABEL,
  actionReadiness,
  ruleReadiness,
  type ActionReadiness,
  type RuleReadiness,
  type RuleReadinessStatus,
} from './readiness'
