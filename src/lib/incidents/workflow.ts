/**
 * Where a case may go next, and what stops it going there.
 *
 * Pure. No database, no clock, no actor — every answer is a function of the
 * facts it is handed, which is what makes the two rules below testable rather
 * than aspirational.
 *
 * ── Two rules, and both of them exist because of one failure ──────────────
 *
 * A damage case ends in one of two ways: somebody decides, or everybody
 * forgets. The second is the ordinary outcome. Six weeks after checkout the
 * vendor never quoted, the guest never replied, and the case gets tidied away
 * during a cleanup because it is old and nobody remembers what it was waiting
 * for. The deposit was released, the worktop is still burnt, and there is no
 * record of a decision — because none was made.
 *
 *   1. **A case cannot be closed with an unanswered question outstanding.**
 *      The question is a row (`CaseQuestion`), so "we were waiting on the
 *      guest" survives the person who was waiting.
 *
 *   2. **A case awaiting a vendor cannot resolve itself.** There is no edge
 *      from `awaiting_vendor` to `resolved` in the table below, so the path
 *      out of it goes through `investigating` — which is a person saying the
 *      wait is over, in the audit trail, with their name on it.
 *
 * A third follows from the module's whole purpose: a case that has money
 * recorded against it cannot close without a liability decision. Costs with no
 * decision is exactly the state where a deposit gets quietly kept or quietly
 * released depending on who tidied up.
 *
 * ── Why this returns a result rather than throwing ────────────────────────
 *
 * The screen asks "which buttons should exist" and the operation asks "may
 * this one run", and those are the same question asked twice. A thrown error
 * answers only the second. `operations.ts` turns a refusal into a
 * `BusinessRuleError`; the screen renders the reason beside the disabled
 * control.
 */

import type { Agorot } from '../booking/types'

import {
  AWAITING_STATUSES,
  INCIDENT_CASE_STATUS_LABEL,
  isAnswered,
  type CaseQuestion,
  type IncidentCaseStatus,
} from './types'

/* --------------------------------------------------------------- edges --- */

/**
 * Every legal move, stated once.
 *
 * Read it as a table rather than as prose. The absences are load-bearing:
 *
 *   · `awaiting_vendor → resolved` is absent — rule 2 above.
 *   · `closed → *` is empty. A closed case is reopened by opening a new one
 *     that references it, never by editing this row back to life, because the
 *     first thing anybody asks about a reopened dispute is what it looked like
 *     when it was closed.
 *   · `open → closed` is absent. Something has to be decided before nothing
 *     is owed; "closed without resolution" is what `resolved` with a business
 *     expense decision is for, and that at least has a decider on it.
 */
export const CASE_TRANSITIONS: Record<
  IncidentCaseStatus,
  readonly IncidentCaseStatus[]
> = {
  open: [
    'investigating',
    'awaiting_guest',
    'awaiting_vendor',
    'awaiting_approval',
    'resolved',
  ],
  investigating: [
    'awaiting_guest',
    'awaiting_vendor',
    'awaiting_approval',
    'resolved',
  ],
  // Back to investigating when the guest answers, or on to approval. Resolving
  // straight from here is allowed: a guest who admits the damage in writing
  // has answered, and the question row records that they did.
  awaiting_guest: ['investigating', 'awaiting_vendor', 'awaiting_approval'],
  // Deliberately no `resolved`. See rule 2.
  awaiting_vendor: ['investigating', 'awaiting_approval'],
  awaiting_approval: [
    'investigating',
    'awaiting_guest',
    'awaiting_vendor',
    'resolved',
  ],
  resolved: ['closed', 'investigating'],
  closed: [],
}

export function allowedTransitions(
  status: IncidentCaseStatus,
): readonly IncidentCaseStatus[] {
  return CASE_TRANSITIONS[status]
}

/* --------------------------------------------------------------- facts --- */

/**
 * What the workflow needs to know, and nothing more.
 *
 * Deliberately not an `IncidentCase`. A state machine that took the record
 * would be a state machine only the repository could call, and these four
 * facts are producible by a screen, an operation and a unit test alike — the
 * argument `payments/types.ts` makes for `CollectionFacts`, applied here.
 */
export interface CaseFacts {
  status: IncidentCaseStatus
  questions: readonly CaseQuestion[]
  /** Whether a person has recorded a liability decision on this case. */
  hasLiabilityDecision: boolean
  /** The sum of the cost lines. Integer agorot. */
  recordedCostAgorot: Agorot
}

/* ------------------------------------------------------------- refusals -- */

export type TransitionRefusal =
  | 'not_a_transition'
  | 'terminal'
  | 'unanswered_question'
  | 'vendor_outstanding'
  | 'money_without_decision'

export const TRANSITION_REFUSAL_MESSAGE: Record<TransitionRefusal, string> = {
  not_a_transition: 'לא ניתן להעביר את התיק ישירות למצב הזה.',
  terminal: 'התיק סגור, ולכן לא ניתן לשנות את מצבו.',
  unanswered_question:
    'יש בתיק שאלה שטרם נענתה. תיק נסגר רק אחרי שכל שאלה פתוחה נענתה או בוטלה.',
  vendor_outstanding:
    'התיק ממתין לספק. כדי להכריע אותו יש קודם להחזיר אותו לבירור — כדי שיהיה ברור מי החליט שההמתנה הסתיימה.',
  money_without_decision:
    'בתיק נרשמו עלויות ואין בו הכרעה מי נושא בהן. תיק עם כסף נסגר רק אחרי שאדם הכריע.',
}

export type TransitionCheck =
  | { ok: true }
  | {
      ok: false
      refusal: TransitionRefusal
      message: string
      /** Names the questions that block a closure, so the screen can list them. */
      blocking: readonly CaseQuestion[]
    }

function refuse(
  refusal: TransitionRefusal,
  blocking: readonly CaseQuestion[] = [],
): TransitionCheck {
  return {
    ok: false,
    refusal,
    message: TRANSITION_REFUSAL_MESSAGE[refusal],
    blocking,
  }
}

/* --------------------------------------------------------------- check --- */

/**
 * May this case move to that status?
 *
 * The edge table is checked first, then the three rules, in the order a person
 * would ask them. Every refusal names a status the reader can see on screen,
 * so "you cannot do that" is never the whole answer.
 */
export function checkTransition(
  facts: CaseFacts,
  to: IncidentCaseStatus,
): TransitionCheck {
  if (facts.status === 'closed') return refuse('terminal')

  if (!CASE_TRANSITIONS[facts.status].includes(to)) {
    // The one refusal worth naming specifically, because it is the rule and
    // not an oversight: the reader tried to resolve a case that is waiting on
    // a vendor, and the generic sentence would read as a bug.
    if (facts.status === 'awaiting_vendor' && to === 'resolved') {
      return refuse('vendor_outstanding')
    }
    return refuse('not_a_transition')
  }

  const outstanding = facts.questions.filter(
    (question) => !isAnswered(question),
  )

  if (to === 'closed' && outstanding.length > 0) {
    return refuse('unanswered_question', outstanding)
  }

  if (to === 'closed' && facts.recordedCostAgorot > 0) {
    if (!facts.hasLiabilityDecision) return refuse('money_without_decision')
  }

  return { ok: true }
}

/**
 * The moves this case can actually make, refusals applied.
 *
 * What a screen renders as buttons. Derived from `checkTransition` rather than
 * from the edge table, so a control the operation would refuse is never drawn
 * — and the two can never drift, because there is only one decision.
 */
export function availableTransitions(
  facts: CaseFacts,
): readonly IncidentCaseStatus[] {
  return CASE_TRANSITIONS[facts.status].filter(
    (target) => checkTransition(facts, target).ok,
  )
}

/**
 * Is anybody outside the business owing this case an answer?
 *
 * The register's most useful column: a case in `awaiting_vendor` for eleven
 * days is a case somebody must chase, and it looks identical to a healthy one
 * unless this is asked.
 */
export function isWaitingOnSomebody(status: IncidentCaseStatus): boolean {
  return AWAITING_STATUSES.includes(status)
}

/**
 * How long this case has been where it is, in whole days.
 *
 * Floor rather than round: a case that has been waiting 47 hours has been
 * waiting one day, and rounding it to two would make the register overstate
 * every wait in the business by up to half a day.
 */
export function daysInState(since: Date, now: Date): number {
  const elapsed = now.getTime() - since.getTime()
  if (elapsed <= 0) return 0
  return Math.floor(elapsed / 86_400_000)
}

/** The label, so a screen never prints `awaiting_vendor` to a guesthouse owner. */
export function statusLabel(status: IncidentCaseStatus): string {
  return INCIDENT_CASE_STATUS_LABEL[status]
}
