/**
 * The fact sources, over the recording client.
 *
 * Same limitation `fake-client.ts` states plainly: this cannot prove a column
 * name — a select naming the wrong column is named wrongly consistently, and
 * only the live integration suite catches that. What it proves is the two
 * things worth proving without a database:
 *
 *   · every read is scoped by `organization_id`, which is a tenant isolation
 *     claim;
 *   · the four fact shapes nothing can supply answer `null` and not `[]`,
 *     because "we did not look" and "there is nothing" are different claims
 *     and collapsing them is how a business is told it is fine.
 */

import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient, hasFilter } from '../../persistence/fake-client'
import { NO_MODULES } from '../signals'

import { SupabaseFactPorts, UNSOURCED_FACTS, type FactScope } from './ports'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROPERTY = '22222222-2222-4222-8222-222222222222'

function scope(): FactScope {
  return {
    organizationId: ORG,
    propertyId: null,
    from: new Date('2026-09-06T09:00:00.000Z'),
    to: new Date('2026-09-09T09:00:00.000Z'),
    modules: NO_MODULES,
    pageSize: 50,
  }
}

describe('the fact shapes with no source', () => {
  it('answer null rather than an empty list', async () => {
    const ports = new SupabaseFactPorts(new FakeSupabaseClient().asDb())

    expect(await ports.loadPayments()).toBeNull()
    expect(await ports.loadShortages()).toBeNull()
    expect(await ports.loadAccess()).toBeNull()
    expect(await ports.loadEmptyNights()).toBeNull()
  })

  it('each states why, for the report and for the screen', () => {
    for (const key of ['payment', 'inventory', 'access', 'opportunity']) {
      expect(UNSOURCED_FACTS[key]).toBeTypeOf('string')
    }
  })
})

describe('tenant scoping', () => {
  it('filters cleaning by organization as well as relying on the policy', async () => {
    const client = new FakeSupabaseClient({
      responses: { tasks: { data: [] }, properties: { data: [] } },
    })

    await new SupabaseFactPorts(client.asDb()).loadCleaning(scope())

    const tasks = client.queries.filter((query) => query.table === 'tasks')
    expect(tasks).toHaveLength(1)
    expect(hasFilter(tasks[0], 'eq', 'organization_id', ORG)).toBe(true)
    // Soft-deleted work is not work anybody has to do.
    expect(hasFilter(tasks[0], 'is', 'deleted_at', null)).toBe(true)
  })

  it('narrows to one property when the pass names one', async () => {
    const client = new FakeSupabaseClient({
      responses: { tasks: { data: [] }, properties: { data: [] } },
    })

    await new SupabaseFactPorts(client.asDb()).loadMaintenance({
      ...scope(),
      propertyId: PROPERTY,
    })

    const tasks = client.queries.filter((query) => query.table === 'tasks')
    expect(hasFilter(tasks[0], 'eq', 'property_id', PROPERTY)).toBe(true)
  })

  it('scopes the laundry read and keeps consolidated orders in view', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        laundry_orders: { data: [] },
        properties: { data: [] },
        laundry_providers: { data: [] },
      },
    })

    await new SupabaseFactPorts(client.asDb()).loadLaundry({
      ...scope(),
      propertyId: PROPERTY,
    })

    const orders = client.queries.filter(
      (query) => query.table === 'laundry_orders',
    )
    expect(hasFilter(orders[0], 'eq', 'organization_id', ORG)).toBe(true)
    // A consolidated order carries `property_id` NULL and must not vanish when
    // somebody narrows to one of the properties in it.
    expect(
      orders[0]?.filters.some(
        (filter) =>
          filter.op === 'or' && String(filter.value).includes('is.null'),
      ),
    ).toBe(true)
  })
})

describe('the modules record', () => {
  it('reads what is switched on rather than what was bought', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        laundry_settings: { data: [] },
        inventory_settings: { data: null },
        payment_collection_settings: { data: [] },
        preparation_catalogues: { data: [] },
        guest_journey_settings: { data: null },
      },
    })

    const modules = await new SupabaseFactPorts(client.asDb()).modules(ORG, {
      cleaning: true,
      inspection: false,
      maintenance: true,
      access: false,
    })

    // Nothing configured: every module the schema can answer for is off, and
    // the four the schema cannot answer for are exactly what the caller said.
    expect(modules.laundry).toBe('off')
    expect(modules.inventory.enabled).toBe(false)
    expect(modules.payments).toBe(false)
    expect(modules.preparation).toBe(false)
    expect(modules.guest_portal).toBe(false)
    expect(modules.contracts).toBe(false)
    expect(modules.cleaning).toBe(true)
    expect(modules.inspection).toBe(false)
    expect(modules.maintenance).toBe(true)
    expect(modules.access).toBe(false)
  })
})
