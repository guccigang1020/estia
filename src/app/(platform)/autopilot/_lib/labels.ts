import { actionSpec } from '@/lib/autopilot/actions'
import { AUTOPILOT_CAPABILITY_STATES } from '@/lib/contracts/states'
import type {
  ActionSafetyLevel,
  AutopilotActionOutcome,
  AutopilotCapabilityState,
  AutopilotDisposition,
  AutopilotRunMode,
} from '@/lib/contracts/states'
import {
  noteIsRequiredFor,
  trialEndIsRequiredFor,
  type CapabilityDivergence,
} from '@/lib/platform/autopilot'

import type { CapabilityStateOption } from '../_components/capability-control'

/**
 * Hebrew for the Autopilot console's enums.
 *
 * Display only, and the same rule as `src/components/platform/labels.ts`:
 * nothing on these screens decides anything from a label. The codes are what
 * the guard, the policies and the operation compare, and the two are kept
 * apart so that rewording a screen can never change what it is allowed to do.
 *
 * Every map is a total `Record<T, string>` rather than a lookup with a
 * fallback, so adding a member to the union fails the build here instead of
 * printing an English enum in the middle of a Hebrew sentence.
 *
 * The one exception is `SUPPRESSION_REASON_LABEL`, and it is deliberate:
 * `suppressed_reason` is a text column, not an enum, precisely so the
 * diagnostic vocabulary can grow without a migration. A reason this file has
 * not heard of is shown as its own code — which is honest — rather than as
 * "אחר", which would hide the fact that the vocabulary moved.
 */

export const CAPABILITY_STATE_LABEL: Record<AutopilotCapabilityState, string> =
  {
    not_available: 'לא מוצע',
    eligible: 'זכאי, לא הופעל',
    trial: 'בהתנסות',
    enabled: 'פעיל',
    suspended: 'מושהה',
    disabled: 'מבוטל',
  }

/** What each state means for the customer, in one sentence. */
export const CAPABILITY_STATE_MEANING: Record<
  AutopilotCapabilityState,
  string
> = {
  not_available:
    'לא הוצע ללקוח הזה. זו ברירת המחדל של רוב הלקוחות, ואינה סירוב.',
  eligible: 'אפשר להציע להם. ההרשאה עדיין לא ניתנה, והמוצר לא מציג את היכולת.',
  trial: 'רצים על התנסות תחומה בזמן. בסיום התאריך ההרשאה עדיין תהיה בתוקף.',
  enabled: 'רצים. ההרשאה autopilot קיימת במנוי, וזה מה שהמוצר קורא.',
  suspended:
    'ESTIA שללה את היכולת, בדרך כלל אחרי אירוע בטיחות. הפיך, וההערה חובה.',
  disabled: 'נשללה ולא חוזרת בלי החלטה חדשה. ההערה חובה.',
}

export const DIVERGENCE_LABEL: Record<CapabilityDivergence, string> = {
  aligned: 'תואם',
  entitlement_missing: 'רשום, בלי הרשאה',
  entitlement_lingering: 'הרשאה נשארה',
}

export const ACTION_OUTCOME_LABEL: Record<AutopilotActionOutcome, string> = {
  planned: 'תוכננה',
  awaiting_approval: 'ממתינה לאישור',
  approved: 'אושרה',
  executed: 'בוצעה',
  executed_unaudited: 'בוצעה ללא רישום ביקורת',
  failed: 'נכשלה',
  retrying: 'בניסיון חוזר',
  needs_review: 'דורשת בדיקה',
  suppressed: 'נמנעה',
  simulated: 'סימולציה',
  cancelled: 'בוטלה',
}

export const DISPOSITION_LABEL: Record<AutopilotDisposition, string> = {
  off: 'כבוי',
  suggest: 'הצעה',
  ask_approval: 'דורש אישור',
  auto: 'אוטומטי',
}

export const SAFETY_LEVEL_LABEL: Record<ActionSafetyLevel, string> = {
  information: 'מידע',
  safe_internal: 'פנימי בטוח',
  external_communication: 'תקשורת החוצה',
  business_impact: 'השפעה עסקית',
  money_access_cancellation: 'כסף, כניסה או ביטול',
}

export const RUN_MODE_LABEL: Record<AutopilotRunMode, string> = {
  live: 'אמיתי',
  simulation: 'סימולציה',
}

const SUPPRESSION_REASON_LABEL: Readonly<Record<string, string>> = {
  level_too_low: 'הרמה שנבחרה נמוכה מדי',
  policy_off: 'המדיניות כבויה לפעולה הזו',
  safety_level_forbidden: 'רמת הבטיחות אוסרת',
  platform_rule: 'כלל בטיחות של הפלטפורמה',
  module_disabled: 'המודול כבוי',
  missing_permission: 'חסרה הרשאה',
  missing_entitlement: 'החבילה אינה כוללת',
  quiet_hours: 'שעות שקטות',
  paused: 'מושהה זמנית',
  kill_switch: 'מתג הכיבוי',
  low_confidence: 'ביטחון נמוך',
  booking_manual_only: 'ההזמנה סומנה לטיפול ידני',
  property_override: 'הנכס הוגדר נמוך יותר',
  simulation: 'סימולציה',
  duplicate: 'כפילות',
}

export function suppressionReasonLabel(code: string | null): string {
  if (!code) return '—'
  return SUPPRESSION_REASON_LABEL[code] ?? code
}

/**
 * The Hebrew name of an action kind, from the catalogue.
 *
 * A kind the catalogue no longer carries is shown as its raw code rather than
 * hidden. `actionSpec()` returns `null` for exactly that case, and a stale row
 * is a thing to notice, not a thing to render as blank.
 */
export function actionKindLabel(kind: string): string {
  return actionSpec(kind)?.label ?? kind
}

/** A percentage, or the honest absence of one. */
export function percentage(rate: number | null): string {
  if (rate === null) return '—'
  return `${Math.round(rate * 100)}%`
}

/**
 * The options the state control offers, with the rules attached.
 *
 * Built here rather than inside the client component so that which states
 * demand a note and which demand an end date is decided by
 * `noteIsRequiredFor()` and `trialEndIsRequiredFor()` — the same two functions
 * the operation's `rule` calls before it writes anything — and carried to the
 * browser as plain booleans. There is no second copy of the rule in the form,
 * so the browser's refusal and the server's cannot drift apart.
 */
export function capabilityStateOptions(): readonly CapabilityStateOption[] {
  return AUTOPILOT_CAPABILITY_STATES.map((state) => ({
    value: state,
    label: CAPABILITY_STATE_LABEL[state],
    meaning: CAPABILITY_STATE_MEANING[state],
    noteRequired: noteIsRequiredFor(state),
    trialEndRequired: trialEndIsRequiredFor(state),
  }))
}
