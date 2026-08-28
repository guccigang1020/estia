/**
 * The rule evaluator.
 *
 * Three small functions and nothing else: does this rule apply, how many does
 * it ask for, and what does the buffer make of that. Everything they read is
 * data — a `PreparationRule` record and a `PreparationFacts` measurement — so
 * the engine has no opinion about towels, guests or Shabbat.
 *
 * ── Why rounding is always up ─────────────────────────────────────────────
 *
 * One hand towel per couple, twenty-five guests: 12.5. Twelve towels leaves a
 * guest without one; thirteen does not. Every quantity in this domain is a
 * physical object that cannot be delivered in halves, and the direction of the
 * error is not symmetric — a spare towel costs the laundry, a missing towel
 * costs the review. So `Math.ceil`, everywhere, with no per-rule override to
 * get wrong.
 *
 * The same applies after the buffer: towels plus ten percent on twenty-five is
 * 27.5, which is twenty-eight.
 */

import type {
  ConditionComparator,
  FactBasis,
  PreparationFacts,
  QuantityExpression,
  RequirementBuffer,
  RuleCondition,
} from './types'

/** Percent is per hundred. The only reason this constant exists. */
const PERCENT_SCALE = 100

// ── Reading a basis ───────────────────────────────────────────────────────

/**
 * The measured value behind a basis name.
 *
 * A `switch` rather than an index into the facts object, so adding a basis to
 * `FACT_BASES` without teaching this function about it fails to compile
 * instead of silently evaluating to `undefined` and producing a plan of `NaN`
 * pillows.
 */
export function factValue(basis: FactBasis, facts: PreparationFacts): number {
  switch (basis) {
    case 'guests':
      return facts.guests
    case 'adults':
      return facts.adults
    case 'children':
      return facts.children
    case 'nights':
      return facts.nights
    case 'bedrooms':
      return facts.bedrooms
    case 'bathrooms':
      return facts.bathrooms
    case 'permanent_capacity':
      return facts.permanentCapacity
    case 'sleeping_places':
      return facts.sleepingPlaces
    case 'extra_beds':
      return facts.extraBeds
    case 'booking':
      return facts.booking
  }
}

// ── Conditions ────────────────────────────────────────────────────────────

/**
 * Does the rule apply?
 *
 * `null` means unconditional, which is the common case and should not require
 * writing `{ kind: 'all', of: [] }` in every record.
 */
export function evaluateCondition(
  condition: RuleCondition | null,
  facts: PreparationFacts,
): boolean {
  if (condition === null) return true

  switch (condition.kind) {
    case 'compare': {
      const left = factValue(condition.basis, facts)
      return compare(left, condition.comparator, condition.value)
    }
    case 'event_type':
      return condition.anyOf.includes(facts.eventType)
    case 'flag':
      return (facts.flags[condition.flag] ?? false) === condition.equals
    case 'all':
      return condition.of.every((inner) => evaluateCondition(inner, facts))
    case 'any':
      return condition.of.some((inner) => evaluateCondition(inner, facts))
    case 'not':
      return !evaluateCondition(condition.of, facts)
  }
}

function compare(
  left: number,
  comparator: ConditionComparator,
  right: number,
): boolean {
  switch (comparator) {
    case 'lt':
      return left < right
    case 'lte':
      return left <= right
    case 'eq':
      return left === right
    case 'gte':
      return left >= right
    case 'gt':
      return left > right
  }
}

// ── Quantities ────────────────────────────────────────────────────────────

/**
 * How many, before the buffer.
 *
 * `basis × factor ÷ divisor + plus`, rounded up. A divisor of zero is treated
 * as one rather than producing `Infinity`: a misconfigured rule should over-
 * order, not crash the plan that a cleaner is standing in the house waiting
 * for.
 */
export function resolveQuantity(
  expression: QuantityExpression,
  facts: PreparationFacts,
): number {
  const basis = factValue(expression.basis, facts)
  const factor = expression.factor ?? 1
  const divisor = expression.divisor ?? 1
  const plus = expression.plus ?? 0

  const safeDivisor = divisor === 0 ? 1 : divisor
  const raw = (basis * factor) / safeDivisor + plus

  return raw <= 0 ? 0 : Math.ceil(raw)
}

/**
 * The quantity with the margin applied, rounded up again.
 *
 * A percentage buffer on zero is still zero — a rule that did not fire must
 * not acquire a requirement from its own safety margin.
 */
export function applyBuffer(
  quantity: number,
  buffer: RequirementBuffer | null,
): number {
  if (buffer === null || quantity <= 0) return quantity

  if (buffer.kind === 'flat') {
    return Math.ceil(quantity + buffer.amount)
  }

  return Math.ceil(
    (quantity * (PERCENT_SCALE + buffer.percent)) / PERCENT_SCALE,
  )
}

// ── Effective dating ──────────────────────────────────────────────────────

/** Anything with an effective window. */
export interface EffectiveDated {
  effectiveFrom: string
  effectiveTo: string | null
}

/**
 * The records in force on a date.
 *
 * Half-open, matching every other range in the product: `effectiveTo` is the
 * first day the rule no longer applies. A rule edited on the first of the
 * month therefore closes on the first and its replacement opens on the first,
 * with no day belonging to both and no day belonging to neither.
 *
 * ISO date strings compare correctly as strings, so no parsing is needed and
 * no timezone can shift a boundary by a day.
 */
export function effectiveOn<T extends EffectiveDated>(
  records: readonly T[],
  date: string,
): readonly T[] {
  return records.filter(
    (record) =>
      record.effectiveFrom <= date &&
      (record.effectiveTo === null || date < record.effectiveTo),
  )
}
