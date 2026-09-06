/**
 * The channel exception model.
 *
 * ── Why this is a queue and not a log ─────────────────────────────────────
 *
 * Every kind in `CHANNEL_EXCEPTION_KINDS` names a moment where the honest
 * answer is "a person has to look at this". The alternatives are all guesses,
 * and every guess available here either drops a booking somebody has paid for
 * or sells one night to two families. So the module does not guess: it writes
 * a row, and the row says what happened, what it affects, and — this is the
 * part that makes it a queue rather than a backlog — *what to do about it*.
 *
 * An exception with no resolution path is a notification with extra steps. The
 * playbook below is therefore a total `Record` over the kinds: adding an
 * exception kind without saying how somebody clears it fails the typecheck.
 *
 * ── Severity is about the calendar, not about the tone ────────────────────
 *
 *   · `critical` — money or a bed is at stake right now. A reservation that
 *     did not become a booking is critical: the guest holds a confirmation and
 *     ESTIA thinks the unit is free.
 *   · `urgent` — the calendars are drifting and will produce the above.
 *   · `warning` — something is wrong and nothing is being sold twice.
 *
 * ── Dedupe ────────────────────────────────────────────────────────────────
 *
 * A webhook that fails to map redelivers every few minutes. Without a stable
 * key that is four hundred rows for one problem, and the exception centre
 * becomes the thing nobody opens. The key is derived from the *problem*, never
 * from the delivery: the same unmapped listing is one row however many times
 * it arrives.
 */

import type { Grant } from '../authz/permissions'

import {
  CHANNEL_LABEL,
  type ChannelCode,
  type ChannelException,
  type ChannelExceptionKind,
  type ExceptionSeverity,
} from './types'

/* ---------------------------------------------------------------- drafts -- */

/**
 * An exception before the database has given it an identity.
 *
 * Produced by pure functions and handed to the repository. Separate from
 * `ChannelException` so a domain test can assert on what was raised without
 * inventing an id and a state that only persistence can supply.
 */
export interface ChannelExceptionDraft {
  organizationId: string
  connectorId: string | null
  channelCode: ChannelCode
  kind: ChannelExceptionKind
  severity: ExceptionSeverity
  title: string
  detail: string
  externalReservationId: string | null
  externalListingId: string | null
  bookingId: string | null
  unitId: string | null
  propertyId: string | null
  dedupeKey: string
  occurredAt: Date
}

/* -------------------------------------------------------------- playbook -- */

export interface ExceptionPlaybook {
  label: string
  severity: ExceptionSeverity
  /**
   * What a person does, in order. Hebrew, imperative, and specific — "צור
   * מיפוי" and not "טפל בבעיה". A step somebody cannot act on from the screen
   * is not a step.
   */
  steps: readonly string[]
  /** The grant a person needs to clear it. Shown so the right person is asked. */
  requires: Grant
  /**
   * True when the underlying reservation is still recoverable by re-running
   * ingestion once the cause is fixed. Drives the "נסה שוב" affordance — and
   * its absence, which matters more: offering a retry that cannot work is how
   * an exception centre teaches people to ignore it.
   */
  retryable: boolean
}

export const EXCEPTION_PLAYBOOK: Readonly<
  Record<ChannelExceptionKind, ExceptionPlaybook>
> = {
  mapping_missing: {
    label: 'הזמנה למודעה שאינה ממופה',
    // Critical, not urgent. The guest has a confirmation from the channel and
    // ESTIA believes the unit is free — the next direct booking sells it.
    severity: 'critical',
    steps: [
      'פתח את מסך ההתאמות ובדוק לאיזו יחידה שייכת המודעה.',
      'צור מיפוי בין המודעה ליחידה, ואמת אותו.',
      'הרץ מחדש את קליטת ההזמנה — היא תיווצר אז כהזמנה רגילה.',
      'עד אז: התאריכים אינם חסומים אצלך. חסום אותם ידנית אם הם קרובים.',
    ],
    requires: 'channel.manage',
    retryable: true,
  },

  duplicate_mapping: {
    label: 'שתי התאמות לאותה מודעה',
    severity: 'urgent',
    steps: [
      'פתח את מסך ההתאמות וסנן לפי המודעה הכפולה.',
      'החלט איזו יחידה באמת נמכרת במודעה הזו.',
      'השהה את ההתאמה השנייה. אל תמחק — היסטוריית ההזמנות תלויה בה.',
    ],
    requires: 'channel.manage',
    retryable: true,
  },

  availability_mismatch: {
    label: 'פער בין היומן שלך ליומן בערוץ',
    severity: 'urgent',
    steps: [
      'בדוק את הלילות שבמחלוקת מול הערוץ עצמו.',
      'החלט מי צודק — המערכת או הערוץ — ואשר את ההחלטה במסך ההשוואה.',
      'עד לאישור, שני הצדדים ממשיכים למכור לפי מה שכל אחד מהם מאמין.',
    ],
    requires: 'channel.manage',
    retryable: false,
  },

  rate_push_failed: {
    label: 'עדכון מחירים לא התקבל בערוץ',
    // Not urgent: a stale price sells at the wrong number, which costs money
    // and does not double-book anybody.
    severity: 'warning',
    steps: [
      'בדוק אילו תאריכים נדחו — הם מפורטים בשורת החריגה.',
      'ודא שהמחיר תקין ושהמודעה פעילה בערוץ.',
      'שלח שוב. אם נדחה שוב, הערוץ דוחה את הבקשה עצמה ולא את המחיר.',
    ],
    requires: 'pricing.manage',
    retryable: true,
  },

  stale_webhook: {
    label: 'עדכון שהגיע באיחור',
    severity: 'warning',
    steps: [
      'בדרך כלל אין מה לעשות: הגיע עדכון ישן יותר ממה שכבר קיים אצלך.',
      'אם המצב אצלך נראה שגוי, הרץ השוואה מול הערוץ.',
    ],
    requires: 'channel.manage',
    retryable: false,
  },

  unknown_booking: {
    label: 'הערוץ מתייחס להזמנה שלא מוכרת',
    severity: 'urgent',
    steps: [
      'חפש את מספר ההזמנה של הערוץ במסך ההזמנות.',
      'אם היא לא קיימת — משכו מחדש את ההזמנות מהערוץ.',
      'אם היא קיימת אך תחת מספר אחר, זהו כפל הזמנה ולא הזמנה חסרה.',
    ],
    requires: 'channel.manage',
    retryable: true,
  },

  modification_conflict: {
    label: 'הערוץ שינה משהו שכבר שונה אצלך',
    // Critical: the system is holding two different truths about one stay, and
    // applying either one silently discards somebody's decision.
    severity: 'critical',
    steps: [
      'השווה את שני השינויים — מה שונה אצלך ומה הערוץ שלח.',
      'החלט מה נכון. שום שינוי לא הוחל אוטומטית.',
      'אם ההחלטה היא לקבל את הערוץ — עדכן דרך מסך ההזמנה, לא כאן.',
    ],
    requires: 'booking.update',
    retryable: false,
  },

  cancellation_conflict: {
    label: 'ביטול שאי אפשר להחיל',
    severity: 'critical',
    steps: [
      'בדוק את מצב ההזמנה: אורח שכבר נכנס אינו הזמנה שאפשר לבטל בשקט.',
      'החלט מה קורה עם התשלום — זו החלטה כספית, לא יומנית.',
      'בצע את השינוי דרך מסך ההזמנה, כדי שיירשם ביומן ובביקורת.',
    ],
    requires: 'booking.cancel',
    retryable: false,
  },

  duplicate_booking: {
    label: 'אותה שהות הגיעה פעמיים',
    severity: 'urgent',
    steps: [
      'השווה את שתי ההזמנות: אותה יחידה, אותם תאריכים, אותו אורח.',
      'אם זו באמת אותה שהות — בטל אחת מהן בערוץ שבו היא נוצרה.',
      'אל תמחק כאן: הערוץ עדיין מחזיק את ההזמנה שמחקת.',
    ],
    requires: 'booking.cancel',
    retryable: false,
  },

  invalid_reservation: {
    label: 'הזמנה שאי אפשר לקלוט',
    // Critical for the same reason `mapping_missing` is: the guest holds a
    // confirmation and ESTIA holds nothing.
    severity: 'critical',
    steps: [
      'קרא את הפירוט — הוא אומר בדיוק איזה שדה אינו תקין.',
      'אם הבעיה בערוץ, תקן שם והזמנה מעודכנת תגיע מעצמה.',
      'אם השהות אמיתית, הקלד אותה ידנית וסמן את מקורה בערוץ.',
      'התאריכים אינם חסומים אצלך עד שאחד מהשניים קורה.',
    ],
    requires: 'booking.create',
    retryable: true,
  },
}

export function playbookFor(kind: ChannelExceptionKind): ExceptionPlaybook {
  return EXCEPTION_PLAYBOOK[kind]
}

/* ---------------------------------------------------------------- keying -- */

/**
 * The key that collapses a repeating problem into one row.
 *
 * Built from the kind plus the thing the problem is *about* — a listing, a
 * reservation, a booking, a date — and never from the delivery, the timestamp
 * or a random id. A webhook redelivered forty times must produce one
 * exception, and the guarantee has to be the key rather than a handler
 * remembering to look first.
 */
export function exceptionDedupeKey(
  kind: ChannelExceptionKind,
  channelCode: ChannelCode,
  subject: string,
): string {
  return `${kind}:${channelCode}:${subject}`
}

/* -------------------------------------------------------------- builders -- */

interface DraftArgs {
  organizationId: string
  connectorId: string | null
  channelCode: ChannelCode
  occurredAt: Date
  detail: string
  subject: string
  externalReservationId?: string | null
  externalListingId?: string | null
  bookingId?: string | null
  unitId?: string | null
  propertyId?: string | null
}

/**
 * One constructor, so severity and title cannot drift from the playbook.
 *
 * The title comes from `EXCEPTION_PLAYBOOK[kind].label` rather than from the
 * caller: two call sites raising `mapping_missing` under two different
 * headings is two rows a person reads as two different problems.
 */
export function draftException(
  kind: ChannelExceptionKind,
  args: DraftArgs,
): ChannelExceptionDraft {
  const playbook = EXCEPTION_PLAYBOOK[kind]

  return {
    organizationId: args.organizationId,
    connectorId: args.connectorId,
    channelCode: args.channelCode,
    kind,
    severity: playbook.severity,
    title: `${CHANNEL_LABEL[args.channelCode]} — ${playbook.label}`,
    detail: args.detail,
    externalReservationId: args.externalReservationId ?? null,
    externalListingId: args.externalListingId ?? null,
    bookingId: args.bookingId ?? null,
    unitId: args.unitId ?? null,
    propertyId: args.propertyId ?? null,
    dedupeKey: exceptionDedupeKey(kind, args.channelCode, args.subject),
    occurredAt: args.occurredAt,
  }
}

/* ------------------------------------------------------------- reporting -- */

/** Highest first. What the exception centre sorts on. */
export const SEVERITY_RANK: Readonly<Record<ExceptionSeverity, number>> = {
  critical: 0,
  urgent: 1,
  warning: 2,
}

export function bySeverityThenAge(
  a: ChannelException,
  b: ChannelException,
): number {
  const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (rank !== 0) return rank
  // Oldest first inside a severity: an unmapped reservation from Tuesday is
  // more dangerous than the identical one from ten minutes ago, because the
  // dates it failed to block are that much closer.
  return a.occurredAt.getTime() - b.occurredAt.getTime()
}

export interface ExceptionTally {
  open: number
  critical: number
  urgent: number
  warning: number
}

export function tallyExceptions(
  exceptions: readonly ChannelException[],
): ExceptionTally {
  const tally: ExceptionTally = {
    open: 0,
    critical: 0,
    urgent: 0,
    warning: 0,
  }

  for (const exception of exceptions) {
    // `acknowledged` counts as open, and deliberately: somebody having seen a
    // double booking does not un-double it. Only `resolved` and `dismissed`
    // leave the queue.
    if (exception.state !== 'open' && exception.state !== 'acknowledged') {
      continue
    }
    tally.open += 1
    tally[exception.severity] += 1
  }

  return tally
}
