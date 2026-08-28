/**
 * The key to the grid's marks.
 *
 * It exists because the grid must be readable without colour, and a mark is
 * only a signal once something says what it means. The states it lists are the
 * states that were actually drawn — see `legendStates` — so it never invites a
 * reader to hunt for a fill that is not on the page.
 */

import { cn } from '@/components/ui/cn'

import { CALENDAR_STATE_META, type CalendarDayState } from './state-meta'

export type CalendarLegendProps = {
  states: readonly CalendarDayState[]
  /** Rendered after the marks: the Shabbat and holiday tint has meaning too. */
  note?: string
}

export function CalendarLegend({ states, note }: CalendarLegendProps) {
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {states.map((state) => {
          const meta = CALENDAR_STATE_META[state]
          return (
            <li
              key={state}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-6 items-center justify-center rounded-sm border border-border text-xs font-bold',
                  meta.className,
                )}
              >
                {meta.mark}
              </span>
              <span className="font-medium text-foreground">{meta.label}</span>
              <span className="sr-only">— {meta.description}</span>
            </li>
          )
        })}

        <li className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            className="flex size-6 items-center justify-center rounded-sm border border-border bg-accent-soft text-xs font-bold text-accent-strong"
          >
            ★
          </span>
          <span className="font-medium text-foreground">שבת או חג</span>
        </li>
      </ul>

      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}
