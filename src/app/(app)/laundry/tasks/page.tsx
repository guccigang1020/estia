import type { Metadata } from 'next'

import { Explanation } from '@/components/laundry/explanation'
import { Quantity } from '@/components/laundry/quantity'
import { LaundrySectionNav } from '@/components/laundry/section-nav'
import { LaundryShell } from '@/components/laundry/shell'
import { LaundryDatasetGap, LaundryPlanLock } from '@/components/laundry/states'
import { Badge } from '@/components/ui/badge'
import {
  LAUNDRY_STATUSES,
  TERMINAL_LAUNDRY_STATUSES,
} from '@/lib/contracts/states'

import { dateAndTime, relativeDay, statusLabel } from '../_lib/labels'
import { loadOrders } from '../_lib/queries'
import { laundryView, nameOf } from '../_lib/view'

export const metadata: Metadata = { title: 'עבודת כביסה בבית' }

const TASK_LIMIT = 60

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The internal laundry work.
 *
 * The batches this business washes itself, laid out as the state machine they
 * actually move through. Exists under `internal` and `hybrid` only; a business
 * on `external` has no utility room and `laundryView` 404s the route.
 *
 * ── Why this is not the task board ────────────────────────────────────────
 *
 * `tasks` in 0011 is the board a person works from and a laundry batch could
 * be projected onto it. It is not, for the reason `0021_preparation.sql` gives
 * about work plans: a batch carries the per-property breakdown and the
 * three-column quantity, and `tasks` has nowhere to put either. A batch can
 * BECOME a task; it is not one.
 *
 * ── Grouped by state, because that is how a laundry room is read ──────────
 *
 * Somebody walking into the utility room asks "what is in the machine and what
 * is waiting", not "what is due on Thursday". The columns are the frozen
 * statuses in their frozen order, and the empty ones are shown — a laundry
 * room with nothing in the dryer is information.
 */
export default async function LaundryTasksPage() {
  const view = await laundryView('laundry.view', 'tasks')
  if (!view) return null

  const { vocabulary } = view
  const mode = view.context.settings.settings.mode

  if (view.locked) {
    return (
      <LaundryShell heading="עבודת כביסה בבית" tagline={vocabulary.tagline}>
        <LaundryPlanLock
          entitlement={view.entitlement}
          mayReachBilling={view.mayReachBilling}
        />
      </LaundryShell>
    )
  }

  const { orders, gap } = await loadOrders(
    view.repo,
    view.actor,
    view.propertyId,
    TASK_LIMIT,
  )

  if (gap !== null) {
    return (
      <LaundryShell heading="עבודת כביסה בבית" tagline={vocabulary.tagline}>
        <LaundryDatasetGap table={gap.table} detail={gap.detail} />
      </LaundryShell>
    )
  }

  const now = new Date()

  // Internal batches only. Under `hybrid` the same screen must not show the
  // runs that went to a provider — those are on the orders screen and there is
  // nothing for anybody here to do about them.
  const internal = orders.filter(
    (order) =>
      order.mode !== 'external' &&
      !TERMINAL_LAUNDRY_STATUSES.includes(order.status),
  )

  // The frozen statuses, in their frozen order, less the ones an internal
  // batch never reaches.
  const columns = LAUNDRY_STATUSES.filter(
    (status) =>
      !TERMINAL_LAUNDRY_STATUSES.includes(status) &&
      status !== 'awaiting_approval',
  )

  return (
    <LaundryShell heading="עבודת כביסה בבית" tagline={vocabulary.tagline}>
      <LaundrySectionNav mode={mode} current="tasks" />

      {internal.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface px-5 py-10 text-center text-sm text-muted-foreground">
          אין כרגע כביסה בתהליך בבית. כשתיווצר דרישה שמסומנת לטיפול פנימי היא
          תופיע כאן.
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          {columns.map((status) => {
            const batches = internal.filter((order) => order.status === status)

            return (
              <section
                key={status}
                aria-labelledby={`status-${status}`}
                className="flex flex-col gap-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
                  <h2
                    id={`status-${status}`}
                    className="font-display text-lg font-bold tracking-tight text-foreground"
                  >
                    {statusLabel(status, mode)}
                  </h2>
                  <span className="text-sm text-muted-foreground">
                    {batches.length === 0
                      ? 'ריק'
                      : `${batches.length} ${vocabulary.batches}`}
                  </span>
                </div>

                {batches.length === 0 ? (
                  // Shown rather than hidden: nothing in the dryer is a fact
                  // somebody walking into the room wants to see.
                  <p className="text-sm text-muted-foreground">
                    אין כרגע דבר בשלב הזה.
                  </p>
                ) : (
                  <ul className="grid gap-3 lg:grid-cols-2">
                    {batches.map((order) => (
                      <li
                        key={order.id}
                        className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <a
                            href={`/laundry/orders/${order.id}`}
                            className="font-display text-sm font-bold text-foreground underline-offset-4 hover:underline"
                          >
                            {order.reference}
                          </a>
                          <Badge
                            tone={
                              new Date(order.requiredBy).getTime() <
                              now.getTime()
                                ? 'accent'
                                : 'neutral'
                            }
                          >
                            {relativeDay(order.requiredBy, now)}
                          </Badge>
                        </div>

                        <span className="text-xs text-muted-foreground">
                          נדרש {dateAndTime(order.requiredBy)}
                        </span>

                        <ul className="flex flex-col gap-3">
                          {order.lines.map((line) => (
                            <li
                              key={line.id}
                              className="flex flex-col gap-2 border-t border-border pt-3 first:border-0 first:pt-0"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex min-w-0 flex-col gap-1">
                                  <span className="font-semibold text-foreground">
                                    {line.label}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    {nameOf(view.properties, line.propertyId)}
                                  </span>
                                </div>
                                <div className="shrink-0">
                                  <Quantity
                                    quantity={line.quantity}
                                    unit={line.unit}
                                  />
                                </div>
                              </div>
                              <Explanation
                                steps={line.explanation}
                                expected={line.quantity.calculated}
                              />
                            </li>
                          ))}
                        </ul>

                        {order.internalNotes !== null && (
                          <p className="rounded-lg bg-muted px-3 py-2 text-xs text-foreground">
                            {order.internalNotes}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      )}
    </LaundryShell>
  )
}
