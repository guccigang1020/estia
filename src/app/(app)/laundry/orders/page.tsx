import type { Metadata } from 'next'

import { LaundryOrderCard } from '@/components/laundry/order-card'
import { LaundrySectionNav } from '@/components/laundry/section-nav'
import { LaundryShell } from '@/components/laundry/shell'
import { LaundryDatasetGap, LaundryPlanLock } from '@/components/laundry/states'
import { TERMINAL_LAUNDRY_STATUSES } from '@/lib/contracts/states'

import { dateAndTime, relativeDay, statusLabel } from '../_lib/labels'
import { loadOrders, loadProviders } from '../_lib/queries'
import { laundryView } from '../_lib/view'

export const metadata: Metadata = { title: 'הזמנות כביסה' }

const ORDER_LIMIT = 100

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The runs, open and closed.
 *
 * This route exists only under `external` and `hybrid`. `laundryView` 404s it
 * for a business on `simple` or `internal` — see the note there on why that is
 * a 404 rather than an empty list.
 *
 * Gated on `laundry.view` rather than `laundry.order_create`, deliberately.
 * Reading what is out at the laundry is part of knowing whether a unit can be
 * turned around; creating and sending are the acts that need more, and they
 * are gated at the operation in `src/lib/laundry/operations.ts` where the
 * distinction can actually be made.
 */
export default async function LaundryOrdersPage() {
  const view = await laundryView('laundry.view', 'orders')
  if (!view) return null

  const { vocabulary } = view
  const mode = view.context.settings.settings.mode

  if (view.locked) {
    return (
      <LaundryShell heading={vocabulary.batches} tagline={vocabulary.tagline}>
        <LaundryPlanLock
          entitlement={view.entitlement}
          mayReachBilling={view.mayReachBilling}
        />
      </LaundryShell>
    )
  }

  const [{ orders, gap }, { providers }] = await Promise.all([
    loadOrders(view.repo, view.actor, view.propertyId, ORDER_LIMIT),
    loadProviders(view.repo, view.actor),
  ])

  if (gap !== null) {
    return (
      <LaundryShell heading={vocabulary.batches} tagline={vocabulary.tagline}>
        <LaundryDatasetGap table={gap.table} detail={gap.detail} />
      </LaundryShell>
    )
  }

  const now = new Date()
  const providerNames = new Map(
    (providers ?? []).map((provider) => [provider.id, provider.name]),
  )

  const open = orders.filter(
    (order) => !TERMINAL_LAUNDRY_STATUSES.includes(order.status),
  )
  const closed = orders.filter((order) =>
    TERMINAL_LAUNDRY_STATUSES.includes(order.status),
  )

  return (
    <LaundryShell heading={vocabulary.batches} tagline={vocabulary.tagline}>
      <LaundrySectionNav mode={mode} current="orders" />

      <Group
        title={`${open.length} פתוחות`}
        empty="אין הזמנות פתוחות."
        orders={open}
        now={now}
        mode={mode}
        providerNames={providerNames}
        properties={view.properties}
        markOverdue
      />

      <Group
        title={`${closed.length} סגורות`}
        empty="אין עדיין היסטוריה."
        orders={closed}
        now={now}
        mode={mode}
        providerNames={providerNames}
        properties={view.properties}
        markOverdue={false}
      />
    </LaundryShell>
  )
}

function Group({
  title,
  empty,
  orders,
  now,
  mode,
  providerNames,
  properties,
  markOverdue,
}: {
  title: string
  empty: string
  orders: readonly Awaited<ReturnType<typeof loadOrders>>['orders'][number][]
  now: Date
  mode: Parameters<typeof statusLabel>[1]
  providerNames: ReadonlyMap<string, string>
  properties: ReadonlyMap<string, string>
  markOverdue: boolean
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
        {title}
      </h2>

      {orders.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface px-5 py-8 text-center text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {orders.map((order) => (
            <li key={order.id}>
              <LaundryOrderCard
                order={order}
                statusLabel={statusLabel(order.status, mode)}
                providerName={
                  order.providerId === null
                    ? null
                    : (providerNames.get(order.providerId) ?? null)
                }
                properties={properties}
                overdue={
                  markOverdue &&
                  new Date(order.requiredBy).getTime() < now.getTime()
                }
                requiredByLabel={dateAndTime(order.requiredBy)}
                relativeLabel={relativeDay(order.requiredBy, now)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
