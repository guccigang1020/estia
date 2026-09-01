import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { EmptyState } from '@/components/states/empty-state'
import { StoreLock } from '@/components/store/store-lock'
import {
  AttentionBadge,
  Money,
  OrderStatusBadge,
  PaymentStatusBadge,
  StoreHeader,
  StoreNav,
} from '@/components/store/store-chrome'
import { Card } from '@/components/ui/card'
import { cn } from '@/components/ui/cn'
import { toSafeResponse } from '@/lib/errors'
import { STORE_ORDER_STATUS_LABEL, STORE_ORDER_SOURCE_LABEL } from '@/lib/store'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireStoreGrant } from '../_lib/gate'
import { loadOrders, type OrderListView } from '../_lib/queries'

export const metadata: Metadata = { title: 'הזמנות · חנות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What guests have asked for.
 *
 * ── Two different empty states, and the difference is the whole point ────
 *
 * "You have never taken an order" and "nothing matched this filter" look
 * identical on screen and mean opposite things. The first is a first-run
 * state; the second shown to somebody who filtered is a data-loss scare. So
 * the loader carries `neverAnyOrders` separately from the filtered rows, and
 * this screen branches on it.
 *
 * ── The filter is chips over what exists, not a fixed list ───────────────
 *
 * `STORE_ORDER_STATUSES` has eleven members and most businesses use four.
 * Rendering all eleven as chips, nine of them matching nothing, teaches a
 * vocabulary nobody asked for — so the chips are built from the statuses this
 * organization's orders actually carry.
 */
export default async function StoreOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const [access, context, params] = await Promise.all([
    requireStoreGrant('order.view'),
    shellContext(),
    searchParams,
  ])

  if (access.kind === 'locked') {
    return (
      <StoreLock
        entitlement={access.entitlement}
        title="החנות אינה כלולה בחבילה שלכם"
        body="כאן היו ההזמנות שהאורחים שלחו, ומה שממתין לאישור."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let view: OrderListView | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    view = await loadOrders({
      db,
      actor: access.actor,
      propertyId,
      status: params.status ?? null,
      now: new Date(),
    })
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <StoreHeader title="הזמנות" lead="מה שהאורחים ביקשו, ומה כבר סודר." />
      <StoreNav current="/store/orders" />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !view ? null : view.neverAnyOrders ? (
        <EmptyState
          illustration="invoice"
          as="h2"
          title="עדיין לא התקבלו הזמנות"
          body="כשאורח יבקש משהו מהחנות — או כשתוסיפו הזמנה בעצמכם אחרי שיחת טלפון — היא תופיע כאן עם כל מה שצריך כדי לאשר אותה."
          action={
            <Link
              href="/store/products"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              מעבר לקטלוג
            </Link>
          }
        />
      ) : (
        <>
          <nav aria-label="סינון לפי מצב" className="flex flex-wrap gap-2">
            <FilterChip
              href="/store/orders"
              label="הכול"
              active={!params.status}
            />
            {view.statuses.map((status) => (
              <FilterChip
                key={status}
                href={`/store/orders?status=${encodeURIComponent(status)}`}
                label={
                  STORE_ORDER_STATUS_LABEL[
                    status as keyof typeof STORE_ORDER_STATUS_LABEL
                  ] ?? status
                }
                active={params.status === status}
              />
            ))}
          </nav>

          {view.rows.length === 0 ? (
            <EmptyState
              illustration="search"
              as="h2"
              title="אין הזמנות במצב הזה"
              body="הסינון הנוכחי לא החזיר כלום. אין פירושו שאין הזמנות — נקו את הסינון כדי לראות את כולן."
              action={
                <Link
                  href="/store/orders"
                  className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground"
                >
                  ניקוי הסינון
                </Link>
              }
            />
          ) : (
            <Card>
              <ul className="flex flex-col divide-y divide-border">
                {view.rows.map(({ order, attention, overdue }) => (
                  <li key={order.id} className="py-4">
                    <Link
                      href={`/store/orders/${order.id}`}
                      className="flex flex-col gap-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-display text-base font-bold text-foreground">
                          {order.reference}
                        </span>
                        <OrderStatusBadge status={order.status} />
                        <AttentionBadge attention={attention} />
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="text-sm text-muted-foreground">
                          {order.lines
                            .map((line) =>
                              line.quantity > 1
                                ? `${line.itemNameSnapshot} × ${line.quantity}`
                                : line.itemNameSnapshot,
                            )
                            .join(' · ') || 'ללא פריטים'}
                        </span>
                        <Money agorot={order.totalAgorot} emphasis />
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <PaymentStatusBadge
                          status={order.paymentStatus}
                          mode={order.paymentMode}
                        />
                        <span>{STORE_ORDER_SOURCE_LABEL[order.source]}</span>
                        {order.requestedForDate && (
                          <span className={cn(overdue && 'text-danger')}>
                            למועד {order.requestedForDate}
                            {overdue && ' · עבר'}
                          </span>
                        )}
                        {order.amendmentCount > 0 && (
                          <span>{order.amendmentCount} תיקונים</span>
                        )}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function FilterChip({
  href,
  label,
  active,
}: {
  href: string
  label: string
  active: boolean
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'rounded-full border px-3 py-1 text-sm transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground font-semibold'
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </Link>
  )
}
