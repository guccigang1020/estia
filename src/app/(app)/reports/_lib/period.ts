/**
 * The reporting window, as a pure function of the URL.
 *
 * Same reasoning as `bookings/_lib/filters.ts`: a report is a thing people
 * send each other ("look at August for וילה הגליל"), and a period held in
 * component state produces a link that opens on somebody else's screen showing
 * a different month. So the window lives in the query string.
 *
 * ── Nothing here computes a figure ────────────────────────────────────────
 *
 * Every date this file produces is built with `addMonths` from
 * `src/lib/metrics/periods.ts`, which is the same arithmetic the comparison
 * uses. Writing `new Date(year, month + 1, 1)` here would be a second calendar
 * implementation, and the first thing it would get wrong is the clamp that
 * makes 31 March minus one month land on 28 February rather than 3 March.
 *
 * The one judgement this file makes is which window to show when the URL says
 * nothing: the calendar month that contains today, at the property's own
 * timezone. A report that opened on "the last thirty days" would never be
 * comparable against the previous period the way a month is, and
 * `isWholeCalendarMonth` is what unlocks that comparison.
 */

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { localDate } from '@/lib/booking/dates'
import { isIsoDate } from '@/lib/booking/dates'
import {
  addMonths,
  isWholeCalendarMonth,
  type ComparisonMode,
  type MetricRange,
} from '@/lib/metrics'

export const REPORT_PARAM_KEYS = {
  from: 'from',
  to: 'to',
  compare: 'compare',
} as const

/** The three modes `comparisonRange` understands, offered as a control. */
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

export type ReportPeriod = {
  range: MetricRange
  comparison: ComparisonMode
  /** True when the window came from the URL rather than from the default. */
  explicit: boolean
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/**
 * The calendar month containing this instant, half-open.
 *
 * `[2026-08-01, 2026-09-01)`. The end is the first of the next month and is
 * *outside* the window, which is the same convention a stay uses — see
 * `MetricRange`. A closed range would count the first of September as an
 * August night and make every monthly report disagree with the calendar by
 * one.
 */
export function monthContaining(now: Date): MetricRange {
  const start = `${localDate(now).slice(0, 7)}-01`
  return { start, end: addMonths(start, 1) }
}

/**
 * The window and the comparison the URL asks for.
 *
 * A `from` or `to` that is not an ISO date, or a window that is reversed or
 * empty, falls back to the default month rather than reaching the domain —
 * `assertValidRange` would throw on it, and an error page is the wrong answer
 * to a hand-edited address bar. `periodIssue` is what tells the person their
 * dates were ignored.
 */
export function parseReportPeriod(
  params: SearchParams,
  now: Date = new Date(),
): ReportPeriod {
  const rawFrom = first(params[REPORT_PARAM_KEYS.from])
  const rawTo = first(params[REPORT_PARAM_KEYS.to])
  const rawCompare = first(params[REPORT_PARAM_KEYS.compare])

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

/**
 * Why the requested window was ignored, or `null`.
 *
 * Said out loud on the screen. A report that silently substitutes a different
 * month for the one somebody typed is a report they will quote in a meeting.
 */
export function periodIssue(params: SearchParams): string | null {
  const rawFrom = first(params[REPORT_PARAM_KEYS.from])
  const rawTo = first(params[REPORT_PARAM_KEYS.to])

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
 * A whole calendar month is named as a month — "אוגוסט 2026" — because that is
 * what the person chose and reading "1.8.2026 – 1.9.2026" back to them invites
 * the question of whether the first of September is included. Anything else is
 * spelled as its two ends, with the end shown as the last night rather than
 * the exclusive boundary, for the same reason.
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

/** The query string for a window, so a link can carry it. */
export function periodQuery(
  range: MetricRange,
  comparison: ComparisonMode,
): string {
  const params = new URLSearchParams({
    [REPORT_PARAM_KEYS.from]: range.start,
    [REPORT_PARAM_KEYS.to]: range.end,
    [REPORT_PARAM_KEYS.compare]: comparison,
  })
  return `?${params.toString()}`
}
