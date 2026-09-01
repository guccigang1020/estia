/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of every store screen.
 *
 * Thin on purpose. The reasoning lives in `src/lib/store` — the eligibility
 * engine, the ranker, the attention rules — and this file assembles what one
 * screen needs from it. A query file that started deciding what an order needs
 * would be a second place that decision lives.
 *
 * ── Failures are values, not exceptions ───────────────────────────────────
 *
 * Each loader returns whatever it could read. A screen that cannot read
 * providers because the reader lacks `provider.manage` gets an empty list and
 * says so honestly — an RLS refusal is the policy working, not an outage, and
 * it must not blank a page that has five other panels on it.
 */

import type { Actor } from '@/lib/authz/can'
import { holdsGrant } from '@/lib/authz/can'
import type { Db } from '@/lib/persistence'
import {
  StoreRepository,
  isOverdue,
  orderAttention,
  storeCapabilities,
  type CatalogueItem,
  type OrderAttention,
  type StoreCategory,
  type StoreOrder,
  type StorePackage,
  type StoreProvider,
  type StoreSettings,
} from '@/lib/store'

/* ------------------------------------------------------------- overview -- */

export type StoreOverview = {
  settings: StoreSettings
  /** Everything the mode makes available. Drives what the section shows. */
  capabilities: ReturnType<typeof storeCapabilities>
  itemCount: number
  activeItemCount: number
  categoryCount: number
  packageCount: number
  /** Orders needing a person, most recent first. */
  needsAttention: readonly { order: StoreOrder; attention: OrderAttention }[]
  openOrderCount: number
  /** Committed money not yet settled, in agorot. */
  outstandingAgorot: number
  /** What the store has sold in the last thirty days, in agorot. */
  soldLast30Agorot: number
}

const THIRTY_DAYS_MS = 30 * 24 * 3_600_000

export async function loadOverview(input: {
  db: Db
  actor: Actor
  propertyId: string | null
  now: Date
}): Promise<StoreOverview> {
  const repository = new StoreRepository(input.db)
  const organizationId = input.actor.organizationId

  const settings = await repository.settings({
    organizationId,
    propertyId: input.propertyId,
  })

  const capabilities = storeCapabilities(settings.mode)

  // Nothing further is worth reading for a store that is switched off, and the
  // screen's whole job in that state is to offer to switch it on.
  if (!capabilities.visible) {
    return {
      settings,
      capabilities,
      itemCount: 0,
      activeItemCount: 0,
      categoryCount: 0,
      packageCount: 0,
      needsAttention: [],
      openOrderCount: 0,
      outstandingAgorot: 0,
      soldLast30Agorot: 0,
    }
  }

  const [items, categories, packages, orders] = await Promise.all([
    repository.items({ organizationId }),
    repository.categories(organizationId),
    repository.packages(organizationId),
    holdsGrant(input.actor, 'order.view')
      ? repository.orders({
          organizationId,
          propertyId: input.propertyId,
          limit: 200,
        })
      : Promise.resolve([] as StoreOrder[]),
  ])

  const live = orders.filter(
    (order) => order.status !== 'cancelled' && order.status !== 'refunded',
  )

  const needsAttention = orders
    .map((order) => ({
      order,
      attention: orderAttention({
        status: order.status,
        requestedForDate: order.requestedForDate,
        // Provider confirmation is read on the order detail rather than here:
        // one query per order on a list screen is the shape that makes a
        // dashboard slow, and the list already shows approval and payment.
        hasUnconfirmedProvider: false,
        now: input.now,
      }),
    }))
    .filter((entry) => entry.attention !== 'none')

  const since = input.now.getTime() - THIRTY_DAYS_MS

  return {
    settings,
    capabilities,
    itemCount: items.length,
    activeItemCount: items.filter((item) => item.status === 'active').length,
    categoryCount: categories.length,
    packageCount: packages.length,
    needsAttention,
    openOrderCount: live.filter(
      (order) => order.status !== 'completed' && order.status !== 'fulfilled',
    ).length,
    // Committed and not yet paid. `unpaid` on a confirmed order is the
    // ordinary state of `with_booking`, so this is a figure to know rather
    // than a problem to solve — the screen says so.
    outstandingAgorot: live
      .filter((order) => order.paymentStatus === 'unpaid')
      .reduce((sum, order) => sum + order.totalAgorot, 0),
    soldLast30Agorot: live
      .filter((order) => Date.parse(order.createdAt) >= since)
      .reduce((sum, order) => sum + order.totalAgorot, 0),
  }
}

/* ------------------------------------------------------------- catalogue -- */

export type CatalogueView = {
  settings: StoreSettings
  items: readonly CatalogueItem[]
  categories: readonly StoreCategory[]
  packages: readonly StorePackage[]
  /** Empty where the reader does not hold `provider.manage`. Not an error. */
  providers: readonly StoreProvider[]
  /** True where the reader may see and change a price. */
  mayPrice: boolean
}

export async function loadCatalogue(input: {
  db: Db
  actor: Actor
  propertyId: string | null
}): Promise<CatalogueView> {
  const repository = new StoreRepository(input.db)
  const organizationId = input.actor.organizationId

  const [settings, items, categories, packages, providers] = await Promise.all([
    repository.settings({ organizationId, propertyId: input.propertyId }),
    repository.items({ organizationId }),
    repository.categories(organizationId),
    repository.packages(organizationId),
    holdsGrant(input.actor, 'provider.manage')
      ? repository.providers(organizationId)
      : Promise.resolve([] as StoreProvider[]),
  ])

  return {
    settings,
    items,
    categories,
    packages,
    providers,
    mayPrice: holdsGrant(input.actor, 'product.price_manage'),
  }
}

/* ---------------------------------------------------------------- orders -- */

export type OrderListRow = {
  order: StoreOrder
  attention: OrderAttention
  overdue: boolean
}

export type OrderListView = {
  settings: StoreSettings
  rows: readonly OrderListRow[]
  /** Every status present in the unfiltered set, for the filter chips. */
  statuses: readonly string[]
  /** True when the organization has never taken an order at all. */
  neverAnyOrders: boolean
}

export async function loadOrders(input: {
  db: Db
  actor: Actor
  propertyId: string | null
  status?: string | null
  now: Date
}): Promise<OrderListView> {
  const repository = new StoreRepository(input.db)
  const organizationId = input.actor.organizationId

  const [settings, all] = await Promise.all([
    repository.settings({ organizationId, propertyId: input.propertyId }),
    repository.orders({
      organizationId,
      propertyId: input.propertyId,
      limit: 200,
    }),
  ])

  // Filtered in memory rather than in a second query, so the chips can show
  // which statuses actually exist — and so an empty result reads as "nothing
  // matched this filter" rather than as "you have never taken an order",
  // which is the distinction `ModuleEmptyState` exists to protect.
  const filtered = input.status
    ? all.filter((order) => order.status === input.status)
    : all

  return {
    settings,
    rows: filtered.map((order) => ({
      order,
      attention: orderAttention({
        status: order.status,
        requestedForDate: order.requestedForDate,
        hasUnconfirmedProvider: false,
        now: input.now,
      }),
      overdue: isOverdue({
        status: order.status,
        requestedForDate: order.requestedForDate,
        now: input.now,
      }),
    })),
    statuses: [...new Set(all.map((order) => order.status))],
    neverAnyOrders: all.length === 0,
  }
}

/* ----------------------------------------------------------- order detail -- */

export type OrderDetailView = {
  settings: StoreSettings
  order: StoreOrder
  payments: Awaited<ReturnType<StoreRepository['payments']>>
  amendments: Awaited<ReturnType<StoreRepository['amendments']>>
  providerRequests: Awaited<ReturnType<StoreRepository['providerRequests']>>
  providers: readonly StoreProvider[]
  attention: OrderAttention
}

export async function loadOrderDetail(input: {
  db: Db
  actor: Actor
  orderId: string
  now: Date
}): Promise<OrderDetailView | null> {
  const repository = new StoreRepository(input.db)
  const organizationId = input.actor.organizationId

  const order = await repository.order({
    organizationId,
    orderId: input.orderId,
  })
  if (!order) return null

  const [settings, payments, amendments, providerRequests, providers] =
    await Promise.all([
      repository.settings({
        organizationId,
        propertyId: order.propertyId,
      }),
      repository.payments({ organizationId, orderId: order.id }),
      repository.amendments({ organizationId, orderId: order.id }),
      repository.providerRequests({ organizationId, orderId: order.id }),
      holdsGrant(input.actor, 'provider.manage')
        ? repository.providers(organizationId)
        : Promise.resolve([] as StoreProvider[]),
    ])

  return {
    settings,
    order,
    payments,
    amendments,
    providerRequests,
    providers,
    attention: orderAttention({
      status: order.status,
      requestedForDate: order.requestedForDate,
      hasUnconfirmedProvider: providerRequests.some(
        (request) =>
          request.status === 'sent' || request.status === 'unconfirmed',
      ),
      now: input.now,
    }),
  }
}
