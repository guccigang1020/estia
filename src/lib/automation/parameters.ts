/**
 * The parts of a shipped rule a business is allowed to change.
 *
 * A rule library is only useful if the numbers in it can be somebody else's
 * numbers. "Ask for a review after two nights" is right for a city apartment
 * and wrong for a guesthouse whose whole business is one-night stops, and a
 * template a customer cannot adjust is a template they switch off.
 *
 * ── A parameter is a threshold that already exists, never a new one ───────
 *
 * Every entry below points at a condition that is ALREADY in the rule, by the
 * fact it compares and the operator it uses, and does nothing but replace the
 * number. That is the whole mechanism, and the restriction is the point:
 *
 *   · A parameter cannot add a condition, so it cannot make a rule compare a
 *     fact the trigger does not carry — which `evaluateConditions` would treat
 *     as unmet forever, leaving a configured-looking rule that never fires.
 *   · A parameter cannot change an action, so it cannot change which
 *     permission the rule needs after somebody has approved it.
 *   · A parameter cannot change the trigger, so `SIMULATED_TRIGGERS` and every
 *     sentence the dry run says about reach stay true.
 *
 * A rule with no numeric condition therefore has no parameters, and the screen
 * says so in Hebrew rather than rendering an empty box. Thirteen of the
 * fourteen shipped rules are in that position today: they are "when this
 * happens, tell the team", and there is genuinely nothing to tune. Inventing a
 * knob for them — a delay, a quiet-hours window — would be inventing a
 * capability the engine does not have.
 *
 * ── Numbers, because the database and the evaluator both say so ───────────
 *
 * `0067_automation_rules.sql` stores parameters as a flat object of numbers and
 * refuses anything else, and `conditions.ts` does not coerce: a string where a
 * number belongs evaluates `not_comparable` rather than matching. The two
 * agree, and this file is the third statement of the same fact — the one the
 * screen reads to render a field with bounds on it.
 *
 * PURE. No storage, no clock, no client.
 */

import { AUTOMATION_TEMPLATES, templateById } from './library'
import type { AutomationCondition, AutomationRule } from './types'

/** The condition kinds whose `value` is a number, and so is tunable. */
export type NumericConditionKind =
  'greater_than' | 'at_least' | 'less_than' | 'at_most'

const NUMERIC_KINDS: ReadonlySet<string> = new Set<NumericConditionKind>([
  'greater_than',
  'at_least',
  'less_than',
  'at_most',
])

export function isNumericCondition(
  condition: AutomationCondition,
): condition is Extract<AutomationCondition, { kind: NumericConditionKind }> {
  return NUMERIC_KINDS.has(condition.kind)
}

export interface RuleParameter {
  /**
   * The key stored in the `parameters` column.
   *
   * Matches the identifier shape 0067 enforces — lower case, underscores — so
   * a key that would be refused by the database cannot be declared here.
   */
  key: string
  /** Hebrew. The label on the field. */
  label: string
  /** Hebrew. Why the number matters, in one sentence a manager can act on. */
  help: string
  /** Hebrew. The unit, rendered beside the input. Empty where there is none. */
  unit: string
  /**
   * The bounds, and they are business bounds rather than storage ones.
   *
   * A minimum-nights threshold of zero would mean "every completed stay",
   * which the rule already expresses by having no condition — and a threshold
   * of four hundred is a rule that will never match. Both are refused with a
   * sentence rather than accepted and left to produce silence.
   */
  min: number
  max: number
  /** The value the library ships. A test asserts it equals the condition's. */
  shipped: number
  /** The condition this replaces the number in, addressed by what it says. */
  appliesTo: { field: string; kind: NumericConditionKind }
}

/**
 * Keyed by template id, and deliberately sparse.
 *
 * A template with no entry has nothing to tune. That is a statement about the
 * rule, not an omission, and `parametersFor` returns an empty list rather than
 * throwing so the caller renders "אין מה להתאים" instead of an error.
 */
export const RULE_PARAMETERS: Readonly<
  Record<string, readonly RuleParameter[]>
> = {
  'review-request-after-stay': [
    {
      key: 'minimum_nights',
      label: 'מספר הלילות המזערי',
      help: 'בקשה לחוות דעת נשלחת רק לשהייה שאורכה לפחות כך. אכסניה שרוב השהיות בה הן לילה אחד תרצה 1; דירת נופש תרצה יותר, כדי לא לבקש חוות דעת על לינה קצרה שאין עליה מה לומר.',
      unit: 'לילות',
      min: 1,
      max: 30,
      shipped: 2,
      appliesTo: { field: 'nights', kind: 'at_least' },
    },
  ],
}

export function parametersFor(templateId: string): readonly RuleParameter[] {
  return RULE_PARAMETERS[templateId] ?? []
}

/** What the library ships, as a stored parameter set would look like. */
export function shippedParameters(
  templateId: string,
): Readonly<Record<string, number>> {
  const values: Record<string, number> = {}
  for (const parameter of parametersFor(templateId)) {
    values[parameter.key] = parameter.shipped
  }
  return values
}

/* --------------------------------------------------------- validation --- */

export interface ParameterIssue {
  key: string
  /**
   * `unknown` — the rule has no such parameter.
   * `out_of_range` — the rule has it and this number is not allowed.
   * `not_finite` — it is not a number the database would store.
   */
  reason: 'unknown' | 'out_of_range' | 'not_finite'
  /** Hebrew, and it names the parameter and the bounds rather than the code. */
  message: string
}

/**
 * Everything wrong with a proposed parameter set, at once.
 *
 * Every failure, not the first, for the reason `evaluateConditions` collects
 * them all: a form must not reveal its problems one at a time.
 *
 * A parameter the caller did not mention is not an issue — it keeps whatever
 * it had, or the shipped value. Only what was said is judged.
 */
export function parameterIssues(
  templateId: string,
  values: Readonly<Record<string, number>>,
): readonly ParameterIssue[] {
  const declared = new Map(
    parametersFor(templateId).map((parameter) => [parameter.key, parameter]),
  )
  const issues: ParameterIssue[] = []

  for (const [key, value] of Object.entries(values)) {
    const parameter = declared.get(key)
    if (!parameter) {
      issues.push({
        key,
        reason: 'unknown',
        message: `לכלל הזה אין ערך בשם ״${key}״, ולכן אין מה לשמור בו.`,
      })
      continue
    }
    if (!Number.isFinite(value)) {
      issues.push({
        key,
        reason: 'not_finite',
        message: `הערך של ״${parameter.label}״ אינו מספר.`,
      })
      continue
    }
    if (value < parameter.min || value > parameter.max) {
      issues.push({
        key,
        reason: 'out_of_range',
        message: `״${parameter.label}״ חייב להיות בין ${parameter.min} ל-${parameter.max}. הערך שנשלח הוא ${value}.`,
      })
    }
  }

  return issues
}

/* ------------------------------------------------------------- applying -- */

/**
 * The rule as this organization configured it.
 *
 * Values the caller did not supply, and values the rule does not declare, are
 * ignored rather than defaulted to zero — a stored parameter set written
 * before a parameter was renamed must leave the rule at its shipped number
 * rather than silently retune it to nothing.
 *
 * The returned rule is a new object. Nothing mutates the library, which is a
 * module-level constant shared by every request in the process.
 */
export function applyParameters(
  rule: AutomationRule,
  values: Readonly<Record<string, number>>,
): AutomationRule {
  const parameters = parametersFor(rule.id)
  if (parameters.length === 0) return rule

  const conditions = rule.conditions.map((condition) => {
    if (!isNumericCondition(condition)) return condition

    const parameter = parameters.find(
      (candidate) =>
        candidate.appliesTo.field === condition.field &&
        candidate.appliesTo.kind === condition.kind,
    )
    if (!parameter) return condition

    const value = values[parameter.key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return condition
    if (value < parameter.min || value > parameter.max) return condition

    return { ...condition, value }
  })

  return { ...rule, conditions }
}

/** Every template that has something to tune. Used by the tests and the screen. */
export function tunableTemplateIds(): readonly string[] {
  return AUTOMATION_TEMPLATES.filter(
    (template) => parametersFor(template.rule.id).length > 0,
  ).map((template) => template.rule.id)
}

/** The template a parameter set belongs to, or null. Re-exported for callers. */
export function templateForParameters(templateId: string) {
  return templateById(templateId)
}
