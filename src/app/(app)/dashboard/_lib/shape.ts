/**
 * The morning's shape, as four figures.
 *
 * PURE. Takes what `home.ts` already loaded and decides what each tile says;
 * reads nothing and queries nothing, so the decisions below are testable
 * against handmade values.
 *
 * ══ A READ THAT FAILED IS NOT A ZERO ════════════════════════════════════════
 *
 * `Settled` carries either a value or the error from the read that failed. The
 * dashboard's existing panels already respect that distinction; these tiles
 * must too, because a tile is the most glanceable thing on the screen and
 * "0 הגעות היום" on a morning with four arrivals is the single most expensive
 * lie this product could tell — somebody reads it, decides the day is quiet,
 * and goes out.
 *
 * So a failed read produces `known: false` with a sentence, never a number.
 * `Figure` in the kit renders that as words rather than as a dash, for the
 * same reason.
 */

import type { Settled, TodayCounts } from './home'

export type TileFigure = {
  readonly label: string
  /** The number, when there is one. */
  readonly count: number | null
  /** Why there is not one. Null when there is. */
  readonly why: string | null
  readonly detail: string | null
}

const UNREADABLE = 'הקריאה נכשלה — המספר אינו ידוע, ואינו אפס'

function fromCounts(
  stays: Settled<TodayCounts>,
  role: keyof TodayCounts,
  label: string,
  detail: string | null,
): TileFigure {
  if (!stays.ok) return { label, count: null, why: UNREADABLE, detail: null }
  return { label, count: stays.value[role], why: null, detail }
}

/**
 * `count` may be null inside a successful read, and that is a third state:
 * the query ran and the product cannot answer — usually a module whose tables
 * this deployment has not provisioned. It is reported as its own sentence
 * rather than folded into the failure above, because one is worth chasing and
 * the other is worth ignoring.
 */
function fromNullable(
  value: Settled<number | null>,
  label: string,
  absent: string,
  detail: (n: number) => string | null,
): TileFigure {
  if (!value.ok) return { label, count: null, why: UNREADABLE, detail: null }
  if (value.value === null)
    return { label, count: null, why: absent, detail: null }
  return { label, count: value.value, why: null, detail: detail(value.value) }
}

export function morningShape(home: {
  stays: Settled<TodayCounts>
  balances: Settled<{ count: number; totalAgorot: number } | null>
  stuckTasks: Settled<number | null>
  approvals: Settled<number | null>
}): readonly TileFigure[] {
  const balances: TileFigure = !home.balances.ok
    ? {
        label: 'יתרות לגבייה',
        count: null,
        why: UNREADABLE,
        detail: null,
      }
    : home.balances.value === null
      ? {
          label: 'יתרות לגבייה',
          count: null,
          why: 'אין מודול תשלומים בהיקף הזה',
          detail: null,
        }
      : {
          label: 'יתרות לגבייה',
          count: home.balances.value.count,
          why: null,
          detail: `₪${Math.round(home.balances.value.totalAgorot / 100).toLocaleString('he-IL')}`,
        }

  return [
    fromCounts(home.stays, 'arriving', 'הגעות היום', 'צ׳ק-אין מ-15:00'),
    fromCounts(home.stays, 'departing', 'יציאות היום', 'צ׳ק-אאוט עד 11:00'),
    balances,
    fromNullable(
      home.stuckTasks,
      'משימות תקועות',
      'אין מודול תפעול בהיקף הזה',
      (n) => (n === 0 ? 'הכול זז' : 'ממתינות מעל הזמן'),
    ),
  ]
}
