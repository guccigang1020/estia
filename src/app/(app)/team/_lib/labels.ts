/**
 * Hebrew wording for what a membership *is*.
 *
 * ── Status is not decoration ──────────────────────────────────────────────
 *
 * `MEMBERSHIP_STATUSES` is declared in `src/lib/authz/can.ts` beside the type
 * it inhabits, and the first thing `authorize()` does with an actor is refuse
 * it unless the status is `active`. So these five words are not a badge on a
 * roster; they are the difference between somebody who can open the product
 * and somebody who cannot, and four of the five mean an unfinished piece of
 * work that a named person is waiting on.
 *
 * Each therefore gets two strings: the word, and a sentence saying what it
 * means *for the person holding it*. "מושהה" on its own tells an administrator
 * nothing about whether the account still exists, whether the work is still
 * attributed, or what undoes it. The sentence does.
 *
 * The tuple is imported rather than restated, so a sixth status added to the
 * union fails the build here — `Record<MembershipStatus, …>` is total — rather
 * than rendering an English enum value at a Hebrew-speaking administrator.
 *
 * ── Employment type is a database enum this file does not own ─────────────
 *
 * `public.employment_type` is declared in `0001_identity.sql` and nothing in
 * `src/lib` names its members, so the values are transcribed here with the
 * migration named, exactly as `properties/_lib/labels.ts` does for the
 * accommodation enums — and `labelOr` renders a value this file has not been
 * taught rather than a blank cell.
 */

import type { BadgeTone } from '@/components/ui/badge'
import type { MembershipStatus, Scope } from '@/lib/authz/can'

/* --------------------------------------------------------------- status -- */

export const MEMBERSHIP_STATUS_LABEL: Record<MembershipStatus, string> = {
  invited: 'הוזמן',
  pending: 'ממתין לאישור',
  active: 'פעיל',
  suspended: 'מושהה',
  removed: 'הוסר',
}

/**
 * What the status means to the person holding it, and to whoever reads this.
 *
 * Written from the engine's behaviour rather than from intuition:
 * `authorize()` refuses anything that is not `active` with
 * `membership_not_active`, and `loadWorkspaces` in `context.ts` only lists
 * organizations where the membership is `active` — so an invited or suspended
 * person does not merely see less, they have no workspace to stand in at all.
 */
export const MEMBERSHIP_STATUS_MEANING: Record<MembershipStatus, string> = {
  invited:
    'ההזמנה נשלחה ועדיין לא מומשה. אין חשבון פעיל, אין גישה לשום מסך, ואף פעולה לא נרשמת על שמו. ההזמנה פגה מעצמה בתאריך שנקבע לה.',
  pending:
    'האדם קיים במערכת והחברות שלו טרם אושרה. הוא אינו יכול להיכנס לארגון עד שמישהו בעל הרשאה יאשר — זו נקודת עצירה מכוונת, לא תקלה.',
  active:
    'חבר מלא בארגון: התפקידים והטווח שלו הם מה שמנוע ההרשאות עונה עליו בכל בקשה.',
  suspended:
    'הגישה נחסמה, והרשומה נשארה. כל בקשה נדחית מיד בשכבת ההרשאות — לא במסך אלא במנוע — והעבודה שביצע בעבר נשארת רשומה על שמו. השהיה היא פעולה הפיכה.',
  removed:
    'האדם עזב או הוסר. השורה לא נמחקת ולעולם לא תימחק: ההזמנות, המשימות והתשלומים שביצע חייבים להישאר משויכים אליו, אחרת יומן הביקורת מפסיק להיות ראיה.',
}

/**
 * The tone for a status.
 *
 * Redundant with the label, deliberately — the label is the message and this
 * is a second, weaker signal for somebody scanning a long roster. `accent`
 * marks the two statuses that mean an *action is outstanding*, which is a
 * different thing from an account that was deliberately closed.
 */
export function membershipStatusTone(status: MembershipStatus): BadgeTone {
  switch (status) {
    case 'active':
      return 'brand'
    case 'invited':
    case 'pending':
      return 'accent'
    default:
      return 'neutral'
  }
}

/* ----------------------------------------------------- employment type --- */

/** `public.employment_type`, declared in `0001_identity.sql`. */
export const EMPLOYMENT_TYPES = [
  'employee',
  'contractor',
  'freelancer',
  'agency',
  'owner',
  'other',
] as const

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]

export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType, string> = {
  employee: 'עובד',
  contractor: 'קבלן',
  freelancer: 'עצמאי',
  agency: 'סוכנות',
  owner: 'בעלות',
  other: 'אחר',
}

/* ---------------------------------------------------------------- scope -- */

/**
 * The kind of a scope, in one word.
 *
 * Total over the `Scope` union, so a sixth variant added to the engine fails
 * the build here instead of rendering `own_records` on a Hebrew roster.
 */
export const SCOPE_KIND_LABEL: Record<Scope['kind'], string> = {
  all_organization: 'כל הארגון',
  properties: 'נכסים מסוימים',
  units: 'יחידות מסוימות',
  team: 'צוות מסוים',
  own_records: 'הרשומות שלו בלבד',
}

/**
 * A scope as a sentence, given the names that were actually resolvable.
 *
 * Two rules, and both are about not inventing:
 *
 *   · names that could not be read are counted, never printed as ids. "ועוד
 *     אחד שאינו קריא לך" is a true statement; a truncated uuid is noise.
 *   · a `properties` or `team` scope that resolved to no names at all is not
 *     described as reaching everything. It reaches things this reader cannot
 *     see, which is a different sentence and the honest one.
 */
export function describeScopeSentence(
  scope: Scope,
  names: readonly string[],
  unresolvedCount: number,
): string {
  const tail =
    unresolvedCount === 0
      ? ''
      : unresolvedCount === 1
        ? ' ועוד אחד שאינו קריא לך'
        : ` ועוד ${unresolvedCount} שאינם קריאים לך`

  switch (scope.kind) {
    case 'all_organization':
      return 'כל הנכסים והיחידות בארגון.'
    case 'own_records':
      return 'רק רשומות שהוא יצר או שהוקצו לו. נכס או יחידה אינם שייכים לאיש, ולכן אינם בטווח שלו.'
    case 'properties':
      return names.length === 0
        ? `נכסים מסוימים בלבד${tail || ' — ואף אחד מהם אינו קריא לך'}.`
        : `${names.join(', ')}${tail}. נכסים אחרים בארגון פשוט אינם קיימים מבחינתו.`
    case 'team':
      return names.length === 0
        ? `צוות מסוים בלבד${tail || ' — ואינו קריא לך'}.`
        : `${names.join(', ')}${tail}. משאב שאינו נושא צוות — נכס, הזמנה — מחוץ להישג ידו, בלי שאף מסך יחליט על כך.`
    case 'units':
      return unresolvedCount === 1
        ? 'יחידה אחת בלבד.'
        : `${unresolvedCount} יחידות בלבד.`
  }
}

/* ----------------------------------------------------------------- misc -- */

/** A label for a value the database returned that this file does not know. */
export function labelOr<T extends string>(
  labels: Record<T, string>,
  value: string,
): string {
  return value in labels ? labels[value as T] : value
}

/**
 * A `timestamptz` as a Hebrew date.
 *
 * `he-IL` and the property's own time zone, because "הצטרף ב-1 בינואר" read
 * off a UTC string is off by a day for anything that happened after 22:00 in
 * Israel — and a joining date that disagrees with the audit trail by a day is
 * a question somebody has to answer.
 */
export function hebrewDate(iso: string | null): string | null {
  if (iso === null) return null
  return new Date(iso).toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

/** The same instant, to the minute. Used where "when exactly" is the question. */
export function hebrewMoment(iso: string | null): string | null {
  if (iso === null) return null
  return new Date(iso).toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
