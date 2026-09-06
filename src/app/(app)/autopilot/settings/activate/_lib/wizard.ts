/**
 * The activation wizard's steps, and the choices carried between them.
 *
 * ── Why the state lives in the URL ───────────────────────────────────────
 *
 * Eight steps, each a link, each a full server render. No client component, no
 * store, no `useState`, and — the part that matters — no half-finished
 * configuration held in a browser tab that a reload silently discards. The URL
 * IS the state, so a person can close the laptop at step five, reopen the link
 * tomorrow, and be exactly where they were; and the review step can be shared
 * with whoever actually holds `autopilot.configure`, which on a real
 * guesthouse is very often somebody else.
 *
 * ── Every choice is validated back into a vocabulary ─────────────────────
 *
 * `parseLevel` and `parseRunMode` map a query parameter onto a member of a
 * tuple and fall back to the timid default. Nothing from the browser is
 * carried as text into a preview that says "this is what will be written":
 * a typo would otherwise render an authoritative-looking sentence about a
 * level that does not exist.
 *
 * ── The defaults are the migration's, not this file's opinion ────────────
 *
 * A wizard that opened on `autopilot` and `live` would be a wizard that
 * nudges. 0046 defaults an unconfigured organization to `off` and
 * `simulation`, and says why: a customer whose entitlement was granted this
 * morning must not wake up to messages having been sent overnight. The wizard
 * opens where the database already is.
 *
 * Pure: no database, no clock, no authorization. Every function here takes
 * strings and returns strings, which is what makes the whole flow testable
 * without rendering a page.
 */

import {
  AUTOPILOT_LADDER,
  AUTOPILOT_RUN_MODES,
  type AutopilotLevel,
  type AutopilotRunMode,
} from '@/lib/contracts/states'

export const WIZARD_STEPS = [
  'level',
  'modules',
  'actions',
  'approvals',
  'properties',
  'notifications',
  'simulation',
  'confirm',
] as const

export type WizardStep = (typeof WIZARD_STEPS)[number]

export const STEP_TITLE: Record<WizardStep, string> = {
  level: 'רמת האוטומציה',
  modules: 'אילו תחומים ESTIA תשגיח עליהם',
  actions: 'הפעולות שייכללו',
  approvals: 'מי מאשר',
  properties: 'אילו נכסים',
  notifications: 'מתי לעדכן אותך',
  simulation: 'סימולציה לפני הפעלה',
  confirm: 'אישור',
}

export const STEP_LEAD: Record<WizardStep, string> = {
  level:
    'כמה מהעבודה ESTIA תעשה לבד. כל רמה מכילה את זו שלפניה, ואפשר לעלות בהדרגה.',
  modules:
    'ESTIA משגיחה רק על מה שהעסק שלכם באמת מפעיל. מודול שאינו בחבילה לא יוזכר, ולא תקבלו הצעה לשריין מגבות ממלאי שאינו קיים.',
  actions:
    'מה בדיוק ESTIA רשאית לעשות, לפי רמת הנזק אם היא טועה. חלק מהשורות חסומות מלמעלה ואי אפשר לפתוח אותן בשום חבילה.',
  approvals:
    'פעולה שדורשת אישור מחכה לאדם. כדאי לוודא שיש מי שיאשר, אחרת היא פשוט תמתין.',
  properties:
    'אפשר להתחיל בנכס אחד. נכס יכול לשבת נמוך מהארגון, ולעולם לא גבוה ממנו.',
  notifications:
    'סיכום בוקר, סיכום ערב, ומה נחשב דחוף מספיק כדי להפריע באמצע היום.',
  simulation:
    'שבועיים שבהם ESTIA רושמת מה הייתה עושה ולא עושה דבר. זו לא בדיקה טכנית — זו הדרך להפעיל.',
  confirm:
    'מה ייכתב, בדיוק. כלום לא נשמר עד שלוחצים, ובמצב הנוכחי גם אז לא — ראו ההערה למטה.',
}

export function parseStep(value: string | null): WizardStep {
  return value !== null && (WIZARD_STEPS as readonly string[]).includes(value)
    ? (value as WizardStep)
    : 'level'
}

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step)
}

export function nextStep(step: WizardStep): WizardStep | null {
  return WIZARD_STEPS[stepIndex(step) + 1] ?? null
}

export function previousStep(step: WizardStep): WizardStep | null {
  const index = stepIndex(step)
  return index === 0 ? null : (WIZARD_STEPS[index - 1] ?? null)
}

/** The four rungs, never `custom` — the matrix is a different conversation. */
export function parseLevel(value: string | null): AutopilotLevel {
  return value !== null &&
    (AUTOPILOT_LADDER as readonly string[]).includes(value)
    ? (value as AutopilotLevel)
    : 'off'
}

export function parseRunMode(value: string | null): AutopilotRunMode {
  return value !== null &&
    (AUTOPILOT_RUN_MODES as readonly string[]).includes(value)
    ? (value as AutopilotRunMode)
    : 'simulation'
}

export type WizardChoices = {
  level: AutopilotLevel
  runMode: AutopilotRunMode
}

/**
 * A link to one step, carrying the choices made so far.
 *
 * Built rather than concatenated so a value containing a reserved character
 * cannot break the URL, and so adding a choice is one line here rather than
 * eight template strings across the page.
 */
export function stepHref(
  step: WizardStep,
  choices: WizardChoices,
  overrides: Partial<WizardChoices> = {},
): string {
  const merged = { ...choices, ...overrides }
  const params = new URLSearchParams({
    step,
    level: merged.level,
    mode: merged.runMode,
  })
  return `/autopilot/settings/activate?${params.toString()}`
}
