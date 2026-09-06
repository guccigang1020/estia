/**
 * Ordering. What ESTIA looks at first, and why no customer can change it.
 *
 * ── The order is the tuple, not a switch statement ────────────────────────
 *
 * `AUTOPILOT_DOMAINS` in the frozen contracts IS the priority order, and the
 * comparator here reads its index. It is deliberately not restated as a map or
 * a switch in this file: a second copy of an order is a second answer to "what
 * does ESTIA look at first", and the day the two disagree the screen and the
 * plan disagree with each other in front of a customer.
 *
 * That also means the order is not configurable, and that is a product
 * decision rather than an unfinished feature. Safety is first and optimization
 * is last for everybody. A business that could put revenue above a guest
 * locked out of a villa at midnight is a business ESTIA should not help build.
 *
 * ── Within a domain: severity, then the clock ─────────────────────────────
 *
 * Two preparation risks are separated by how badly they are going and then by
 * how little time is left. Both are arithmetic — the risk state was decided by
 * the detector and the deadline by the engine that owns it — so nothing here
 * is judgment, and the same batch always sorts the same way. That is what lets
 * the whole triage be tested without a database.
 */

import {
  AUTOPILOT_DOMAINS,
  AUTOPILOT_RISK_STATES,
  type AutopilotDomain,
  type AutopilotRiskState,
} from '../../contracts/states'
import type { Signal } from '../types'

/* ------------------------------------------------------------- ordinals -- */

/**
 * Domain → position, built once from the frozen tuple.
 *
 * A Map rather than `indexOf` on every comparison: a triage over a busy
 * morning's signals runs this on the order of n log n times, and the linear
 * scan inside it turns a cheap sort into a quadratic one for no reason.
 */
const DOMAIN_ORDER: ReadonlyMap<AutopilotDomain, number> = new Map(
  AUTOPILOT_DOMAINS.map((domain, index) => [domain, index]),
)

/**
 * Risk → position, with the tuple read backwards.
 *
 * `AUTOPILOT_RISK_STATES` ascends in severity — ready, on_track, at_risk,
 * critical — because that is the order somebody reading the contract wants.
 * Triage wants the worst first, so the position is the mirror of the index and
 * is derived from the tuple rather than typed out again here.
 */
const RISK_ORDER: ReadonlyMap<AutopilotRiskState, number> = new Map(
  AUTOPILOT_RISK_STATES.map((risk, index) => [
    risk,
    AUTOPILOT_RISK_STATES.length - 1 - index,
  ]),
)

/**
 * How early in the day this domain is looked at. Lower is sooner.
 *
 * A domain outside the tuple sorts last rather than throwing. A detector
 * emitting a domain the contract does not know is a bug in that detector, and
 * the right consequence is one badly-placed row at the bottom of the list, not
 * an empty screen during the morning it happens.
 */
export function domainPriority(domain: AutopilotDomain): number {
  return DOMAIN_ORDER.get(domain) ?? AUTOPILOT_DOMAINS.length
}

/** How bad it is. Lower is worse — `critical` is 0. */
export function riskPriority(risk: AutopilotRiskState): number {
  return RISK_ORDER.get(risk) ?? AUTOPILOT_RISK_STATES.length
}

/* ------------------------------------------------------------- deadline -- */

/**
 * When this stops being fixable, as a number.
 *
 * `dueAt` is the real deadline; `criticalAt` and `warnAt` are the thresholds
 * on the way to it and are only consulted when there is no `dueAt`, so a
 * signal that carries all three is ordered by the one that actually matters.
 *
 * Absent and unparseable both become `Infinity` — last. An unparseable
 * timestamp is a detector bug, and sorting it to the top on the strength of a
 * `NaN` comparison would put a broken row above a villa with a guest arriving
 * in forty minutes.
 */
export function deadlineOf(signal: Signal): number {
  return firstTime([signal.dueAt, signal.criticalAt, signal.warnAt])
}

function firstTime(candidates: readonly (string | undefined)[]): number {
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const parsed = Date.parse(candidate)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Number.POSITIVE_INFINITY
}

/* ----------------------------------------------------------- comparison -- */

/**
 * The whole triage rule, in the order it is applied.
 *
 * The final tiebreak on `dedupeKey` is not decoration. Two signals identical
 * in domain, risk and deadline would otherwise land in whatever order the
 * detectors happened to emit them, and a plan that reshuffles between two
 * passes over unchanged data is a plan a manager stops trusting.
 */
export function compareSignals(a: Signal, b: Signal): number {
  const byDomain = domainPriority(a.domain) - domainPriority(b.domain)
  if (byDomain !== 0) return byDomain

  const byRisk = riskPriority(a.risk) - riskPriority(b.risk)
  if (byRisk !== 0) return byRisk

  const byDeadline = deadlineOf(a) - deadlineOf(b)
  if (byDeadline !== 0 && Number.isFinite(byDeadline)) return byDeadline

  // One deadline present and the other absent: the one with a deadline first.
  const aHasDeadline = Number.isFinite(deadlineOf(a))
  const bHasDeadline = Number.isFinite(deadlineOf(b))
  if (aHasDeadline !== bHasDeadline) return aHasDeadline ? -1 : 1

  return a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0
}

/**
 * The batch, ordered.
 *
 * Returns a new array. Sorting the caller's array in place would mutate
 * something a detector may still hold a reference to, and the surprise would
 * surface as an ordering bug three stages downstream.
 */
export function triage(signals: readonly Signal[]): readonly Signal[] {
  return [...signals].sort(compareSignals)
}

/**
 * Where one signal would sit in a batch, without sorting the batch.
 *
 * For the screens that show a single exception and want to say how urgent it
 * is relative to everything else, without the list in hand.
 */
export function triageRank(signal: Signal): {
  domain: number
  risk: number
  deadline: number
} {
  return {
    domain: domainPriority(signal.domain),
    risk: riskPriority(signal.risk),
    deadline: deadlineOf(signal),
  }
}
