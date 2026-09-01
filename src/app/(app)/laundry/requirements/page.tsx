import type { Metadata } from 'next'

import { Explanation } from '@/components/laundry/explanation'
import { Quantity } from '@/components/laundry/quantity'
import { LaundrySectionNav } from '@/components/laundry/section-nav'
import { LaundryShell } from '@/components/laundry/shell'
import { LaundryDatasetGap, LaundryPlanLock } from '@/components/laundry/states'
import { Badge } from '@/components/ui/badge'
import { TERMINAL_LAUNDRY_STATUSES } from '@/lib/contracts/states'
import { isoDay } from '@/lib/laundry'

import {
  ROUTE_LABEL,
  dateAndTime,
  relativeDay,
  weekdayOf,
} from '../_lib/labels'
import { loadOrders } from '../_lib/queries'
import { laundryView, nameOf } from '../_lib/view'

export const metadata: Metadata = { title: 'מה צריך להיות נקי' }

const HORIZON_LIMIT = 120

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What has to be clean, and by when.
 *
 * THIS IS THE WHOLE PRODUCT FOR A `simple` BUSINESS. A villa owner who picked
 * `simple` gets this screen and the forecast, and nothing else — no orders, no
 * providers, no stock — and the words on it come from the mode's own
 * vocabulary so that nothing here implies an operation they do not have. The
 * `simple` copy is checked against `FORBIDDEN_IN_SIMPLE` by
 * `src/lib/laundry/requirements.test.ts`.
 *
 * ── Grouped by day, because that is the question ──────────────────────────
 *
 * Not by property and not by item. Somebody looking at this is asking "what do
 * I have to have ready tomorrow", and a list grouped by item makes them do the
 * grouping in their head. Within a day the property is named on every row,
 * because a manager with two houses needs it and a manager with one ignores it.
 *
 * ── Every quantity carries its arithmetic ─────────────────────────────────
 *
 * `Explanation` renders the chain under each figure — the preparation rule, the
 * two buffers and the bundle rounding — because a number a manager cannot
 * check is a number they will not trust, and the first time they disagree with
 * one they need something to point at.
 */
export default async function LaundryRequirementsPage() {
  const view = await laundryView('laundry.view', 'requirements')
  if (!view) return null

  const { vocabulary } = view
  const mode = view.context.settings.settings.mode

  if (view.locked) {
    return (
      <LaundryShell heading="מה צריך להיות נקי" tagline={vocabulary.tagline}>
        <LaundryPlanLock
          entitlement={view.entitlement}
          mayReachBilling={view.mayReachBilling}
        />
      </LaundryShell>
    )
  }

  const { orders, gap } = await loadOrders(view.propertyId, HORIZON_LIMIT)

  if (gap !== null) {
    return (
      <LaundryShell heading="מה צריך להיות נקי" tagline={vocabulary.tagline}>
        <LaundryDatasetGap table={gap.table} detail={gap.detail} />
      </LaundryShell>
    )
  }

  const now = new Date()

  // Every line of every open run, flattened and grouped by the day it is
  // needed. A terminal run has nothing left to prepare for.
  const lines = orders
    .filter((order) => !TERMINAL_LAUNDRY_STATUSES.includes(order.status))
    .flatMap((order) =>
      order.lines.map((line) => ({
        line,
        orderId: order.id,
        reference: order.reference,
        route: order.mode === 'external' ? 'external' : 'internal',
      })),
    )

  const byDay = new Map<string, typeof lines>()
  for (const entry of lines) {
    const day = isoDay(entry.line.requiredBy)
    const existing = byDay.get(day)
    if (existing) existing.push(entry)
    else byDay.set(day, [entry])
  }

  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))

  return (
    <LaundryShell heading="מה צריך להיות נקי" tagline={vocabulary.tagline}>
      <LaundrySectionNav mode={mode} current="requirements" />

      {days.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface px-5 py-10 text-center text-sm text-muted-foreground">
          אין כרגע פריטים שצריכים להיות נקיים. דרישות נוצרות מהזמנות מאושרות,
          לפי כללי ההכנה של העסק.
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          {days.map(([day, entries]) => {
            const total = entries.reduce(
              (sum, entry) => sum + entry.line.quantity.final,
              0,
            )

            return (
              <section
                key={day}
                aria-labelledby={`day-${day}`}
                className="flex flex-col gap-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
                  <h2
                    id={`day-${day}`}
                    className="font-display text-lg font-bold tracking-tight text-foreground"
                  >
                    {weekdayOf(entries[0]?.line.requiredBy ?? day)}{' '}
                    <span className="text-muted-foreground">
                      {relativeDay(entries[0]?.line.requiredBy ?? day, now)}
                    </span>
                  </h2>
                  <span className="text-sm text-muted-foreground">
                    {total} יחידות · {entries.length} פריטים
                  </span>
                </div>

                <ul className="flex flex-col gap-3">
                  {entries.map((entry) => (
                    <li
                      key={entry.line.id}
                      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="flex min-w-0 flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-foreground">
                            {entry.line.label}
                          </span>
                          <Badge>
                            {nameOf(view.properties, entry.line.propertyId)}
                          </Badge>
                          {/* The route is shown only where it is a real
                              choice. Under `simple` and `internal` there is
                              nowhere else for it to go. */}
                          {(mode === 'hybrid' || mode === 'external') && (
                            <Badge tone="brand">
                              {
                                ROUTE_LABEL[
                                  entry.route as 'internal' | 'external'
                                ]
                              }
                            </Badge>
                          )}
                        </div>

                        <Explanation
                          steps={entry.line.explanation}
                          expected={entry.line.quantity.calculated}
                        />

                        <span className="text-xs text-muted-foreground">
                          נדרש {dateAndTime(entry.line.requiredBy)}
                        </span>
                      </div>

                      <div className="shrink-0 sm:text-left">
                        <Quantity
                          quantity={entry.line.quantity}
                          unit={entry.line.unit}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </LaundryShell>
  )
}
