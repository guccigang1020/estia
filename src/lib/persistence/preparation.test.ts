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
    facts: {
      arrivalAt: '2026-05-10T12:00:00.000Z',
      eventType: 'accommodation',
      specialRequests: null,
      guests: 2,
      adults: 2,
      children: 0,
    },
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

describe('the facts and the revision on a plan', () => {
  const FACTS = {
    arrivalAt: '2026-05-10T12:00:00.000Z',
    eventType: 'shabbat' as const,
    specialRequests: 'שתי מיטות תינוק',
    guests: 7,
    adults: 4,
    children: 2,
  }

  it('writes the frozen booking facts, so a cleaner never needs the booking', async () => {
    const client = new FakeSupabaseClient({
      responses: { work_plans: { data: [{ id: 'plan-1' }] } },
    })

    await new SupabasePreparationPorts(client.asDb()).savePlan(
      plan({ facts: FACTS }),
      undefined,
    )

    const write = client.queriesFor('work_plans')[0]
    expect(write.payload).toMatchObject({
      arrival_at: '2026-05-10T12:00:00.000Z',
      event_type: 'shabbat',
      special_requests: 'שתי מיטות תינוק',
      guests: 7,
      adults: 4,
      children: 2,
    })
  })

  it('leaves the columns alone for a plan that carries no facts', async () => {
    // A plan stored before 0036. Writing five explicit nulls over its columns
    // would be this adapter deciding that "not computed yet" means "none",
    // and the common write here is a cleaner ticking a section off.
    const client = new FakeSupabaseClient({
      responses: { work_plans: { data: [{ id: 'plan-1' }] } },
    })

    await new SupabasePreparationPorts(client.asDb()).savePlan(
      plan({ facts: null }),
      undefined,
    )

    const write = client.queriesFor('work_plans')[0]
    expect(write.payload).not.toHaveProperty('arrival_at')
    expect(write.payload).not.toHaveProperty('guests')
  })

  it('writes the account of what moved when the caller names a revision', async () => {
    // `delta`, `supersedes_version`, `change_reason` and `changed_by` have
    // existed since 0021 and nothing wrote them, so every revision reached
    // `work_plan_versions` with no account of why.
    const client = new FakeSupabaseClient({
      responses: { work_plans: { data: [{ id: 'plan-1' }] } },
    })

    await new SupabasePreparationPorts(client.asDb()).savePlan(
      plan({ version: 2 }),
      undefined,
      {
        delta: { fromVersion: 1, toVersion: 2 } as never,
        supersedesVersion: 1,
        reason: 'ההזמנה גדלה',
        changedByUserId: 'user-1',
      },
    )

    const write = client.queriesFor('work_plans')[0]
    expect(write.payload).toMatchObject({
      supersedes_version: 1,
      change_reason: 'ההזמנה גדלה',
      changed_by: 'user-1',
    })
  })

  it('does not touch the revision columns when no revision is named', async () => {
    // Ticking a section off supersedes nothing and must not overwrite the
    // delta that explains the last real change.
    const client = new FakeSupabaseClient({
      responses: { work_plans: { data: [{ id: 'plan-1' }] } },
    })

    await new SupabasePreparationPorts(client.asDb()).savePlan(
      plan(),
      undefined,
    )

    const write = client.queriesFor('work_plans')[0]
    expect(write.payload).not.toHaveProperty('delta')
    expect(write.payload).not.toHaveProperty('change_reason')
  })

  it('reads a pre-0036 row back as a plan with no facts, not half a set', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        work_plans: {
          data: {
            id: 'plan-1',
            organization_id: 'org-a',
            booking_id: 'book-1',
            property_id: 'prop-a',
            unit_id: 'unit-a',
            version: 1,
            snapshot_hash: 'sha256:abc',
            created_at: '2026-05-01T09:00:00+00:00',
            sections: [],
            critical_path_minutes: 120,
            recommended_staff: 2,
          },
        },
      },
    })

    const stored = await new SupabasePreparationPorts(client.asDb()).loadPlan(
      'book-1',
    )

    expect(stored?.facts).toBeNull()
  })
})

describe('SupabasePreparationPorts.loadBooking', () => {
  const BOOKING_ROW = {
    id: 'book-1',
    organization_id: 'org-a',
    property_id: 'prop-a',
    unit_id: 'unit-a',
    check_in: '2026-05-10',
    check_out: '2026-05-12',
    arrival_time: '16:30:00',
    adults: 4,
    children: 2,
    infants: 1,
    couples: 2,
    extra_beds_requested: 1,
    cots_requested: 2,
    event_type: 'shabbat',
    special_requests: 'שתי מיטות תינוק',
  }

  function client(overrides: Record<string, unknown> = {}) {
    return new FakeSupabaseClient({
      responses: {
        bookings: { data: { ...BOOKING_ROW, ...overrides } },
        preparation_catalogues: { data: null },
        booking_price_lines: { data: [] },
        units: { data: null },
        properties: { data: null },
      },
    })
  }

  it('reads the party the desk typed, rather than the whole count as adults', async () => {
    // The assertion that used to stand here said this port *refuses*, because
    // `bookings` carried no event type, no sleeping request and no extras.
    // 0028 added the five columns and `SupabaseBookingRepository` now writes
    // the real split, so the refusal is gone and this is what replaced it.
    const booking = await new SupabasePreparationPorts(
      client().asDb(),
    ).loadBooking('book-1')

    expect(booking?.adults).toBe(4)
    expect(booking?.children).toBe(2)
    // Every head, infants included: the number the stay was priced against.
    expect(booking?.guests).toBe(7)
    expect(booking?.eventType).toBe('shabbat')
    expect(booking?.sleeping).toEqual({
      couples: 2,
      extraBedsRequested: 1,
      cotsRequested: 2,
    })
  })

  it('carries the special request through, because a cleaner has to read it', async () => {
    const booking = await new SupabasePreparationPorts(
      client().asDb(),
    ).loadBooking('book-1')

    expect(booking?.specialRequests).toBe('שתי מיטות תינוק')
  })

  it('turns the requested beds and cots into countable extras', async () => {
    const booking = await new SupabasePreparationPorts(
      client().asDb(),
    ).loadBooking('book-1')

    expect(booking?.extras.map((extra) => extra.itemId)).toEqual([
      'extra_bed',
      'cot',
    ])
    // No catalogue is configured here, so nothing claims to know how long a
    // cot takes. Understating the estimate is the honest direction.
    expect(booking?.extras.every((extra) => extra.minutesPerUnit === 0)).toBe(
      true,
    )
  })

  it('resolves the arrival in the property time zone, not in UTC', async () => {
    // May is summer time in Israel, so 16:30 local is 13:30Z. Reading the
    // `time` column as UTC would put the deadline three hours early and every
    // readiness countdown in the product inherits it.
    const booking = await new SupabasePreparationPorts(
      client().asDb(),
    ).loadBooking('book-1')

    expect(booking?.arrivalAt).toBe('2026-05-10T13:30:00.000Z')
  })

  it('is null for a booking that is not there', async () => {
    const empty = new FakeSupabaseClient({
      responses: { bookings: { data: null } },
    })

    const booking = await new SupabasePreparationPorts(
      empty.asDb(),
    ).loadBooking('missing')

    expect(booking).toBeNull()
  })
})

describe('what preparation still cannot read', () => {
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
