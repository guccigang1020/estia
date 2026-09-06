/**
 * "סדר לי את היום" — every open decision, turned into a list somebody can
 * actually work through.
 *
 * ── A plan of forty items is not a plan ───────────────────────────────────
 *
 * The failure this file is written against is not "ESTIA missed something". It
 * is "ESTIA produced a correct, exhaustive, forty-line list at 06:00 and the
 * manager closed the tab". A plan is a thing a person completes. Once it is
 * longer than a morning, it stops being a plan and becomes a second inbox.
 *
 * So the list is capped, and what is over the cap is COUNTED and reported
 * rather than dropped in silence. "עוד 23 נושאים ממתינים" is a true statement
 * a person can act on. Twenty-three invisible rows is not.
 *
 * ── One line per incident, not per alarm ──────────────────────────────────
 *
 * The grouping is the other half of the compression, and it is the half that
 * makes the cap honest rather than merely short. Four signals about a late
 * laundry van are one line, because there is one thing to do. Dropping three
 * of four unrelated problems would be hiding work; showing one line for four
 * connected ones is describing it correctly.
 *
 * ── The incident inherits the urgency of its worst consequence ────────────
 *
 * Ordering by the root's own domain would put a late van — `laundry`, near the
 * bottom of `AUTOPILOT_DOMAINS` — beneath things that can wait, on a morning
 * when the van is the reason a guest arrives at an unready villa. So an
 * incident is placed by the most urgent thing anywhere inside it. See
 * `rootCause`, which orders on the same rule for the same reason.
 *
 * Everything here is pure. The clock, the cap and the decisions all arrive as
 * arguments, which is what lets "what would the plan have been that morning"
 * be answered by a test rather than by a database restore.
 */

import type { Decision, Signal } from '../types'

import { rootCause, type CycleReport, type DanglingCause } from './root-cause'

/* --------------------------------------------------------------- shapes -- */

/**
 * How many lines a plan may have before it stops being one.
 *
 * Seven, and the number is a judgment rather than a measurement: it is about
 * one screen without scrolling, and about the number of things a shift
 * supervisor holds in their head between the office and the first villa. A
 * caller with a different situation — a full-day view, an owner with two
 * units — passes its own.
 */
export const DEFAULT_PLAN_LIMIT = 7

export interface PlanItem {
  /** Position in the plan, from 1, so it reads as "1 of 7" on a screen. */
  position: number
  /** The decision to act on: the root of the incident. */
  decision: Decision
  /**
   * What the screen offers. The first proposal, which is never absent —
   * `proposeActions` guarantees at least the manual-intervention floor.
   */
  next: Decision['actions'][number] | null
  /** The other decisions this one is causing, in triage order. */
  consequences: readonly Decision[]
  /**
   * Why this is where it is: the most urgent signal anywhere in the incident.
   * The same signal as `decision.signal` unless a consequence outranks it, in
   * which case a screen can say "מטפלים בכביסה כי ההגעה ב-15:00 תלויה בה".
   */
  drivenBy: Signal
}

export interface DayPlan {
  items: readonly PlanItem[]
  /** Incidents that did not fit the cap. Counted, never silently dropped. */
  deferred: number
  /** Individual decisions represented, the items and their consequences. */
  covered: number
  /** Hebrew, one line, for the top of the screen. */
  headline: string
  /** Detector bugs found on the way. Surfaced, not swallowed. */
  cycles: readonly CycleReport[]
  /** Consequences whose root was raised before this batch. */
  dangling: readonly DanglingCause[]
}

export interface PlanOptions {
  /** Default `DEFAULT_PLAN_LIMIT`. A limit of 0 means "count, show nothing". */
  limit?: number
}

/* ----------------------------------------------------------- the plan ---- */

/**
 * Group, order, cap.
 *
 * The decisions arrive already triaged and deduplicated — `decide()` does
 * both — so this function performs no ordering of its own beyond what
 * `rootCause` returns, which is deliberately the same comparator. A second
 * sort here would be a second opinion about priority.
 */
export function planDay(
  decisions: readonly Decision[],
  options: PlanOptions = {},
): DayPlan {
  const limit = options.limit ?? DEFAULT_PLAN_LIMIT

  const byKey = new Map<string, Decision>()
  for (const decision of decisions) {
    if (!byKey.has(decision.signal.dedupeKey)) {
      byKey.set(decision.signal.dedupeKey, decision)
    }
  }

  const graph = rootCause(decisions.map((decision) => decision.signal))

  const items: PlanItem[] = []
  let covered = 0

  for (const incident of graph.incidents) {
    const rootDecision = byKey.get(incident.root.dedupeKey)
    if (rootDecision === undefined) continue
    if (items.length >= limit) continue

    const consequences: Decision[] = []
    for (const consequence of incident.consequences) {
      const found = byKey.get(consequence.signal.dedupeKey)
      if (found !== undefined) consequences.push(found)
    }

    covered += 1 + consequences.length
    items.push({
      position: items.length + 1,
      decision: rootDecision,
      next: rootDecision.actions[0] ?? null,
      consequences,
      drivenBy: drivingSignal(rootDecision, consequences),
    })
  }

  const deferred = Math.max(0, graph.incidents.length - items.length)

  return {
    items,
    deferred,
    covered,
    headline: headlineFor(items.length, deferred, covered),
    cycles: graph.cycles,
    dangling: graph.dangling,
  }
}

/**
 * The signal that put this incident where it is.
 *
 * `rootCause` already ordered the consequences by triage within each level, so
 * the first consequence of the first level is the strongest candidate — but a
 * root that is itself worse than all of them keeps the honour, which is the
 * ordinary case and should not need a comparison to notice.
 */
function drivingSignal(
  root: Decision,
  consequences: readonly Decision[],
): Signal {
  let driver = root.signal
  let best = root.priority
  for (const consequence of consequences) {
    if (consequence.priority < best) {
      best = consequence.priority
      driver = consequence.signal
    }
  }
  return driver
}

/**
 * One Hebrew line describing the plan.
 *
 * Composed here rather than on the screen because the sentence changes shape
 * with the numbers — "אין נושאים פתוחים" is not a template with a zero in it —
 * and a template with three conditionals inside a component is where a product
 * starts saying "1 נושאים".
 */
function headlineFor(shown: number, deferred: number, covered: number): string {
  if (shown === 0 && deferred === 0) {
    return 'אין נושאים פתוחים. היום נראה מסודר.'
  }
  if (shown === 0) {
    return `${deferred} נושאים ממתינים, ואף אחד מהם לא נכנס לרשימה הנוכחית.`
  }

  const head =
    shown === 1 ? 'נושא אחד לטיפול היום' : `${shown} נושאים לטיפול היום`

  const grouped = covered > shown ? `, המכסים ${covered} התראות` : ''

  const rest = deferred > 0 ? `. עוד ${deferred} ממתינים אחריהם.` : '.'

  return `${head}${grouped}${rest}`
}
