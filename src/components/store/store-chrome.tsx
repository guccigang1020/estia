/**
 * The pieces every store screen draws with.
 *
 * No `"use client"`: nothing here holds state. These are values in, markup
 * out, so they render on the server with the rest of the page.
 *
 * ── Why the labels are imported and not written here ─────────────────────
 *
 * `src/lib/store/labels.ts` holds one `Record<TheUnion, string>` per frozen
 * vocabulary, so a status added to the contracts makes that file fail to
 * compile. A component that wrote its own Hebrew would render a raw English
 * enum value at a customer instead.
 */

import Link from 'next/link'

import { Money } from '@/components/finance/money'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/components/ui/cn'
import type {
  StoreOrderStatus,
  StorePricingModel,
} from '@/lib/contracts/states'
import { formatAgorot } from '@/lib/plans/plan'
import {
  ORDER_ATTENTION_LABEL,
  STORE_ITEM_STATUS_LABEL,
  STORE_ORDER_STATUS_LABEL,
  STORE_PAYMENT_MODE_LABEL,
  STORE_PAYMENT_STATUS_LABEL,
  priceCaption,
  type OrderAttention,
  type StoreOrder,
} from '@/lib/store'
import type {
  StoreItemStatus,
  StorePaymentStatus,
} from '@/lib/contracts/states'

/* ---------------------------------------------------------------- header -- */

export function StoreHeader({
  title,
  lead,
  action,
}: {
  title: string
  lead: string
  action?: React.ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        <p className="max-w-prose text-muted-foreground">{lead}</p>
      </div>
      {action}
    </header>
  )
}

/**
 * The section's own navigation.
 *
 * Rendered inside the section rather than added to the sidebar, because the
 * sidebar is `src/components/nav/menu.ts` and belongs to the coordinator —
 * the hrefs this needs are listed in the report so they can be wired there.
 * Until they are, this is how somebody moves between the store screens.
 */
export function StoreNav({ current }: { current: string }) {
  const links: readonly { href: string; label: string }[] = [
    { href: '/store', label: 'סקירה' },
    { href: '/store/products', label: 'מוצרים' },
    { href: '/store/services', label: 'שירותים' },
    { href: '/store/packages', label: 'חבילות' },
    { href: '/store/orders', label: 'הזמנות' },
    { href: '/store/categories', label: 'קטגוריות' },
    { href: '/store/availability', label: 'זמינות' },
    { href: '/store/promotions', label: 'קודי הנחה' },
    { href: '/store/settings', label: 'הגדרות' },
  ]

  return (
    <nav
      aria-label="ניווט בחנות"
      className="-mx-1 flex flex-wrap gap-1 overflow-x-auto"
    >
      {links.map((link) => {
        const active = link.href === current
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm transition-colors',
              active
                ? 'bg-primary text-primary-foreground font-semibold'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}

/* ----------------------------------------------------------------- tiles -- */

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string
  value: React.ReactNode
  hint?: string
}) {
  return (
    <Card className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-display text-2xl font-bold tabular-nums text-foreground">
        {value}
      </span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </Card>
  )
}

/* --------------------------------------------------------------- badges -- */

/**
 * Which statuses read as "something is happening" and which as "it is done".
 *
 * Data rather than a chain of conditions, because the same mapping is needed
 * on the list, the detail and the dashboard, and three copies drift.
 */
const ORDER_TONE: Readonly<
  Record<StoreOrderStatus, 'neutral' | 'brand' | 'accent'>
> = {
  draft: 'neutral',
  pending: 'brand',
  awaiting_approval: 'accent',
  awaiting_payment: 'accent',
  confirmed: 'brand',
  in_preparation: 'brand',
  ready: 'brand',
  fulfilled: 'neutral',
  completed: 'neutral',
  cancelled: 'neutral',
  refunded: 'neutral',
}

export function OrderStatusBadge({ status }: { status: StoreOrderStatus }) {
  return (
    <Badge tone={ORDER_TONE[status]}>{STORE_ORDER_STATUS_LABEL[status]}</Badge>
  )
}

export function PaymentStatusBadge({
  status,
  mode,
}: {
  status: StorePaymentStatus
  mode?: StoreOrder['paymentMode']
}) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <Badge tone={status === 'paid' ? 'brand' : 'neutral'}>
        {STORE_PAYMENT_STATUS_LABEL[status]}
      </Badge>
      {/* `unpaid` on a `with_booking` order is the ORDINARY state, not a
          problem, and saying which mode it is stops it reading as a debt. */}
      {mode && <span>{STORE_PAYMENT_MODE_LABEL[mode]}</span>}
    </span>
  )
}

export function ItemStatusBadge({ status }: { status: StoreItemStatus }) {
  return (
    <Badge tone={status === 'active' ? 'brand' : 'neutral'}>
      {STORE_ITEM_STATUS_LABEL[status]}
    </Badge>
  )
}

export function AttentionBadge({ attention }: { attention: OrderAttention }) {
  if (attention === 'none') return null
  return <Badge tone="accent">{ORDER_ATTENTION_LABEL[attention]}</Badge>
}

/* ---------------------------------------------------------------- prices -- */

/**
 * A price, said the way the pricing model means it.
 *
 * `quote` renders "לפי הצעת מחיר" and `starting_from` renders "החל מ־", both
 * of which are honest answers rather than missing numbers. Nothing here
 * divides by a hundred — `formatAgorot` is the product's one ₪ formatter.
 */
export function PriceCaption({
  agorot,
  model,
  className,
}: {
  agorot: number | null
  model: StorePricingModel
  className?: string
}) {
  if (model === 'quote' || agorot === null) {
    return (
      <span className={cn('text-sm text-muted-foreground', className)}>
        לפי הצעת מחיר
      </span>
    )
  }

  return (
    <span className={cn('text-sm text-foreground', className)}>
      {priceCaption(model, formatAgorot(agorot))}
    </span>
  )
}

export { Money }
