/**
 * The timeline, as a table.
 *
 * ── Every column is arithmetic somebody can check ─────────────────────────
 *
 * date · item · required · expected clean · reserved · shortage. Not a
 * verdict, not a colour, not a score. A person looking at "חסרים 5" has to be
 * able to see the twenty-five and the thirty that produced it in the same row,
 * because the alternative is a number they either believe or ignore, and after
 * the first wrong one they ignore all of them.
 *
 * ── Flat days are dropped ─────────────────────────────────────────────────
 *
 * `significantRows` in the engine keeps a day when something is required,
 * arriving, short or breaching the floor — and today, always, because "what is
 * the position right now" is the first question. Thirty flat rows per item is
 * a table nobody scrolls.
 *
 * No `"use client"`: it renders text and numbers.
 */

import { formatDayMonth } from '@/lib/booking'
import type { ForecastRow } from '@/lib/inventory'

import { Cell, Td, Th } from '@/components/operations/table-parts'

export function ForecastTable({
  rows,
  today,
  propertyNames,
  caption,
}: {
  rows: readonly ForecastRow[]
  today: string
  propertyNames: ReadonlyMap<string, string>
  caption: string
}) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-border bg-surface shadow-soft md:block">
        <table className="w-full min-w-[52rem] text-start text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b border-border bg-muted text-muted-foreground">
            <tr>
              <Th>תאריך</Th>
              <Th>פריט</Th>
              <Th>נכס</Th>
              <Th align="end">נדרש</Th>
              <Th align="end">צפוי נקי</Th>
              <Th align="end">משוריין</Th>
              <Th align="end">חסר</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.propertyId}:${row.itemId}:${row.date}`}
                className="border-b border-border last:border-0"
              >
                <Td>
                  {formatDayMonth(row.date)}
                  {row.date === today && (
                    <span className="ms-2 text-xs text-muted-foreground">
                      היום
                    </span>
                  )}
                </Td>
                <Td>{row.label}</Td>
                <Td>{propertyNames.get(row.propertyId) ?? '—'}</Td>
                <Td align="end" className="tabular-nums">
                  {row.required}
                </Td>
                <Td align="end" className="tabular-nums">
                  {row.expectedClean}
                  {row.incoming > 0 && (
                    // The incoming half is shown beside the total, because
                    // "twenty-five, of which twenty are coming back from the
                    // wash" is a different level of confidence from
                    // "twenty-five in the cupboard".
                    <span className="ms-1 text-xs text-muted-foreground">
                      (+{row.incoming})
                    </span>
                  )}
                </Td>
                <Td align="end" className="tabular-nums">
                  {row.reserved}
                </Td>
                <Td
                  align="end"
                  className={
                    row.shortage > 0
                      ? 'font-bold tabular-nums text-danger'
                      : row.breachesBuffer
                        ? 'tabular-nums text-warning'
                        : 'tabular-nums text-muted-foreground'
                  }
                >
                  {/* Colour is never the only signal in this product. */}
                  {row.shortage > 0 ? (
                    <>
                      <span aria-hidden="true">■ </span>
                      {row.shortage}
                    </>
                  ) : row.breachesBuffer ? (
                    `מתחת למלאי ביטחון (${row.safetyBuffer})`
                  ) : (
                    '—'
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <li
            key={`${row.propertyId}:${row.itemId}:${row.date}`}
            className="rounded-xl border border-border bg-surface p-4 shadow-soft"
          >
            <p className="font-semibold text-foreground">
              {row.label} · {formatDayMonth(row.date)}
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <Cell label="נדרש">{row.required}</Cell>
              <Cell label="צפוי נקי">{row.expectedClean}</Cell>
              <Cell label="משוריין">{row.reserved}</Cell>
              <Cell label="חסר">{row.shortage > 0 ? row.shortage : '—'}</Cell>
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}
