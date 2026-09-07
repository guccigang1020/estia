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
  EXTERNALLY_VISIBLE_ACTIONS,
  actionGrant,
  reachesOutsideTheBusiness,
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
  COMPARED_FACTS,
  candidatesForEvent,
  factsForEvent,
  type EvaluationCandidate,
  type EvaluationGate,
} from './evaluation'

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

export {
  RULE_PARAMETERS,
  applyParameters,
  isNumericCondition,
  parameterIssues,
  parametersFor,
  shippedParameters,
  tunableTemplateIds,
  type NumericConditionKind,
  type ParameterIssue,
  type RuleParameter,
} from './parameters'

export {
  RULE_SOURCE_LABEL,
  effectiveRules,
  resolveRules,
  type ResolvedRule,
  type RuleSource,
  type StoredRule,
} from './state'

/**
 * The repository, the operations, the runs and the performing half are NOT
 * re-exported here.
 *
 * This barrel is imported by pure modules and by client components — the rule
 * cards read `AUTOMATION_ACTIONS` and `READINESS_LABEL` from it — and those
 * files all run on a server: `repository.ts` and `runs.ts` take a Supabase
 * client, `operations.ts` reaches the authorization engine and the audit
 * pipeline, and `performing.ts` is the door to acting on somebody's business.
 * Re-exporting them would put a database client in the import graph of a
 * component that renders in a browser.
 *
 * `performing.ts` is kept out for a second reason as well. It is the half that
 * is deliberately switched off, and a barrel is how a module becomes easy to
 * reach by accident. `import { performEvaluatedEvent } from '@/lib/automation/performing'`
 * is a line somebody has to mean.
 */
