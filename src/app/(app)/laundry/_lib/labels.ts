/**
 * Hebrew for the laundry screens, and the two vocabularies that live here
 * rather than in the engine.
 *
 * ── The weekday names and the forecast horizons ───────────────────────────
 *
 * Both are presentation, and both are here for the same stated reason:
 * `src/lib/laundry/no-hardcoded-numbers.test.ts` admits no non-structural
 * literal in the engine, the length of a week and the four horizons the
 * product offers are numbers, and the honest place for a number that is about
 * what the product offers rather than about arithmetic is the screen and the
 * migration. `0029_laundry.sql` carries the same four in a check constraint,
 * so the database and this list agree by construction rather than by memory.
 *
 * The engine itself accepts any positive horizon, which is asserted over a
 * random draw in that same test. Nothing here narrows what it can do; it
 * narrows what a person is offered.
 */

import type {
  LaundryChannel,
  LaundryDispatchMode,
  LaundryMode,
  LaundryRoute,
  LaundryStatus,
} from '@/lib/laundry'

/** ISO weekday numbers, 1 = Monday .. 7 = Sunday. */
export const WEEKDAY_LABEL: Readonly<Record<number, string>> = {
  1: 'שני',
  2: 'שלישי',
  3: 'רביעי',
  4: 'חמישי',
  5: 'שישי',
  6: 'שבת',
  7: 'ראשון',
}

/** "ראשון, רביעי" — or an honest sentence when nobody has said. */
export function weekdays(days: readonly number[]): string {
  if (days.length === 0) return 'לא הוגדר'
  return [...days]
    .sort((a, b) => a - b)
    .map((day) => WEEKDAY_LABEL[day] ?? String(day))
    .join(', ')
}

/**
 * The horizons the forecast screen offers.
 *
 * Mirrors `laundry_settings_horizon_offered` in 0029. A fifth value added here
 * and not there would be refused by the database on save, which is the right
 * failure — loud, immediate, and on the screen that tried it.
 */
export const FORECAST_HORIZONS: readonly number[] = [3, 7, 14, 30]

export function horizonLabel(days: number): string {
  return `${days} ימים`
}

/** Clamp a horizon from a query string to something the product offers. */
export function readHorizon(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return FORECAST_HORIZONS.includes(parsed) ? parsed : fallback
}

// ── Vocabularies ──────────────────────────────────────────────────────────

export const STATUS_LABEL: Readonly<Record<LaundryStatus, string>> = {
  draft: 'טיוטה',
  awaiting_approval: 'ממתין לאישור',
  to_collect: 'ממתין לאיסוף',
  collected: 'נאסף',
  sorting: 'במיון',
  washing: 'בכביסה',
  drying: 'בייבוש',
  folding: 'בקיפול',
  ready: 'מוכן',
  delivered_to_property: 'הגיע לנכס',
  completed: 'הושלם',
  cancelled: 'בוטל',
}

/**
 * The same lifecycle, said the way a one-person operation would say it.
 *
 * `internal` and `simple` businesses have no van and no company, so "ממתין
 * לאיסוף" describes something that does not happen to them. The states are
 * the frozen ones either way — this is only what they are called on screen.
 */
export const INTERNAL_STATUS_LABEL: Readonly<Record<LaundryStatus, string>> = {
  ...STATUS_LABEL,
  to_collect: 'ממתין',
  collected: 'התחיל',
  delivered_to_property: 'חזר למקום',
}

export function statusLabel(status: LaundryStatus, mode: LaundryMode): string {
  return mode === 'external' || mode === 'hybrid'
    ? STATUS_LABEL[status]
    : INTERNAL_STATUS_LABEL[status]
}

export const MODE_LABEL: Readonly<Record<LaundryMode, string>> = {
  off: 'כבוי',
  simple: 'רשימה בלבד',
  internal: 'כביסה עצמית',
  external: 'מכבסה חיצונית',
  hybrid: 'משולב',
}

export const ROUTE_LABEL: Readonly<Record<LaundryRoute, string>> = {
  internal: 'בבית',
  external: 'במכבסה',
}

export const CHANNEL_LABEL: Readonly<Record<LaundryChannel, string>> = {
  whatsapp: 'וואטסאפ',
  sms: 'מסרון',
  email: 'דוא״ל',
  print: 'הדפסה',
  export: 'ייצוא',
  copy: 'העתקה',
}

export const DISPATCH_LABEL: Readonly<Record<LaundryDispatchMode, string>> = {
  manual_send: 'שליחה ידנית',
  approval_required: 'דורש אישור לפני שליחה',
  auto_send: 'שליחה אוטומטית',
}

/** Where the configuration in force came from, said plainly. */
export const SOURCE_LABEL: Readonly<
  Record<'property' | 'organization' | 'default', string>
> = {
  property: 'הגדרה ייעודית לנכס הזה',
  organization: 'הגדרת ברירת המחדל של הארגון',
  default: 'לא הוגדר דבר — המודול כבוי',
}

// ── Dates ─────────────────────────────────────────────────────────────────

const DATE = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem',
  day: 'numeric',
  month: 'short',
})

const DATE_TIME = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

const WEEKDAY = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem',
  weekday: 'long',
})

export function shortDate(instant: string): string {
  const at = new Date(instant)
  return Number.isNaN(at.getTime()) ? instant : DATE.format(at)
}

export function dateAndTime(instant: string): string {
  const at = new Date(instant)
  return Number.isNaN(at.getTime()) ? instant : DATE_TIME.format(at)
}

export function weekdayOf(instant: string): string {
  const at = new Date(instant)
  return Number.isNaN(at.getTime()) ? '' : WEEKDAY.format(at)
}

/** "היום", "מחר", "לפני יומיים" — the words a person actually uses. */
export function relativeDay(instant: string, now: Date): string {
  const at = new Date(instant)
  if (Number.isNaN(at.getTime())) return instant

  const days = Math.round(
    (Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) -
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) /
      86_400_000,
  )

  if (days === 0) return 'היום'
  if (days === 1) return 'מחר'
  if (days === -1) return 'אתמול'
  if (days > 0) return `בעוד ${days} ימים`
  return `לפני ${Math.abs(days)} ימים`
}
