/**
 * Will this house be ready when the guest walks in.
 *
 * ── The sentence this file exists to make possible ────────────────────────
 *
 *   "המנקה טרם התחיל, הכנה טיפוסית 105 דקות, ההגעה ב-15:00, השעה כעת 13:42."
 *
 * Not "וילה ים — 78%". A percentage is a summary of an argument, and the
 * argument is the useful part: it names what is wrong, how long it takes, and
 * how long there is. A manager can act on the sentence and can only worry
 * about the number. So every verdict here carries the `Evidence` that produced
 * it, each fact with the engine that said it, and the screen composes the
 * sentence from those rather than being handed prose it cannot check.
 *
 * ── The arithmetic, and what it deliberately is not ───────────────────────
 *
 *     remaining = typical preparation minutes, less the part already done
 *     slack     = minutes until arrival − remaining
 *
 * `typicalPreparationMinutes` comes from the preparation engine and is not
 * estimated here. Neither is the percentage complete. This file subtracts two
 * numbers other people computed and grades the result — a second opinion about
 * how long a villa takes to clean is not a feature, and it would be the one
 * number nobody could trace to a rule.
 *
 * ── One signal, escalating, and never a second row ────────────────────────
 *
 * The arrival signal's code is `arrival.not_ready` at every severity. It would
 * have been natural to emit `arrival.at_risk` and later `arrival.critical`,
 * and that is exactly the bug: the code is in the dedupe key, so escalation
 * would open a SECOND exception for the same villa and the same afternoon, and
 * the manager would acknowledge one and be left with the other. Severity lives
 * in `risk`, which is a field and not an identity.
 */

import type { AutopilotRiskState } from '../../contracts/states'
import type { Evidence, Readiness, Signal } from '../types'

import { localTime, minutesBetween } from './deadlines'
import { fact, type BookingFacts, type DetectorContext } from './facts'
import { signalKey } from './keys'
import { blockingRequirements } from './readiness'
import { isModuleEnabled, type SignalModule } from './modules'

/**
 * Something standing in the way, already decided by the module that owns it.
 *
 * `dedupeKey` is the key of the signal that reported it, when there is one.
 * That is what makes the incident a tree: the arrival risk points at the
 * shortage, the shortage points at the laundry delay, and the screen shows one
 * problem with three consequences rather than three alarms.
 */
export interface ArrivalBlocker {
  key: string
  /** `null` for a blocker that belongs to the core product. */
  module: SignalModule | null
  label: string
  /** Hebrew, from the owning engine. */
  detail: string
  source: string
  /** `blocking` stops the arrival. `warning` makes it worse, not impossible. */
  severity: 'blocking' | 'warning'
  /** The signal this came from, for `causedBy`. */
  dedupeKey?: string
}

/**
 * How much slack this organization considers comfortable.
 *
 * An input and never a default. Ninety minutes of margin is generous for a
 * studio and nothing at all for a villa with fifteen extra mattresses, and a
 * number chosen in this file would be the number every customer silently ran
 * on. `preparation/readiness.ts` takes the same position about the same
 * question.
 */
export interface ArrivalRiskThresholds {
  /** Below this much slack, `at_risk`. */
  warnSlackMinutes: number
  /** Below this much slack, `critical`. Usually zero or near it. */
  criticalSlackMinutes: number
}

export interface PreparationProgress {
  /** 0–100, from the preparation engine. `null` when there is no plan. */
  percentComplete: number | null
  /** The engine's typical duration for this property. Minutes. */
  typicalMinutes: number | null
  /** When the work actually started. `null` means it has not. */
  startedAt: string | null
  cleanerAssigned: boolean
  /** When the person holding the job took it on. */
  cleanerAcceptedAt: string | null
}

export interface ArrivalRiskInput {
  facts: BookingFacts
  readiness: Readiness
  preparation: PreparationProgress
  blockers: readonly ArrivalBlocker[]
  thresholds: ArrivalRiskThresholds
  context: DetectorContext
}

export interface ArrivalRiskAssessment {
  bookingId: string
  propertyId: string | null
  state: AutopilotRiskState
  /** Negative once the guest is due. `null` when no arrival time is fixed. */
  minutesToArrival: number | null
  /** What the preparation engine's numbers say is left. `null` without them. */
  remainingPreparationMinutes: number | null
  /** Minutes to spare. Negative means it cannot be finished in time. */
  slackMinutes: number | null
  /** Blockers for modules this organization actually has. */
  blockers: readonly ArrivalBlocker[]
  evidence: readonly Evidence[]
  readiness: Readiness
}

const PERCENT = 100

export function assessArrivalRisk(
  input: ArrivalRiskInput,
): ArrivalRiskAssessment {
  const { facts, readiness, preparation, context, thresholds } = input
  const { now } = context

  // A blocker naming a module the organization does not have is dropped here
  // and not later. Filtering at the screen would leave the wording in the
  // stored evidence, and the evidence is what a person reads six weeks on.
  const blockers = input.blockers.filter(
    (blocker) =>
      blocker.module === null ||
      isModuleEnabled(context.modules, blocker.module),
  )

  const arrival = facts.arrivalAt === null ? null : new Date(facts.arrivalAt)
  const minutesToArrival =
    arrival === null || Number.isNaN(arrival.getTime())
      ? null
      : minutesBetween(now, arrival)

  const remaining = remainingMinutes(preparation)
  const slack =
    minutesToArrival === null || remaining === null
      ? null
      : minutesToArrival - remaining

  const evidence = describe(input, minutesToArrival, remaining, slack, blockers)
  const state = grade({
    readiness,
    blockers,
    slack,
    remaining,
    minutesToArrival,
    thresholds,
  })

  return {
    bookingId: facts.bookingId,
    propertyId: facts.propertyId,
    state,
    minutesToArrival,
    remainingPreparationMinutes: remaining,
    slackMinutes: slack,
    blockers,
    evidence,
    readiness,
  }
}

/**
 * How much of the typical duration is left.
 *
 * A plan that has not started has all of it left, which is the case the whole
 * feature is for: at 13:42 with a 105-minute preparation and a 15:00 arrival,
 * the work is already eighteen minutes late and nobody has noticed, because
 * nothing is overdue and no task is red.
 */
function remainingMinutes(preparation: PreparationProgress): number | null {
  if (preparation.typicalMinutes === null) return null
  if (preparation.percentComplete === null) return preparation.typicalMinutes
  const done = Math.min(PERCENT, Math.max(0, preparation.percentComplete))
  return Math.round((preparation.typicalMinutes * (PERCENT - done)) / PERCENT)
}

function grade(args: {
  readiness: Readiness
  blockers: readonly ArrivalBlocker[]
  slack: number | null
  remaining: number | null
  minutesToArrival: number | null
  thresholds: ArrivalRiskThresholds
}): AutopilotRiskState {
  const blocking = args.blockers.filter(
    (blocker) => blocker.severity === 'blocking',
  )
  const blockedRequirements = blockingRequirements(args.readiness)

  // With no work left there is nothing to fit into the remaining time, so
  // slack is not a verdict about anything. Without this, a villa finished at
  // noon reports `critical` from three o'clock onward purely because the
  // arrival is in the past — which is the sort of alarm that teaches a manager
  // the red rows are wrong.
  const slackState: AutopilotRiskState | null =
    args.slack === null || args.remaining === 0
      ? null
      : args.slack <= args.thresholds.criticalSlackMinutes
        ? 'critical'
        : args.slack <= args.thresholds.warnSlackMinutes
          ? 'at_risk'
          : 'on_track'

  // Everything that could be wrong is right, and the work still fits. Said as
  // a condition rather than as `percent === 100`, because a booking whose
  // requirements are all `not_applicable` has `percent: null` and is
  // legitimately ready — see `readiness.ts` on the empty denominator.
  if (
    args.readiness.risk === 'ready' &&
    blocking.length === 0 &&
    (slackState === null || slackState === 'on_track')
  ) {
    return 'ready'
  }

  // Past the arrival with something still open is critical whatever the
  // arithmetic says. There is no time left to grade.
  if (args.minutesToArrival !== null && args.minutesToArrival <= 0) {
    return 'critical'
  }

  // A blocker with time still on the clock is at risk; a blocker with the
  // clock run out is critical. The two are separate judgments and both are
  // needed: an unresolved gas leak at 09:00 is not "on track" merely because
  // there are six hours left.
  const blockerState: AutopilotRiskState | null =
    blocking.length === 0 && blockedRequirements.length === 0
      ? null
      : slackState === 'critical'
        ? 'critical'
        : 'at_risk'

  return worst([slackState, blockerState, args.readiness.risk])
}

const SEVERITY: Readonly<Record<AutopilotRiskState, number>> = {
  ready: 0,
  on_track: 1,
  at_risk: 2,
  critical: 3,
}

/** The worst of several verdicts. Absent verdicts do not vote. */
export function worst(
  states: readonly (AutopilotRiskState | null)[],
): AutopilotRiskState {
  let found: AutopilotRiskState = 'on_track'
  for (const state of states) {
    if (state === null) continue
    if (SEVERITY[state] > SEVERITY[found]) found = state
  }
  return found
}

function describe(
  input: ArrivalRiskInput,
  minutesToArrival: number | null,
  remaining: number | null,
  slack: number | null,
  blockers: readonly ArrivalBlocker[],
): readonly Evidence[] {
  const { facts, preparation, context } = input
  const { now, timeZone } = context
  const evidence: Evidence[] = []

  if (facts.arrivalAt !== null) {
    evidence.push(
      fact(
        'arrival.at',
        'שעת ההגעה',
        localTime(new Date(facts.arrivalAt), timeZone),
        'booking',
        facts.arrivalAt,
      ),
    )
  }
  evidence.push(
    fact(
      'arrival.now',
      'השעה כעת',
      localTime(now, timeZone),
      'deadlines',
      now.toISOString(),
    ),
  )
  if (minutesToArrival !== null) {
    evidence.push(
      fact(
        'arrival.minutes_to_arrival',
        minutesToArrival < 0 ? 'דקות מאז ההגעה' : 'דקות עד ההגעה',
        Math.abs(minutesToArrival),
        'deadlines',
      ),
    )
  }
  if (preparation.typicalMinutes !== null) {
    evidence.push(
      fact(
        'preparation.typical_minutes',
        'משך הכנה טיפוסי בדקות',
        preparation.typicalMinutes,
        'preparation',
      ),
    )
  }
  if (preparation.percentComplete !== null) {
    evidence.push(
      fact(
        'preparation.percent_complete',
        'אחוז ההכנה שהושלם',
        preparation.percentComplete,
        'preparation',
      ),
    )
  }
  if (remaining !== null) {
    evidence.push(
      fact(
        'preparation.remaining_minutes',
        'דקות עבודה שנותרו',
        remaining,
        'preparation',
      ),
    )
  }
  if (slack !== null) {
    evidence.push(
      fact(
        'arrival.slack_minutes',
        slack < 0 ? 'דקות חסרות' : 'דקות מרווח',
        Math.abs(slack),
        'deadlines',
      ),
    )
  }

  // The cleaner's state is stated even when it is fine, because "המנקה טרם
  // התחיל" is the half of the sentence a person acts on and its absence would
  // read as "we did not look".
  evidence.push(
    fact(
      'cleaner.state',
      'מצב המנקה',
      cleanerState(preparation),
      'preparation',
      preparation.startedAt ?? preparation.cleanerAcceptedAt ?? undefined,
    ),
  )

  for (const blocker of blockers) {
    evidence.push({
      key: blocker.key,
      label: blocker.label,
      value: blocker.detail,
      source: blocker.source,
    })
  }

  for (const requirement of blockingRequirements(input.readiness)) {
    for (const item of requirement.evidence) evidence.push(item)
  }

  return evidence
}

function cleanerState(preparation: PreparationProgress): string {
  if (!preparation.cleanerAssigned) return 'טרם שובץ'
  if (preparation.cleanerAcceptedAt === null) return 'שובץ וטרם אישר'
  if (preparation.startedAt === null) return 'אישר וטרם התחיל'
  return 'בעבודה'
}

/**
 * The assessment as a signal, when there is something to say.
 *
 * `ready` and `on_track` produce nothing. An alert that fires when everything
 * is fine is an alert people turn off, and the readiness figure is already on
 * the screen for anybody who wants to look.
 */
export function arrivalRiskSignals(
  assessment: ArrivalRiskAssessment,
  facts: BookingFacts,
): Signal[] {
  if (assessment.state === 'ready' || assessment.state === 'on_track') return []

  const dedupeKey = signalKey({
    code: 'arrival.not_ready',
    resourceType: 'booking',
    resourceId: assessment.bookingId,
  })

  // The root, when a blocker named the signal it came from. The first blocking
  // one, because `blockers` arrives in the caller's triage order and the
  // caller is the one that knows which module it asked first.
  const root = assessment.blockers.find(
    (blocker) =>
      blocker.severity === 'blocking' && blocker.dedupeKey !== undefined,
  )

  const signal: Signal = {
    code: 'arrival.not_ready',
    domain: 'arrival_risk',
    risk: assessment.state,
    resourceType: 'booking',
    resourceId: assessment.bookingId,
    propertyId: assessment.propertyId,
    title: `${facts.label} — הנכס עלול לא להיות מוכן להגעה`,
    detail: composeDetail(assessment, facts),
    evidence: assessment.evidence,
    dedupeKey,
    ...(facts.arrivalAt === null ? {} : { dueAt: facts.arrivalAt }),
    ...(root?.dedupeKey === undefined ? {} : { causedBy: root.dedupeKey }),
  }
  return [signal]
}

function composeDetail(
  assessment: ArrivalRiskAssessment,
  facts: BookingFacts,
): string {
  const clauses: string[] = []
  const blocking = assessment.blockers.filter(
    (blocker) => blocker.severity === 'blocking',
  )
  for (const blocker of blocking) clauses.push(blocker.detail)

  for (const requirement of blockingRequirements(assessment.readiness)) {
    clauses.push(requirement.label)
  }

  if (assessment.slackMinutes !== null && assessment.slackMinutes < 0) {
    clauses.push(
      `חסרות ${Math.abs(assessment.slackMinutes)} דקות עד ההגעה` +
        (facts.arrivalTime === null ? '' : ` בשעה ${facts.arrivalTime}`),
    )
  }

  if (clauses.length === 0) return 'ההכנה אינה מתקדמת בקצב שיספיק עד ההגעה.'
  return clauses.join('; ')
}
