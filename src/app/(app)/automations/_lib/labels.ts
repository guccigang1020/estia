/**
 * Hebrew for the automation vocabulary.
 *
 * The domain in `src/lib/automation` is deliberately language-free about two
 * things: the trigger, which is a member of the frozen catalogue in
 * `src/lib/contracts/events.ts` and therefore an English identifier, and the
 * facts a condition compares, which are the keys of a flat record built by the
 * caller. Both reach the screen, and neither has a Hebrew name anywhere in the
 * codebase — so it is written here, once, for the two routes that render them.
 *
 * ── Why this is not in `src/lib/automation` ───────────────────────────────
 *
 * Nothing in the engine needs it. `runAutomations` never renders a word, and a
 * Hebrew label sitting in the domain would be the first thing to drift when the
 * screens change their mind about phrasing. This is presentation, it lives with
 * the presentation, and `templates/page.tsx` imports it from here exactly as
 * `action-center/page.tsx` imports `finance/_lib/labels`.
 *
 * ── The maps are partial, and a test closes the gap ───────────────────────
 *
 * `DomainEventName` has around a hundred members and the library uses fourteen
 * of them; a total `Record` would mean writing eighty-six Hebrew strings nobody
 * will ever read, and getting them wrong. So the maps are partial and
 * `labels.test.ts` asserts that every trigger the library actually uses, and
 * every grant the action catalogue actually demands, has an entry — which is
 * the same guarantee as exhaustiveness, checked against the thing that
 * generates the demand rather than against the whole universe.
 */

import {
  actionGrant,
  describeCondition,
  type AutomationActionKind,
  type AutomationCondition,
} from '@/lib/automation'
import type { Grant } from '@/lib/authz/permissions'
import type { DomainEventName } from '@/lib/contracts/events'

/* -------------------------------------------------------------- WHEN --- */

/**
 * The moment a rule listens for, in the words a hotelier would use.
 *
 * Written as the event, not as the rule: "הזמנה אושרה", not "כשהזמנה מאושרת,
 * עדכן". The rule's own name says what it does; this line says when.
 */
export const TRIGGER_LABEL: Partial<Record<DomainEventName, string>> = {
  'booking.confirmed': 'הזמנה אושרה',
  'booking.deposit_paid': 'מקדמה נקלטה',
  'booking.pre_arrival': 'מתקרב מועד ההגעה',
  'booking.ready_for_check_in': 'משק הבית סימן שהיחידה מוכנה',
  'booking.checked_out': 'האורח עזב',
  'booking.completed': 'השהייה הסתיימה',
  'booking.cancelled': 'הזמנה בוטלה',
  'payment.failed': 'סליקה נכשלה',
  'payment.outcome_unknown': 'הסולק לא השיב',
  'quote.accepted': 'הצעת מחיר התקבלה',
  'task.overdue': 'משימה עברה את מועדה',
  'incident.opened': 'נפתחה תקלה',
  'channel.sync_failed': 'סנכרון מול ערוץ הפצה נכשל',
  'security.permission_escalated': 'הרשאות של מישהו הורחבו',
  'security.bulk_export': 'בוצע ייצוא נתונים בהיקף חריג',
}

/**
 * The Hebrew for a trigger, or the catalogue name.
 *
 * The fallback is the raw event name and not a polite placeholder. Every
 * trigger rendered today is covered — the test proves it — so this branch means
 * a template was added without a label, and showing `booking.no_show` tells
 * whoever notices exactly which entry is missing. "אירוע" would hide it.
 */
export function triggerLabel(name: DomainEventName): string {
  return TRIGGER_LABEL[name] ?? name
}

/* ---------------------------------------------------------------- IF --- */

/**
 * The facts the dry run builds, in Hebrew.
 *
 * These are exactly the keys `candidateEvents` writes into `Candidate.facts`.
 * A key absent here is a fact no rule can currently be written against, so the
 * fallback returns the key itself rather than inventing a reading of it.
 */
export const FACT_LABEL: Readonly<Record<string, string>> = {
  nights: 'מספר הלילות',
  status: 'סטטוס',
  source: 'מקור ההזמנה',
}

export function factLabel(field: string): string {
  return FACT_LABEL[field] ?? field
}

/**
 * One IF clause, with the fact named in Hebrew.
 *
 * The operator rendering is `describeCondition`'s and is not repeated here.
 * The domain already answers "how is `at_least` written", including the `≥`
 * and the set notation for `one_of`, and a second switch over
 * `AutomationCondition` in this file would be a second place for a new
 * condition kind to be forgotten. `describeCondition` always begins with the
 * field name, so the field is the only part substituted.
 */
export function describeConditionInHebrew(
  condition: AutomationCondition,
): string {
  const technical = describeCondition(condition)
  const remainder = technical.slice(condition.field.length).trim()
  return `${factLabel(condition.field)} ${remainder}`.trim()
}

/* -------------------------------------------------------------- THEN --- */

/**
 * The permission each action would have needed, in Hebrew.
 *
 * Keyed by `Grant` rather than by action kind, because two actions can demand
 * the same right — `notify_team`, `message_guest` and `request_review` are all
 * `message.send` — and a card that named the same permission three different
 * ways would read as three different problems.
 */
export const ACTION_GRANT_LABEL: Partial<Record<Grant, string>> = {
  'message.send': 'שליחת הודעות',
  'task.create': 'פתיחת משימות',
  'approval.request': 'פתיחת בקשת אישור',
  'payment.request_link': 'שליחת קישור לתשלום',
  'invoice.issue': 'הפקת חשבוניות',
  'hold.create': 'חסימת זמינות',
}

/** The Hebrew for a grant, or the grant code. Same reasoning as `triggerLabel`. */
export function actionGrantLabel(grant: Grant): string {
  return ACTION_GRANT_LABEL[grant] ?? grant
}

/** The permission an action kind demands, named in Hebrew. */
export function labelForActionGrant(kind: AutomationActionKind): string {
  return actionGrantLabel(actionGrant(kind))
}

/* ---------------------------------------------------- the dry run's reach -- */

/**
 * The triggers `candidateEvents` can reconstruct from rows that exist.
 *
 * This list is not a policy — it is a description of what
 * `automations/_lib/dry-run.ts` actually derives, and its header explains each
 * one: a booking sitting in `confirmed` was confirmed, a payment sitting in
 * `failed` failed, a task past its `due_at` is overdue.
 *
 * It exists so the screen can tell two zeroes apart. "This rule matched nothing
 * because your business has had no failed payments" and "this rule matched
 * nothing because the simulation has no way to reconstruct its trigger" look
 * identical on a card and mean opposite things: the first is good news about
 * the business, the second is a limit of the preview. Stating the second is the
 * difference between a dry run somebody trusts and one they quietly stop
 * reading.
 *
 * Kept beside the labels and covered by the same test file, so a trigger added
 * to `candidateEvents` that is not added here is caught rather than silently
 * reported as underivable.
 */
export const SIMULATED_TRIGGERS: readonly DomainEventName[] = [
  'booking.confirmed',
  'booking.pre_arrival',
  'booking.checked_out',
  'booking.completed',
  'booking.cancelled',
  'payment.failed',
  'payment.outcome_unknown',
  'task.overdue',
]

const SIMULATED = new Set<DomainEventName>(SIMULATED_TRIGGERS)

export function isSimulatedTrigger(name: DomainEventName): boolean {
  return SIMULATED.has(name)
}

/**
 * Why the preview cannot produce this trigger, in one sentence.
 *
 * Written per trigger rather than as one generic line, because the reasons are
 * genuinely different and a customer deciding whether to buy the module
 * deserves to know which: a housekeeping sign-off is a column the schema does
 * not have, and a security escalation is an event the product raises and never
 * stores. Neither is a defect, and neither should read as one.
 */
export const NOT_SIMULATED_REASON: Partial<Record<DomainEventName, string>> = {
  'booking.deposit_paid':
    'המקדמה נקלטת כאירוע, והמערכת שומרת את המצב שאחריו ולא את הרגע עצמו — ולכן אין ממה לשחזר אותו כאן.',
  'booking.ready_for_check_in':
    'הסימון של משק הבית שהיחידה מוכנה אינו נשמר כעמודה, ולכן אין דרך להסיק מהנתונים מתי הוא קרה.',
  'quote.accepted':
    'קבלת הצעת מחיר היא רגע ולא מצב שנשמר על השורה, ולכן ההדמיה לא ממציאה אותו.',
  'incident.opened':
    'תקלה נרשמת כמשימת תחזוקה, ומועד הפתיחה שלה אינו מבדיל בין תקלה חדשה לאחת שנפתחה לפני חודש.',
  'channel.sync_failed':
    'כישלון סנכרון מדווח בזמן אמת ואינו נשמר כשורה שאפשר לקרוא בדיעבד.',
  'security.permission_escalated':
    'אירועי אבטחה נכתבים ליומן הפעילות ולא כמצב על רשומה, ויומן הפעילות אינו מאגר האירועים של המוצר.',
  'security.bulk_export':
    'אירועי אבטחה נכתבים ליומן הפעילות ולא כמצב על רשומה, ויומן הפעילות אינו מאגר האירועים של המוצר.',
}

/** The reason, or a truthful generic one. */
export function notSimulatedReason(name: DomainEventName): string {
  return (
    NOT_SIMULATED_REASON[name] ??
    'אין במסד הנתונים מצב שממנו אפשר לשחזר את האירוע הזה, ולכן ההדמיה לא מייצרת אותו.'
  )
}
