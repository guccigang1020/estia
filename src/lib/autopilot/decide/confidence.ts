/**
 * How sure ESTIA is about the JUDGMENT, and never about the facts.
 *
 * ── The distinction this file exists to protect ───────────────────────────
 *
 * "A second cleaner would probably finish Villa A before three" is a judgment,
 * and `medium` is an honest thing to say about it. "Six towels short" is
 * arithmetic performed by the inventory engine, and "probably six towels" is
 * not a more careful version of it — it is a different and false claim.
 *
 * So confidence is attached to a `ProposedAction` and never to a `Signal` or
 * an `Evidence`, and this file only ever reads evidence to ask ONE question:
 * is the reasoning standing on records, or on predictions?
 *
 * ── The ceiling, not a score ──────────────────────────────────────────────
 *
 * There are three values on purpose (see `AUTOPILOT_CONFIDENCE_LEVELS`), and
 * the rule is a ceiling rather than a sum:
 *
 *   · anything resting on an estimate — a typical duration, a predicted
 *     usage, a projected stock level — is at most `medium`;
 *   · anything resting only on recorded facts is `high`;
 *   · anything with nothing measured under it at all is `low`, and `low`
 *     never executes anything external or material.
 *
 * A weighted score would invite the threshold argument the three-value
 * vocabulary was chosen to avoid, and would imply a precision that a heuristic
 * over operational data does not have.
 */

import {
  AUTOPILOT_CONFIDENCE_LEVELS,
  type AutopilotConfidence,
} from '../../contracts/states'
import type { Evidence } from '../types'

/* ---------------------------------------------------------- the ladder --- */

/**
 * Confidence → position, from the frozen tuple. Higher index is more sure.
 *
 * Derived rather than restated so that adding a level to the contract does not
 * leave a silently stale comparison here.
 */
const CONFIDENCE_ORDER: ReadonlyMap<AutopilotConfidence, number> = new Map(
  AUTOPILOT_CONFIDENCE_LEVELS.map((level, index) => [level, index]),
)

function rank(level: AutopilotConfidence): number {
  return CONFIDENCE_ORDER.get(level) ?? 0
}

/** The lower of two levels. The ceiling rule, as a function. */
export function atMost(
  level: AutopilotConfidence,
  ceiling: AutopilotConfidence,
): AutopilotConfidence {
  return rank(level) <= rank(ceiling) ? level : ceiling
}

/** Ordinal comparison, for a policy floor such as "never act below medium". */
export function isAtLeast(
  level: AutopilotConfidence,
  floor: AutopilotConfidence,
): boolean {
  return rank(level) >= rank(floor)
}

/* ------------------------------------------------- estimate recognition -- */

/**
 * The words an engine uses when it is predicting rather than reporting.
 *
 * Matched against the SEGMENTS of an evidence key — `stock.projected` and
 * `duration.typical` are the shapes `types.ts` documents — rather than as a
 * substring of the whole key, so a real recorded fact about a property called
 * `expected_arrivals_desk` is not quietly demoted by a coincidence of naming.
 *
 * This is a convention, and conventions drift. `estimatedKeys` on the input is
 * the escape hatch: a caller that knows a key is an estimate says so, and is
 * believed over the naming.
 */
export const ESTIMATE_KEY_SEGMENTS: readonly string[] = [
  'projected',
  'predicted',
  'forecast',
  'typical',
  'estimated',
  'estimate',
  'expected',
  'assumed',
  'average',
  'likely',
]

/** Engines whose whole output is a prediction, whatever the key says. */
export const ESTIMATING_SOURCES: readonly string[] = [
  'forecast',
  'prediction',
  'model',
  'estimate',
]

function segments(key: string): readonly string[] {
  return key.toLowerCase().split(/[.\-_]/)
}

/**
 * Whether this fact is a prediction.
 *
 * `extraKeys` wins over the naming convention in both directions is
 * deliberately NOT the behaviour: it can only add. A caller cannot declare a
 * key named `stock.projected` to be a record, because the naming convention is
 * the thing the rest of the product reads and a local override would make the
 * same fact carry two confidences on two screens.
 */
export function isEstimatedEvidence(
  item: Evidence,
  extraKeys: readonly string[] = [],
): boolean {
  if (extraKeys.includes(item.key)) return true

  const source = item.source.toLowerCase()
  if (ESTIMATING_SOURCES.some((word) => source === word)) return true

  const parts = segments(item.key)
  return ESTIMATE_KEY_SEGMENTS.some((word) => parts.includes(word))
}

/* ----------------------------------------------------------- the ruling -- */

export interface ConfidenceInput {
  /** The facts under the proposal, exactly as the detector recorded them. */
  evidence: readonly Evidence[]
  /**
   * The REMEDY is a guess, even where every fact under it is recorded. "An
   * extra cleaner would fix this" rests on how long a second person takes,
   * which nobody measured for this villa on this morning.
   */
  remedyRestsOnEstimate?: boolean
  /**
   * Facts that would have mattered and could not be observed at all — a
   * cleaner with no phone signal, a provider who has not confirmed. Distinct
   * from an estimate: an estimate is a number with error bars, and this is no
   * number at all.
   */
  unobserved?: readonly string[]
  /** Keys the caller knows are predictions despite their naming. */
  estimatedKeys?: readonly string[]
}

/**
 * The confidence for one proposal.
 *
 * Note the first two rules, which are the ones that keep this honest. A
 * proposal with no measured fact under it is `low` even when everything about
 * it seems obvious, and a proposal with an unobserved gap in it is `low` even
 * when the facts that WERE observed are all records. Both are cases where the
 * remedy might be right and nobody can show why, and `low` is exactly the
 * state that stops it from being performed automatically.
 *
 * An evidence item whose `value` is `null` does not count as measured. That is
 * what a null is for here — the engine was asked and had no answer — and
 * counting it would let a detector reach `high` by listing questions.
 */
export function confidenceFor(input: ConfidenceInput): AutopilotConfidence {
  const measured = input.evidence.filter((item) => item.value !== null)
  if (measured.length === 0) return 'low'

  const unobserved = input.unobserved ?? []
  if (unobserved.length > 0) return 'low'

  const estimated = measured.some((item) =>
    isEstimatedEvidence(item, input.estimatedKeys ?? []),
  )
  if (estimated || input.remedyRestsOnEstimate === true) return 'medium'

  return 'high'
}
