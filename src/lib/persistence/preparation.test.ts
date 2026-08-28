/**
 * Stock, and the four ports that have no table to read from.
 */

import { describe, expect, it } from 'vitest'

import { SchemaNotProvisionedError } from './errors'
import { FakeSupabaseClient, hasFilter } from './fake-client'
import { SupabasePreparationPorts } from './preparation'

const ITEM_ROW = {
  id: 'item-1',
  organization_id: 'org-a',
  property_id: 'prop-a',
  name: 'מגבת גדולה',
  state: 'available',
  quantity: 24,
  quantity_reserved: 6,
  min_quantity: 8,
}

describe('SupabasePreparationPorts.loadStock', () => {
  it('maps an inventory row to a stock level', async () => {
    const client = new FakeSupabaseClient({
      responses: { inventory_items: { data: [ITEM_ROW] } },
    })

    const stock = await new SupabasePreparationPorts(client.asDb()).loadStock(
      'prop-a',
    )

    expect(stock).toEqual([
      {
        itemId: 'item-1',
        label: 'מגבת גדולה',
        location: { kind: 'property', propertyId: 'prop-a' },
        onHand: 24,
        reserved: 6,
        // `min_quantity` and not `par_level`. The floor a business keeps for
        // the booking it has not taken yet is a different number from the
        // level it reorders up to, and using the second would report a safety
        // breach every time stock dipped below the reorder point.
        safetyStock: 8,
        byState: { available: 24 },
      },
    ])
  })

  it('treats an absent min_quantity as no floor rather than as a breach', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        inventory_items: { data: [{ ...ITEM_ROW, min_quantity: null }] },
      },
    })

    const [level] = await new SupabasePreparationPorts(client.asDb()).loadStock(
      'prop-a',
    )

    expect(level.safetyStock).toBe(0)
  })

  it('excludes soft-deleted items, because a deleted item is not stock', async () => {
    const client = new FakeSupabaseClient({
      responses: { inventory_items: { data: [] } },
    })

    await new SupabasePreparationPorts(client.asDb()).loadStock('prop-a')

    const read = client.queriesFor('inventory_items')[0]
    expect(hasFilter(read, 'is', 'deleted_at', null)).toBe(true)
    expect(hasFilter(read, 'eq', 'property_id', 'prop-a')).toBe(true)
  })

  it('looks elsewhere in the organization for transferrable stock', async () => {
    // The alternative to a transfer is a purchase. A business with forty
    // spare towels in the next village should be told before it buys more.
    const client = new FakeSupabaseClient({
      responses: { inventory_items: { data: [] } },
    })

    await new SupabasePreparationPorts(client.asDb()).loadTransferrableStock(
      'org-a',
      'prop-a',
    )

    const read = client.queriesFor('inventory_items')[0]
    expect(hasFilter(read, 'eq', 'organization_id', 'org-a')).toBe(true)
    expect(hasFilter(read, 'neq', 'property_id', 'prop-a')).toBe(true)
  })
})

describe('what preparation cannot store yet', () => {
  it('refuses a work plan rather than projecting one onto tasks', async () => {
    // The projection would almost work, which is what makes it dangerous. A
    // WorkPlan is a versioned artefact with a frozen snapshot beside it, and
    // the snapshot is the whole mechanism that stops historical drift —
    // `tasks` can hold neither. The loss would surface as a slowly wrong
    // number on an owner's statement months later.
    const ports = new SupabasePreparationPorts(new FakeSupabaseClient().asDb())

    await expect(ports.loadPlan()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
    await expect(ports.loadSnapshot()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
    await expect(ports.loadCatalogue()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
    await expect(ports.loadBooking()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
  })

  it('says so in the message, naming tasks as the thing it will not use', async () => {
    const ports = new SupabasePreparationPorts(new FakeSupabaseClient().asDb())
    const failure = await caught(ports.loadPlan())
    expect(failure.message).toContain('public.tasks is not the same thing')
  })

  it('still hands out plan ids, because that was never storage', () => {
    const ports = new SupabasePreparationPorts(new FakeSupabaseClient().asDb())
    expect(ports.nextPlanId()).not.toBe(ports.nextPlanId())
  })
})

/**
 * The error a promise rejected with.
 *
 * A plain `.catch(e => e)` types as `T | unknown` and every assertion after it
 * needs a cast; this says once that the promise is expected to reject, and
 * fails the test with a useful sentence when it does not.
 */
async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('Expected the call to reject, and it resolved.')
}
