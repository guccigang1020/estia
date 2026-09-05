/**
 * The window this screen is looking at, as a pure function of the URL.
 *
 * Same reasoning as `reports/_lib/period.ts`, and written here rather than
 * imported from it for the reason `gate.ts` gives about crossing a screen
 * group's `_lib`. What is *not* duplicated is the arithmetic: every date below
 * is produced by `addMonths` from `src/lib/metrics/periods.ts`, which is the
 * same function the comparison engine uses. A local `new Date(year, month + 1)`
 * would be a second calendar, and the first thing it would get wrong is the
 * clamp that makes 31 March minus one month land on 28 February.
 *
 * ── An insight is a link somebody sends ───────────────────────────────────
 *
 * "Look at what happened in August" is the whole point of this screen, so the
 * window lives in the query string and never in component state. A period held
 * in state produces a link that opens on somebody else's screen showing a
 * different month, and they will quote the wrong one in a meeting.
 */

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { isIsoDate, localDate } from '@/lib/booking/dates'
import {
  addMonths,
  isWholeCalendarMonth,
  type ComparisonMode,
  type MetricRange,
} from '@/lib/metrics'

export const INSIGHT_PARAM_KEYS = {
  from: 'from',
  to: 'to',
  compare: 'compare',
} as const

/**
 * The comparison modes offered.
 *
 * `none` is deliberately included even though a trend needs a baseline: an
 * insight screen with the comparison switched off is honest — it stops
 * claiming directions and says so — and hiding the option would leave somebody
 * who wants a single month with no way to ask for one.
 */
export const COMPARISON_MODES: readonly ComparisonMode[] = [
  'previous_period',
  'previous_year',
  'none',
]

export const COMPARISON_LABEL: Readonly<Record<ComparisonMode, string>> = {
  previous_period: 'מול התקופה הקודמת',
  previous_year: 'מול אשתקד',
  none: 'ללא השוואה',
}

export type InsightPeriod = {
  range: MetricRange
  comparison: ComparisonMode
  /** True when the window came from the URL rather than from the default. */
  explicit: boolean
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/** The calendar month containing this instant, half-open: `[1.8, 1.9)`. */
export function monthContaining(now: Date): MetricRange {
  const start = `${localDate(now).slice(0, 7)}-01`
  return { start, end: addMonths(start, 1) }
}

/**
 * The window and the comparison the URL asks for.
 *
 * A malformed or reversed range falls back to the default month rather than
 * reaching the domain, where `assertValidRange` would throw — an error page is
 * the wrong answer to a hand-edited address bar. `periodIssue` is what tells
 * the person their dates were ignored, because a screen that silently
 * substitutes a different month is a screen they will quote.
 *
 * The default comparison is `previous_period`, so the screen opens able to say
 * something about direction. That is the difference between this screen and a
 * report: a report is happy to state one month, an insight mostly is not.
 */
export function parseInsightPeriod(
  params: SearchParams,
  now: Date = new Date(),
): InsightPeriod {
  const rawFrom = first(params[INSIGHT_PARAM_KEYS.from])
  const rawTo = first(params[INSIGHT_PARAM_KEYS.to])
  const rawCompare = first(params[INSIGHT_PARAM_KEYS.compare])

  const comparison = (COMPARISON_MODES as readonly string[]).includes(
    rawCompare ?? '',
  )
    ? (rawCompare as ComparisonMode)
    : 'previous_period'

  if (
    rawFrom !== null &&
    rawTo !== null &&
    isIsoDate(rawFrom) &&
    isIsoDate(rawTo) &&
    rawFrom < rawTo
  ) {
    return { range: { start: rawFrom, end: rawTo }, comparison, explicit: true }
  }

  return { range: monthContaining(now), comparison, explicit: false }
}

/** Why the requested window was ignored, or `null`. Said out loud on screen. */
export function periodIssue(params: SearchParams): string | null {
  const rawFrom = first(params[INSIGHT_PARAM_KEYS.from])
  const rawTo = first(params[INSIGHT_PARAM_KEYS.to])

  if (rawFrom === null && rawTo === null) return null
  if (rawFrom === null || rawTo === null) {
    return 'טווח דורש תאריך התחלה ותאריך סיום. הוצג החודש הנוכחי.'
  }
  if (!isIsoDate(rawFrom) || !isIsoDate(rawTo)) {
    return 'אחד התאריכים אינו תקין. הוצג החודש הנוכחי.'
  }
  if (rawFrom >= rawTo) {
    return 'תאריך הסיום אינו מאוחר מתאריך ההתחלה, ולכן אין תקופה למדוד. הוצג החודש הנוכחי.'
  }
  return null
}

/**
 * The window, in words.
 *
 * A whole calendar month is named as a month, because that is what the person
 * chose and reading "1.8.2026 – 1.9.2026" back to them invites the question of
 * whether the first of September is included.
 */
export function describePeriod(range: MetricRange): string {
  if (isWholeCalendarMonth(range)) {
    return new Intl.DateTimeFormat('he-IL', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${range.start}T00:00:00Z`))
  }

  return `${hebrewDate(range.start)} – ${hebrewDate(range.end)}`
}

function hebrewDate(value: string): string {
  return new Intl.DateTimeFormat('he-IL', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`))
}

/** The months offered in the picker, newest first. */
export function recentMonths(
  now: Date,
  count = 13,
): readonly { range: MetricRange; label: string }[] {
  const current = monthContaining(now)
  const months: { range: MetricRange; label: string }[] = []

  for (let back = 0; back < count; back += 1) {
    const start = addMonths(current.start, -back)
    const range = { start, end: addMonths(start, 1) }
    months.push({ range, label: describePeriod(range) })
  }

  return months
}
