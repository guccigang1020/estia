/**
 * Every Autopilot vocabulary, said in Hebrew, once.
 *
 * ── Why a `Record` and never a lookup with a fallback ─────────────────────
 *
 * Each map below is typed `Record<Vocabulary, string>`, so adding a member to
 * `src/lib/contracts/states.ts` and not to this file is a compile error rather
 * than a screen that prints `money_access_cancellation` to a guesthouse owner.
 * That has already happened three times in this codebase with database
 * vocabularies — 0035, 0044, the `booking.manage` defect in 0042 — and the fix
 * each time was to make the omission fail early. A `?? code` fallback would
 * make it fail late and in front of a customer.
 *
 * ── These are labels, not explanations, with one deliberate exception ─────
 *
 * A label names a value; it does not argue for it. `DISPOSITION_MEANING` is
 * the exception, and it exists because the four cells of the policy matrix are
 * the single most consequential control in the product: "ask_approval" as a
 * bare word tells a manager nothing about whether their guest gets a message
 * tonight. So each disposition carries one sentence saying what it does, and
 * that sentence is rendered beside the control rather than in documentation
 * nobody opens.
 *
 * ── What this file must never grow into ──────────────────────────────────
 *
 * No function here decides anything. There is no `isAllowed`, no
 * `ceilingFor`, no ordering helper — those are the policy engine's and the
 * screens read its conclusions. This file turns a stored value into words.
 *
 * No `'use client'`: constants in, strings out, and it must stay importable
 * from a Client Component, so it imports only types.
 */

import type {
  ActionSafetyLevel,
  AutopilotActionOutcome,
  AutopilotBookingHandling,
  AutopilotCapabilityState,
  AutopilotConfidence,
  AutopilotDisposition,
  AutopilotDomain,
  AutopilotExceptionState,
  AutopilotLevel,
  AutopilotRiskState,
  AutopilotRunMode,
  AutopilotSuppressionReason,
} from '@/lib/contracts/states'

/* --------------------------------------------------------------- level -- */

export const LEVEL_LABEL: Record<AutopilotLevel, string> = {
  off: 'כבוי',
  advisory: 'מייעץ',
  assisted: 'מלווה',
  autopilot: 'אוטומטי',
  custom: 'מותאם',
}

/** What the customer is actually choosing, in one sentence per rung. */
export const LEVEL_MEANING: Record<AutopilotLevel, string> = {
  off: 'ESTIA לא תזהה ולא תציע דבר מעבר למה שהמערכת עושה ממילא.',
  advisory: 'ESTIA מזהה ומסבירה. היא לא מבצעת שום פעולה.',
  assisted: 'ESTIA מכינה את הפעולה, ואדם לוחץ על הכפתור.',
  autopilot: 'פעולות בטוחות שאישרתם מראש מתבצעות לבד, בתוך הגבולות שהגדרתם.',
  custom: 'מטריצת המדיניות מחליטה, פעולה אחר פעולה.',
}

export const RUN_MODE_LABEL: Record<AutopilotRunMode, string> = {
  live: 'פעיל',
  simulation: 'סימולציה',
}

export const RUN_MODE_MEANING: Record<AutopilotRunMode, string> = {
  live: 'פעולות שמותר לבצע — מתבצעות במציאות.',
  simulation:
    'ESTIA רושמת מה הייתה עושה ולא עושה דבר. שום הודעה לא יוצאת החוצה.',
}

/* -------------------------------------------------------------- safety -- */

export const SAFETY_LEVEL_LABEL: Record<ActionSafetyLevel, string> = {
  information: 'מידע',
  safe_internal: 'פנימי בטוח',
  external_communication: 'תקשורת החוצה',
  business_impact: 'השפעה עסקית',
  money_access_cancellation: 'כסף, גישה וביטול',
}

export const SAFETY_LEVEL_MEANING: Record<ActionSafetyLevel, string> = {
  information: 'אומרת משהו. לא משנה כלום.',
  safe_internal: 'פנימי, הפיך, ולא נראה מחוץ לעסק.',
  external_communication: 'מישהו מחוץ לעסק קורא את זה — אורח, ספק או עובד.',
  business_impact: 'משנה את מה שהעסק מציע, גובה או מבטיח.',
  money_access_cancellation: 'כסף, גישה של אורח, או אובדן הזמנה.',
}

/* --------------------------------------------------------- disposition -- */

export const DISPOSITION_LABEL: Record<AutopilotDisposition, string> = {
  off: 'כבוי',
  suggest: 'הצעה',
  ask_approval: 'באישור',
  auto: 'אוטומטי',
}

export const DISPOSITION_MEANING: Record<AutopilotDisposition, string> = {
  off: 'ESTIA לא תעלה את זה בכלל.',
  suggest: 'ESTIA תעלה את זה ולא תכין פעולה.',
  ask_approval: 'ESTIA תכין את הפעולה, ואדם ילחץ על הכפתור.',
  auto: 'ESTIA תבצע את הפעולה.',
}

/* -------------------------------------------------------------- domain -- */

export const DOMAIN_LABEL: Record<AutopilotDomain, string> = {
  safety: 'בטיחות',
  arrival_risk: 'סיכון בהגעה',
  guest_access: 'גישת אורח',
  payment_risk: 'סיכון תשלום',
  preparation: 'הכנה',
  maintenance: 'תחזוקה',
  inventory: 'מלאי',
  laundry: 'כביסה',
  staff: 'צוות',
  sales_opportunity: 'הזדמנות מכירה',
  optimization: 'ייעול',
}

/* ---------------------------------------------------------------- risk -- */

export const RISK_LABEL: Record<AutopilotRiskState, string> = {
  ready: 'מוכן',
  on_track: 'בכיוון',
  at_risk: 'בסיכון',
  critical: 'קריטי',
}

export const EXCEPTION_STATE_LABEL: Record<AutopilotExceptionState, string> = {
  new: 'חדש',
  acknowledged: 'נראה',
  in_progress: 'בטיפול',
  resolved: 'נפתר',
  dismissed: 'נדחה',
}

export const CONFIDENCE_LABEL: Record<AutopilotConfidence, string> = {
  low: 'ביטחון נמוך',
  medium: 'ביטחון בינוני',
  high: 'ביטחון גבוה',
}

/* ------------------------------------------------------------- outcome -- */

export const OUTCOME_LABEL: Record<AutopilotActionOutcome, string> = {
  planned: 'תוכננה',
  awaiting_approval: 'ממתינה לאישור',
  approved: 'אושרה',
  executed: 'בוצעה',
  executed_unaudited: 'בוצעה — והתיעוד נכשל',
  failed: 'נכשלה',
  retrying: 'בניסיון חוזר',
  needs_review: 'דורשת בדיקה',
  suppressed: 'נמנעה',
  simulated: 'סימולציה',
  cancelled: 'בוטלה',
}

/**
 * Why an action did not happen, said to the person who asked.
 *
 * Every member is here because the schema's own comment is right: "Autopilot
 * did nothing" with no reason attached is the fastest way to lose a customer's
 * trust in it. A suppression that renders as a blank cell is that failure with
 * extra steps.
 */
export const SUPPRESSION_LABEL: Record<AutopilotSuppressionReason, string> = {
  level_too_low: 'רמת האוטומציה נמוכה מכדי לבצע את זה',
  policy_off: 'הפעולה כבויה במטריצת המדיניות',
  safety_level_forbidden: 'רמת הסיכון של הפעולה אינה מתירה ביצוע אוטומטי',
  platform_rule: 'כלל בטיחות של ESTIA חוסם ביצוע אוטומטי',
  module_disabled: 'המודול שהפעולה נשענת עליו כבוי',
  missing_permission: 'למי שהפעולה רצה בשמו אין את ההרשאה',
  missing_entitlement: 'החבילה אינה כוללת את היכולת',
  quiet_hours: 'שעות שקט',
  paused: 'האוטומציה מושהית',
  kill_switch: 'מתג הכיבוי פעיל',
  low_confidence: 'רמת הביטחון נמוכה מדי לפעולה כזו',
  booking_manual_only: 'ההזמנה מסומנת לטיפול ידני בלבד',
  property_override: 'הנכס מוגדר ברמה נמוכה מהארגון',
  simulation: 'הרצה בסימולציה — שום דבר לא יצא החוצה',
  duplicate: 'פעולה זהה כבר נרשמה',
}

/* ------------------------------------------------------ other narrowings -- */

export const BOOKING_HANDLING_LABEL: Record<AutopilotBookingHandling, string> =
  {
    normal: 'רגיל',
    high_attention: 'תשומת לב מוגברת',
    manual_only: 'ידני בלבד',
  }

export const CAPABILITY_STATE_LABEL: Record<AutopilotCapabilityState, string> =
  {
    not_available: 'לא מוצע',
    eligible: 'זמין להפעלה',
    trial: 'תקופת התנסות',
    enabled: 'פעיל',
    suspended: 'הושעה',
    disabled: 'הופסק',
  }
