/**
 * Hebrew for everything this module can be in the middle of.
 *
 * One rule, and it is the reason the file exists rather than the strings
 * living beside each screen: **a provider's own words never reach a person.**
 * `error_code` and `suppressed_reason` are English diagnostics for whoever
 * reads the table; what a business owner sees is written here, deliberately,
 * by somebody who thought about what they should do next.
 *
 * The second rule is that "nothing was sent" and "you asked us not to send it"
 * are different sentences. Merging them is how a product ends up telling a
 * business to buy an SMS channel that its own staff switched off.
 */

import type {
  NotificationCategory,
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationSeverity,
  SuppressionReason,
} from './types'

export const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  in_app: 'במערכת',
  email: 'דוא״ל',
  sms: 'SMS',
  whatsapp: 'ווטסאפ',
  push: 'התראת דחיפה',
}

/** What each channel is FOR, in one line, on the preferences screen. */
export const CHANNEL_HINT: Record<NotificationChannel, string> = {
  in_app: 'מופיע בפעמון בתוך המערכת. לא דורש שום חיבור חיצוני, ולכן תמיד עובד.',
  email: 'נשלח לכתובת הדוא״ל שבפרופיל.',
  sms: 'מסרון לטלפון שבפרופיל.',
  whatsapp: 'הודעת ווטסאפ לטלפון שבפרופיל.',
  push: 'התראה למכשיר.',
}

export const SEVERITY_LABEL: Record<NotificationSeverity, string> = {
  info: 'לידיעה',
  attention: 'דורש תשומת לב',
  urgent: 'דחוף',
  critical: 'קריטי',
}

export const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  booking: 'הזמנות',
  guest: 'אורחים',
  money: 'כספים',
  operations: 'תפעול',
  inventory: 'מלאי',
  approval: 'אישורים',
  security: 'אבטחה',
  system: 'מערכת',
}

/** One line saying what falls into each category, so nobody has to guess. */
export const CATEGORY_HINT: Record<NotificationCategory, string> = {
  booking: 'הזמנות חדשות, שינויים, ביטולים והזמנות מערוצים חיצוניים.',
  guest: 'בקשות של אורחים, מילוי פרטים ואישור מחדש של תנאים.',
  money: 'תשלומים, החזרים, חשבוניות ועמלות.',
  operations: 'משימות, אירועים, הכנות וכביסה.',
  inventory: 'חוסרים במלאי — קיימים וצפויים.',
  approval: 'בקשות שממתינות להחלטה שלך, והחלטות בבקשות שלך.',
  security: 'כניסות חריגות, שינויי הרשאות, ייצוא מידע ושינוי הגדרות גבייה.',
  system: 'סנכרון ערוצים, פרסום האתר ותקלות תשתית.',
}

export const DELIVERY_STATUS_LABEL: Record<NotificationDeliveryStatus, string> =
  {
    pending: 'ממתין לשליחה',
    deferred: 'מוחזק עד סוף שעות השקט',
    sent: 'נשלח',
    delivered: 'נמסר',
    failed: 'נכשל',
    not_configured: 'אין ערוץ מחובר',
    suppressed: 'לא נשלח לפי הגדרה',
  }

/**
 * Why nothing went out, written for the person who has to decide what to do.
 *
 * `no_transport` and `channel_disabled` are the pair that must never be
 * confused: the first is the business missing an integration, the second is
 * the business having chosen not to use one.
 */
export const SUPPRESSION_LABEL: Record<SuppressionReason, string> = {
  quiet_hours: 'הוחזק בשעות השקט וייצא כשהן נגמרות.',
  preference_off: 'ההגדרה האישית בערוץ הזה כבויה.',
  below_min_severity: 'רמת הדחיפות נמוכה מהסף שהוגדר לערוץ הזה.',
  channel_disabled: 'הערוץ כבוי ברמת הארגון.',
  no_transport: 'אין ערוץ מחובר — ההודעה נרשמה ולא נשלחה לאף מקום.',
}

/**
 * The sentence a business reads about its own unsent messages.
 *
 * A count and nothing else would be a number without a decision attached to
 * it. This says what the number means and what it costs, and it deliberately
 * does not apologise: the record exists, the in-app channel delivered, and the
 * gap is one integration rather than a failure.
 */
export function unsentSummary(count: number, days: number): string {
  if (count === 0) {
    return `בטווח ${days} הימים האחרונים לא היו הודעות שנחסמו בגלל ערוץ חסר.`
  }

  return (
    `בטווח ${days} הימים האחרונים היינו שולחים ${count} הודעות בערוצים חיצוניים, ` +
    `ואין אף ערוץ מחובר. ההודעות עצמן נשמרו ומופיעות בפעמון במערכת — ` +
    `מה שלא קרה הוא שמישהו קיבל מסרון או דוא״ל כשהוא לא היה מול המסך.`
  )
}
