/**
 * What the rules decided about one event — and nothing about what they did.
 *
 * PURE. An event name and a payload in, a list of decisions out. The write
 * lives in `runs.ts` and the subscriber that calls both lives in
 * `(app)/_lib/events.ts`.
 *
 * ── Why this is not `runAutomations` ──────────────────────────────────────
 *
 * `engine.ts` is the thing that performs. It takes an `Actor`, asks
 * `holdsGrant` per action, claims an idempotency key, calls a performer and
 * writes the audit trail. Every one of those is correct and every one of them
 * is out of reach here: the event bus is handed a Supabase client and an event,
 * it has no actor, and there is no performer behind any of the eight action
 * kinds. Calling the engine with a recording performer and a fabricated actor
 * would produce a run report whose refusals were about the fake actor rather
 * than about the business — a screen full of confident wrong answers.
 *
 * So this module answers the part that IS knowable from an event alone: does
 * the trigger match, is the rule on here, and does its IF clause hold. It
 * shares the evaluator with the engine — `evaluateConditions`, unmodified — so
 * the two cannot disagree about whether a condition held.
 *
 * A record therefore means "this rule is on and its conditions held", never
 * "this would have happened". The permission and plan floors are per action and
 * belong to the engine. `0075`'s comment on the column says the same thing, and
 * the screen says it in Hebrew.
 *
 * ── The threshold the caller cannot see ───────────────────────────────────
 *
 * A rule's numeric threshold may have been tuned by the business, and that
 * number lives in `automation_rules`, which the person whose action raised the
 * event may not read — 0067 gates it behind `automation.view`, which a
 * receptionist does not hold. The recorder in 0075 is SECURITY DEFINER for
 * exactly that reason, and it reads the threshold inside itself rather than
 * handing the configuration back.
 *
 * Which leaves this module unable to finish one comparison. So it does not
 * pretend to: every condition a parameter CANNOT touch is evaluated here, with
 * the real evaluator, and the remainder is emitted as a `gate` — the fact, the
 * operator and the shipped default — for the recorder to close. The split is
 * exactly the line `parameters.ts` draws: a parameter may only replace the
 * number in a numeric condition the rule already has.
 *
 * ── The facts are the ones a rule compares, and no others ─────────────────
 *
 * `factsForEvent` reads only the fields some template's conditions actually
 * name, derived from the library rather than listed here. An event payload can
 * carry a guest's name, a phone number, an amount; none of that decides
 * anything, so none of it is copied into a table that will sit for years. What
 * IS copied is what the decision turned on, which is what makes "it did not
 * match" diagnosable instead of a shrug.
 *
 * A consequence worth stating plainly rather than discovering: most event
 * payloads in this product do not carry the fields the library compares. A rule
 * whose condition names `nights` against an event whose payload has no `nights`
 * evaluates **unmet**, by `conditions.ts`'s deliberate fail-closed rule, and is
 * recorded as such with the missing field named. That is not this module being
 * wrong. It is the first time anybody could see it.
 */

import { evaluateConditions } from './conditions'
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from './library'
import {
  isNumericCondition,
  parametersFor,
  type NumericConditionKind,
  type RuleParameter,
} from './parameters'
import type {
  AutomationAction,
  AutomationCondition,
  AutomationFacts,
  FactValue,
} from './types'

import type { DomainEventName } from '../contracts/events'

/* --------------------------------------------------------------- facts --- */

/**
 * Every field any shipped rule compares, derived from the library.
 *
 * Derived rather than listed, so a template added next year with a condition on
 * `source` starts having `source` extracted without anybody remembering to come
 * back here — and so a fact nothing compares is never stored.
 */
export const COMPARED_FACTS: ReadonlySet<string> = new Set(
  AUTOMATION_TEMPLATES.flatMap((template) =>
    template.rule.conditions.map((condition) => condition.field),
  ),
)

/**
 * The payload, reduced to the facts a rule could compare.
 *
 * Scalars only, and only the named fields. A nested value is dropped rather
 * than flattened: `AutomationFacts` is flat precisely so a rule can never reach
 * into a structure the product did not mean to expose, and inventing a path
 * syntax here would be the place that promise stopped holding.
 *
 * A field that is present but is an object, an array or `undefined` is
 * **omitted**, not written as null. Absent and null are different answers to
 * `is_absent`, and only absence is honest about a value nobody supplied.
 */
export function factsForEvent(payload: unknown): AutomationFacts {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return {}

  const facts: Record<string, FactValue> = {}
  for (const [key, value] of Object.entries(
    payload as Record<string, unknown>,
  )) {
    if (!COMPARED_FACTS.has(key)) continue
    if (value === null) {
      facts[key] = null
      continue
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
      facts[key] = value
      continue
    }
    // `NaN` and `Infinity` are not facts. A numeric condition compared against
    // one would answer something, and `conditions.ts` refuses exactly this.
    if (typeof value === 'number' && Number.isFinite(value)) facts[key] = value
  }
  return facts
}

/* ---------------------------------------------------------- candidates --- */

/**
 * A comparison this module cannot finish.
 *
 * `fact` is null when the event did not carry the field or carried something
 * that is not a number — which the recorder treats as unmet, the same way
 * `conditions.ts` does. `shipped` is the library's own threshold, used when the
 * business has not stored one of its own.
 */
export interface EvaluationGate {
  key: string
  operator: NumericConditionKind
  fact: number | null
  shipped: number
}

/** One rule's decision about one event, as far as it can be decided here. */
export interface EvaluationCandidate {
  templateId: string
  /** The library's own answer, for a rule this business has never touched. */
  shippedEnabled: boolean
  /** Every condition a parameter cannot touch, per `evaluateConditions`. */
  conditionsMet: boolean
  /** Hebrew, from the evaluator. Null when everything held. */
  reason: string | null
  gates: readonly EvaluationGate[]
  wouldPerform: readonly AutomationAction[]
  facts: AutomationFacts
}

/**
 * Which parameter, if any, owns the number in this condition.
 *
 * Matched by what the condition SAYS — the fact and the operator — rather than
 * by position, exactly as `applyParameters` matches. A rule whose conditions
 * are reordered keeps the same parameters.
 */
function parameterFor(
  condition: AutomationCondition,
  parameters: readonly RuleParameter[],
): RuleParameter | null {
  if (!isNumericCondition(condition)) return null
  return (
    parameters.find(
      (parameter) =>
        parameter.appliesTo.field === condition.field &&
        parameter.appliesTo.kind === condition.kind,
    ) ?? null
  )
}

function numericFact(facts: AutomationFacts, field: string): number | null {
  const value = facts[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The rules that listen to this event, each with its decision so far.
 *
 * A rule whose trigger does not match produces nothing at all — not a
 * `skipped_trigger` record. Fourteen rules and roughly a hundred event names
 * would mean a table growing by fourteen rows per event to say thirteen times
 * that nothing was supposed to happen, which is the noise that makes an audit
 * trail unreadable. `skipped_disabled` IS recorded, because "this happened and
 * the rule that would have handled it is switched off" is a sentence somebody
 * wants to read.
 */
export function candidatesForEvent(
  name: DomainEventName,
  payload: unknown,
): readonly EvaluationCandidate[] {
  const facts = factsForEvent(payload)

  return AUTOMATION_TEMPLATES.filter(
    (template) => template.rule.when === name,
  ).map((template) => candidateFor(template, facts))
}

function candidateFor(
  template: AutomationTemplate,
  facts: AutomationFacts,
): EvaluationCandidate {
  const parameters = parametersFor(template.rule.id)

  const gates: EvaluationGate[] = []
  const fixed: AutomationCondition[] = []

  for (const condition of template.rule.conditions) {
    const parameter = parameterFor(condition, parameters)
    if (parameter === null) {
      fixed.push(condition)
      continue
    }
    gates.push({
      key: parameter.key,
      operator: parameter.appliesTo.kind,
      fact: numericFact(facts, condition.field),
      shipped: parameter.shipped,
    })
  }

  const result = evaluateConditions(fixed, facts)

  return {
    templateId: template.rule.id,
    shippedEnabled: template.rule.enabled,
    conditionsMet: result.met,
    // The first failure, not all of them. One column, one sentence, and the
    // rule card on screen already lists every condition the rule has.
    reason: result.failures[0]?.message ?? null,
    gates,
    wouldPerform: template.rule.actions,
    facts,
  }
}
