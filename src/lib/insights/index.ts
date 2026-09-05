/**
 * The insight layer, in one import.
 *
 * An insight is a claim about the business with its arithmetic attached. Every
 * figure in one comes from `src/lib/metrics`; nothing in this directory
 * defines a measure, and the day it does is the day the insights screen and
 * the report screen start disagreeing in front of a customer.
 */

export {
  FORMULA,
  arithmeticLine,
  baselineEvidence,
  metricEvidence,
  type MetricVisibility,
} from './evidence'

export {
  GAPS,
  INSIGHT_RULES,
  type InsightRule,
  type RuleInput,
  type RuleOutcome,
} from './rules'

export { buildInsightReport, type InsightReportArgs } from './report'

export { CachedMetricSource } from './source-cache'

export {
  INSIGHT_IDS,
  type AbsenceReason,
  type EvidenceBlock,
  type EvidenceOperand,
  type Insight,
  type InsightAbsence,
  type InsightDestination,
  type InsightGap,
  type InsightId,
  type InsightReport,
  type MetricEvidence,
} from './types'
