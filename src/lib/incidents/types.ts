/**
 * The shapes the incident case module works in.
 *
 * ── What a case is, and why it is not a task ──────────────────────────────
 *
 * A cleaner who finds a cracked shower screen already has somewhere to put it:
 * `defineTaskCreation` in `src/lib/tasks` takes `incident.create` as its
 * permission, writes a `maintenance` task and publishes `incident.opened`.
 * That path is not replaced by anything here and must not be — it is ten
 * seconds on a landing with one hand holding a mop, and it is the reason the
 * fault register exists at all.
 *
 * A case is what happens when the fault costs money. It carries an estimate, a
 * repair invoice, a decision about who pays, and possibly a claim against a
 * security deposit — and none of that belongs on a task row, because a task is
 * work somebody does and a case is a dispute somebody settles. The two are
 * linked by `taskId`: the fault report stays the fault report, and the case
 * points back at it.
 *
 * ── Vocabularies are declared here and nowhere else ───────────────────────
 *
 * `src/lib/contracts/states.ts` is frozen and carries none of these — there is
 * no incident enum in it, because there has never been an incident table. So
 * they are declared once, here, and every other file in this module imports
 * them. A second list of statuses is a list that disagrees with the CHECK
 * constraint the migration will carry, and the disagreement surfaces as a case
 * the screen cannot render rather than as a compile error.
 *
 * Nothing in this file reaches a database and nothing in it decides anything.
 */

import type { Agorot } from '../booking/types'

/* ------------------------------------------------------------- the case -- */

/**
 * What kind of thing happened.
 *
 * Eight values and not a free-text field, because the first question anybody
 * asks about a damage case is "is this the guest's or ours", and the answer
 * starts with what broke. `other` exists so nobody has to lie; a register full
 * of `other` is a signal that this list is wrong, which is information a
 * free-text field would have destroyed.
 */
export const INCIDENT_CASE_TYPES = [
  /** The building or a fixture: a cracked screen, a burnt worktop, a wall. */
  'property_damage',
  /** A thing the business owns and lends: a kettle, a hairdryer, a duvet. */
  'item_damage',
  /** The same thing, gone rather than broken. */
  'item_loss',
  /** The guest says something is wrong. Not yet a finding about anything. */
  'guest_reported_issue',
  /** A system failed: the boiler, the air conditioning, the lock. */
  'maintenance_failure',
  /** Damage caused while cleaning. Ours by default, and still investigated. */
  'cleaning_damage',
  /** A door, a code, a key: somebody was locked out, or somebody got in. */
  'access_incident',
  'other',
] as const

export type IncidentCaseType = (typeof INCIDENT_CASE_TYPES)[number]

export const INCIDENT_CASE_TYPE_LABEL: Record<IncidentCaseType, string> = {
  property_damage: 'נזק לנכס',
  item_damage: 'נזק לפריט',
  item_loss: 'פריט חסר',
  guest_reported_issue: 'תלונת אורח',
  maintenance_failure: 'תקלת תחזוקה',
  cleaning_damage: 'נזק בניקיון',
  access_incident: 'אירוע גישה',
  other: 'אחר',
}

/**
 * Where the case came from.
 *
 * Kept apart from the type because the same broken worktop is a different
 * case depending on who found it and when. A checkout inspection finding is
 * arguable against a deposit; the same finding raised by a cleaner three days
 * into the next guest's stay is not, and the origin is the only field that
 * remembers which one this was.
 */
export const INCIDENT_ORIGINS = [
  'pre_stay_inspection',
  'cleaner_report',
  'guest_report',
  'maintenance',
  'checkout_inspection',
  'inventory_discrepancy',
] as const

export type IncidentOrigin = (typeof INCIDENT_ORIGINS)[number]

export const INCIDENT_ORIGIN_LABEL: Record<IncidentOrigin, string> = {
  pre_stay_inspection: 'בדיקה לפני כניסה',
  cleaner_report: 'דיווח מהצוות',
  guest_report: 'דיווח מהאורח',
  maintenance: 'תחזוקה',
  checkout_inspection: 'בדיקה ביציאה',
  inventory_discrepancy: 'פער במלאי',
}

/**
 * Where the case is.
 *
 * The three `awaiting_*` states are the point of this list. "Open" is not a
 * state anybody can act on; "waiting for the vendor's quote" is, and so is
 * "waiting for the guest to answer" — and a register that collapses them into
 * one is a register where a case nobody is waiting for looks exactly like a
 * case everybody is waiting for.
 */
export const INCIDENT_CASE_STATUSES = [
  'open',
  'investigating',
  'awaiting_guest',
  'awaiting_vendor',
  'awaiting_approval',
  'resolved',
  'closed',
] as const

export type IncidentCaseStatus = (typeof INCIDENT_CASE_STATUSES)[number]

export const INCIDENT_CASE_STATUS_LABEL: Record<IncidentCaseStatus, string> = {
  open: 'נפתח',
  investigating: 'בבירור',
  awaiting_guest: 'ממתין לאורח',
  awaiting_vendor: 'ממתין לספק',
  awaiting_approval: 'ממתין לאישור',
  resolved: 'הוכרע',
  closed: 'סגור',
}

/**
 * The statuses that mean nobody is working this case any more.
 *
 * A reading of `INCIDENT_CASE_STATUSES` and not a second vocabulary: both
 * members are typed as one, so a rename breaks this line rather than quietly
 * leaving a closed case editable.
 */
export const SETTLED_CASE_STATUSES: readonly IncidentCaseStatus[] = [
  'resolved',
  'closed',
]

export function isSettledCase(status: IncidentCaseStatus): boolean {
  return SETTLED_CASE_STATUSES.includes(status)
}

/**
 * The statuses in which somebody outside the business owes an answer.
 *
 * Read by the workflow, which refuses to let a case in one of them resolve
 * itself — see `workflow.ts`.
 */
export const AWAITING_STATUSES: readonly IncidentCaseStatus[] = [
  'awaiting_guest',
  'awaiting_vendor',
  'awaiting_approval',
]

/**
 * One case.
 *
 * `bookingId` and `taskId` are both nullable and both usually set. A case
 * without a booking is real — a boiler that failed between stays — and a case
 * without a task is real too, because a checkout inspection can raise one
 * directly. Neither is inferred from the other.
 *
 * There is no money on this record. Costs are lines and the decision is its
 * own record, because a single `amount` column on the case would be a number
 * whose meaning changes silently between "what we think", "what it cost" and
 * "what the guest owes" — three different figures that argue with each other
 * in every real dispute.
 */
export interface IncidentCase {
  id: string
  organizationId: string
  propertyId: string
  unitId: string | null
  /** The stay this is argued against, when there is one. */
  bookingId: string | null
  /** The fault report it grew out of. `tasks.id` — see the header. */
  taskId: string | null
  caseType: IncidentCaseType
  origin: IncidentOrigin
  status: IncidentCaseStatus
  /** One line, in the reader's words. Never generated. */
  title: string
  description: string | null
  /** When the damage happened, as opposed to when it was found. */
  occurredAt: Date | null
  openedAt: Date
  openedByUserId: string | null
  resolvedAt: Date | null
  closedAt: Date | null
  closedByUserId: string | null
  version: number
}

/* -------------------------------------------------------- open questions -- */

/**
 * Who is being asked.
 *
 * `internal` is here because most unanswered questions in a real damage case
 * are not asked of anybody outside — "did the previous cleaner photograph
 * this?" blocks a closure exactly as hard as a guest who has not replied.
 */
export const QUESTION_AUDIENCES = [
  'guest',
  'vendor',
  'owner',
  'internal',
] as const

export type QuestionAudience = (typeof QUESTION_AUDIENCES)[number]

export const QUESTION_AUDIENCE_LABEL: Record<QuestionAudience, string> = {
  guest: 'אורח',
  vendor: 'ספק',
  owner: 'בעלים',
  internal: 'פנימי',
}

/**
 * Something somebody asked and nobody has answered.
 *
 * The reason this is a record and not a boolean on the case: a case is closed
 * by one person, months after another person asked the question, and "there
 * was an open question" is only checkable if the question is a row. See
 * `workflow.ts` — an unanswered question is the one thing that refuses a
 * closure outright.
 */
export interface CaseQuestion {
  id: string
  caseId: string
  audience: QuestionAudience
  question: string
  askedAt: Date
  askedByUserId: string | null
  answeredAt: Date | null
  answer: string | null
}

/**
 * Has this question been answered?
 *
 * Both fields, not either. A row with an `answeredAt` and no text is somebody
 * closing a question by clicking, and a row with text and no timestamp is a
 * draft — treating either as answered is how a case closes over an open
 * question without anybody lying.
 */
export function isAnswered(question: CaseQuestion): boolean {
  return question.answeredAt !== null && question.answer !== null
}

export function unansweredQuestions(
  questions: readonly CaseQuestion[],
): readonly CaseQuestion[] {
  return questions.filter((question) => !isAnswered(question))
}

/* -------------------------------------------------------------- drafts --- */

/** What opening a case needs. No id, no status: both are derived. */
export interface IncidentCaseDraft {
  organizationId: string
  propertyId: string
  unitId: string | null
  bookingId: string | null
  taskId: string | null
  caseType: IncidentCaseType
  origin: IncidentOrigin
  title: string
  description: string | null
  occurredAt: Date | null
  openedByUserId: string | null
}

export interface CaseQuestionDraft {
  caseId: string
  audience: QuestionAudience
  question: string
  askedByUserId: string | null
}

/* --------------------------------------------------------- the whole file -- */

/**
 * Everything about one case, assembled.
 *
 * The screens read this and nothing else. It exists so that the workflow, the
 * money and the evidence are answered from one consistent read rather than
 * from four queries that can disagree about which case they are describing.
 *
 * `costLines`, `evidence`, `decisions` and `inspections` are typed in the
 * files that own them; this interface is declared in `liability.ts` where the
 * money is, to keep the import graph one-directional. What lives here is the
 * case and its questions, which are the two things every other file needs.
 */
export interface CaseCore {
  incident: IncidentCase
  questions: readonly CaseQuestion[]
}

/** Money, restated locally so a reader of this module sees the unit. */
export type { Agorot }
