/**
 * EXECUTION CONTEXT — SERVER ONLY. Every read the laundry screens perform.
 *
 * ── What this file used to be, and why it was wrong ───────────────────────
 *
 * It hand-rolled eight queries — `laundry_settings`, `laundry_item_profiles`,
 * `laundry_orders` twice, `laundry_order_lines` twice, `laundry_providers` and
 * `properties` — and not one of them named `organization_id`. Its own header
 * argued that this was correct: row level security is the filter, and
 * re-filtering here would be "a second copy of that rule, and the second copy
 * is the one that is wrong".
 *
 * That argument is wrong twice, and `src/lib/persistence/finance.ts` makes the
 * case at length. RLS is the floor, never the plan. The policy is the
 * enforcement; the filter is what stops a mistake in a query from becoming a
 * cross-tenant read the first time it runs as `service_role`, which carries
 * BYPASSRLS and is precisely the caller policies cannot stop.
 *
 * And the second reason is the one that is easy to forget: **demo mode has no
 * row level security at all.** `src/lib/demo/client.ts` says so in its own
 * header — there is no policy engine behind those arrays. Every laundry
 * setting of every organization was readable in the demo, and the only thing
 * concealing it was that the dataset ships one organization. The second one
 * would not have been concealed.
 *
 * `loadOrder` was the sharpest edge. It fetched by primary key and let the
 * policy decide, which is the classic insecure-direct-object-reference shape:
 * correct in production, wide open in the demo, and one `service_role` client
 * away from wrong in both. It filters in the query now.
 *
 * ── So the signatures changed, and they had to ────────────────────────────
 *
 * `loadOrders` and `loadOrder` took no actor at all, so they *could not*
 * scope — that is why this was never a one-line fix. Every function here now
 * takes the actor whose organization the read belongs to, and hands it to an
 * adapter that filters. `laundryContext` had the actor already and used it for
 * nothing but a default.
 *
 * ── And the queries themselves are gone ───────────────────────────────────
 *
 * They lived here as raw `supabase.from(...)` chains with their own column
 * lists and their own row mapping, duplicating `SupabaseLaundryRepository`
 * almost line for line. Two copies of one mapping is two places for a column
 * to be renamed and one place for it to be missed, so this file no longer maps
 * anything: it resolves the request's repository, calls it, and translates the
 * one failure the screens render specially.
 *
 * ── The demo dataset gap, kept because it is still reachable ──────────────
 *
 * `DemoDatabase.rows` throws `MissingDemoTable` for a key it has never heard
 * of, deliberately, because answering `[]` would render as "this business has
 * no laundry" — a claim about the customer rather than about the wiring. The
 * five laundry tables are in the dataset now, so this should not fire; it is
 * kept because the screens still render it and because a table added to this
 * module tomorrow would reach it before the dataset caught up. Every other
 * failure propagates.
 */

import { holdsGrant, type Actor } from '@/lib/authz/can'
import {
  defaultSettings,
  resolveSettings,
  type LaundryItemProfile,
  type LaundryOrder,
  type LaundryProvider,
  type LaundryRepository,
  type ResolvedSettings,
} from '@/lib/laundry'
/* -------------------------------------------------------- the demo gap --- */

/**
 * The name of a table the demo dataset has never heard of.
 *
 * Matched on the error's own name rather than by importing `MissingDemoTable`,
 * because `src/lib/demo` must not be imported by a screen — that rule is in
 * the demo's own header and it is a good one.
 */
export type DatasetGap = { table: string; detail: string }

function datasetGapFrom(error: unknown): DatasetGap | null {
  if (typeof error !== 'object' || error === null) return null
  const named = error as { name?: unknown; message?: unknown }
  if (named.name !== 'MissingDemoTable') return null

  const detail = String(named.message ?? '')
  const table = /'([a-z_]+)'/.exec(detail)?.[1] ?? 'unknown'
  return { table, detail }
}

/** Run a read, turning only the demo's missing-table failure into a value. */
async function tolerateDatasetGap<T>(
  read: () => Promise<T>,
): Promise<{ data: T; gap: null } | { data: null; gap: DatasetGap }> {
  try {
    return { data: await read(), gap: null }
  } catch (error) {
    const gap = datasetGapFrom(error)
    if (gap === null) throw error
    return { data: null, gap }
  }
}

/* ------------------------------------------------------------- reads ---- */

export type LaundryContext = {
  settings: ResolvedSettings
  profiles: readonly LaundryItemProfile[]
  gap: DatasetGap | null
}

/**
 * The mode and the item configuration: what every laundry screen needs first.
 *
 * Resolved before anything else, because the mode decides which sections exist
 * at all and a screen that reads orders before knowing the mode has already
 * assumed there are orders.
 *
 * The settings rows are resolved by the domain rather than by a narrowing
 * query — `resolveSettings` picks a property override, else the organization
 * row, else the inert defaults, and says which of the three it was. That is
 * why the read asks for the organization's rows rather than for one of them.
 */
export async function laundryContext(
  repo: LaundryRepository,
  actor: Actor,
  propertyId: string | null,
): Promise<LaundryContext> {
  const settingsRead = await tolerateDatasetGap(() =>
    repo.listSettings(actor.organizationId),
  )

  if (settingsRead.gap !== null) {
    return {
      settings: {
        settings: defaultSettings(actor.organizationId),
        source: 'default',
      },
      profiles: [],
      gap: settingsRead.gap,
    }
  }

  const profileRead = await tolerateDatasetGap(() =>
    repo.listItemProfiles(actor.organizationId),
  )

  return {
    settings: resolveSettings(
      actor.organizationId,
      settingsRead.data,
      propertyId,
    ),
    profiles: profileRead.data ?? [],
    gap: profileRead.gap,
  }
}

export type OrdersRead = {
  orders: readonly LaundryOrder[]
  gap: DatasetGap | null
}

/**
 * Orders with their lines, newest deadline first.
 *
 * `propertyId` narrows without hiding a consolidated run: the adapter reads the
 * property's own orders and the organization's consolidated ones and merges
 * them, because an order that carries this property in its breakdown is
 * exactly the one somebody narrowing to it wants to see.
 *
 * `limit` is required by the port and supplied by each screen. A dashboard's
 * four and a history page's two hundred are different questions, and the
 * adapter refuses to invent an answer to either.
 */
export async function loadOrders(
  repo: LaundryRepository,
  actor: Actor,
  propertyId: string | null,
  limit: number,
): Promise<OrdersRead> {
  const read = await tolerateDatasetGap(() =>
    repo.listOrders(actor.organizationId, { limit, propertyId }),
  )

  return { orders: read.data ?? [], gap: read.gap }
}

/**
 * One order, by id AND by organization.
 *
 * Both filters are in the query. Fetching by primary key and then inspecting
 * the row's organization is the shape that leaks: it reads the row before it
 * decides, and in an environment with no policy engine — the demo — it never
 * decides at all.
 */
export async function loadOrder(
  repo: LaundryRepository,
  actor: Actor,
  id: string,
): Promise<{ order: LaundryOrder | null; gap: DatasetGap | null }> {
  const read = await tolerateDatasetGap(() =>
    repo.loadOrder(actor.organizationId, id),
  )

  return { order: read.data ?? null, gap: read.gap }
}

/**
 * The providers, or `null` when this person may not see them.
 *
 * THE NULL IS THE POINT. A housekeeping supervisor holds `laundry.view` and
 * not `laundry.provider_manage`, and `laundry_providers_select` returns them
 * nothing — so an empty array here would be indistinguishable from a business
 * with no providers, and the screen would tell them something false about their
 * employer rather than something true about their own access.
 *
 * The grant is checked before the query rather than after, so the refusal does
 * not depend on a policy the demo client does not enforce. `client.ts` is
 * explicit that the demo has no RLS; this check is what makes the cleaner's
 * experience honest there too.
 */
export async function loadProviders(
  repo: LaundryRepository,
  actor: Actor,
): Promise<{
  providers: readonly LaundryProvider[] | null
  gap: DatasetGap | null
}> {
  if (!holdsGrant(actor, 'laundry.provider_manage')) {
    return { providers: null, gap: null }
  }

  const read = await tolerateDatasetGap(() =>
    // Inactive providers included: only somebody holding `provider_manage`
    // reaches this line, the providers screen is where one is switched back
    // on, and a provider hidden from its own management screen cannot be.
    repo.listProviders(actor.organizationId, { includeInactive: true }),
  )

  return { providers: read.data ?? [], gap: read.gap }
}

/** Property id → name, for every property in the person's scope. */
export async function propertyNames(
  repo: LaundryRepository,
  actor: Actor,
): Promise<ReadonlyMap<string, string>> {
  return repo.listPropertyNames(actor.organizationId)
}
