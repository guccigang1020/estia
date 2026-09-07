/**
 * The Hebrew this module says out loud.
 *
 * In one file because a refusal a person reads has to say the same thing on
 * the screen, in the server action and in the audit sentence. Three copies of
 * "אין תוכנית תעריפים שמתאימה" is three chances for two of them to drift and
 * for a support call to be about which one is right.
 *
 * ══ HOW A REFUSAL IS WORDED ═════════════════════════════════════════════════
 *
 * Every message states the FACT, not the rule. "לא ניתן לשנות מחיר של הזמנה
 * שהושלמה" and then what to do instead — not "invalid transition", and not
 * "BusinessRuleError". The person reading it is usually holding a telephone
 * with a guest on the other end, and a message that names an internal concept
 * costs them the call.
 *
 * ══ AND HOW AN ABSENT FIGURE IS WORDED ══════════════════════════════════════
 *
 * A number that cannot be sourced is reported as absent WITH ITS REASON, never
 * estimated and never shown as zero. `UNMEASURABLE_REASON` is the Hebrew for
 * each `Unmeasurable`, and every screen in this module uses it rather than
 * printing an em dash and leaving the reader to guess whether the business
 * sold nothing or the system knows nothing.
 */

import type { Unmeasurable } from '../revenue/types'
import type { AutoApplyBlocker } from './suggestions'
import type {
  NightBaseOrigin,
  PricingRefusal,
  RateCalendarSource,
  RateModifierKind,
  RatePlanKind,
  RateScope,
  RateSuggestionStatus,
} from './types'

export const RATE_PLAN_KIND_LABEL: Record<RatePlanKind, string> = {
  flexible: 'גמיש',
  non_refundable: 'ללא ביטול',
  direct: 'ישיר',
  agent: 'סוכן',
  ota: 'ערוץ הפצה',
  corporate: 'חברות',
  owner_special: 'בעלים',
}

export const RATE_SCOPE_LABEL: Record<RateScope, string> = {
  unit: 'יחידה',
  unit_group: 'קבוצת יחידות',
  property: 'נכס',
}

export const RATE_CALENDAR_SOURCE_LABEL: Record<RateCalendarSource, string> = {
  manual: 'הוזן ידנית',
  ai_approved: 'המלצה שאושרה',
  channel_sync: 'סונכרן מערוץ',
}

export const RATE_MODIFIER_KIND_LABEL: Record<RateModifierKind, string> = {
  weekend: 'סוף שבוע',
  holiday: 'חג',
  occupancy: 'ביקוש',
  guest_count: 'מספר אורחים',
  event_type: 'סוג אירוע',
}

export const SUGGESTION_STATUS_LABEL: Record<RateSuggestionStatus, string> = {
  pending: 'ממתינה להחלטה',
  approved: 'אושרה',
  rejected: 'נדחתה',
  expired: 'פגה',
  auto_applied: 'יושמה אוטומטית',
}

export const NIGHT_BASE_ORIGIN_LABEL: Record<NightBaseOrigin, string> = {
  rate_calendar: 'מחיר שנקבע ללילה הזה',
  rate_rule: 'חוק תעריף',
  unit_base_price: 'מחיר הבסיס של היחידה',
}

/** The Hebrew for a figure that has no source. Never an em dash on its own. */
export const UNMEASURABLE_REASON: Record<Unmeasurable, string> = {
  no_data: 'אין נתונים בטווח הזה.',
  no_source: 'אין מקור נתונים למדד הזה.',
  no_denominator: 'אין מכנה לחישוב — לא ניתן להציג אחוז.',
  not_in_product: 'המדד הזה עדיין לא נאסף במוצר.',
}

/** Why a stay could not be priced, said as a fact. */
export function refusalMessage(refusal: PricingRefusal): string {
  switch (refusal.code) {
    case 'no_rate_plan':
      return 'אין תוכנית תעריפים שמתאימה לתאריכים ולערוץ האלה. אי אפשר לצטט מחיר בלי תוכנית — מחיר כזה הוא מחיר שאיש לא אישר.'
    case 'derivation_too_deep':
      return 'שרשרת גזירת התעריפים ארוכה מדי (עד שלוש רמות). מחירון שאי אפשר לקרוא הוא מחירון שאי אפשר לבדוק.'
    case 'derivation_cycle':
      return 'גזירת התעריפים יוצרת מעגל: תוכנית שמפנה בסופו של דבר לעצמה.'
    case 'below_minimum_nights':
      return `השהות קצרה מהמינימום: ${refusal.required} לילות נדרשים, ${refusal.requested} התבקשו.`
    case 'invalid_range':
      return 'תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה.'
  }
}

/** Why an automatic application, or an approval, was refused. */
export function blockerMessage(blocker: AutoApplyBlocker): string {
  switch (blocker.code) {
    case 'no_policy':
      return 'לא הוגדרה מדיניות תמחור אוטומטי.'
    case 'policy_disabled':
      return 'התמחור האוטומטי כבוי. ההמלצה ממתינה לאישור אדם.'
    case 'policy_unattributed':
      return 'למדיניות התמחור האוטומטי אין מי שהפעיל אותה, ולכן שינוי אוטומטי לא יוכל לשאת שם.'
    case 'not_pending':
      return 'ההמלצה כבר הוכרעה.'
    case 'expired':
      return 'ההמלצה פגה. המלצה על מחר אינה רלוונטית מחרתיים.'
    case 'night_is_sold':
      return 'הלילה כבר נמכר. המחיר של לילה שנמכר הוא עובדה, לא הגדרה.'
    case 'delta_unmeasurable':
      return 'המחיר הדטרמיניסטי הוא אפס, ולכן אי אפשר למדוד את הפער באחוזים. שינוי אוטומטי לא מתבצע כשאי אפשר להוכיח שהוא בתוך הגבול.'
    case 'delta_exceeded':
      return `הפער מהמחיר הדטרמיניסטי (${formatBps(blocker.deltaBps)}) גדול מהמותר במדיניות (${formatBps(blocker.maxDeltaBps)}).`
    case 'below_floor':
      return `ההצעה נמוכה מרצפת המדיניות (${formatAgorotShort(blocker.floorAgorot)}).`
    case 'above_ceiling':
      return `ההצעה גבוהה מתקרת המדיניות (${formatAgorotShort(blocker.ceilingAgorot)}).`
    case 'daily_changes_used':
      return `נוצלו כבר ${blocker.used} מתוך ${blocker.allowed} שינויים אוטומטיים ליחידה הזאת היום.`
  }
}

/** Basis points as a percentage a person reads. `1500` → `15%`. */
export function formatBps(bps: number): string {
  const percent = bps / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`
}

/**
 * Agorot as shekels.
 *
 * Local to this module and deliberately short: money is stored, computed and
 * compared in integer agorot everywhere, and the ONLY place shekels exist is
 * the string a person reads. A helper that returned a shekel NUMBER would be
 * one somebody eventually did arithmetic with.
 */
export function formatAgorotShort(agorot: number): string {
  const shekels = agorot / 100
  return `₪${shekels.toLocaleString('he-IL', {
    minimumFractionDigits: shekels % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

/** The empty-state sentences. Each names a number rather than showing a void. */
export const PRICING_NOTE = {
  noRateCard:
    'עוד לא הוגדר מחירון ליחידה הזאת. המחיר שיוצג לאורח הוא מחיר הבסיס של היחידה.',
  noEngine:
    'אין בפריסה הזאת מנוע שמייצר המלצות תמחור. הטבלה קיימת והמסך מוכן — כשיהיה מנוע, ההמלצות יופיעו כאן וימתינו לאישור אדם. עד אז אין מה לאשר, וזה לא מסך ריק בטעות.',
  frozen:
    'מחיר של הזמנה קיימת אינו זז כששינוי נעשה במחירון. ההזמנה מחזיקה צילום של המחיר, לא הפניה למחירון.',
  notProvisioned:
    'טבלאות התמחור אינן קיימות בבסיס הנתונים הזה. יש להריץ את המיגרציה 0072.',
  suggestionNeedsReason: 'דחיית המלצה דורשת נימוק. הסבר בקצרה מדוע היא נדחית.',
} as const
