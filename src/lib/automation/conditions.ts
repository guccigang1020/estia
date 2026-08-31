/**
 * The IF clause, evaluated.
 *
 * Pure, total and boring on purpose. It takes a flat fact record and a list of
 * conditions and answers whether all of them hold — with the reason when they
 * do not, because "the automation did not run" is the single hardest thing to
 * diagnose about any rules engine, and the answer must not be a shrug.
 *
 * ── A missing fact is unmet, never true ───────────────────────────────────
 *
 * The one decision in this file worth arguing about. Three shapes exist and
 * they are genuinely different:
 *
 *   · the fact is present and matches      → met
 *   · the fact is present and does not     → unmet
 *   · the fact was never supplied          → unmet, and *said so*
 *
 * Folding the third into the second would be tolerable. Folding it into the
 * first would not: a `not_equals` against an absent field would evaluate true,
 * and the rule "when a booking is cancelled and the reason is not
 * `guest_request`, charge the fee" would charge every cancellation whose
 * payload happened not to carry a reason. So absence is its own outcome, it
 * fails closed, and it is reported by name.
 *
 * ── Comparisons do not coerce ─────────────────────────────────────────────
 *
 * `'3' === 3` is false here, and a numeric comparison against a non-numeric
 * fact is unmet rather than `NaN`-true. The facts come from a database through
 * PostgREST, where a `numeric` column arrives as a string, so the caller is
 * responsible for building facts in the type the rule compares against — and
 * a mismatch is visible as a rule that does not fire rather than as one that
 * fires on the wrong rows.
 */

import type { AutomationCondition, AutomationFacts, FactValue } from './types'

/** Why one condition did not hold. Hebrew, because a screen renders it. */
export interface ConditionFailure {
  condition: AutomationCondition
  /** The fact the condition names. */
  field: string
  reason: 'missing_fact' | 'not_matched' | 'not_comparable'
  message: string
}

export interface ConditionResult {
  met: boolean
  /** Every failure, not the first — a card lists all of them at once. */
  failures: readonly ConditionFailure[]
}

const MET: ConditionResult = { met: true, failures: [] }

/**
 * Do all of these hold?
 *
 * An empty list is met, and that is a deliberate statement rather than an
 * accident of the fold: a rule with no IF clause runs on every occurrence of
 * its event, which is exactly what "when a booking is cancelled, tell the
 * team" means.
 */
export function evaluateConditions(
  conditions: readonly AutomationCondition[],
  facts: AutomationFacts,
): ConditionResult {
  if (conditions.length === 0) return MET

  const failures: ConditionFailure[] = []
  for (const condition of conditions) {
    const failure = evaluateOne(condition, facts)
    if (failure) failures.push(failure)
  }

  return { met: failures.length === 0, failures }
}

function evaluateOne(
  condition: AutomationCondition,
  facts: AutomationFacts,
): ConditionFailure | null {
  const present = Object.prototype.hasOwnProperty.call(facts, condition.field)

  // `is_absent` is the one condition for which absence is the success case, so
  // the presence check has to come after it rather than before.
  if (condition.kind === 'is_absent') {
    const absent = !present || facts[condition.field] === null
    return absent
      ? null
      : failure(condition, 'not_matched', `השדה ״${condition.field}״ קיים.`)
  }

  if (!present) {
    return failure(
      condition,
      'missing_fact',
      `האירוע לא נשא את השדה ״${condition.field}״, ולכן התנאי לא התקיים.`,
    )
  }

  const value = facts[condition.field]

  switch (condition.kind) {
    case 'is_present':
      return value !== null
        ? null
        : failure(condition, 'not_matched', `השדה ״${condition.field}״ ריק.`)

    case 'equals':
      return value === condition.value
        ? null
        : failure(
            condition,
            'not_matched',
            `${condition.field} הוא ${describe(value)} ולא ${describe(condition.value)}.`,
          )

    case 'not_equals':
      return value !== condition.value
        ? null
        : failure(
            condition,
            'not_matched',
            `${condition.field} הוא ${describe(condition.value)}.`,
          )

    case 'one_of':
      return condition.values.includes(value)
        ? null
        : failure(
            condition,
            'not_matched',
            `${condition.field} הוא ${describe(value)} ואינו אחד מהערכים המבוקשים.`,
          )

    case 'greater_than':
    case 'at_least':
    case 'less_than':
    case 'at_most':
      return compare(condition, value)
  }
}

function compare(
  condition: Extract<
    AutomationCondition,
    { kind: 'greater_than' | 'at_least' | 'less_than' | 'at_most' }
  >,
  value: FactValue,
): ConditionFailure | null {
  // No coercion. A numeric rule against a string fact is a configuration
  // mistake, and reporting it as such is more useful than silently comparing
  // `'12' > 5` — which JavaScript would answer, correctly and uselessly.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return failure(
      condition,
      'not_comparable',
      `${condition.field} אינו מספר, ולכן לא ניתן להשוות אותו.`,
    )
  }

  const held =
    condition.kind === 'greater_than'
      ? value > condition.value
      : condition.kind === 'at_least'
        ? value >= condition.value
        : condition.kind === 'less_than'
          ? value < condition.value
          : value <= condition.value

  return held
    ? null
    : failure(
        condition,
        'not_matched',
        `${condition.field} הוא ${value} ואינו ${OPERATOR_LABEL[condition.kind]} ${condition.value}.`,
      )
}

const OPERATOR_LABEL: Record<
  'greater_than' | 'at_least' | 'less_than' | 'at_most',
  string
> = {
  greater_than: 'גדול מ־',
  at_least: 'לפחות',
  less_than: 'קטן מ־',
  at_most: 'לכל היותר',
}

function failure(
  condition: AutomationCondition,
  reason: ConditionFailure['reason'],
  message: string,
): ConditionFailure {
  return { condition, field: condition.field, reason, message }
}

function describe(value: FactValue): string {
  if (value === null) return 'ריק'
  if (value === true) return 'כן'
  if (value === false) return 'לא'
  return String(value)
}

/**
 * The IF clause as a sentence, for a card that has to show the rule rather
 * than execute it.
 *
 * Composed from the same union the evaluator switches on, so a condition kind
 * added without a label is a type error rather than a blank line on screen.
 */
export function describeCondition(condition: AutomationCondition): string {
  switch (condition.kind) {
    case 'equals':
      return `${condition.field} = ${describe(condition.value)}`
    case 'not_equals':
      return `${condition.field} ≠ ${describe(condition.value)}`
    case 'greater_than':
      return `${condition.field} > ${condition.value}`
    case 'at_least':
      return `${condition.field} ≥ ${condition.value}`
    case 'less_than':
      return `${condition.field} < ${condition.value}`
    case 'at_most':
      return `${condition.field} ≤ ${condition.value}`
    case 'one_of':
      return `${condition.field} ∈ {${condition.values.map(describe).join(', ')}}`
    case 'is_present':
      return `${condition.field} קיים`
    case 'is_absent':
      return `${condition.field} אינו קיים`
  }
}
