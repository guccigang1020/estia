/**
 * The laundry reads, and the tenant filter they used to be missing.
 *
 * ── The defect this file exists to keep closed ────────────────────────────
 *
 * `queries.ts` issued eight reads and not one named `organization_id`. It
 * argued in its own header that row level security was filter enough. That is
 * wrong on two counts, and the second is the one that bites first:
 *
 *   1. RLS is the floor, never the plan. `service_role` carries BYPASSRLS, and
 *      an explicit filter is what stops a mistake in a query from becoming a
 *      cross-tenant read the first time somebody runs it as one.
 *   2. **Demo mode has no row level security at all.** `src/lib/demo/client.ts`
 *      says so plainly — there is no policy engine behind those arrays. So in
 *      the demo the filter was not a second copy of the rule, it was the ONLY
 *      copy, and it was absent. One demo organization hid that. A second one
 *      would not have.
 *
 * ── Two layers, because one of them can lie ───────────────────────────────
 *
 * The first sweep runs every exported read over `FakeSupabaseClient` and
 * asserts each recorded query carries `eq organization_id`. Written as a sweep
 * rather than one assertion per function on purpose: the ninth query somebody
 * adds next month is covered without anybody remembering to extend this file,
 * which is exactly how the eight got in.
 *
 * But a filter that is present can still be wrong, and a recording client
 * cannot tell. So the second layer runs the same reads over the real demo
 * dataset — the one with no policy engine — and asserts both halves of the
 * claim: the reads still return the rows a screen needs, and the *same* read
 * with another organization's id returns nothing. That second assertion is the
 * vulnerability, executed. Before the fix it returned the whole dataset.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { DemoPlan } from '@/lib/demo/types'
import {
  SupabaseLaundryRepository,
  type LaundryRepository,
} from '@/lib/laundry'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import { FakeSupabaseClient, hasFilter } from '@/lib/persistence/fake-client'

import {
  laundryContext,
  loadOrder,
  loadOrders,
  loadProviders,
  propertyNames,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

/** A tenant that is not the demo's. Nothing may ever come back for it. */
const OTHER_ORGANIZATION = '00000000-0000-4000-8000-0000000000ff'

/** A page size, chosen here the way a screen chooses one. */
const PAGE = 20

/* ------------------------------------------------------------- fixtures -- */

function demoDb(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

function demoRepository(db: Db = demoDb()): LaundryRepository {
  return new SupabaseLaundryRepository(db)
}

function planNamed(code: string): DemoPlan {
  const found = DEMO_PLANS.find((plan) => plan.code === code)
  if (!found) throw new Error(`No demo plan '${code}'`)
  return found
}

/**
 * The actor a persona resolves to, through the ordinary path.
 *
 * The same modules a paying customer's request runs through. Nothing
 * demo-specific is substituted, which is the point.
 */
async function actorFor(
  personaId: string,
  plan: DemoPlan = planNamed('pro'),
): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const source = new DemoActorSource(new SupabaseActorSource(demoDb()), plan)

  const resolution = await resolveActor(source, persona.userId, ORGANIZATION)
  if (!resolution.ok) {
    throw new Error(
      `${persona.label} does not resolve to an actor: ${resolution.reason}`,
    )
  }
  return resolution.actor
}

/**
 * The same person, with another organization's id in the query.
 *
 * Not a fabricated actor: a real, fully resolved one, holding every laundry
 * grant, pointed at a tenant that is not theirs. That is the shape of the
 * attack the filter exists to refuse, and in demo mode there is nothing else
 * standing in its way.
 */
function pointedAt(actor: Actor, organizationId: string): Actor {
  return { ...actor, organizationId }
}

/* ------------------------------------- layer one: the filter is present -- */

/** Everything a laundry read may touch. `organizations` is keyed by `id`. */
const SCOPED_TABLES = [
  'laundry_settings',
  'laundry_providers',
  'laundry_item_profiles',
  'laundry_orders',
  'laundry_order_lines',
  'properties',
]

describe('every read the laundry screens perform', () => {
  it('names organization_id, including any added later', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        laundry_settings: { data: [] },
        laundry_item_profiles: { data: [] },
        laundry_providers: { data: [] },
        // Four reads of this table, in call order: the two `loadOrders` below
        // issue one and two, and `loadOrder` issues the fourth. A list read
        // wants an array and a `maybeSingle` wants `null`, so they are queued
        // rather than shared.
        'laundry_orders:select': [
          { data: [] },
          { data: [] },
          { data: [] },
          { data: null },
        ],
        'laundry_order_lines:select': { data: [] },
        properties: { data: [] },
      } as never,
    })
    const repo = new SupabaseLaundryRepository(client.asDb())
    const actor = await actorFor('owner')

    // Every exported read in `queries.ts`. `loadOrders` returning nothing means
    // no line read follows, so `loadOrder` is called too — it is the one that
    // used to fetch by primary key alone.
    await laundryContext(repo, actor, null)
    await loadOrders(repo, actor, null, PAGE)
    await loadOrders(repo, actor, 'some-property', PAGE)
    await loadOrder(repo, actor, 'some-order')
    await loadProviders(repo, actor)
    await propertyNames(repo, actor)

    const reads = client.queries.filter(
      (query) => query.verb === 'select' && SCOPED_TABLES.includes(query.table),
    )

    expect(reads.length).toBeGreaterThan(6)
    for (const read of reads) {
      expect(
        hasFilter(read, 'eq', 'organization_id', ORGANIZATION),
        `${read.table} was read without an organization_id filter`,
      ).toBe(true)
    }
  })

  it('filters the single-order read in the query, not after it', async () => {
    const client = new FakeSupabaseClient({
      responses: { 'laundry_orders:select': { data: null } } as never,
    })
    const repo = new SupabaseLaundryRepository(client.asDb())
    const actor = await actorFor('owner')

    await loadOrder(repo, actor, 'some-order')

    // Fetching by primary key and *then* comparing the row's organization is
    // the insecure-direct-object-reference shape: it has already read the row
    // by the time it decides, and where there is no policy engine it never
    // decides at all.
    const read = client.queries[0]
    expect(hasFilter(read, 'eq', 'id', 'some-order')).toBe(true)
    expect(hasFilter(read, 'eq', 'organization_id', ORGANIZATION)).toBe(true)
  })
})

/* ----------------------------------- layer two: the filter is the right -- */

describe('over the demo dataset, which has no row level security', () => {
  it('still returns the rows the screens are built to show', async () => {
    const repo = demoRepository()
    const actor = await actorFor('owner')

    const context = await laundryContext(repo, actor, null)
    const { orders } = await loadOrders(repo, actor, null, PAGE)
    const { providers } = await loadProviders(repo, actor)
    const names = await propertyNames(repo, actor)

    // The scoping did not empty the product. Every one of these was a real
    // list before the filter went in and has to still be one after.
    expect(context.gap).toBeNull()
    expect(context.settings.source).not.toBe('default')
    expect(context.profiles.length).toBeGreaterThan(0)
    expect(orders.length).toBeGreaterThan(0)
    expect(providers?.length ?? 0).toBeGreaterThan(0)
    expect(names.size).toBeGreaterThan(0)
  })

  it('carries the lines with the orders, and the sum the database generates', async () => {
    const repo = demoRepository()
    const actor = await actorFor('owner')

    const { orders } = await loadOrders(repo, actor, null, PAGE)
    const withLines = orders.find((order) => order.lines.length > 0)

    expect(withLines, 'no demo order carries lines').toBeDefined()
    for (const line of withLines?.lines ?? []) {
      expect(line.quantity.final).toBe(
        line.quantity.calculated + line.quantity.adjustment,
      )
    }
  })

  it('hands another organization nothing at all', async () => {
    const repo = demoRepository()
    const owner = await actorFor('owner')
    const intruder = pointedAt(owner, OTHER_ORGANIZATION)

    const context = await laundryContext(repo, intruder, null)
    const { orders } = await loadOrders(repo, intruder, null, PAGE)
    const { providers } = await loadProviders(repo, intruder)
    const names = await propertyNames(repo, intruder)

    // THIS IS THE DEFECT, EXECUTED. Before the filter, every one of these
    // returned the demo organization's rows to a caller who named a different
    // tenant, because there is no policy behind the demo client to say no.
    expect(orders).toEqual([])
    expect(providers).toEqual([])
    expect(names.size).toBe(0)
    expect(context.profiles).toEqual([])
    // No settings row for that tenant resolves to the inert defaults — `off`,
    // and not the demo business's real configuration.
    expect(context.settings.source).toBe('default')
    expect(context.settings.settings.mode).toBe('off')
  })

  it('refuses a real order id to a caller from another organization', async () => {
    const repo = demoRepository()
    const owner = await actorFor('owner')

    const { orders } = await loadOrders(repo, owner, null, PAGE)
    const real = orders[0]
    expect(real, 'the demo dataset has no laundry orders').toBeDefined()

    // The same id the owner can open. The only thing that differs is which
    // tenant is asking, and that is the whole of the check.
    const mine = await loadOrder(repo, owner, real!.id)
    const theirs = await loadOrder(
      repo,
      pointedAt(owner, OTHER_ORGANIZATION),
      real!.id,
    )

    expect(mine.order?.id).toBe(real!.id)
    expect(theirs.order).toBeNull()
  })
})

/* ------------------------------------------- the refusal that is not an -- */

describe('a person who may not see the providers', () => {
  it('is told null rather than "this business has none"', async () => {
    const repo = demoRepository()
    const supervisor = await actorFor('housekeeping-supervisor')

    const { providers } = await loadProviders(repo, supervisor)

    // `null`, never `[]`. An empty array would tell a housekeeping supervisor
    // something false about their employer instead of something true about
    // their own access — and the grant is checked before the query, so the
    // answer does not depend on a policy the demo client does not enforce.
    expect(providers).toBeNull()
  })

  it('and the owner, who may, gets the list', async () => {
    const repo = demoRepository()
    const owner = await actorFor('owner')

    const { providers } = await loadProviders(repo, owner)

    expect(providers).not.toBeNull()
    expect(providers?.length ?? 0).toBeGreaterThan(0)
  })
})
