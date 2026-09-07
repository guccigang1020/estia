/**
 * Turning the database's refusals into sentences a person can act on.
 *
 * `guest_merge_apply` and `guest_merge_undo` raise messages that begin with a
 * stable uppercase token — `GUEST_MERGE_STALE:`, `GUEST_MERGE_UNDO_EXPIRED:`
 * and so on. The English half is a diagnostic for a log; this maps the token
 * to Hebrew.
 *
 * Matching on a token rather than on prose is the point. A refusal whose
 * wording is matched with `includes('already')` is a refusal nobody can ever
 * improve the wording of, and the first person to try breaks a screen without
 * a test noticing.
 *
 * Anything with no token is rethrown untouched. A `TypeError` inside a
 * function must not become a Hebrew sentence about merging profiles — every
 * unrecognised failure keeps its own identity and reaches `toSafeResponse` as
 * itself.
 */

import { BusinessRuleError } from '../errors'

/** The tokens the two functions raise, and what to say about each. */
const MESSAGES: Readonly<
  Record<string, { code: string; userMessage: string }>
> = {
  GUEST_MERGE_INCOMPLETE: {
    code: 'guest_merge.incomplete',
    userMessage: 'המיזוג לא כלל שני פרופילים. רענן את המסך ונסה שוב.',
  },
  GUEST_MERGE_SAME_ROW: {
    code: 'guest_merge.same_row',
    userMessage: 'אי אפשר למזג פרופיל לתוך עצמו.',
  },
  GUEST_MERGE_NEEDS_A_REASON: {
    code: 'guest_merge.reason_required',
    userMessage:
      'יש להסביר למה מיזגת את הפרופילים — לפחות משפט קצר. מישהו יקרא ' +
      'את זה בעוד חודשיים.',
  },
  GUEST_MERGE_FORBIDDEN: {
    code: 'guest_merge.forbidden',
    // Named precisely, because "no permission" sends somebody to look for
    // the wrong switch. Merging needs both halves of what it does.
    userMessage:
      'מיזוג פרופילים דורש גם הרשאת עדכון אורח וגם הרשאת מחיקת אורח, ' +
      'ואין לך את שתיהן. פנה למנהל המערכת.',
  },
  GUEST_MERGE_UNKNOWN_TABLE: {
    code: 'guest_merge.unknown_table',
    userMessage:
      'המיזוג נעצר: יש במערכת נתונים שמקושרים לאורח והמיזוג לא יודע ' +
      'להעביר אותם, ולכן הוא סירב במקום להשאיר אותם מאחור. זו תקלה ' +
      'שדורשת טיפול של צוות המוצר.',
  },
  GUEST_MERGE_NOT_FOUND: {
    code: 'guest_merge.not_found',
    userMessage: 'אחד הפרופילים לא נמצא בארגון הזה. רענן את המסך.',
  },
  GUEST_MERGE_ALREADY_MERGED: {
    code: 'guest_merge.already_merged',
    userMessage:
      'הפרופילים כבר מוזגו, או שאחד מהם כבר מוזג לפרופיל אחר. רענן את ' +
      'המסך כדי לראות את המצב הנוכחי.',
  },
  GUEST_MERGE_STALE: {
    code: 'guest_merge.stale',
    userMessage:
      'אחד הפרופילים השתנה מאז שהמסך נטען, ולכן הבחירות שעשית נעשו מול ' +
      'נתונים ישנים. רענן ובחר שוב.',
  },
  GUEST_MERGE_UNDO_INCOMPLETE: {
    code: 'guest_merge.undo_incomplete',
    userMessage: 'לא צוין איזה מיזוג לבטל.',
  },
  GUEST_MERGE_UNDO_NEEDS_A_REASON: {
    code: 'guest_merge.undo_reason_required',
    userMessage: 'ביטול מיזוג דורש נימוק — לפחות משפט קצר.',
  },
  GUEST_MERGE_UNDO_FORBIDDEN: {
    code: 'guest_merge.undo_forbidden',
    userMessage:
      'ביטול מיזוג דורש גם הרשאת עדכון אורח וגם הרשאת מחיקת אורח, ' +
      'ואין לך את שתיהן.',
  },
  GUEST_MERGE_UNDO_NOT_FOUND: {
    code: 'guest_merge.undo_not_found',
    userMessage: 'המיזוג הזה לא נמצא.',
  },
  GUEST_MERGE_UNDO_ALREADY_DONE: {
    code: 'guest_merge.undo_already_done',
    userMessage: 'המיזוג הזה כבר בוטל.',
  },
  GUEST_MERGE_UNDO_EXPIRED: {
    code: 'guest_merge.undo_expired',
    userMessage:
      'חלון הביטול (30 יום) חלף. הפרופילים נשארים מאוחדים — פנו לתמיכה ' +
      'אם צריך להפריד אותם.',
  },
  GUEST_MERGE_UNDO_CHAINED: {
    code: 'guest_merge.undo_chained',
    userMessage:
      'הפרופיל השורד מוזג מאז לפרופיל נוסף. יש לבטל קודם את המיזוג ' +
      'המאוחר יותר.',
  },
  GUEST_MERGE_UNDO_ROWS_CHANGED: {
    code: 'guest_merge.undo_rows_changed',
    // The one refusal a person genuinely needs to understand: the undo is
    // refusing in order to protect work they did, and the alternative would
    // have been to overwrite it.
    userMessage:
      'חלק מהרשומות שהועברו במיזוג נערכו מאז, ולכן הביטול נעצר כדי לא ' +
      'למחוק את העבודה הזאת. יש לטפל בהן ידנית — הפירוט נשמר ביומן ' +
      'הפעולות.',
  },
}

const TOKEN = /^([A-Z][A-Z_]*[A-Z]):/

/**
 * The Hebrew failure for a refusal raised by the merge functions, or `null`
 * when the error is not one of theirs.
 *
 * `null` rather than a generic message on purpose: the caller rethrows, and an
 * error that is not about merging keeps its own identity all the way to the
 * log.
 */
export function asMergeFailure(error: unknown): BusinessRuleError | null {
  const message = messageOf(error)
  if (message === null) return null

  const token = TOKEN.exec(message)?.[1]
  if (token === undefined) return null

  const known = MESSAGES[token]
  if (known === undefined) return null

  return new BusinessRuleError({
    code: known.code,
    message,
    userMessage: known.userMessage,
    cause: error,
  })
}

function messageOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const record = error as { message?: unknown }
  return typeof record.message === 'string' ? record.message : null
}

/** The tokens this file knows, for the test that keeps it level with the SQL. */
export const KNOWN_MERGE_TOKENS: readonly string[] = Object.keys(MESSAGES)
