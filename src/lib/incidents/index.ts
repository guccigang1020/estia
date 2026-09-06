/**
 * The incident case module, in one import.
 *
 * ── What this module is, in one sentence ──────────────────────────────────
 *
 * A fault report is a task; a fault report that costs money is a case. The
 * first is `defineTaskCreation` in `src/lib/tasks` with `incident.create` as
 * its permission, it writes a `maintenance` row and it publishes
 * `incident.opened`, and none of it is replaced here. This module is the
 * second: evidence, cost lines, a decision about who pays with a person's name
 * on it, and a settlement plan somebody else executes.
 *
 * ── SAFE FOR A CLIENT COMPONENT, AND KEPT THAT WAY DELIBERATELY ───────────
 *
 * `repository.ts` imports `src/lib/persistence` and through it the `postgres`
 * driver, and `operations.ts` imports `repository.ts`. **Neither is exported
 * here.** A barrel that re-exported either would be traced into any client
 * bundle that touched this file and the build would fail with a
 * module-not-found for `perf_hooks` — the failure `scripts/client-bundle.mjs`
 * exists to catch, and which has taken this product down three times in one
 * day for three different workers.
 *
 * So: a Server Component or a server action imports
 * `@/lib/incidents/operations` and `@/lib/incidents/repository` by path. A
 * `'use client'` component imports this barrel, or the leaf it needs. Every
 * file behind this barrel is a pure function over plain data.
 *
 * ── What is deliberately not re-exported ──────────────────────────────────
 *
 * `Agorot`, `Grant`, `DomainEventName` and every other frozen contract this
 * module consumes. They belong to `booking/types`, `authz/permissions` and
 * `contracts/events`, and a second import path for a frozen contract is how
 * two modules come to believe they are reading different vocabularies.
 */

export {
  AWAITING_STATUSES,
  INCIDENT_CASE_STATUSES,
  INCIDENT_CASE_STATUS_LABEL,
  INCIDENT_CASE_TYPES,
  INCIDENT_CASE_TYPE_LABEL,
  INCIDENT_ORIGINS,
  INCIDENT_ORIGIN_LABEL,
  QUESTION_AUDIENCES,
  QUESTION_AUDIENCE_LABEL,
  SETTLED_CASE_STATUSES,
  isAnswered,
  isSettledCase,
  unansweredQuestions,
  type CaseCore,
  type CaseQuestion,
  type CaseQuestionDraft,
  type IncidentCase,
  type IncidentCaseDraft,
  type IncidentCaseStatus,
  type IncidentCaseType,
  type IncidentOrigin,
  type QuestionAudience,
} from './types'

export {
  COMPARISON_KINDS,
  EVIDENCE_KINDS,
  EVIDENCE_KIND_LABEL,
  EVIDENCE_PROBLEM_MESSAGE,
  EVIDENCE_SOURCES,
  EVIDENCE_SOURCE_LABEL,
  MEDIA_EVIDENCE_KINDS,
  STATEMENT_EVIDENCE_KINDS,
  checkEvidence,
  looksLikeInlineBytes,
  pairComparisons,
  tallyEvidence,
  type CaseEvidence,
  type CaseEvidenceDraft,
  type EvidenceCheck,
  type EvidenceKind,
  type EvidencePair,
  type EvidenceProblem,
  type EvidenceSource,
  type EvidenceTally,
} from './evidence'

export {
  CASE_TRANSITIONS,
  TRANSITION_REFUSAL_MESSAGE,
  allowedTransitions,
  availableTransitions,
  checkTransition,
  daysInState,
  isWaitingOnSomebody,
  statusLabel,
  type CaseFacts,
  type TransitionCheck,
  type TransitionRefusal,
} from './workflow'

export {
  COST_LINE_KINDS,
  COST_LINE_KIND_LABEL,
  LIABILITY_BASES,
  LIABILITY_BASIS_LABEL,
  LIABILITY_OUTCOMES,
  LIABILITY_OUTCOME_LABEL,
  LIABILITY_PROBLEM_MESSAGE,
  MIN_RATIONALE_LENGTH,
  PROVISIONAL_COST_KINDS,
  SETTLEMENT_NOT_EXECUTED_NOTE,
  assessedTotal,
  checkAllocation,
  describeSupport,
  evaluateLiability,
  planSettlement,
  provisionalTotal,
  sumLines,
  type CaseCostLine,
  type CaseCostLineDraft,
  type CostLineKind,
  type LiabilityBasis,
  type LiabilityCheck,
  type LiabilityDecision,
  type LiabilityDecisionDraft,
  type LiabilityInput,
  type LiabilityOutcome,
  type LiabilityProblem,
  type LiabilitySupport,
  type SettlementPlan,
} from './liability'

export {
  DIFFERENCE_KINDS,
  DIFFERENCE_KIND_LABEL,
  INSPECTION_CONDITIONS,
  INSPECTION_CONDITION_LABEL,
  INSPECTION_STAGES,
  INSPECTION_STAGE_LABEL,
  STAGE_ORDER,
  byAttention,
  compareChain,
  compareInspections,
  hasBaseline,
  type DifferenceKind,
  type InspectionChainStep,
  type InspectionCondition,
  type InspectionDifference,
  type InspectionItem,
  type InspectionRecord,
  type InspectionRecordDraft,
  type InspectionStage,
} from './inspection'
