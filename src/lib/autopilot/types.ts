/**
 * The shapes every part of Autopilot passes to every other part.
 *
 * Autopilot is four stages and they are deliberately separable:
 *
 *     signals   →   decide   →   policy   →   execute
 *     what is    what matters   may we do    do it, through
 *     wrong        and why       it, and      the same command
 *                                how much     a person uses
 *
 * Each stage takes the previous stage's output and nothing else. No stage
 * reads the database on behalf of another, and no stage decides something a
 * later one is also entitled to decide. That is what makes it testable
 * without a database and what stops "why did ESTIA do this" from having four
 * possible answers.
 *
 * ── Deterministic first, and the boundary is here ─────────────────────────
 *
 * Payment states, availability, deadlines, inventory arithmetic, permissions
 * and money are computed by the engines that already own them, and their
 * outputs arrive here as `Evidence`. Nothing in Autopilot recomputes any of
 * them — a second opinion about whether a deposit was paid is not a feature.
 *
 * Interpretation, ordering, wording and pattern-noticing are the parts where
 * judgment is allowed, and they operate on `Evidence` that was already
 * decided elsewhere. `confidence` describes that judgment and never the
 * underlying facts: an arithmetic shortage is not "probably six towels".
 */

import type {
  ActionSafetyLevel,
  AutopilotConfidence,
  AutopilotDisposition,
  AutopilotDomain,
  AutopilotLevel,
  AutopilotRiskState,
  AutopilotRunMode,
  AutopilotSuppressionReason,
} from '../contracts/states'
import type { DomainEventName } from '../contracts/events'
import type { Entitlement } from '../plans/entitlements'

import type { AutopilotActionKind } from './actions'

/* ----------------------------------------------------------- evidence --- */

/**
 * One fact, and where it came from.
 *
 * Every claim Autopilot makes on a screen is built from these, and the source
 * travels with the value. "Villa A may not be ready" is not a sentence a
 * person can act on; "the cleaner has not started, typical preparation is 105
 * minutes, arrival is at 15:00 and it is now 13:42" is three facts with three
 * sources, and the manager can check each one.
 *
 * The same argument the website module makes about published claims, for the
 * same reason: a system that asserts things it cannot attribute is a system
 * people stop believing the first time it is wrong.
 */
export interface Evidence {
  /** Stable, machine-readable: `cleaner.not_started`, `stock.projected`. */
  key: string
  /** Hebrew, for a person. */
  label: string
  value: string | number | boolean | null
  /** Which engine said so — `preparation`, `inventory`, `payments`. */
  source: string
  /** The row it came from, when there is one. */
  sourceId?: string
  /** When the fact was true. Absent means "now", which is rarely honest. */
  observedAt?: string
}

/* ------------------------------------------------------------ signals --- */

/**
 * The expected state and the real one, for one thing, at one moment.
 *
 * A detector produces these and decides nothing else. It does not know the
 * organization's Autopilot level, whether the module is switched on, or who
 * would be told — those are later questions, and a detector that asked them
 * would be a detector nobody could test.
 */
export interface Signal {
  /** `laundry.delivery_late`, `payment.balance_overdue`. */
  code: string
  domain: AutopilotDomain
  risk: AutopilotRiskState
  /** What this is about. */
  resourceType: string
  resourceId: string | null
  propertyId: string | null
  title: string
  detail: string
  evidence: readonly Evidence[]
  /**
   * Stable across passes for the SAME ongoing problem, and never derived from
   * the clock. A shortage noticed every five minutes for six hours is one
   * problem; a key containing a timestamp would make it seventy-two.
   */
  dedupeKey: string
  /** When this stops being fixable. */
  dueAt?: string
  warnAt?: string
  criticalAt?: string
  /**
   * The IMMEDIATE cause of this signal, by `dedupeKey` — its parent, never
   * the ultimate root and never itself.
   *
   * A laundry delay causes a shortage causes a preparation risk causes an
   * arrival risk: four signals, one incident, and the screen shows the chain
   * rather than four alarms that look unrelated at 06:00. Immediate-parent
   * edges are what make that chain reconstructable; if every signal pointed
   * at the root instead, the four-level chain would flatten into a star and
   * the depth — the part a person reads to understand what to fix first —
   * would be gone.
   */
  causedBy?: string
}

/* ------------------------------------------------------------ decision -- */

/**
 * What Autopilot proposes to do about one signal, before anybody has asked
 * whether it may.
 *
 * `confidence` belongs here rather than on the signal because it describes
 * the JUDGMENT — "an extra cleaner would probably fix this" — and not the
 * facts, which are either true or were not measured.
 */
export interface ProposedAction {
  kind: AutopilotActionKind
  /** Prose, in Hebrew, composed now and stored. Never re-derived later. */
  reason: string
  confidence: AutopilotConfidence
  /** The input for the domain command. Validated by the command, not here. */
  input: Readonly<Record<string, unknown>>
  /**
   * Stable across redeliveries of the triggering event. The uniqueness
   * guarantee lives in the database; this is what it is computed from.
   */
  idempotencyKey: string
  /** When it should happen, if not now. */
  scheduledFor?: string
}

export interface Decision {
  signal: Signal
  /** Ordered. The first is what the screen offers; the rest are alternatives. */
  actions: readonly ProposedAction[]
  /** Position in the triage, lower first. Derived from the domain order. */
  priority: number
}

/* -------------------------------------------------------------- policy -- */

/**
 * Everything the safety engine needs, gathered once.
 *
 * A record rather than a set of callbacks so that a ruling is a pure function
 * of stated inputs — which is what makes "why was this suppressed" answerable
 * by reading a test rather than by reproducing a database.
 */
export interface PolicyContext {
  organizationId: string
  propertyId: string | null
  bookingId: string | null
  /** After the property narrowing, never before. */
  level: AutopilotLevel
  runMode: AutopilotRunMode
  /** The kill switch. `false` stops everything except reading. */
  enabled: boolean
  /** In the future means paused; in the past means nothing. */
  pausedUntil: string | null
  /** `manual_only` and `high_attention` narrow; they never widen. */
  bookingHandling: 'normal' | 'high_attention' | 'manual_only'
  /** From `autopilot_policies`, already narrowed to this property. */
  dispositions: Readonly<
    Partial<Record<AutopilotActionKind, AutopilotDisposition>>
  >
  /**
   * The platform ceiling by safety level — the blanket rules, which are the
   * ones that matter: money, access and cancellation are never automatic for
   * anybody.
   */
  safetyCeiling: Readonly<
    Partial<Record<ActionSafetyLevel, AutopilotDisposition>>
  >
  /**
   * The platform ceiling for ONE named action, when such a rule exists.
   *
   * `autopilot_safety_rules.action_kind` is nullable precisely so ESTIA can
   * cap a single action without capping its whole safety level — the shape a
   * rule takes after an incident with one specific thing. Kept separate from
   * `safetyCeiling` rather than folded into it, because folding a per-action
   * rule in at its safety level is correct only for a context built for that
   * one action and quietly wrong for a context built for many.
   */
  safetyCeilingByAction: Readonly<
    Partial<Record<AutopilotActionKind, AutopilotDisposition>>
  >
  /** What this customer's package actually includes. */
  entitlements: readonly Entitlement[]
  /** Whether the acting identity holds each action's grant. */
  holdsGrant: (grant: string) => boolean
  /** Local wall-clock quiet window, already resolved to a yes or no. */
  inQuietHours: boolean
  now: Date
}

/**
 * The ruling. One of exactly two shapes, so a caller cannot read `disposition`
 * off a refusal or forget to check whether it was allowed.
 */
export type PolicyRuling =
  | {
      allowed: true
      /** What may happen: suggest it, ask about it, or do it. */
      disposition: Exclude<AutopilotDisposition, 'off'>
      /** Every floor that was consulted, in the order they were applied. */
      appliedFloors: readonly string[]
    }
  | {
      allowed: false
      reason: AutopilotSuppressionReason
      /** Hebrew, for the activity log. Says which floor refused and why. */
      explanation: string
    }

/* ------------------------------------------------------------- execute -- */

/**
 * A decision that has been through the policy engine and survived.
 *
 * `safetyLevel` and `disposition` are copied onto it rather than looked up
 * again at execution time. Reading them live would let a customer change the
 * matrix at noon and have the morning's queued actions behave under rules
 * nobody applied to them.
 */
export interface PlannedAction {
  organizationId: string
  propertyId: string | null
  kind: AutopilotActionKind
  safetyLevel: ActionSafetyLevel
  disposition: Exclude<AutopilotDisposition, 'off'>
  runMode: AutopilotRunMode
  confidence: AutopilotConfidence
  reason: string
  triggerEvent: DomainEventName | null
  evidence: readonly Evidence[]
  command: string | null
  commandInput: Readonly<Record<string, unknown>>
  idempotencyKey: string
  correlationId: string | null
  exceptionDedupeKey: string | null
  scheduledFor: string | null
}

/**
 * What happened when it ran.
 *
 * `executed_unaudited` is a real outcome and not an oversight: the work
 * happened and the record of it did not. Reporting it as `executed` or as
 * `failed` would both be lies, and it is exactly the state somebody needs to
 * be told about — the same argument `automation/engine.ts` already makes.
 */
export type ExecutionOutcome =
  /**
   * Recorded and deliberately not run. What a `suggest` disposition produces:
   * the decision is real, it is on the screen, and nobody has been asked for
   * anything. Distinct from `awaiting_approval`, which is a question already
   * put to a person and waiting on them.
   */
  | { status: 'planned' }
  | { status: 'executed'; result: Readonly<Record<string, unknown>> }
  | { status: 'executed_unaudited'; result: Readonly<Record<string, unknown>> }
  | { status: 'awaiting_approval' }
  | { status: 'simulated' }
  | { status: 'suppressed'; reason: AutopilotSuppressionReason }
  | { status: 'failed'; code: string; detail: string; retryable: boolean }

/* ---------------------------------------------------------- readiness --- */

/**
 * One thing that has to be true before an arrival, and whether it is.
 *
 * `not_applicable` is why a readiness score is not a lie. A business with
 * laundry switched off has no laundry requirement, and a score that counted
 * it as unmet would tell every one of those customers they are permanently
 * 87% ready. The requirement is dropped from the denominator, and the screen
 * says which requirements it counted.
 */
export interface ReadinessRequirement {
  key: string
  label: string
  status: 'met' | 'unmet' | 'at_risk' | 'not_applicable'
  /** Why. Present even when met — "deposit received on 4 September". */
  evidence: readonly Evidence[]
  /** Absent when `not_applicable`. */
  blocksArrival?: boolean
}

/**
 * A readiness figure and the arithmetic behind it.
 *
 * There is no private denominator. `met` over `applicable` is the whole
 * calculation, both numbers are on the object, and the requirements that
 * produced them are listed — so a manager who disagrees with 78% can see
 * which line they disagree with. A score nobody can decompose is a score
 * people learn to ignore.
 */
export interface Readiness {
  subject: { type: 'booking' | 'property'; id: string }
  requirements: readonly ReadinessRequirement[]
  /** Requirements that apply here. Never includes `not_applicable`. */
  applicable: number
  met: number
  /** `met / applicable`, rounded. `null` when nothing applies. */
  percent: number | null
  risk: AutopilotRiskState
}
