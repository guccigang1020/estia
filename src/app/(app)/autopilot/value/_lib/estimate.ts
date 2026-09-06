/**
 * EXECUTION CONTEXT — SERVER ONLY. An ESTIMATE, and it says so everywhere.
 *
 * ══ THIS IS NOT MEASURED TIME ════════════════════════════════════════════
 *
 * ESTIA has never timed anybody sending a payment reminder. Nothing in the
 * database records how long a task took a human who did not do it. What this
 * module produces is a COUNT of actions multiplied by a per-action ASSUMPTION
 * written below, and the screen must present it as exactly that: the figure,
 * the coefficient, and the arithmetic, so a manager who thinks a reminder
 * takes one minute rather than four can do the sum themselves and disagree
 * with the right number.
 *
 * The alternative — "ESTIA saved you 14 hours this month" with no method — is
 * a number somebody repeats to their accountant, and `dashboard/page.tsx`
 * refuses to open with those for the same reason. A value screen that cannot
 * be argued with is a value screen nobody believes twice.
 *
 * ── Only what actually happened is counted ───────────────────────────────
 *
 * `executed` and `executed_unaudited` only. A `simulated` action saved nobody
 * anything — that is the whole point of simulation — and a `suppressed` action
 * is ESTIA correctly declining, which is valuable and is NOT time saved.
 * Counting either would inflate the figure with the two outcomes a customer is
 * most likely to have a lot of in their first fortnight, which is precisely
 * when they are deciding whether to believe the screen.
 *
 * ── Where the coefficients come from ─────────────────────────────────────
 *
 * They are stated assumptions about how long the equivalent manual step takes
 * in a small hospitality operation: find the record, decide, write the
 * message, send it, note that it was sent. They are round numbers on purpose —
 * a coefficient of 3.7 would imply a measurement that does not exist. They are
 * declared per action kind where the work genuinely differs, and otherwise
 * fall back to a figure per safety level, because an action that leaves the
 * building costs more human attention than one that opens an internal task.
 *
 * When somebody eventually measures this properly, the coefficients move to a
 * table and this file reads them. Until then they are visible, in one place,
 * and printed on the screen next to the total.
 */

import type { AutopilotActionKind } from '@/lib/autopilot/actions'
import { actionSpec } from '@/lib/autopilot/actions'
import type { ActionSafetyLevel } from '@/lib/contracts/states'
import type { ActionView } from '@/components/autopilot/views'

/** The outcomes that represent work that really happened. */
const COUNTED_OUTCOMES: readonly ActionView['outcome'][] = [
  'executed',
  'executed_unaudited',
]

/**
 * Minutes the equivalent manual step is ASSUMED to take.
 *
 * Declared per kind only where the work genuinely differs from its safety
 * class. Everything else falls back to `MINUTES_BY_SAFETY`.
 */
export const MINUTES_PER_KIND: Readonly<
  Partial<Record<AutopilotActionKind, number>>
> = {
  // Composing a brief by hand means reading five screens first.
  'brief.compose': 15,
  // Noticing a shortage before it happens is the expensive part.
  'inventory.flag_shortage': 10,
  'laundry.request_earlier': 8,
  'cleaner.escalate': 6,
  'guest.send_reminder': 4,
  'guest.send_arrival_info': 4,
  'payment.request': 5,
  'task.create': 3,
  'task.assign': 2,
}

/**
 * The fallback, by how much attention the action needs.
 *
 * Ascending with harm, because the classes ascend with how carefully a person
 * would have had to do the same thing by hand.
 */
export const MINUTES_BY_SAFETY: Record<ActionSafetyLevel, number> = {
  information: 2,
  safe_internal: 3,
  external_communication: 5,
  business_impact: 8,
  money_access_cancellation: 8,
}

/** The one sentence the screen must print beside the total. */
export const ESTIMATE_METHOD =
  'הערכה, לא מדידה. מספר הפעולות שבוצעו בפועל, כפול מספר דקות מוסכם לכל סוג פעולה. ' +
  'ESTIA לא מדדה כמה זמן לוקח לאדם לעשות את זה, ואין במסד נתונים כזה.'

export function minutesFor(kind: string): number {
  const known = MINUTES_PER_KIND[kind as AutopilotActionKind]
  if (known !== undefined) return known

  const spec = actionSpec(kind)
  // A kind the catalogue no longer carries has no safety class to fall back
  // on. It is counted as the cheapest class rather than dropped, so the row
  // count and the minutes are about the same set of actions.
  return spec === null
    ? MINUTES_BY_SAFETY.information
    : MINUTES_BY_SAFETY[spec.safety]
}

export type EstimateLine = {
  kind: string
  label: string
  count: number
  /** The assumption for this kind. Printed, always. */
  minutesEach: number
  minutes: number
}

export type TimeEstimate = {
  /** Actions counted. `executed` and `executed_unaudited` only. */
  countedActions: number
  totalMinutes: number
  /** Every kind that contributed, largest first. The arithmetic, shown. */
  lines: readonly EstimateLine[]
}

export function estimateTimeSaved(
  actions: readonly ActionView[],
): TimeEstimate {
  const counted = actions.filter((action) =>
    COUNTED_OUTCOMES.includes(action.outcome),
  )

  const byKind = new Map<string, EstimateLine>()
  for (const action of counted) {
    const existing = byKind.get(action.kind)
    if (existing) {
      existing.count += 1
      existing.minutes += existing.minutesEach
      continue
    }
    const minutesEach = minutesFor(action.kind)
    byKind.set(action.kind, {
      kind: action.kind,
      label: action.kindLabel,
      count: 1,
      minutesEach,
      minutes: minutesEach,
    })
  }

  const lines = [...byKind.values()].sort((a, b) => b.minutes - a.minutes)

  return {
    countedActions: counted.length,
    totalMinutes: lines.reduce((sum, line) => sum + line.minutes, 0),
    lines,
  }
}

/** Whole hours and minutes, in Hebrew, without pretending to precision. */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} דקות`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} שעות` : `${hours} שעות ו־${rest} דקות`
}
