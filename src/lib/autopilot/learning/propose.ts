/**
 * Turning something noticed into something a person can accept or refuse.
 *
 * ── A proposal is the whole product here ──────────────────────────────────
 *
 * The row this file builds is not a rule and never becomes one by itself. It
 * is an argument put to a manager, and it has to be an argument they can
 * check: what was observed, how many times, over what period, which rows it
 * happened on, what the rule would be, and what it is expected to change. A
 * proposal missing any of those is a claim, and a claim a manager cannot
 * verify is a claim they should refuse.
 *
 * ── Adoption is structurally out of reach from here ───────────────────────
 *
 * `RuleCandidateDraft.state` is typed as `'observed' | 'proposed'`. There is
 * no value this file can put in that field that means adopted, so no code path
 * through the detectors, the screening or the proposal builder can produce an
 * adopted candidate — not by accident and not by a mistaken edit that
 * typechecks.
 *
 * Adoption goes through `prepareDecision`, which refuses without a named
 * person and a timestamp, and then through the database, whose
 * `autopilot_rule_candidates_decided_pair` constraint refuses the same thing
 * again. Two independent enforcements, because this is the one property of the
 * module that must not depend on anybody reading a comment.
 *
 * ── Noise is how a business learns to ignore a feature ────────────────────
 *
 * A suggestion built from four occurrences in a year is not a small
 * suggestion, it is a wrong one — and the cost of raising it is not the
 * screen space, it is that the next twenty proposals get skimmed. So a pattern
 * below the floors is not raised at all. It is reported as withheld, with the
 * floor it missed, so that "why did ESTIA not notice this" has an answer.
 */

import type { FeedbackRecord } from './feedback'
import { dampingFor, shouldRaise } from './feedback'
import type { AutopilotDomain } from '../../contracts/states'
import { screenPatterns, type BoundaryRefusal } from './boundaries'
import {
  formatRate,
  isPatternCode,
  occurrenceRate,
  type ObservedPattern,
  type PatternParameter,
  type PatternSubject,
} from './patterns'

/* ------------------------------------------------------------ thresholds -- */

export interface ProposalThresholds {
  /** Below this many occurrences, nothing is raised. */
  minOccurrences: number
  /** Below this share of the chances it had, nothing is raised. */
  minRate: number
  /** A window shorter than this cannot show a habit, only a busy week. */
  minWindowDays: number
  /** Fewer chances than this and the rate is not a rate. */
  minOpportunities: number
}

/**
 * The floors, and they are judgments.
 *
 * HEURISTIC, every one of them, and stated as constants rather than inlined so
 * that a customer's argument about them is an argument about four numbers in
 * one place. What they gate is arithmetic: `occurrences`, `opportunities` and
 * the window are counted, and this file only compares.
 *
 * Six occurrences over thirty days at three fifths of the chances is roughly
 * "twice a week for a month, more often than not" — the point at which a
 * person watching the business would have said it out loud themselves.
 */
export const DEFAULT_THRESHOLDS: ProposalThresholds = {
  minOccurrences: 6,
  minRate: 0.6,
  minWindowDays: 30,
  minOpportunities: 8,
}

/* ---------------------------------------------------------------- shapes -- */

/**
 * The states a draft may hold.
 *
 * `adopted`, `rejected` and `muted` are absent by construction — see the
 * header. This is the type that makes the module's central promise a compile
 * error rather than a review comment.
 */
export type DraftState = 'observed' | 'proposed'

/**
 * The proposal body, as it is stored in `autopilot_rule_candidates.proposal`.
 *
 * Stored rather than regenerated, exactly as the column comment says: what a
 * person approved must be what gets created, even if the pattern has moved on
 * by the time they get to it.
 */
export interface ProposalBody {
  /** Hebrew: the observed behaviour. */
  observed: string
  occurrences: number
  opportunities: number
  /** `82%`, already rounded once for reading. */
  rate: string
  /** Hebrew: the period, as a person would say it. */
  period: string
  /** Hebrew: the suggested rule. */
  suggestedRule: string
  /** Hebrew: what it is expected to change. */
  expectedImpact: string
  /** Which module would own the real rule. */
  module: string
  /** For whoever creates it. Flat scalars only. */
  parameters: Readonly<Record<string, PatternParameter>>
  /** The Autopilot action it would cause, or `null`. */
  actionKind: string | null
}

export interface RuleCandidateDraft {
  organizationId: string
  propertyId: string | null
  state: DraftState
  patternCode: string
  subject: PatternSubject
  /** Hebrew, one sentence. The database refuses a blank one. */
  summary: string
  occurrences: number
  observedFrom: string
  observedTo: string
  sample: readonly { reference: string; label: string; occurredOn: string }[]
  proposal: ProposalBody
}

export const WITHHOLDING_REASONS = [
  'below_occurrence_floor',
  'below_rate_floor',
  'below_opportunity_floor',
  'window_too_short',
  'damped',
  'invalid_pattern_code',
] as const

export type WithholdingReason = (typeof WITHHOLDING_REASONS)[number]

export interface WithheldPattern {
  patternCode: string
  propertyId: string | null
  reason: WithholdingReason
  occurrences: number
  opportunities: number
  /** Hebrew: which floor it missed, and by how much. */
  explanation: string
}

export interface ProposalResult {
  proposals: readonly RuleCandidateDraft[]
  /** Below a floor, or damped. Visible so the silence is diagnosable. */
  withheld: readonly WithheldPattern[]
  /** Dropped by `boundaries.ts`. Never silently. */
  refusals: readonly BoundaryRefusal[]
}

/* --------------------------------------------------------------- domains -- */

/**
 * Which Autopilot domain a learned preference belongs to, for damping.
 *
 * Note what is not here: `safety`. Learning produces operational preferences
 * and nothing else, so no proposal from this module is ever exempt from
 * damping — the exemption in `feedback.ts` exists for the signals the rest of
 * Autopilot raises, and a proposal must not be able to borrow it.
 */
export const SUBJECT_DOMAIN: Readonly<Record<PatternSubject, AutopilotDomain>> =
  {
    preparation_quantity: 'preparation',
    cleaner_preference: 'staff',
    staffing_level: 'staff',
    payment_exception_handling: 'payment_risk',
    preparation_timing: 'preparation',
    laundry_provider: 'laundry',
    message_template: 'optimization',
  }

/* ---------------------------------------------------------------- period -- */

const DAY_MS = 86_400_000

/** Whole days between two ISO dates, inclusive of both ends. */
export function windowDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return 0
  return Math.round((end - start) / DAY_MS) + 1
}

/** Hebrew, the way somebody says a period out loud. */
export function describePeriod(from: string, to: string): string {
  const days = windowDays(from, to)
  return `${from} עד ${to} (${days} ימים)`
}

/* -------------------------------------------------------------- building -- */

export interface ProposalInput {
  organizationId: string
  patterns: readonly ObservedPattern[]
  /** What people have already said about these. Empty is the normal case. */
  feedback?: readonly FeedbackRecord[]
  now: Date
  thresholds?: Partial<ProposalThresholds>
}

function withhold(
  pattern: ObservedPattern,
  reason: WithholdingReason,
  explanation: string,
): WithheldPattern {
  return {
    patternCode: pattern.patternCode,
    propertyId: pattern.propertyId,
    reason,
    occurrences: pattern.occurrences,
    opportunities: pattern.opportunities,
    explanation,
  }
}

/**
 * One pattern, as a row somebody can accept.
 *
 * Exported on its own so a test can build a draft without a whole batch, and
 * so the summary sentence has exactly one author.
 */
export function draftFromPattern(
  organizationId: string,
  pattern: ObservedPattern,
): RuleCandidateDraft {
  const rate = formatRate(occurrenceRate(pattern))

  return {
    organizationId,
    propertyId: pattern.propertyId,
    // Never anything else. See the header.
    state: 'proposed',
    patternCode: pattern.patternCode,
    subject: pattern.subject,
    summary:
      `${pattern.observation} הצעה: ${pattern.suggestion.statement}`.trim(),
    occurrences: pattern.occurrences,
    observedFrom: pattern.observedFrom,
    observedTo: pattern.observedTo,
    sample: pattern.sample.map((one) => ({ ...one })),
    proposal: {
      observed: pattern.observation,
      occurrences: pattern.occurrences,
      opportunities: pattern.opportunities,
      rate,
      period: describePeriod(pattern.observedFrom, pattern.observedTo),
      suggestedRule: pattern.suggestion.statement,
      expectedImpact: pattern.suggestion.expectedImpact,
      module: pattern.suggestion.module,
      parameters: { ...pattern.suggestion.parameters },
      actionKind: pattern.suggestion.actionKind,
    },
  }
}

/**
 * Screen, filter, and build.
 *
 * The order is deliberate: boundaries first, so a forbidden pattern is refused
 * before anybody counts whether it was frequent enough to be worth forbidding.
 */
export function proposeFromPatterns(input: ProposalInput): ProposalResult {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds }
  const feedback = input.feedback ?? []

  const { permitted, refusals } = screenPatterns(input.patterns, input.now)

  const proposals: RuleCandidateDraft[] = []
  const withheld: WithheldPattern[] = []

  for (const pattern of permitted) {
    if (!isPatternCode(pattern.patternCode)) {
      // The database would refuse this at the insert with a constraint name
      // nobody can read. Refusing it here makes it a listed omission instead.
      withheld.push(
        withhold(
          pattern,
          'invalid_pattern_code',
          'מזהה הדפוס אינו בפורמט שהמערכת מאחסנת, ולכן ההצעה לא נשמרה.',
        ),
      )
      continue
    }

    if (pattern.occurrences < thresholds.minOccurrences) {
      withheld.push(
        withhold(
          pattern,
          'below_occurrence_floor',
          `הדפוס חזר ${pattern.occurrences} פעמים, מתחת לסף של ` +
            `${thresholds.minOccurrences}. מעט מדי מקרים כדי להציע כלל.`,
        ),
      )
      continue
    }

    if (pattern.opportunities < thresholds.minOpportunities) {
      withheld.push(
        withhold(
          pattern,
          'below_opportunity_floor',
          `היו רק ${pattern.opportunities} הזדמנויות בתקופה, מתחת לסף של ` +
            `${thresholds.minOpportunities}. שיעור שמחושב על מדגם קטן אינו ` +
            'שיעור.',
        ),
      )
      continue
    }

    const rate = occurrenceRate(pattern)
    if (rate < thresholds.minRate) {
      withheld.push(
        withhold(
          pattern,
          'below_rate_floor',
          `הדפוס מופיע ב-${formatRate(rate)} מהמקרים, מתחת לסף של ` +
            `${formatRate(thresholds.minRate)}.`,
        ),
      )
      continue
    }

    const days = windowDays(pattern.observedFrom, pattern.observedTo)
    if (days < thresholds.minWindowDays) {
      withheld.push(
        withhold(
          pattern,
          'window_too_short',
          `הדפוס נצפה על פני ${days} ימים בלבד, מתחת ל-` +
            `${thresholds.minWindowDays}. תקופה קצרה מדי כדי להבדיל הרגל ` +
            'משבוע עמוס.',
        ),
      )
      continue
    }

    const damping = dampingFor(
      { key: pattern.patternCode, domain: SUBJECT_DOMAIN[pattern.subject] },
      feedback,
    )

    if (!shouldRaise(damping, pattern.occurrences)) {
      withheld.push(withhold(pattern, 'damped', damping.explanation))
      continue
    }

    proposals.push(draftFromPattern(input.organizationId, pattern))
  }

  return { proposals, withheld, refusals }
}

/* -------------------------------------------------------------- decision -- */

/**
 * A candidate as it comes back from the database, including the states this
 * module cannot create.
 */
export interface RuleCandidate {
  id: string
  organizationId: string
  propertyId: string | null
  state: 'observed' | 'proposed' | 'adopted' | 'rejected' | 'muted'
  patternCode: string
  summary: string
  occurrences: number
  observedFrom: string
  observedTo: string
  sample: readonly { reference: string; label: string; occurredOn: string }[]
  proposal: ProposalBody | null
  decidedAt: string | null
  decidedBy: string | null
  version: number
}

/**
 * What a person did about a candidate.
 *
 * `muted` carries no decider because it is not a decision about the rule — it
 * is the system recording that a rejected pattern happened again, which the
 * state list in `contracts/states.ts` describes as "counted, never
 * re-proposed". Adoption and rejection are decisions, and both name somebody.
 */
export type CandidateDecision =
  | { state: 'adopted'; decidedBy: string; decidedAt: string }
  | { state: 'rejected'; decidedBy: string; decidedAt: string }
  | { state: 'muted' }

export class MissingDeciderError extends Error {
  readonly attemptedState: string

  constructor(attemptedState: string, detail: string) {
    super(
      `A rule candidate cannot become '${attemptedState}' without a named ` +
        `person and the time they decided: ${detail}. Turning somebody's ` +
        `habit into a standing instruction is a decision they have to have ` +
        `made.`,
    )
    this.name = 'MissingDeciderError'
    this.attemptedState = attemptedState
  }
}

/** The shape the repository writes. Validated, never assembled by a caller. */
export interface PreparedDecision {
  state: 'adopted' | 'rejected' | 'muted'
  decidedBy: string | null
  decidedAt: string | null
}

/**
 * Validate a decision before it reaches the database.
 *
 * The database's `autopilot_rule_candidates_decided_pair` constraint enforces
 * the same rule and is the real guarantee. This exists so the failure is a
 * readable error at the point somebody made the mistake, rather than a 23514
 * three layers down naming a constraint.
 */
export function prepareDecision(decision: CandidateDecision): PreparedDecision {
  if (decision.state === 'muted') {
    return { state: 'muted', decidedBy: null, decidedAt: null }
  }

  const decidedBy = decision.decidedBy.trim()
  if (decidedBy.length === 0) {
    throw new MissingDeciderError(decision.state, 'decidedBy was blank')
  }

  const decidedAt = decision.decidedAt.trim()
  if (decidedAt.length === 0 || Number.isNaN(Date.parse(decidedAt))) {
    throw new MissingDeciderError(
      decision.state,
      `decidedAt is not a timestamp: '${decision.decidedAt}'`,
    )
  }

  return {
    state: decision.state,
    decidedBy,
    decidedAt: new Date(decidedAt).toISOString(),
  }
}
