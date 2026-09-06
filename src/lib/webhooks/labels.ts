/**
 * The Hebrew a person reads.
 *
 * Separate from the codes for the reason every other module here separates
 * them: a stable code is what the database stores and what a test asserts,
 * and a sentence is what somebody fixing their endpoint at eleven at night
 * needs. Changing the wording must never change a stored value.
 *
 * The refusal messages say what to do, not what went wrong. "כתובת לא חוקית"
 * is true and useless; the person needs to know that http is not merely
 * discouraged, or that their address points inside our network and no wording
 * will change that.
 */

import type {
  WebhookDeliveryStatus,
  WebhookDisableReason,
  WebhookEndpointStatus,
} from './types'
import type { UrlRefusalCode } from './url-safety'

export const URL_REFUSAL_LABEL: Readonly<Record<UrlRefusalCode, string>> =
  Object.freeze({
    not_a_url:
      'זו אינה כתובת. צריך כתובת מלאה, למשל https://example.com/estia.',
    not_https:
      'כתובת חייבת להתחיל ב-https. מעל http אפשר לקרוא את תוכן ההודעה ולשחזר אותה, והחתימה מאבדת את משמעותה.',
    has_credentials:
      'אין לכלול שם משתמש או סיסמה בכתובת — הם נשמרים בכל שורת יומן שמזכירה אותה.',
    blocked_address:
      'הכתובת מצביעה על כתובת רשת פנימית או שמורה. ESTIA לא תשלח לשם.',
    internal_hostname:
      'שם המארח נראה פנימי. צריך שם מלא וציבורי, למשל hooks.example.com.',
    too_long: 'הכתובת ארוכה מדי.',
  })

export const WEBHOOK_ENDPOINT_STATUS_LABEL: Readonly<
  Record<WebhookEndpointStatus, string>
> = Object.freeze({
  active: 'פעיל',
  paused: 'מושהה',
  disabled: 'כובה',
})

export const WEBHOOK_DELIVERY_STATUS_LABEL: Readonly<
  Record<WebhookDeliveryStatus, string>
> = Object.freeze({
  pending: 'ממתין',
  succeeded: 'נמסר',
  exhausted: 'נכשל אחרי כל הניסיונות',
  blocked: 'נחסם לפני שליחה',
})

/**
 * Why the product turned it off.
 *
 * Each one says what happened AND what to do, because "we noticed it failing"
 * is not something a person can act on.
 */
export const WEBHOOK_DISABLE_REASON_LABEL: Readonly<
  Record<WebhookDisableReason, string>
> = Object.freeze({
  too_many_failures:
    'היעד לא ענה בעשרים מסירות רצופות. בדקו שהשרת מגיב ואז הפעילו מחדש.',
  receiver_said_gone:
    'השרת שלכם החזיר 410 Gone — כלומר ביקש במפורש להפסיק. הפעלה מחדש כאן לא תעזור עד שהצד השני יקבל שוב.',
  address_became_unsafe:
    'הכתובת התחילה להצביע על רשת פנימית. זה קורה כששם המארח שינה רשומת DNS.',
})
