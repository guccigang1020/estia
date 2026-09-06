/**
 * The windows a screen offers, computed from one clock reading.
 *
 * ══ THE WINDOW ENDS TODAY AND DOES NOT INCLUDE IT ═══════════════════════════
 *
 * Tonight has not happened yet. A window that runs up to and including today
 * counts a night that is still ahead as sold or unsold, and either way it is
 * a guess about the future sitting inside a report about the past. The window
 * is half-open — `to` is the first day NOT counted — which is the same shape
 * as a stay, so a booking that checks out today contributes its last night and
 * a booking that checks in today contributes nothing yet.
 *
 * ══ FORWARD WINDOWS ARE A DIFFERENT QUESTION AND NOT THIS ONE ═══════════════
 *
 * "How full is next month" is a pace question, not a revenue one: nights not
 * yet sold are still sellable, so reporting 20% occupancy for December in
 * September is not a fact about performance. This module only looks backwards,
 * and a forward view belongs to whoever builds the pace screen.
 */

import type { Window } from './types'

export type WindowName = '30d' | '90d' | '365d'

export const WINDOW_NIGHTS: Readonly<Record<WindowName, number>> =
  Object.freeze({ '30d': 30, '90d': 90, '365d': 365 })

export const WINDOW_LABEL: Readonly<Record<WindowName, string>> = Object.freeze(
  { '30d': '30 ימים אחרונים', '90d': '90 ימים אחרונים', '365d': 'שנה אחרונה' },
)

export function isWindowName(value: unknown): value is WindowName {
  return value === '30d' || value === '90d' || value === '365d'
}

const MS_PER_DAY = 86_400_000
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/**
 * `today` is passed in rather than read here, so every test states its own
 * clock and no figure on this screen depends on when the suite ran.
 */
export function windowFor(name: WindowName, today: Date): Window {
  const end = Date.parse(`${iso(today.getTime())}T00:00:00Z`)
  return { from: iso(end - WINDOW_NIGHTS[name] * MS_PER_DAY), to: iso(end) }
}
