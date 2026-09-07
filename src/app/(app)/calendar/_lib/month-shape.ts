/**
 * EXECUTION CONTEXT — PURE. No I/O, no clock, no Supabase.
 *
 * The month grid, counted.
 *
 * ── WHY THIS IS ALLOWED TO EXIST AT ALL ───────────────────────────────────
 *
 * `page.tsx` says, in its own header, that no number on the calendar was
 * invented — no occupancy percentage, no "X nights sold". That was true and it
 * stays true: this file invents nothing either. It counts cells that the
 * availability engine has already decided, in a grid the reader is looking at.
 * Every figure here is answerable by pointing at the screen and counting, which
 * is exactly the property a fabricated metric does not have.
 *
 * That also fixes the scope. These are figures about THE VISIBLE MONTH AND THE
 * VISIBLE UNITS — not about the business. `/revenue` is where a business-wide
 * occupancy lives, with a denominator built from active units and a window that
 * excludes today's unfinished night. Nothing here should ever be quoted as the
 * business's occupancy, and the wording on screen says so.
 *
 * ── THE DENOMINATOR IS SELLABLE NIGHTS, NOT ALL NIGHTS ────────────────────
 *
 * A blocked night was never for sale: a unit out of service, a closure, a
 * maintenance window. Counting it in the denominator reports a failure to sell
 * something that was not on the shelf — the same argument `/revenue` makes when
 * it drops units in maintenance from its own denominator, and the same answer,
 * so that the two screens cannot contradict each other in principle.
 *
 * When every night in view is blocked there is no denominator, and occupancy is
 * `null` rather than 0. A month showing 0% for a villa that was closed for
 * renovation is a lie that reads as a catastrophe.
 *
 * ── OCCUPIED MEANS "NOT OPEN", AND NOT "SOLD" ─────────────────────────────
 *
 * The grid mixes two vocabularies on purpose. A reader entitled to the internal
 * diary sees `booked` and `held` apart; a reader who is not sees `unavailable`,
 * which is deliberately the two of them collapsed so that an external seller
 * cannot learn a rival is mid-deal. A single grid can hold both, because
 * `unit.detailed` is decided per unit.
 *
 * So there is no honest month-wide count of *sold* nights available from these
 * cells, and this file does not pretend otherwise. It counts nights that are
 * not open, which is the one question both vocabularies answer the same way,
 * and the label on screen is "תפוסים" and never "נמכרו". Holds are reported
 * separately, and `held.known` goes false the moment any row in view is the
 * collapsed kind — a partial count of holds is worse than none, because it
 * would be believed.
 */

import type { CalendarDayState } from '@/components/calendar/state-meta'

import type { UnitMonth } from './availability'

/** Holds, or the reason there is no count of them. */
export type HeldNights =
  { readonly known: true; readonly count: number } | { readonly known: false }

export interface MonthShape {
  /** Units in the grid — rows, not the organization's inventory. */
  readonly units: number
  /** Cells in the grid: units × nights in the month. */
  readonly cells: number
  /** Cells that were on the shelf. Zero when everything in view is blocked. */
  readonly sellable: number
  /** Sellable cells that are not open. Booked, held, or collapsed. */
  readonly occupied: number
  /** Sellable cells still open for sale. */
  readonly free: number
  /** Cells that were never for sale, and are outside the denominator. */
  readonly blocked: number
  /**
   * Holds, when the whole grid is the detailed vocabulary. `known: false` as
   * soon as one row is the collapsed one — see the header.
   */
  readonly held: HeldNights
  /**
   * `occupied / sellable`, or null when nothing in view was sellable.
   *
   * A fraction in 0..1 — the caller multiplies for a percentage, and `Dial`
   * takes the fraction directly.
   */
  readonly occupancy: number | null
}

/** States that were never on the shelf, and so are not in the denominator. */
const NOT_FOR_SALE: ReadonlySet<CalendarDayState> = new Set(['blocked'])

/** States that mean the night is still open. */
const OPEN: ReadonlySet<CalendarDayState> = new Set(['free'])

/**
 * Count the grid the reader is looking at.
 *
 * Deliberately takes the rendered rows rather than re-reading anything: if the
 * grid and this row of figures could ever disagree, the figures would be the
 * ones believed, and they would be describing a different month.
 */
export function monthShape(rows: readonly UnitMonth[]): MonthShape {
  let cells = 0
  let blocked = 0
  let free = 0
  let held = 0
  let collapsedSeen = false

  for (const row of rows) {
    for (const day of row.days) {
      cells += 1
      if (NOT_FOR_SALE.has(day.state)) blocked += 1
      else if (OPEN.has(day.state)) free += 1
      if (day.state === 'held') held += 1
      if (day.state === 'unavailable') collapsedSeen = true
    }
  }

  const sellable = cells - blocked
  const occupied = sellable - free

  return {
    units: rows.length,
    cells,
    sellable,
    occupied,
    free,
    blocked,
    held: collapsedSeen ? { known: false } : { known: true, count: held },
    // Not `fractionOf` from the gauge kit: this module is about counting and
    // has no business importing a drawing helper. The guard is the same one —
    // a zero denominator is null and never 0.
    occupancy: sellable > 0 ? occupied / sellable : null,
  }
}

/** `0.4137` → `41`. Rounded down, so a month is never reported fuller than it is. */
export function occupancyPercent(fraction: number | null): number | null {
  return fraction === null ? null : Math.floor(fraction * 100)
}
