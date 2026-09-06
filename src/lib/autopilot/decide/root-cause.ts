/**
 * Four alarms that are really one incident.
 *
 * ── The morning this exists for ───────────────────────────────────────────
 *
 * The laundry van is late. Because the van is late the linen is not back, so
 * the towel count for Friday is short. Because the count is short the
 * preparation for Villa A cannot be completed. Because the preparation cannot
 * be completed the 15:00 arrival is at risk.
 *
 * Four detectors fire, correctly, and a screen that has not been told they are
 * connected shows four unrelated red rows at 06:00. The manager reads them as
 * four problems, opens four conversations, and solves none of them — because
 * there is exactly one thing to do, and it is to telephone the laundry.
 *
 * This file turns that into ONE incident with three consequences.
 *
 * ── `causedBy` points at the cause, and cycles are bugs ───────────────────
 *
 * A signal's `causedBy` is the `dedupeKey` of the signal it is downstream of.
 * The graph that produces is supposed to be a forest, and two things reliably
 * break that in production:
 *
 *   · a cycle, which is always a detector bug — nothing physically causes its
 *     own cause. It is dropped, reported, and never crashes a morning brief.
 *     A thrown exception here would take down the whole screen because two
 *     detectors disagreed about which of them was upstream.
 *
 *   · a `causedBy` naming a signal that is not in this batch, because the root
 *     was raised yesterday and is still open. The child is kept as its own
 *     root and reported, rather than being silently attached to nothing and
 *     disappearing from a plan that is supposed to be exhaustive.
 *
 * Everything here is arithmetic over the batch it is handed. No clock, no
 * database, no lookup of the older root — the caller who has that row can
 * re-parent it, and this function's answer stays testable in isolation.
 */

import type { Signal } from '../types'

import { compareSignals, triage } from './triage'

/* --------------------------------------------------------------- shapes -- */

/** One downstream signal, and how far downstream it is. */
export interface Consequence {
  signal: Signal
  /** 1 is caused directly by the root; 2 is caused by a consequence. */
  depth: number
  /** The `dedupeKey` of the IMMEDIATE cause, which is not always the root. */
  causedBy: string
}

/**
 * A root and everything downstream of it, flattened.
 *
 * Flat rather than nested, because the question the screen asks is "what else
 * is this breaking" and the answer is a list. The chain is still recoverable:
 * `depth` and `causedBy` on each consequence describe the tree exactly, and a
 * caller that wants to indent has everything it needs without this shape
 * forcing recursion on every caller that does not.
 */
export interface Incident {
  root: Signal
  consequences: readonly Consequence[]
}

/** A detector bug: a `causedBy` chain that closes on itself. */
export interface CycleReport {
  /** The keys on the cycle, in the order they were walked. */
  members: readonly string[]
  /** The edge that was dropped, `from` → `to`. `from` became a root. */
  droppedFrom: string
  droppedTo: string
}

/** A `causedBy` naming something outside this batch. */
export interface DanglingCause {
  dedupeKey: string
  missingCause: string
}

export interface RootCauseResult {
  /** Ordered by triage, on the most urgent member of each incident. */
  incidents: readonly Incident[]
  cycles: readonly CycleReport[]
  dangling: readonly DanglingCause[]
  /** Batch keys that appeared more than once. Dedupe should have run first. */
  duplicateKeys: readonly string[]
}

/* ------------------------------------------------------------ the graph -- */

/**
 * Build the forest.
 *
 * Three passes, each of which is doing one thing:
 *
 *   1. index the batch by `dedupeKey`, noticing repeats;
 *   2. resolve every edge to a parent that exists, dropping self-references
 *      and back-edges as it goes;
 *   3. walk down from the roots, collecting depth.
 *
 * The cycle break in pass 2 is iterative and memoised rather than recursive:
 * a chain of a few hundred signals is a plausible morning for a management
 * company, and a stack overflow inside the thing that is supposed to make a
 * screen readable is a poor trade.
 */
export function rootCause(signals: readonly Signal[]): RootCauseResult {
  const index = new Map<string, Signal>()
  const duplicateKeys: string[] = []

  for (const signal of signals) {
    const existing = index.get(signal.dedupeKey)
    if (existing === undefined) {
      index.set(signal.dedupeKey, signal)
      continue
    }
    // Keep the more urgent of the two, so a graph built over a batch that
    // skipped dedupe still shows the worse of the pair rather than whichever
    // detector happened to run first.
    if (compareSignals(signal, existing) < 0)
      index.set(signal.dedupeKey, signal)
    if (!duplicateKeys.includes(signal.dedupeKey)) {
      duplicateKeys.push(signal.dedupeKey)
    }
  }

  const dangling: DanglingCause[] = []
  const cycles: CycleReport[] = []

  /** key → the parent it will actually be attached to, or null for a root. */
  const parent = new Map<string, string | null>()

  for (const [key, signal] of index) {
    const cause = signal.causedBy
    if (cause === undefined || cause === key) {
      // A self-reference is the degenerate cycle. The database refuses it with
      // `autopilot_exceptions_not_self_caused`; in memory it would be an
      // infinite walk, so it is reported as the cycle it is.
      if (cause === key) {
        cycles.push({ members: [key], droppedFrom: key, droppedTo: key })
      }
      parent.set(key, null)
      continue
    }
    if (!index.has(cause)) {
      dangling.push({ dedupeKey: key, missingCause: cause })
      parent.set(key, null)
      continue
    }
    parent.set(key, cause)
  }

  breakCycles(parent, cycles)

  /* ---- pass 3: children, then a walk down from each root ---------------- */

  const children = new Map<string, string[]>()
  const roots: string[] = []

  for (const [key, cause] of parent) {
    if (cause === null) {
      roots.push(key)
      continue
    }
    const siblings = children.get(cause)
    if (siblings === undefined) children.set(cause, [key])
    else siblings.push(key)
  }

  const incidents: Incident[] = []

  for (const rootKey of roots) {
    const rootSignal = index.get(rootKey)
    if (rootSignal === undefined) continue

    const consequences: Consequence[] = []
    let frontier = [rootKey]
    let depth = 1

    while (frontier.length > 0) {
      const next: string[] = []
      const level: Consequence[] = []

      for (const parentKey of frontier) {
        const kids = children.get(parentKey) ?? []
        for (const kidKey of kids) {
          const kidSignal = index.get(kidKey)
          if (kidSignal === undefined) continue
          level.push({ signal: kidSignal, depth, causedBy: parentKey })
          next.push(kidKey)
        }
      }

      // Within one level, triage order — so the most urgent consequence of a
      // late van reads first whatever order the detectors emitted them in.
      level.sort((a, b) => compareSignals(a.signal, b.signal))
      consequences.push(...level)

      frontier = next
      depth += 1
    }

    incidents.push({ root: rootSignal, consequences })
  }

  incidents.sort(compareIncidents)

  return { incidents, cycles, dangling, duplicateKeys }
}

/**
 * Drop the back-edge of every cycle, and only the back-edge.
 *
 * Walks up from each key, remembering the path. Reaching a key already on the
 * current path means the last edge closed a loop, so that edge is cut and the
 * node it came from becomes a root — which keeps every member of the cycle
 * present and visible, rather than deleting a cluster of real problems because
 * two detectors disagreed about direction.
 *
 * `settled` makes this near-linear: a key whose ancestry has already been
 * walked cannot start a new cycle, because any cycle it belonged to was cut on
 * that earlier walk.
 */
function breakCycles(
  parent: Map<string, string | null>,
  cycles: CycleReport[],
): void {
  const settled = new Set<string>()

  for (const start of parent.keys()) {
    if (settled.has(start)) continue

    const path: string[] = []
    const onPath = new Set<string>()
    let cursor: string | null = start

    while (cursor !== null && !settled.has(cursor)) {
      if (onPath.has(cursor)) {
        // `cursor` is already above us on this walk: the edge from the
        // previous node closed the loop.
        const from = path[path.length - 1]
        if (from !== undefined) {
          parent.set(from, null)
          cycles.push({
            members: path.slice(path.indexOf(cursor)),
            droppedFrom: from,
            droppedTo: cursor,
          })
        }
        break
      }
      path.push(cursor)
      onPath.add(cursor)
      cursor = parent.get(cursor) ?? null
    }

    for (const key of path) settled.add(key)
  }
}

/**
 * Incidents are ordered by their most urgent member, not by their root.
 *
 * A late laundry van sits in the `laundry` domain, near the bottom of the
 * triage order — and if it is about to cost a 15:00 arrival, an ordering that
 * read only the root would bury the single most important thing in the day
 * beneath four things that can wait. The incident inherits the urgency of the
 * worst thing it is causing, which is the honest reading of why it matters.
 */
function compareIncidents(a: Incident, b: Incident): number {
  return compareSignals(mostUrgent(a), mostUrgent(b))
}

function mostUrgent(incident: Incident): Signal {
  const members = [incident.root, ...incident.consequences.map((c) => c.signal)]
  const ordered = triage(members)
  return ordered[0] ?? incident.root
}

/* ------------------------------------------------------------- helpers --- */

/** Every signal in one incident, root first. For a caller counting rows. */
export function incidentSignals(incident: Incident): readonly Signal[] {
  return [incident.root, ...incident.consequences.map((c) => c.signal)]
}

/** The root's `dedupeKey` for each signal in the batch, including its own. */
export function rootKeyBySignal(
  result: RootCauseResult,
): ReadonlyMap<string, string> {
  const byKey = new Map<string, string>()
  for (const incident of result.incidents) {
    byKey.set(incident.root.dedupeKey, incident.root.dedupeKey)
    for (const consequence of incident.consequences) {
      byKey.set(consequence.signal.dedupeKey, incident.root.dedupeKey)
    }
  }
  return byKey
}
