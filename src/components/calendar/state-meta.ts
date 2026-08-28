/**
 * How a night's state is spelled on screen.
 *
 * The states themselves are the availability engine's — `DayState` from
 * `src/lib/booking/availability.ts` for a reader entitled to the internal
 * diary, and `AgentDayState` from `src/lib/agents/availability-view.ts` for one
 * who is not. Nothing here decides whether a night is free; it decides how the
 * answer is worded and marked.
 *
 * COLOUR IS NEVER THE MESSAGE. Every cell carries a mark and an accessible
 * name, and the legend maps each mark to its Hebrew label. A person who cannot
 * distinguish the fills — colour blindness, a monochrome print of the month, a
 * screen reader — still reads the calendar, because the fill is the third
 * signal and not the first.
 */

import type { DayState } from '@/lib/booking/availability'
import type { AgentDayState } from '@/lib/agents/availability-view'

/**
 * Every state a cell can be in.
 *
 * The union of the two engine vocabularies rather than a third one of its own:
 * a state added to `DayState` becomes a compile error here until it is given
 * wording, which is the behaviour worth having.
 */
export type CalendarDayState = DayState | AgentDayState

export interface CalendarStateMeta {
  /** Hebrew, and the primary signal. Rendered in the legend and as the cell's name. */
  label: string
  /** A shape, not a colour. Rendered inside the cell and beside the legend label. */
  mark: string
  /** The sentence a screen reader gets, and the cell's tooltip. */
  description: string
  /** Token classes only. No hex, no stock palette. */
  className: string
}

export const CALENDAR_STATE_META: Record<CalendarDayState, CalendarStateMeta> =
  {
    free: {
      label: 'פנוי',
      mark: '○',
      description: 'הלילה פנוי למכירה.',
      className: 'bg-surface text-muted-foreground',
    },
    booked: {
      label: 'מוזמן',
      mark: '●',
      description: 'הלילה תפוס על ידי הזמנה.',
      className: 'bg-primary-soft text-primary',
    },
    held: {
      label: 'בהחזקה',
      mark: '◐',
      description: 'הלילה מוחזק זמנית ועדיין אינו הזמנה.',
      className: 'bg-accent-soft text-accent-strong',
    },
    blocked: {
      label: 'חסום',
      mark: '⊘',
      description: 'הלילה אינו למכירה — חסימה או יחידה שאינה פעילה.',
      className: 'bg-muted text-muted-foreground',
    },
    /**
     * What a reader who may not see the internal diary is told. The engine
     * distinguishes a booking from a hold; this reader is deliberately not
     * shown which, because "מוחזק" tells an external seller that a rival is
     * mid-deal on those dates.
     */
    unavailable: {
      label: 'תפוס',
      mark: '●',
      description: 'הלילה אינו זמין למכירה.',
      className: 'bg-primary-soft text-primary',
    },
  }

/** The order a legend reads in: sellable first, then why not. */
const STATE_ORDER: readonly CalendarDayState[] = [
  'free',
  'booked',
  'held',
  'unavailable',
  'blocked',
]

/**
 * The states a legend should list, derived from what was actually drawn.
 *
 * Not from a `detailed` flag. A reader entitled to the internal diary on one
 * property and not on another sees both vocabularies in the same grid, and a
 * legend computed from a single flag would then omit half of its own marks.
 * Listing a state the grid never draws is the opposite mistake — it invites
 * the reader to hunt for a colour that is not there.
 */
export function legendStates(
  present: Iterable<CalendarDayState>,
): CalendarDayState[] {
  const drawn = new Set(present)
  return STATE_ORDER.filter((state) => drawn.has(state))
}
