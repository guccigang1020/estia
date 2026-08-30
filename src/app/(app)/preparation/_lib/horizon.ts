/**
 * The window the preparation board covers, as a pure function of the URL.
 *
 * Same reasoning as the bookings filter and the report period: a board is a
 * thing people send each other ("look at the weekend"), and a window held in
 * component state produces a link that opens on somebody else's screen showing
 * different days.
 *
 * ── Why it opens on yesterday and not on today ────────────────────────────
 *
 * A departure clean that did not finish yesterday is the single most expensive
 * thing to hide from a board, because the unit it belongs to has an arrival
 * today. Starting the window at today would show the arrival and not the
 * reason it is not ready. One day of look-back is the cheapest version of that
 * and is why the default is `[today − 1, today + 7)` rather than a week from
 * now.
 *
 * Half-open, `[from, to)`, matching every other range in the product: the last
 * day named is *outside* the window, so two consecutive weeks neither overlap
 * nor leave a gap.
 */

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { addDays, isIsoDate, localDate } from '@/lib/booking/dates'

export const HORIZON_PARAM_KEYS = { from: 'from', to: 'to' } as const

/** How far back the board looks by default, in days. */
export const DEFAULT_LOOK_BACK = 1

/** How far ahead, in days. A week is what a rota is planned over. */
export const DEFAULT_LOOK_AHEAD = 7

export type Horizon = {
  /** Property-local ISO date, inclusive. */
  from: string
  /** Property-local ISO date, exclusive. */
  to: string
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/** The default window, anchored on the property's calendar date. */
export function defaultHorizon(now: Date = new Date()): Horizon {
  const today = localDate(now)
  return {
    from: addDays(today, -DEFAULT_LOOK_BACK),
    to: addDays(today, DEFAULT_LOOK_AHEAD + 1),
  }
}

/**
 * The window the URL asks for, or the default.
 *
 * A malformed or reversed window falls back rather than reaching the query: a
 * reversed range matches nothing, and a board that silently renders empty for
 * it is indistinguishable from a day with no work. `horizonIssue` is what
 * tells the person their dates were ignored.
 */
export function parseHorizon(
  params: SearchParams,
  now: Date = new Date(),
): Horizon {
  const rawFrom = first(params[HORIZON_PARAM_KEYS.from])
  const rawTo = first(params[HORIZON_PARAM_KEYS.to])

  if (
    rawFrom !== null &&
    rawTo !== null &&
    isIsoDate(rawFrom) &&
    isIsoDate(rawTo) &&
    rawFrom < rawTo
  ) {
    return { from: rawFrom, to: rawTo }
  }

  return defaultHorizon(now)
}

/** True when the person narrowed the board themselves. */
export function isCustomHorizon(
  horizon: Horizon,
  now: Date = new Date(),
): boolean {
  const fallback = defaultHorizon(now)
  return horizon.from !== fallback.from || horizon.to !== fallback.to
}

/** Why the requested window was ignored, or `null`. */
export function horizonIssue(params: SearchParams): string | null {
  const rawFrom = first(params[HORIZON_PARAM_KEYS.from])
  const rawTo = first(params[HORIZON_PARAM_KEYS.to])

  if (rawFrom === null && rawTo === null) return null
  if (rawFrom === null || rawTo === null) {
    return 'טווח דורש תאריך התחלה ותאריך סיום. הוצג הטווח הרגיל.'
  }
  if (!isIsoDate(rawFrom) || !isIsoDate(rawTo)) {
    return 'אחד התאריכים אינו תקין. הוצג הטווח הרגיל.'
  }
  if (rawFrom >= rawTo) {
    return 'תאריך הסיום אינו מאוחר מתאריך ההתחלה, ולכן אין ימים להציג. הוצג הטווח הרגיל.'
  }
  return null
}

/** The window, in words: `29.8.2026 – 5.9.2026`. */
export function describeHorizon(horizon: Horizon): string {
  return `${hebrewDate(horizon.from)} – ${hebrewDate(addDays(horizon.to, -1))}`
}

function hebrewDate(value: string): string {
  return new Intl.DateTimeFormat('he-IL', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`))
}
