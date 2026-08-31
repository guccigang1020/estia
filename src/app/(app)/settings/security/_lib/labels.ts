/**
 * Hebrew wording for the two vocabularies the security screen prints, and for
 * the credentials it refuses to print.
 *
 * WHAT IS NOT HERE. Role names come from `roles.name` in the database, because
 * a customer can compose a role and no file in the codebase can name it in
 * advance. `ENTITLEMENT_LABELS` is in `src/components/nav/labels.ts`.
 *
 * ── The scope wording is deliberately not `scopeLabel` ────────────────────
 *
 * `scopeLabel` in `components/nav/labels.ts` takes a resolved `Scope` and says
 * "2 נכסים שהוקצו לך" — second person, and it counts the ids inside the union.
 * This screen lists *other people's* scopes read from `membership_scopes.kind`,
 * which is a bare enum string with no ids attached, and the second person would
 * be wrong on every row. Different question, different sentence.
 */

import type { MembershipStatus } from '@/lib/authz/can'

/** `public.membership_status`, 0001. */
export const MEMBERSHIP_STATUS_LABEL: Record<MembershipStatus, string> = {
  invited: 'הוזמן ולא הצטרף',
  pending: 'ממתין',
  active: 'פעיל',
  suspended: 'מושהה',
  removed: 'הוסר',
}

/**
 * `public.membership_scope_kind`, 0002. How far a membership reaches.
 *
 * A plain `Record<string, string>` rather than a total record over an enum,
 * because the kind is read as a bare column value here — the union type
 * `Scope` is the resolved shape and this screen never resolves one. The screen
 * falls back to the raw value rather than rendering nothing, so a kind added to
 * the database before this file catches up degrades to `own_records` on screen
 * instead of to a blank.
 */
export const SCOPE_KIND_LABEL: Record<string, string> = {
  all_organization: 'כל הארגון',
  properties: 'נכסים מסוימים',
  units: 'יחידות מסוימות',
  team: 'צוות אחד',
  own_records: 'רשומות שלו בלבד',
}

/**
 * The credentials the product holds, and what is said instead of showing them.
 *
 * Each entry names the column, says what the value is for, and says why the
 * screen will not render it. The "when it changed" figure is supplied by the
 * query as a count and a timestamp read from columns that are not the secret.
 */
export const SECRET_COPY: Record<
  'invitation_token' | 'guest_portal_token' | 'auth_credentials',
  { title: string; column: string; body: string; countNoun: string }
> = {
  invitation_token: {
    title: 'אסימון הזמנה',
    column: 'invitations.token_hash',
    body: 'מה שנשלח במייל למי שהוזמן, ושמור אצלנו כגיבוב בלבד. גם גיבוב הוא ערך בצורת אישור כניסה, ולכן הוא לא נשלף למסך הזה כלל — לא חתוך, לא ממוסך.',
    countNoun: 'הזמנות שנרשמו אי פעם',
  },
  guest_portal_token: {
    title: 'אסימון פורטל אורח',
    column: 'bookings.guest_token',
    body: '32 בתים מגנרטור אקראי מאובטח, ייחודיים לכל הזמנה. האורח מגיע איתו וללא שום דבר אחר — אין לו חשבון ואין לו תפקיד — ולכן הוא מפתח לכל דבר. הוא נוצר עם יצירת ההזמנה, ואין במוצר מסלול להחליף אותו.',
    countNoun: 'הזמנות, ולכל אחת אסימון',
  },
  auth_credentials: {
    title: 'סיסמאות, אסימוני שחזור וגורם שני',
    column: 'auth.*',
    body: 'נשמרים אצל ספק ההזדהות בסכימת auth, שאינה חשופה כלל דרך ה־API. אין כאן מה לספור ואין מה להסתיר — המוצר עצמו לא רואה אותם.',
    countNoun: '',
  },
}
