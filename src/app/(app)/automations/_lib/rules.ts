/**
 * PURE. One rule, everything the screen knows about it, in one object.
 *
 * Three modules already answer three different questions about a rule, and no
 * screen wants three lists that have to be zipped together by hand:
 *
 *   · `ruleReadiness` — could this run, for this person, on this package?
 *   · `simulate`      — what would it have done to the rows in this database?
 *   · `candidateEvents` — is its trigger even reconstructible from those rows?
 *
 * This file joins them and adds exactly one thing none of them can answer,
 * because none of them sees both halves: whether the events that *did* occur
 * carried the facts the rule's IF clause compares against. That is the third
 * refusal the product owes a reader — a missing entitlement, a missing grant,
 * or a fact the trigger does not carry — and without it a rule that will never
 * fire renders as a healthy green card.
 *
 * ── Nothing here re-derives a decision ────────────────────────────────────
 *
 * The readiness statuses are `readiness.ts`'s, the counts are the engine's as
 * reported by `simulate`, and the blockers below are a *translation* of those
 * into sentences — not a second opinion about them. The one computation this
 * file performs is `missingFacts`, which is a set difference over data the
 * other two never look at together.
 */

import {
  AUTOMATION_ENTITLEMENT,
  AUTOMATION_TEMPLATES,
  ruleReadiness,
  type AutomationRule,
  type RuleReadiness,
} from '@/lib/automation'
import type { Actor } from '@/lib/authz/can'
import type { Entitlement } from '@/lib/plans/entitlements'

import type { Candidate, DryRun, RuleSimulation } from './dry-run'
import {
  actionGrantLabel,
  factLabel,
  isSimulatedTrigger,
  notSimulatedReason,
} from './labels'

/* --------------------------------------------------------- the rule set --- */

/**
 * The rules this organization has.
 *
 * They are the library's, and that is a statement about the deployment rather
 * than a shortcut. `library.ts` says it in its own header: a template is a
 * definition that gets copied, per-organization enablement and editing need
 * storage this deployment does not have, and there is no `automation_rules`
 * table in any migration. So the honest answer to "which rules does this
 * business have" is "the ones ESTIA ships, in the state ESTIA ships them", and
 * the screen says exactly that instead of rendering switches that would forget
 * themselves on reload.
 *
 * `enabled` is therefore the library's decision — anything that speaks to a
 * guest, spends money or issues a document ships off — and it is read, not
 * overridden here.
 */
export function shippedRules(): readonly AutomationRule[] {
  return AUTOMATION_TEMPLATES.map((template) => template.rule)
}

/* ------------------------------------------------------------- the facts -- */

/**
 * Facts the rule compares against that its own trigger never carried.
 *
 * A rule whose IF clause asks for `nights` on an event that carries no
 * `nights` is a rule that can never be met — `evaluateConditions` fails closed
 * on an absent fact, deliberately — and it will sit on the screen looking
 * configured and correct while doing nothing forever. That is the failure mode
 * the whole product is trying to avoid, so it is computed rather than hoped
 * about.
 *
 * Answered from the candidates for *this rule's trigger only*. A `nights` fact
 * present on `booking.completed` says nothing about `payment.failed`, and
 * pooling every candidate's keys would report full coverage for a rule whose
 * own event carries none of them.
 *
 * A trigger with no candidates at all yields no missing facts, on purpose: the
 * absence is already reported as "the preview cannot reconstruct this trigger",
 * and adding "and the fact was missing" would be inventing a second finding out
 * of the same silence.
 */
export function missingFacts(
  rule: AutomationRule,
  candidates: readonly Candidate[],
): readonly string[] {
  const mine = candidates.filter(
    (candidate) => candidate.event.name === rule.when,
  )
  if (mine.length === 0) return []

  const carried = new Set<string>()
  for (const candidate of mine) {
    for (const key of Object.keys(candidate.facts)) carried.add(key)
  }

  return [
    ...new Set(
      rule.conditions
        .map((condition) => condition.field)
        .filter((field) => !carried.has(field)),
    ),
  ]
}

/* ---------------------------------------------------------- the blockers -- */

/**
 * Why a rule would not do what it says, in one sentence a person can act on.
 *
 * `kind` exists so the screen can keep the two conversations apart without
 * parsing Hebrew: `plan` is a conversation with whoever owns the package,
 * `permission` is a conversation with an administrator, and `fact` and
 * `trigger` are conversations with nobody — they are statements about what the
 * data can support. Colour is never the only signal; the sentence always says
 * which it is.
 */
export type Blocker =
  | { kind: 'plan'; entitlement: Entitlement; message: string }
  | { kind: 'permission'; message: string }
  | { kind: 'fact'; message: string }
  | { kind: 'trigger'; message: string }

export function blockersFor(
  readiness: RuleReadiness,
  absentFacts: readonly string[],
  triggerSimulated: boolean,
): readonly Blocker[] {
  const blockers: Blocker[] = []

  if (readiness.status === 'module_locked') {
    blockers.push({
      kind: 'plan',
      entitlement: AUTOMATION_ENTITLEMENT,
      message:
        'החבילה של העסק אינה כוללת אוטומציות, ולכן הכלל הזה לא ירוץ. ההרשאות שלך תקינות — מה שחסר הוא היכולת בחבילה.',
    })
  } else {
    // Reported per grant rather than per action: a rule with three actions that
    // all need `message.send` has one problem, not three.
    for (const grant of readiness.missingGrants) {
      blockers.push({
        kind: 'permission',
        message: `התפקיד שלך אינו כולל ${actionGrantLabel(grant)}, ולכן החלק הזה של הכלל לא יתבצע. מנהל בארגון יכול להוסיף את ההרשאה.`,
      })
    }

    for (const entitlement of readiness.missingFeatures) {
      if (entitlement === AUTOMATION_ENTITLEMENT) continue
      blockers.push({
        kind: 'plan',
        entitlement,
        message: `אחת הפעולות בכלל דורשת יכולת שאינה בחבילה הנוכחית. אין צורך לבקש הרשאה — ההרשאה קיימת.`,
      })
    }
  }

  for (const field of absentFacts) {
    blockers.push({
      kind: 'fact',
      message: `האירוע שהכלל מאזין לו אינו נושא את הנתון ״${factLabel(field)}״, והתנאי שנשען עליו נחשב כלא־מתקיים. הכלל לא יפעל אף פעם עד שהנתון יגיע עם האירוע.`,
    })
  }

  if (!triggerSimulated) {
    blockers.push({
      kind: 'trigger',
      message: notSimulatedReason(readiness.rule.when),
    })
  }

  return blockers
}

/* ------------------------------------------------------------- the view --- */

export interface RuleView {
  rule: AutomationRule
  readiness: RuleReadiness
  simulation: RuleSimulation
  /** Whether the preview could reconstruct this rule's trigger at all. */
  triggerSimulated: boolean
  absentFacts: readonly string[]
  blockers: readonly Blocker[]
}

/**
 * Every rule, joined and ordered so the interesting ones are first.
 *
 * The order is the order somebody scanning the screen needs: rules that would
 * genuinely act on real rows, then rules whose trigger fired and was refused or
 * filtered, then everything the preview never reached. Alphabetical would put a
 * rule that fired forty times below one that has never had a chance to.
 */
export function ruleViews(
  actor: Actor,
  dryRun: DryRun,
  candidates: readonly Candidate[],
): readonly RuleView[] {
  return dryRun.rules
    .map((simulation) => {
      const readiness = ruleReadiness(actor, simulation.rule)
      const absentFacts = missingFacts(simulation.rule, candidates)
      const triggerSimulated = isSimulatedTrigger(simulation.rule.when)

      return {
        rule: simulation.rule,
        readiness,
        simulation,
        triggerSimulated,
        absentFacts,
        blockers: blockersFor(readiness, absentFacts, triggerSimulated),
      }
    })
    .sort(byInterest)
}

function byInterest(a: RuleView, b: RuleView): number {
  if (a.simulation.wouldRun !== b.simulation.wouldRun) {
    return b.simulation.wouldRun - a.simulation.wouldRun
  }
  if (a.simulation.matched !== b.simulation.matched) {
    return b.simulation.matched - a.simulation.matched
  }
  if (a.triggerSimulated !== b.triggerSimulated) {
    return a.triggerSimulated ? -1 : 1
  }
  return a.rule.name.localeCompare(b.rule.name, 'he')
}

/* ---------------------------------------------------------- the headline -- */

export interface DryRunHeadline {
  /** Events the data implies, across every trigger. */
  candidates: number
  /** Rules that would have acted at least once. */
  actingRules: number
  /**
   * Rules that fired and were stopped at least once.
   *
   * Counted beside `actingRules` rather than derived from it, because under a
   * plan lock the first is zero for every rule and the screen still has to be
   * able to say how many rules are waiting on the package. "0 rules would have
   * run" next to "14 actions would have run" is a contradiction a reader has to
   * resolve themselves, and they should not have to.
   */
  refusingRules: number
  /** Times an action would have been performed on a real row. */
  wouldRun: number
  /** Times a rule triggered and the role or the package refused it. */
  refused: number
  /** Times a rule triggered and its IF clause narrowed it away. */
  filtered: number
}

/**
 * The four numbers above the list.
 *
 * `refused` is stated separately from `wouldRun` and never folded into it. On a
 * package without the automation module every one of these is a refusal, and
 * that number *is* the upgrade argument — measured on the customer's own rows
 * rather than asserted in a brochure. Collapsing it into a total would delete
 * the only honest version of that sentence.
 */
export function headline(
  views: readonly RuleView[],
  dryRun: DryRun,
): DryRunHeadline {
  return {
    candidates: dryRun.candidates,
    actingRules: views.filter((view) => view.simulation.wouldRun > 0).length,
    refusingRules: views.filter((view) => view.simulation.refused > 0).length,
    wouldRun: sum(views, (view) => view.simulation.wouldRun),
    refused: sum(views, (view) => view.simulation.refused),
    filtered: sum(views, (view) => view.simulation.filtered),
  }
}

function sum(
  views: readonly RuleView[],
  of: (view: RuleView) => number,
): number {
  return views.reduce((total, view) => total + of(view), 0)
}
