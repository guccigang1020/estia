/**
 * The multi-unit month: rows are units, columns are nights.
 *
 * NO `"use client"`. There is no state here and no handler — the month is a
 * query parameter and navigation is a link, so the whole grid renders on the
 * server and works with JavaScript disabled.
 *
 * WHAT IT DOES NOT DECIDE. Not one cell's state is computed here. Every
 * `state` arrives already decided by the availability engine, and every Hebrew
 * date, holiday and Shabbat mark arrives already resolved by
 * `calendar/_lib/month.ts`. This file is layout.
 *
 * READING IT WITHOUT COLOUR. Each cell carries a mark — `○ ● ◐ ⊘` — and a
 * screen-reader sentence naming the unit, the date and the state. The fill is
 * the third signal, never the first, so the grid survives a monochrome print,
 * colour blindness and a screen reader equally.
 *
 * RTL. Nothing here says `left` or `right`. The unit column is pinned with
 * `start-0`, which is the right-hand edge in Hebrew and would be the left-hand
 * edge if this product were ever run in a Latin locale.
 */

import { cn } from '@/components/ui/cn'

import { CALENDAR_STATE_META, type CalendarDayState } from './state-meta'

export interface MonthGridDay {
  date: string
  dayOfMonth: number
  weekdayLetter: string
  hebrewDay: string
  hebrewFull: string
  shabbat: boolean
  peak: boolean
  /** The holiday to mark this column with, already precedence-resolved. */
  specialShortName: string | null
  specialName: string | null
}

export interface MonthGridRow {
  unitId: string
  unitName: string
  unitCode: string
  propertyName: string
  /** Same length and order as `days`. */
  states: readonly CalendarDayState[]
}

export type MonthGridProps = {
  caption: string
  days: readonly MonthGridDay[]
  rows: readonly MonthGridRow[]
}

export function MonthGrid({ caption, days, rows }: MonthGridProps) {
  return (
    // The grid scrolls itself. A month of 31 columns must never widen the
    // shell and push the sidebar off the screen.
    <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-soft">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>

        <thead>
          <tr>
            <th
              scope="col"
              className="sticky start-0 z-20 min-w-44 border-b border-e border-border bg-surface px-3 py-2 text-start text-xs font-semibold text-muted-foreground"
            >
              יחידה
            </th>
            {days.map((day) => (
              <th
                key={day.date}
                scope="col"
                className={cn(
                  'min-w-11 border-b border-border px-1 py-2 text-center align-top',
                  day.shabbat || day.peak ? 'bg-accent-soft' : 'bg-surface',
                )}
              >
                <span className="sr-only">
                  {day.date} · {day.hebrewFull}
                  {day.specialName ? ` · ${day.specialName}` : ''}
                </span>

                <span aria-hidden="true" className="flex flex-col items-center">
                  <span className="text-[0.625rem] font-medium text-muted-foreground">
                    {day.weekdayLetter}
                  </span>
                  <span className="text-sm font-semibold text-foreground">
                    {day.dayOfMonth}
                  </span>
                  <span className="text-[0.625rem] leading-tight text-muted-foreground">
                    {day.hebrewDay}
                  </span>
                  {/* The holiday name, clipped to the column width. The full
                      name is in the screen-reader text above and in `title`. */}
                  <span
                    title={day.specialName ?? undefined}
                    className="mt-0.5 block h-3.5 max-w-11 overflow-hidden text-[0.5625rem] leading-tight font-semibold text-accent-strong"
                  >
                    {day.specialShortName ?? ''}
                  </span>
                </span>
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => (
            <tr key={row.unitId} className="even:bg-muted/40">
              <th
                scope="row"
                className="sticky start-0 z-10 border-b border-e border-border bg-surface px-3 py-2 text-start font-medium"
              >
                <span className="block text-foreground">{row.unitName}</span>
                <span className="block text-xs text-muted-foreground">
                  <span dir="ltr">{row.unitCode}</span> · {row.propertyName}
                </span>
              </th>

              {row.states.map((state, index) => {
                const day = days[index]
                const meta = CALENDAR_STATE_META[state]
                return (
                  <td
                    key={day.date}
                    className="border-b border-border p-0.5 text-center"
                  >
                    <span
                      title={`${day.date} · ${meta.label}`}
                      className={cn(
                        'flex h-8 items-center justify-center rounded-sm text-xs font-bold',
                        meta.className,
                      )}
                    >
                      <span aria-hidden="true">{meta.mark}</span>
                      <span className="sr-only">
                        {row.unitName} · {day.date} · {meta.label}
                      </span>
                    </span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
