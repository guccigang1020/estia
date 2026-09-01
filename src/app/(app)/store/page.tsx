import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { EmptyState } from '@/components/states/empty-state'
import { StoreLock } from '@/components/store/store-lock'
import {
  AttentionBadge,
  Money,
  OrderStatusBadge,
  StatTile,
  StoreHeader,
  StoreNav,
} from '@/components/store/store-chrome'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { toSafeResponse } from '@/lib/errors'
import { STORE_MODE_LABEL, STORE_MODE_SUMMARY } from '@/lib/store'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireStoreGrant } from './_lib/gate'
import { loadOverview, type StoreOverview } from './_lib/queries'

export const metadata: Metadata = { title: 'חנות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What the shop is doing this morning.
 *
 * ── The three states this screen has, and why none of them nags ──────────
 *
 *   1. **The plan does not include commerce.** The gate returns `locked` and
 *      `StoreLock` explains what the section is for. Not a permission error.
 *
 *   2. **The store is `off`.** That is the DEFAULT and a first-class answer —
 *      a great many single-villa businesses will never turn it on, and
 *      bookings carry on exactly as they did. The screen says what the store
 *      would do and offers to switch it on, once, without a warning colour.
 *
 *   3. **The store is on.** KPIs, then the orders that need a person, then the
 *      catalogue's own numbers.
 *
 * ── What the KPIs deliberately do not say ────────────────────────────────
 *
 * "₪X outstanding" is a figure to know, not a debt to chase. On the default
 * payment mode an order is `confirmed` and `unpaid` because the purchase joins
 * the booking's balance, which is the ordinary arrangement — so the tile says
 * so beneath the number rather than colouring it red.
 */
export default async function StoreOverviewPage() {
  const [access, context] = await Promise.all([
    requireStoreGrant('product.view'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <StoreLock
        entitlement={access.entitlement}
        title="החנות אינה כלולה בחבילה שלכם"
        body="כאן היו מוצגים המוצרים והשירותים שאתם מוכרים לאורחים, ההזמנות שהתקבלו ומה שממתין לטיפול."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let overview: StoreOverview | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    overview = await loadOverview({
      db,
      actor: access.actor,
      propertyId,
      now: new Date(),
    })
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <StoreHeader
        title="חנות"
        lead="מה אתם מוכרים לאורחים, ומה מחכה לטיפול."
      />
      <StoreNav current="/store" />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !overview ? null : !overview.capabilities.visible ? (
        <StoreIsOff mode={overview.settings.mode} />
      ) : (
        <>
          <section
            aria-label="מספרים"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <StatTile
              label="מוצרים פעילים"
              value={overview.activeItemCount}
              hint={
                overview.itemCount > overview.activeItemCount
                  ? `מתוך ${overview.itemCount} בקטלוג`
                  : undefined
              }
            />
            <StatTile label="הזמנות פתוחות" value={overview.openOrderCount} />
            <StatTile
              label="נמכר ב־30 הימים האחרונים"
              value={<Money agorot={overview.soldLast30Agorot} emphasis />}
            />
            <StatTile
              label="טרם שולם"
              value={<Money agorot={overview.outstandingAgorot} emphasis />}
              // Not a debt. On the default mode this is exactly how it should
              // look, and a red number here would send somebody chasing money
              // the business deliberately deferred.
              hint="כולל הזמנות שסוכם עליהן להתווסף לחשבון השהות"
            />
          </section>

          <Card>
            <CardHeader>
              <CardTitle as="h2">ממתין לך</CardTitle>
            </CardHeader>

            {overview.needsAttention.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                אין הזמנות שממתינות לטיפול כרגע.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col divide-y divide-border">
                {overview.needsAttention
                  .slice(0, 8)
                  .map(({ order, attention }) => (
                    <li key={order.id} className="py-3">
                      <Link
                        href={`/store/orders/${order.id}`}
                        className="flex flex-wrap items-center justify-between gap-3"
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">
                            {order.reference}
                          </span>
                          <OrderStatusBadge status={order.status} />
                          <AttentionBadge attention={attention} />
                        </span>
                        <span className="flex items-center gap-4 text-sm">
                          <span className="text-muted-foreground">
                            {order.lines.length === 1
                              ? order.lines[0].itemNameSnapshot
                              : `${order.lines.length} פריטים`}
                          </span>
                          <Money agorot={order.totalAgorot} emphasis />
                        </span>
                      </Link>
                    </li>
                  ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2">הקטלוג</CardTitle>
            </CardHeader>

            {overview.itemCount === 0 ? (
              <EmptyState
                className="mt-4"
                illustration="invoice"
                title="עדיין לא הוספת מוצרים או שירותים"
                body="חנות מתחילה בפריט אחד. הוסיפו את הדבר שאתם כבר מוכרים לאורחים בטלפון — שולחן שוק, חימום בריכה, ארוחת בוקר — ואפשר יהיה לבקש אותו מתוך ההזמנה."
                action={
                  <Link
                    href="/store/products"
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
                  >
                    הוספת המוצר הראשון
                  </Link>
                }
              />
            ) : (
              <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                <CatalogueCount
                  label="מוצרים ושירותים"
                  value={overview.itemCount}
                  href="/store/products"
                />
                <CatalogueCount
                  label="קטגוריות"
                  value={overview.categoryCount}
                  href="/store/categories"
                />
                <CatalogueCount
                  label="חבילות"
                  value={overview.packageCount}
                  href="/store/packages"
                />
              </dl>
            )}
          </Card>

          <p className="text-sm text-muted-foreground">
            מצב החנות כרגע:{' '}
            <span className="font-semibold text-foreground">
              {STORE_MODE_LABEL[overview.settings.mode]}
            </span>{' '}
            — {STORE_MODE_SUMMARY[overview.settings.mode]}{' '}
            <Link
              href="/store/settings"
              className="text-primary underline underline-offset-4"
            >
              שינוי
            </Link>
          </p>
        </>
      )}
    </div>
  )
}

function CatalogueCount({
  label,
  value,
  href,
}: {
  label: string
  value: number
  href: string
}) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-lg border border-border bg-muted px-4 py-3"
    >
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-xl font-bold tabular-nums text-foreground">
        {value}
      </dd>
    </Link>
  )
}

/**
 * `off` is a setting, not a problem.
 *
 * No warning colour, no exclamation mark and no count of what is "missing".
 * A business that never turns the store on is using the product correctly.
 */
function StoreIsOff({
  mode,
}: {
  mode: 'off' | 'simple' | 'commerce' | 'advanced'
}) {
  return (
    <EmptyState
      illustration="invoice"
      as="h2"
      title="החנות כבויה"
      body={`${STORE_MODE_SUMMARY[mode]} כשתפעילו אותה, האורחים יוכלו לבקש תוספות מתוך ההזמנה שלהם — ואתם תאשרו כל בקשה לפני שהיא הופכת להתחייבות.`}
      action={
        <Link
          href="/store/settings"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
        >
          הפעלת החנות
        </Link>
      }
    />
  )
}
