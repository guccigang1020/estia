/**
 * The stock reads, walked the way the product walks them.
 *
 * Three things are being proved here and they are not the same thing.
 *
 * 1. **The three quantities.** `quantity`, `quantity_reserved` and what is
 *    therefore free. A screen showing only the first shows sufficient stock
 *    right up to the morning two events need the same twenty mattresses, and
 *    `quantity_reserved` exists in 0011 for exactly that.
 *
 * 2. **The team-scoped reader reaches nothing, honestly.** `inventory_items`
 *    has no `team_id`, so `can()` refuses a team scope over it — and the
 *    handyman *does* hold `inventory.view`. An empty list for him is the
 *    correct answer and it must arrive by the scope refusing, not by a query
 *    naming a column that is not there.
 *
 * 3. **The money is withheld as absent keys.** A blank cell in a money column
 *    reads as ₪0, which is a number and a wrong one.
 *
 * Not a test of row level security — `createDemoClient` has no policy engine
 * behind it. What is exercised is the floor above: the narrowing, the `can()`
 * per row, and the `redact()` field rules.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PLANS } from '@/lib/demo/dataset'
import { person } from '@/lib/demo/dataset-identity'
import { PROPERTY_IDS } from '@/lib/demo/dataset-inventory'
import { DemoActorSource } from '@/lib/demo/session'
import { INVENTORY_STATES } from '@/lib/contracts/states'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import { NO_INVENTORY_FILTER } from './filters'
import {
  INVENTORY_MOVEMENT_KINDS,
  countInventoryItems,
  itemsBelowReorderPoint,
  listInventoryItems,
  listMovements,
  type InventoryListItem,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

async function actorFor(key: string): Promise<Actor> {
  const plan = DEMO_PLANS.find((entry) => entry.code === 'pro')
  if (!plan) throw new Error("No demo plan 'pro'")

  const resolution = await resolveActor(
    new DemoActorSource(new SupabaseActorSource(client()), plan),
    person(key).userId,
    ORGANIZATION,
  )
  if (!resolution.ok) {
    throw new Error(`${key} does not resolve to an actor: ${resolution.reason}`)
  }
  return resolution.actor
}

async function stockFor(key: string): Promise<readonly InventoryListItem[]> {
  return listInventoryItems({
    db: client(),
    actor: await actorFor(key),
    propertyId: null,
    filter: NO_INVENTORY_FILTER,
  })
}

function seeded(table: string): number {
  return DEMO_DATASET.tables[table]?.length ?? 0
}

describe('the stock list', () => {
  it('serves the owner every seeded item', async () => {
    const items = await stockFor('owner')

    expect(items).toHaveLength(seeded('inventory_items'))
    expect(items.length).toBeGreaterThanOrEqual(10)

    for (const item of items) {
      expect(typeof item.name).toBe('string')
      expect(typeof item.unitOfMeasure).toBe('string')
      expect(Number.isInteger(item.quantity)).toBe(true)
      expect(Number.isInteger(item.quantityReserved)).toBe(true)
      expect(INVENTORY_STATES).toContain(item.state)
      expect(item.propertyName).toEqual(expect.any(String))
    }
  })

  it('computes what is free rather than printing only what is held', async () => {
    const items = await stockFor('owner')
    const reserved = items.filter((item) => item.quantityReserved > 0)

    // If nothing were ever reserved the column would be untested, and the
    // whole point of `quantity_reserved` is the row where it is not zero.
    expect(reserved.length).toBeGreaterThan(0)

    for (const item of items) {
      expect(item.quantityFree).toBe(item.quantity - item.quantityReserved)
      // `inventory_items_reserved_within_quantity` guarantees this at the
      // database. If it ever failed, a negative here is how it would be found.
      expect(item.quantityFree).toBeGreaterThanOrEqual(0)
    }
  })

  it('flags the items at or below their reorder point, and only those', async () => {
    const items = await stockFor('owner')
    const short = itemsBelowReorderPoint(items)

    expect(short.length).toBeGreaterThan(0)
    expect(
      short.every(
        (item) =>
          item.minQuantity !== null && item.quantity <= item.minQuantity,
      ),
    ).toBe(true)
    // An item nobody set a minimum for is not short. Guessing one would put a
    // permanent warning on the screen, which is how a warning stops being read.
    expect(short.every((item) => item.minQuantity !== null)).toBe(true)
  })

  it('filters by state', async () => {
    const laundry = await listInventoryItems({
      db: client(),
      actor: await actorFor('owner'),
      propertyId: null,
      filter: { state: 'laundry' },
    })

    expect(laundry.length).toBeGreaterThan(0)
    expect(laundry.every((item) => item.state === 'laundry')).toBe(true)
  })

  it('narrows to one property when the shell switcher has', async () => {
    const items = await listInventoryItems({
      db: client(),
      actor: await actorFor('owner'),
      propertyId: PROPERTY_IDS.kacholYam,
      filter: NO_INVENTORY_FILTER,
    })

    expect(items.length).toBeGreaterThan(0)
    expect(
      items.every((item) => item.propertyId === PROPERTY_IDS.kacholYam),
    ).toBe(true)
  })
})

describe('the ledger under the table', () => {
  it('reads the movements for the items on screen, newest first', async () => {
    const db = client()
    const items = await stockFor('owner')
    const movements = await listMovements(db, ORGANIZATION, items)

    expect(movements).toHaveLength(seeded('inventory_movements'))

    for (const movement of movements) {
      expect(INVENTORY_MOVEMENT_KINDS).toContain(movement.kind)
      expect(Number.isInteger(movement.quantityDelta)).toBe(true)
      // `inventory_movements_delta_nonzero`: a movement of nothing is not a
      // movement, and one would corrupt every running total.
      expect(movement.quantityDelta).not.toBe(0)
      expect(movement.occurredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(movement.itemName).toEqual(expect.any(String))
    }

    for (let index = 1; index < movements.length; index += 1) {
      expect(
        movements[index - 1].occurredOn >= movements[index].occurredOn,
      ).toBe(true)
    }
  })

  it('carries both directions, signed', async () => {
    const movements = await listMovements(
      client(),
      ORGANIZATION,
      await stockFor('owner'),
    )

    expect(movements.some((movement) => movement.quantityDelta > 0)).toBe(true)
    expect(movements.some((movement) => movement.quantityDelta < 0)).toBe(true)
  })

  it('asks for nothing when the reader has no items', async () => {
    // `in.()` with no values is not a query worth issuing, and asking it would
    // turn an empty page into an error.
    expect(await listMovements(client(), ORGANIZATION, [])).toEqual([])
  })
})

describe('who may see the stock', () => {
  it('refuses the cleaner, who holds no inventory grant at all', async () => {
    const actor = await actorFor('housekeeping')
    expect(holdsGrant(actor, 'inventory.view')).toBe(false)

    // The route guard refuses her first. This proves the query underneath
    // would refuse her too, so the two floors agree.
    expect(await stockFor('housekeeping')).toHaveLength(0)
  })

  it('returns nothing to the handyman, because stock belongs to no team', async () => {
    // He *does* hold `inventory.view`. What he does not have is a scope that
    // reaches a property-anchored row: `scopeReaches` answers a `team` scope by
    // looking for `resource.teamId`, and `inventory_items` has no `team_id`.
    // Empty is the correct answer, and the screen says which kind of empty.
    const actor = await actorFor('maintenance')
    expect(holdsGrant(actor, 'inventory.view')).toBe(true)
    expect(actor.scope.kind).toBe('team')

    expect(await stockFor('maintenance')).toHaveLength(0)
    expect(
      await countInventoryItems({
        db: client(),
        actor,
        propertyId: null,
      }),
    ).toBe(0)
  })

  it('confines the property manager to her property', async () => {
    const items = await stockFor('property-manager')

    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThan(seeded('inventory_items'))
    expect(
      items.every((item) => item.propertyId === PROPERTY_IDS.rimonim),
    ).toBe(true)

    const reachable = await countInventoryItems({
      db: client(),
      actor: await actorFor('property-manager'),
      propertyId: null,
    })
    expect(reachable).toBe(items.length)
  })
})

describe('the money on a stock row', () => {
  it('values the stock for a reader with expense.view', async () => {
    const actor = await actorFor('property-manager')
    expect(holdsGrant(actor, 'expense.view')).toBe(true)

    const items = await stockFor('property-manager')
    const priced = items.filter((item) => item.unitCostAgorot !== null)

    expect(priced.length).toBeGreaterThan(0)
    for (const item of priced) {
      expect(Number.isInteger(item.unitCostAgorot)).toBe(true)
      expect(item.valueAgorot).toBe(
        (item.unitCostAgorot as number) * item.quantity,
      )
    }
  })

  it('withholds it as absent keys from a reader who may count but not price', async () => {
    /**
     * The role the catalogue permits and this dataset does not seed.
     *
     * `housekeeping_supervisor` holds `inventory.view` and `inventory.edit` and
     * no expense grant — she counts the linen and orders more, and what the
     * business paid per set is not her screen. No demo persona carries that
     * role with a scope that reaches stock, so the actor is derived from a real
     * one by removing the one grant, which is exactly what a business composing
     * that role would produce. Everything else about the actor — the
     * membership, the scope, the plan — is the dataset's own.
     */
    const owner = await actorFor('owner')
    const grants = new Set(owner.grants)
    grants.delete('expense.view')
    const counter = { ...owner, grants }

    expect(holdsGrant(counter, 'inventory.view')).toBe(true)
    expect(holdsGrant(counter, 'expense.view')).toBe(false)

    const items = await listInventoryItems({
      db: client(),
      actor: counter,
      propertyId: null,
      filter: NO_INVENTORY_FILTER,
    })

    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      // Gone, not zero. `Money` prints "לא זמין לצפייה"; an empty cell in a
      // money column would read as ₪0, which is a number and a wrong one.
      expect('unitCostAgorot' in item).toBe(false)
      expect('valueAgorot' in item).toBe(false)
      // The counting half of her job is untouched.
      expect(Number.isInteger(item.quantity)).toBe(true)
      expect(Number.isInteger(item.quantityFree)).toBe(true)
    }
  })
})
