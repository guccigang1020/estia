/**
 * One ongoing problem is one row, however many times it is noticed.
 *
 * ── The number this file exists to keep from happening ────────────────────
 *
 * A towel shortage detected every five minutes for six hours is one problem
 * and seventy-two detections. A table that stored the detections would show a
 * manager seventy-two red rows about one cupboard, and the correct response to
 * that screen is to stop reading the screen.
 *
 * `autopilot_exceptions` enforces the shape with `unique (organization_id,
 * dedupe_key)`, so the guarantee does not depend on every detector remembering
 * to look first. What lives here is the arithmetic that goes with it: which of
 * a batch's repeats survives, what `seen_count` becomes, and how `last_seen_at`
 * moves.
 *
 * ── A pass is a sighting, not a row-count ─────────────────────────────────
 *
 * If one detection pass emits the same `dedupeKey` twice, that is one problem
 * observed once by a detector that ran a loop badly — so a pass contributes
 * exactly one to `seenCount`, never two. Counting the emissions would make
 * `seen_count` a measure of detector behaviour rather than of how long a
 * problem has been going on, which is the only thing anybody reads it for.
 *
 * ── Which copy survives ───────────────────────────────────────────────────
 *
 * The most urgent one, by the same comparator the triage uses — not the first
 * one in the array. Order-independence matters because the batch arrives from
 * several detectors whose order nobody controls, and "which of the two
 * identical keys did we keep" must not be answerable with "whichever ran
 * first".
 */

import type { Decision, Signal } from '../types'

import { compareSignals } from './triage'

/* --------------------------------------------------------------- shapes -- */

/**
 * The `seen_count` / `first_seen_at` / `last_seen_at` triple for one key.
 *
 * Carried beside the collapsed rows rather than inside them, because a
 * `Signal` is what a detector observed and these three are what the store
 * knows about the history of observing it. Merging them into the signal would
 * make a detector look like it had reported something it never saw.
 */
export interface Occurrence {
  dedupeKey: string
  /** Detection passes this problem has appeared in, this one included. */
  seenCount: number
  firstSeenAt: string
  lastSeenAt: string
}

export interface DedupeOptions {
  /** When this pass ran. ISO-8601. The one clock reading, passed in. */
  observedAt: string
  /**
   * What the store already holds for these keys, if the caller looked. Absent
   * means "treat everything as new", which is right for a caller that only
   * wants the batch collapsed and will do its own upsert.
   */
  known?: readonly Occurrence[]
}

export interface DedupeResult<T> {
  /** One per `dedupeKey`, most urgent copy kept, ordering otherwise intact. */
  kept: readonly T[]
  occurrences: readonly Occurrence[]
  /** How many rows were folded away. For the activity log, not the screen. */
  collapsed: number
}

/* ---------------------------------------------------------- the collapse -- */

/**
 * Collapse anything that carries a `Signal`, keeping the most urgent copy.
 *
 * Generic over the carrier rather than duplicated for signals and decisions:
 * the rule is identical and a second copy of it is a second place for the
 * `seen_count` arithmetic to be got subtly wrong.
 */
function collapse<T>(
  items: readonly T[],
  signalOf: (item: T) => Signal,
  options: DedupeOptions,
): DedupeResult<T> {
  const kept = new Map<string, T>()
  let collapsed = 0

  for (const item of items) {
    const signal = signalOf(item)
    const existing = kept.get(signal.dedupeKey)
    if (existing === undefined) {
      kept.set(signal.dedupeKey, item)
      continue
    }
    collapsed += 1
    if (compareSignals(signal, signalOf(existing)) < 0) {
      kept.set(signal.dedupeKey, item)
    }
  }

  const knownByKey = new Map<string, Occurrence>()
  for (const entry of options.known ?? [])
    knownByKey.set(entry.dedupeKey, entry)

  const occurrences: Occurrence[] = []
  for (const key of kept.keys()) {
    occurrences.push(
      occurrenceFor(key, knownByKey.get(key), options.observedAt),
    )
  }

  return { kept: [...kept.values()], occurrences, collapsed }
}

/**
 * The new counters for one key.
 *
 * `lastSeenAt` takes the LATER of the stored value and this pass, and
 * `firstSeenAt` the earlier. A clock that steps backwards — a replayed queue,
 * a container whose time syncs after start — must not rewind the history of a
 * problem, and "when did this start" must not move forward because a late
 * delivery of an old event arrived after a new one.
 */
function occurrenceFor(
  dedupeKey: string,
  known: Occurrence | undefined,
  observedAt: string,
): Occurrence {
  if (known === undefined) {
    return {
      dedupeKey,
      seenCount: 1,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
    }
  }
  return {
    dedupeKey,
    seenCount: known.seenCount + 1,
    firstSeenAt: earlier(known.firstSeenAt, observedAt),
    lastSeenAt: later(known.lastSeenAt, observedAt),
  }
}

/**
 * Compare two ISO timestamps, treating an unparseable one as absent.
 *
 * A stored value that will not parse is a corrupt row, and the right answer is
 * to prefer the one that does parse rather than to produce a `NaN` that would
 * quietly win every subsequent comparison.
 */
function pick(a: string, b: string, wantLater: boolean): string {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta)) return b
  if (Number.isNaN(tb)) return a
  const aWins = wantLater ? ta >= tb : ta <= tb
  return aWins ? a : b
}

function later(a: string, b: string): string {
  return pick(a, b, true)
}

function earlier(a: string, b: string): string {
  return pick(a, b, false)
}

/* ------------------------------------------------------------ the API ---- */

/**
 * Collapse a batch of signals before anything is composed for them.
 *
 * Cheaper than collapsing decisions, because composing a Hebrew reason for a
 * row that is about to be thrown away is work nobody reads. `decide()` uses
 * this one.
 */
export function dedupeSignals(
  signals: readonly Signal[],
  options: DedupeOptions,
): DedupeResult<Signal> {
  return collapse(signals, (signal) => signal, options)
}

/**
 * Collapse decisions, for a caller that already holds them — the plan screen
 * merging a fresh pass into what is already open.
 */
export function dedupeDecisions(
  decisions: readonly Decision[],
  options: DedupeOptions,
): DedupeResult<Decision> {
  return collapse(decisions, (decision) => decision.signal, options)
}

/** The occurrences as a lookup, for a screen showing "seen 72 times". */
export function occurrencesByKey(
  occurrences: readonly Occurrence[],
): ReadonlyMap<string, Occurrence> {
  return new Map(occurrences.map((entry) => [entry.dedupeKey, entry]))
}
