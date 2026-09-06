/**
 * The decide stage: signals in, an ordered and de-duplicated set of decisions
 * out.
 *
 *     signals   →   DECIDE   →   policy   →   execute
 *                what matters,   may we do    do it, through the same
 *                in what order    it, and     command a person uses
 *                and why           how much
 *
 * This stage answers WHAT SHOULD HAPPEN and IN WHAT ORDER. It never answers
 * whether it is allowed — that is `policy`, which holds the level, the matrix,
 * the quiet hours and the kill switch — and it never performs anything.
 *
 * ── Everything in here is a pure function ─────────────────────────────────
 *
 * There is no database client anywhere in this directory, and there is not
 * going to be one. Every input arrives as an argument: the signals, the
 * entitlements, the shortage facts, the clock reading, the cap on the plan.
 * That is not tidiness — it is what makes "why did ESTIA put the laundry
 * first on the fourth of September" answerable by a test that runs in
 * milliseconds with no Supabase project, and what stops the triage from
 * quietly acquiring a second source of truth about what a customer has bought.
 *
 * ── Where judgment is allowed, and where it is not ────────────────────────
 *
 * Ordering, grouping, root-causing and dedupe are rules. Given the same batch
 * they produce the same answer, every time, in any input order. The only two
 * places judgment lives are `confidence.ts` — how sure ESTIA is about a
 * remedy — and the wording of `reason`, which is composed now, in Hebrew, and
 * stored rather than re-derived later against rules that have since changed.
 */

export {
  compareSignals,
  deadlineOf,
  domainPriority,
  riskPriority,
  triage,
  triageRank,
} from './triage'

export {
  ESTIMATE_KEY_SEGMENTS,
  ESTIMATING_SOURCES,
  atMost,
  confidenceFor,
  isAtLeast,
  isEstimatedEvidence,
  type ConfidenceInput,
} from './confidence'

export {
  dedupeDecisions,
  dedupeSignals,
  occurrencesByKey,
  type DedupeOptions,
  type DedupeResult,
  type Occurrence,
} from './dedupe'

export {
  incidentSignals,
  rootCause,
  rootKeyBySignal,
  type Consequence,
  type CycleReport,
  type DanglingCause,
  type Incident,
  type RootCauseResult,
} from './root-cause'

export {
  decide,
  idempotencyKeyFor,
  proposeActions,
  shortageLadder,
  type DecideResult,
  type ProposalCandidate,
  type ProposalContext,
  type ShortageFacts,
} from './propose'

export {
  DEFAULT_PLAN_LIMIT,
  planDay,
  type DayPlan,
  type PlanItem,
  type PlanOptions,
} from './plan'
