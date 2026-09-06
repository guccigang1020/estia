/**
 * The Hebrew a person reads, and the sentence that explains an absent number.
 *
 * The `Unmeasurable` lines are the ones that matter. A dash on a dashboard is
 * read as zero by everybody who is in a hurry, and a business that reads its
 * occupancy as zero for a full August will do something about it. Each reason
 * therefore says what is missing and what would fill it.
 */

import type { BookingSourceName, Unmeasurable } from './types'

export const SOURCE_LABEL: Readonly<Record<BookingSourceName, string>> =
  Object.freeze({
    direct_website: 'האתר שלכם',
    direct_manual: 'ישיר — טלפון או וואטסאפ',
    agent: 'סוכן',
    agency: 'סוכנות',
    airbnb: 'Airbnb',
    booking_com: 'Booking.com',
    vrbo: 'Vrbo',
    other_channel: 'ערוץ אחר',
  })

export const UNMEASURABLE_LABEL: Readonly<Record<Unmeasurable, string>> =
  Object.freeze({
    no_data: 'אין הזמנות בטווח הזה — אין מה לחשב',
    no_source: 'ההזמנות קיימות אך חסר להן שורות מחיר של לינה',
    no_denominator: 'לא ידוע כמה יחידות היו זמינות, ולכן אין במה לחלק',
    not_in_product: 'אין מקור נתונים כזה במוצר',
  })

export const METRIC_LABEL: Readonly<Record<string, string>> = Object.freeze({
  occupancy: 'תפוסה',
  adr: 'מחיר ממוצע ללילה (ADR)',
  revpar: 'הכנסה ללילה זמין (RevPAR)',
  roomRevenue: 'הכנסות לינה',
  totalRevenue: 'הכנסות כולל',
  nightsSold: 'לילות שנמכרו',
  nightsAvailable: 'לילות זמינים',
  averageStay: 'אורך שהייה ממוצע',
  leadTime: 'ימי הקדמה בהזמנה',
  cancellation: 'שיעור ביטולים',
  marketPosition: 'מיקום מול השוק',
})

/**
 * The three sentences the screen owes a reader who wonders why a figure is
 * lower or higher than they expected. Written once, here, because a number
 * whose definition lives only in a code comment gets re-argued every quarter.
 */
export const METRIC_NOTE: Readonly<Record<string, string>> = Object.freeze({
  adr:
    'מחושב משורות המחיר מסוג "לינה" בלבד. דמי ניקיון, מיטות נוספות ותוספות ' +
    'אינם הכנסת לינה — לכלול אותם מנפח את המחיר הממוצע ומוביל לתמחור עונה שגוי.',
  occupancy:
    'לילות שנמכרו מתוך לילות זמינים. הזמנה שממתינה לתשלום נספרת: היחידה ' +
    'תפוסה ואי אפשר למכור אותה לאחר. פניות והצעות מחיר אינן נספרות — הן ביקוש, לא תפוסה.',
  cancellation:
    'מתוך ההזמנות שהוכרעו בלבד. פנייה שנשתקה מעולם לא בוטלה, וספירתה כאן ' +
    'הייתה מציגה כל עסק עמוס כלא אמין.',
  marketPosition:
    'אין נתוני שוק במוצר הזה. השוואה למתחרים תהיה אפשרית רק כשיהיה מקור ' +
    'נתונים אמיתי — עד אז כל מספר כאן יהיה המצאה.',
  leadTime:
    'הזמנות שנרשמו אחרי שהאורח כבר הגיע אינן נספרות — הן הוזנו בדיעבד או ' +
    'יובאו ממערכת קודמת, וממוצע שכולל אותן מדווח אפס ימי הקדמה על עסק שמזמינים אצלו חודשיים מראש.',
})

/** ₪ from agorot, with no false precision. */
export function shekels(agorot: number): string {
  return `₪${(agorot / 100).toLocaleString('he-IL', {
    maximumFractionDigits: 0,
  })}`
}
