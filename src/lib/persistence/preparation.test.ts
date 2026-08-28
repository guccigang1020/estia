/**
 * Stock, and the four ports that have no table to read from.
 */

import { describe, expect, it } from 'vitest'

import { SchemaNotProvisionedError } from './errors'
import { FakeSupabaseClient, hasFilter } from './fake-client'
import { SupabasePreparationPorts } from './preparation'
import type { PreparationSnapshot, WorkPlan } from '../preparation/types'

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

/**
 * The jsonb halves of a catalogue and a snapshot.
 *
 * Deliberately thin. What these tests prove is that the columns are read under
 * the right names and that array and object columns keep their shape; the
 * contents are the domain's own types, already exercised by
 * `src/lib/preparation`'s suite without a database anywhere near them.
 */
const RULESET = {
  bed_types: [{ id: 'double' }],
  rules: [{ id: 'rule-1' }],
  event_templates: [],
  property_configuration: { label: 'וילה' },
  variable_costs: [],
  fixed_costs: [],
  complexity: { perGuest: 1 },
  readiness_policy: { thresholds: {} },
  section_labels: { bedrooms: 'חדרי שינה' },
}

const CATALOGUE_ROW = {
  organization_id: 'org-a',
  property_id: 'prop-a',
  ...RULESET,
  commission_rules: [],
}

const SNAPSHOT_ROW = {
  organization_id: 'org-a',
  property_id: 'prop-a',
  booking_id: 'book-1',
  hash: 'sha256:abc',
  captured_at: '2026-05-01T09:00:00+00:00',
  effective_on: '2026-05-10',
  ...RULESET,
  commission_rule: null,
  price_lines: [],
}

function plan(overrides: Partial<WorkPlan> = {}): WorkPlan {
  return {
    id: 'plan-1',
    organizationId: 'org-a',
    bookingId: 'book-1',
    propertyId: 'prop-a',
    unitId: 'unit-a',
    version: 1,
    snapshotHash: 'sha256:abc',
    createdAt: '2026-05-01T09:00:00.000Z',
    sections: [],
    criticalPathMinutes: 120,
    recommendedStaff: 2,
    ...overrides,
  }
}

function snapshot(
  overrides: Partial<PreparationSnapshot> = {},
): PreparationSnapshot {
  return {
    organizationId: 'org-a',
    hash: 'sha256:abc',
    capturedAt: '2026-05-01T09:00:00.000Z',
    effectiveOn: '2026-05-10',
    bedTypes: [],
    rules: [],
    eventTemplates: [],
    propertyConfiguration:
      {} as unknown as PreparationSnapshot['propertyConfiguration'],
    variableCosts: [],
    fixedCosts: [],
    commissionRule: null,
    complexity: {} as unknown as PreparationSnapshot['complexity'],
    readinessPolicy: {} as unknown as PreparationSnapshot['readinessPolicy'],
    sectionLabels: {} as unknown as PreparationSnapshot['sectionLabels'],
    priceLines: [],
    ...overrides,
  }
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

describe('the catalogue, the snapshot and the plan', () => {
  it('reads a catalogue by organization and property, and carries its jsonb through', async () => {
    const client = new FakeSupabaseClient({
      responses: { preparation_catalogues: { data: CATALOGUE_ROW } },
    })

    const catalogue = await new SupabasePreparationPorts(
      client.asDb(),
    ).loadCatalogue('org-a', 'prop-a')

    expect(catalogue).toMatchObject({
      organizationId: 'org-a',
      rules: [{ id: 'rule-1' }],
      sectionLabels: { bedrooms: 'חדרי שינה' },
    })

    const read = client.queriesFor('preparation_catalogues')[0]
    expect(hasFilter(read, 'eq', 'organization_id', 'org-a')).toBe(true)
    expect(hasFilter(read, 'eq', 'property_id', 'prop-a')).toBe(true)
  })

  it('keeps effective_on a date string rather than parsing it to an instant', async () => {
    // Which rules were in force on the day is a fact about the property's
    // calendar. Parsing it into an instant makes it depend on the server's
    // time zone, and a snapshot that answers differently in two data centres
    // is not a frozen ruleset.
    const client = new FakeSupabaseClient({
      responses: { preparation_snapshots: { data: SNAPSHOT_ROW } },
    })

    const snapshot = await new SupabasePreparationPorts(
      client.asDb(),
    ).loadSnapshot('book-1')

    expect(snapshot?.effectiveOn).toBe('2026-05-10')
    expect(snapshot?.commissionRule).toBeNull()
  })

  it('updates an existing plan rather than upserting over it', async () => {
    // PostgREST compiles an upsert into `insert … on conflict do update`,
    // which needs both policies. 0021 separates them: creating a plan is
    // `task.create`, advancing one is `task.update`/`complete`/`verify`. A
    // cleaner ticking off a section holds the second and not the first.
    const client = new FakeSupabaseClient({
      responses: { 'work_plans:update': { data: [{ id: 'plan-1' }] } },
    })

    await new SupabasePreparationPorts(client.asDb()).savePlan(
      plan(),
      undefined,
    )

    const writes = client.queriesFor('work_plans')
    expect(writes).toHaveLength(1)
    expect(writes[0].verb).toBe('update')
    expect(hasFilter(writes[0], 'eq', 'organization_id', 'org-a')).toBe(true)
  })

  it('inserts when the update matched nothing, and sends the revision either way', async () => {
    // `work_plans.version` is the domain's plan revision, not `tg_touch_row`'s
    // counter — which is why it is written here and is not used as an
    // optimistic predicate. Locking on it would refuse every revision, since
    // the domain advanced it before the record arrived.
    const client = new FakeSupabaseClient({
      responses: {
        'work_plans:update': { data: [] },
        'work_plans:insert': { data: null },
      },
    })

    await new SupabasePreparationPorts(client.asDb()).savePlan(
      plan({ version: 3 }),
      undefined,
    )

    const [update, insert] = client.queriesFor('work_plans')
    expect((update.payload as Record<string, unknown>).version).toBe(3)
    expect(hasFilter(update, 'eq', 'version')).toBe(false)
    expect(insert.verb).toBe('insert')
    expect((insert.payload as Record<string, unknown>).booking_id).toBe(
      'book-1',
    )
  })

  it('reads the snapshot’s property from the booking instead of inventing one', async () => {
    // `property_id` is NOT NULL because both foreign keys are checked against
    // it, and PreparationSnapshot has no property field. The fact exists on a
    // row we already name, so reading it is not a guess — inventing it would
    // let a snapshot claim a booking belongs to a property it does not.
    const client = new FakeSupabaseClient({
      responses: {
        bookings: { data: { property_id: 'prop-a' } },
        preparation_snapshots: { data: null },
      },
    })

    await new SupabasePreparationPorts(client.asDb()).saveSnapshot(
      'book-1',
      snapshot(),
      undefined,
    )

    const write = client.queriesFor('preparation_snapshots')[0]
    const payload = write.payload as Record<string, unknown>
    expect(write.verb).toBe('insert')
    expect(payload.property_id).toBe('prop-a')
    expect(payload.booking_id).toBe('book-1')
  })

  it('refuses to freeze a snapshot against a booking it cannot see', async () => {
    const client = new FakeSupabaseClient({
      responses: { bookings: { data: null } },
    })

    await expect(
      new SupabasePreparationPorts(client.asDb()).saveSnapshot(
        'book-1',
        snapshot(),
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('what preparation still cannot read', () => {
  it('refuses a booking rather than inventing an event type', async () => {
    // 0021 added the catalogue, the snapshot and the plan and deliberately
    // did not touch `bookings`. A plan built for the wrong kind of stay is
    // not noticed until the linen runs out.
    const ports = new SupabasePreparationPorts(new FakeSupabaseClient().asDb())

    const failure = await caught(ports.loadBooking())
    expect(failure).toBeInstanceOf(SchemaNotProvisionedError)
    expect(failure.message).toContain('event type')
  })

  it('refuses allocation contexts rather than deciding what counts as occupied', async () => {
    // What is missing is the rule, not the storage. Whether a cancelled
    // booking is a booking and whether revenue is gross or net are business
    // decisions that change an owner's statement, and a mapping layer must
    // not make them.
    const ports = new SupabasePreparationPorts(new FakeSupabaseClient().asDb())

    const failure = await caught(ports.loadAllocationContexts())
    expect(failure).toBeInstanceOf(SchemaNotProvisionedError)
    expect(failure.message).toContain('cancelled booking counts')
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
