/**
 * Does this booking qualify?
 *
 * ── The rule that shapes every line below ──────────────────────────────────
 *
 * **A condition that cannot be decided is not met.**
 *
 * A discount engine that guesses gives money away. Every fact in
 * `PromotionFacts` is nullable, and a null is never read as zero: "the stay is
 * zero nights long" and "nobody counted the nights" are different statements,
 * and only the first should decide anything. So an absent fact fails the
 * condition and says which fact was missing, rather than defaulting to a value
 * that happens to satisfy the comparison.
 *
 * This is the opposite of the default a permissive evaluator would take, and
 * it is the whole reason the result carries a reason instead of a boolean.
 *
 * ── No coercion, deliberately ──────────────────────────────────────────────
 *
 * `conditions.ts` in `src/lib/automation` learned this the expensive way: a
 * threshold that arrives as the string `"3"` and is coerced compares fine
 * today and silently changes meaning the first time somebody stores `"3a"`.
 * Here a non-finite threshold is a malformed condition and says so. The CHECK
 * on `promotions.conditions` refuses those at the database, so reaching one is
 * evidence of a write that went round the table — worth a loud answer.
 */

import { BOOKING_SOURCES } from '../booking/types'
import type {
  ConditionComparator,
  PromotionCondition,
  PromotionFacts,
} from './types'

/**
 * Met, or not met with the reason.
 *
 * The reason is a machine code and not a sentence. Hebrew belongs in
 * `labels.ts`, next to the screen that renders it; a reason string baked in
 * here would be a translation nobody could find.
 */
export type ConditionResult =
  { met: true } | { met: false; because: ConditionFailure }

export type ConditionFailure =
  /** The comparison ran and the booking did not qualify. */
  | { reason: 'not_qualified' }
  /** A fact the condition needs was not measured. Fails closed. */
  | { reason: 'fact_absent'; fact: string }
  /** The stored condition is not one this evaluator knows how to run. */
  | { reason: 'malformed'; detail: string }

const MET: ConditionResult = { met: true }

const NOT_QUALIFIED: ConditionResult = {
  met: false,
  because: { reason: 'not_qualified' },
}

function absent(fact: string): ConditionResult {
  return { met: false, because: { reason: 'fact_absent', fact } }
}

function malformed(detail: string): ConditionResult {
  return { met: false, because: { reason: 'malformed', detail } }
}

/**
 * How deep a condition tree may go.
 *
 * Six, matching `promotion_condition_valid` in 0073. Not a capacity limit — a
 * readability one. A campaign's terms are read aloud to a guest on the phone,
 * and past six nestings nobody can do that. The honest fix for a rule that
 * needs seven is two promotions in an `exclusiveGroup`, which a person can
 * describe in two sentences.
 */
export const MAX_CONDITION_DEPTH = 6

/** The weekdays a `weekday_set` may name. 0 = Sunday, 6 = Saturday. */
const WEEKDAYS = new Set([0, 1, 2, 3, 4, 5, 6])

const SOURCES: ReadonlySet<string> = new Set(BOOKING_SOURCES)

export function evaluateCondition(
  node: PromotionCondition,
  facts: PromotionFacts,
  depth = 0,
): ConditionResult {
  if (depth > MAX_CONDITION_DEPTH) {
    return malformed(`nested deeper than ${MAX_CONDITION_DEPTH}`)
  }

  switch (node.kind) {
    case 'compare': {
      if (!Number.isFinite(node.value)) {
        return malformed('compare threshold is not a finite number')
      }
      const measured = facts.measures[node.basis]
      // `?? undefined` is not enough here: the record may legitimately carry a
      // key whose value is undefined, and both spellings of "not measured"
      // must fail closed rather than compare against NaN.
      if (measured === undefined || !Number.isFinite(measured)) {
        return absent(node.basis)
      }
      return compare(measured, node.comparator, node.value)
    }

    case 'advance': {
      if (!Number.isFinite(node.days)) {
        return malformed('advance threshold is not a finite number')
      }
      // Measured from the booking's creation day, never from now — §6 rule 36.
      // Whoever builds the facts owes that; this file only refuses to invent
      // the number when they did not.
      if (facts.advanceDays === null) return absent('advance_days')
      return compare(facts.advanceDays, node.comparator, node.days)
    }

    case 'weekday_set': {
      if (node.allOf.length === 0) {
        // An empty set would be vacuously true for every stay, which reads on
        // screen as "midweek only" and behaves as "always". A campaign that
        // means "always" says so by having no condition at all.
        return malformed('weekday_set names no days')
      }
      if (node.allOf.some((day) => !WEEKDAYS.has(day))) {
        return malformed('weekday_set names a day outside 0–6')
      }
      if (facts.nightWeekdays === null) return absent('night_weekdays')
      // A stay with no nights cannot satisfy "every night is midweek". It is
      // also not a stay — §6 rule 2 refuses it before pricing — so this is the
      // belt rather than the braces.
      if (facts.nightWeekdays.length === 0) return NOT_QUALIFIED

      const allowed = new Set(node.allOf)
      return facts.nightWeekdays.every((day) => allowed.has(day))
        ? MET
        : NOT_QUALIFIED
    }

    case 'source': {
      if (node.anyOf.length === 0) return malformed('source names no channels')
      if (node.anyOf.some((source) => !SOURCES.has(source))) {
        return malformed('source names a channel that does not exist')
      }
      if (facts.source === null) return absent('source')
      return node.anyOf.includes(facts.source) ? MET : NOT_QUALIFIED
    }

    case 'guest_history': {
      if (!Number.isFinite(node.minCompletedBookings)) {
        return malformed('guest_history threshold is not a finite number')
      }
      // §6 rule 35: this count is scoped to the organization by whoever
      // measured it. A returning guest of another business is not one here,
      // and there is no query in this module that could accidentally widen it.
      if (facts.completedBookings === null) return absent('completed_bookings')
      return facts.completedBookings >= node.minCompletedBookings
        ? MET
        : NOT_QUALIFIED
    }

    case 'all': {
      // An empty `all` is `NO_CONDITION`: a campaign with nothing to test.
      // Vacuously true, which is the correct reading of a conjunction of
      // nothing and the reason the empty case is spelled this way.
      for (const child of node.of) {
        const result = evaluateCondition(child, facts, depth + 1)
        if (!result.met) return result
      }
      return MET
    }

    case 'any': {
      if (node.of.length === 0) {
        // A disjunction of nothing is vacuously FALSE, which on screen looks
        // identical to the vacuously-true empty `all` and behaves opposite.
        // Refusing it is kinder than having the two differ silently.
        return malformed('any has no branches')
      }
      let firstFailure: ConditionResult = NOT_QUALIFIED
      let sawFailure = false
      for (const child of node.of) {
        const result = evaluateCondition(child, facts, depth + 1)
        if (result.met) return MET
        if (!sawFailure) {
          firstFailure = result
          sawFailure = true
        }
      }
      return firstFailure
    }

    case 'not': {
      const inner = evaluateCondition(node.of, facts, depth + 1)
      // A negation does NOT rescue a missing fact. `not(nights >= 5)` on a
      // booking whose nights were never counted is still undecidable, and
      // reporting it as met would be the guess this whole file refuses.
      if (!inner.met && inner.because.reason !== 'not_qualified') return inner
      return inner.met ? NOT_QUALIFIED : MET
    }

    default: {
      // Unreachable through the type, reachable through a row. The CHECK in
      // 0073 refuses an unknown `kind`, so arriving here means something wrote
      // past the table.
      const unknown = node as { kind?: unknown }
      return malformed(`unknown condition kind: ${String(unknown.kind)}`)
    }
  }
}

function compare(
  left: number,
  comparator: ConditionComparator,
  right: number,
): ConditionResult {
  switch (comparator) {
    case 'lt':
      return left < right ? MET : NOT_QUALIFIED
    case 'lte':
      return left <= right ? MET : NOT_QUALIFIED
    case 'eq':
      return left === right ? MET : NOT_QUALIFIED
    case 'gte':
      return left >= right ? MET : NOT_QUALIFIED
    case 'gt':
      return left > right ? MET : NOT_QUALIFIED
    default:
      return malformed(`unknown comparator: ${String(comparator)}`)
  }
}
