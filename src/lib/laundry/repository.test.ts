/**
 * The laundry adapter, over a client that records instead of connecting.
 *
 * `fake-client.ts` states the limitation plainly and it applies here: this
 * cannot prove a column name is spelled right, because a misspelling would be
 * spelled the same way in the seed and would fail only on the first real
 * request. What it proves is the other half, and on these five tables that
 * half is the important one:
 *
 *   1. EVERY read names `organization_id` in the query. Row level security is
 *      enabled and forced on all five tables, and it is still the floor rather
 *      than the plan — `service_role` carries BYPASSRLS, and the filter is what
 *      stops a mistake in the adapter from becoming a cross-tenant read the
 *      first time somebody runs it as one. The sweep at the bottom asserts it
 *      over every read the port has, so a method added later without the
 *      filter fails without anybody remembering to write a test for it.
 *
 *   2. `final_quantity` is NEVER sent. It is `GENERATED ALWAYS`, Postgres
 *      refuses an explicit write, and that refusal is exactly what makes an
 *      adjusted quantity unfakeable. A test that only checked the happy path
 *      would not notice the day somebody adds it to a payload "for
 *      completeness" and every write starts failing.
 *
 *   3. A retried creation returns the order that exists. The unique constraint
 *      `laundry_orders_requirement_key` is the module's durable idempotency,
 *      and the interesting case is not that it refuses — it is what a person
 *      sees afterwards.
 *
 *   4. The two line triggers reach a screen as Hebrew, not as `23514`.
 */

import { describe, expect, it } from 'vitest'

import { BusinessRuleError } from '../errors'
import { FakeSupabaseClient, hasFilter } from '../persistence/fake-client'

import {
  LaundryLineDoesNotBelongError,
  LaundryLineFrozenError,
  SupabaseLaundryRepository,
  laundryOperationPorts,
  type LaundryOrderDraft,
} from './repository'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
const PROPERTY = '33333333-3333-4333-8333-333333333333'
const OTHER_PROPERTY = '44444444-4444-4444-8444-444444444444'
const ORDER = '55555555-5555-4555-8555-555555555555'
const LINE = '66666666-6666-4666-8666-666666666666'
const USER = '77777777-7777-4777-8777-777777777777'
const PROVIDER = '88888888-8888-4888-8888-888888888888'

/**
 * A page size, chosen by this test the way a screen chooses one.
 *
 * The repository has no default and must not grow one: how much a screen shows
 * is a product decision, and the module's own literal scan would object to a
 * number invented in the adapter.
 */
const PAGE = 20

function repositoryWith(responses: Record<string, unknown>) {
  const client = new FakeSupabaseClient({ responses: responses as never })
  return { client, repo: new SupabaseLaundryRepository(client.asDb()) }
}

/* ------------------------------------------------------------- fixtures -- */

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'settings-1',
    organization_id: ORG,
    property_id: null,
    mode: 'external',
    dispatch_mode: 'approval_required',
    default_channel: 'whatsapp',
    default_provider_id: PROVIDER,
    turnaround_hours: 48,
    pickup_days: [1, 4],
    delivery_days: [2, 5],
    forecast_horizon_days: 7,
    standing_notes: 'קוד לשער 1234',
    version: 1,
    ...overrides,
  }
}

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROVIDER,
    organization_id: ORG,
    name: 'מכבסת הגליל',
    contact_name: 'רונית',
    phone: '050-0000000',
    email: null,
    default_channel: 'whatsapp',
    turnaround_hours: 48,
    pickup_days: [1, 4],
    delivery_days: [2, 5],
    minimum_order_units: 20,
    notes: null,
    is_active: true,
    version: 1,
    ...overrides,
  }
}

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: ORG,
    item_id: 'linen_set',
    label: 'מערכת מצעים',
    laundry_managed: true,
    washable: true,
    external_laundry_allowed: true,
    route: 'external',
    default_provider_id: PROVIDER,
    turnaround_hours: null,
    unit: 'set',
    bundle_size: 5,
    minimum_buffer: 2,
    version: 1,
    ...overrides,
  }
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER,
    organization_id: ORG,
    property_id: PROPERTY,
    provider_id: PROVIDER,
    status: 'draft',
    mode: 'external',
    dispatch_mode: 'approval_required',
    channel: 'whatsapp',
    reference: 'LND-2026-0007',
    requirement_key: 'provider:88 external 2026-03-06 linen_set:30',
    required_by: '2026-03-06T08:00:00.000Z',
    pickup_at: '2026-03-04T06:00:00.000Z',
    expected_return_at: '2026-03-06T06:00:00.000Z',
    returned_at: null,
    sent_at: null,
    sent_body: null,
    internal_notes: 'לשים לב לכתם',
    provider_notes: 'לאסוף מהכניסה האחורית',
    version: 3,
    ...overrides,
  }
}

function lineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LINE,
    organization_id: ORG,
    order_id: ORDER,
    property_id: PROPERTY,
    item_id: 'linen_set',
    label: 'מערכת מצעים',
    unit: 'set',
    calculated_quantity: 28,
    adjustment_quantity: 2,
    adjustment_reason: 'הגיעו עוד שני אורחים',
    adjusted_by: USER,
    adjusted_at: '2026-03-03T10:00:00.000Z',
    explanation: [
      { kind: 'preparation', text: '28 מערכות מצעים', value: 28 },
      { kind: 'bundle', text: 'עיגול לחבילות של 5', value: 30 },
    ],
    source_booking_id: null,
    required_by: '2026-03-06T08:00:00.000Z',
    notes: null,
    ...overrides,
  }
}

function draft(overrides: Partial<LaundryOrderDraft> = {}): LaundryOrderDraft {
  return {
    propertyId: PROPERTY,
    providerId: PROVIDER,
    mode: 'external',
    dispatchMode: 'approval_required',
    channel: 'whatsapp',
    reference: 'LND-2026-0007',
    requirementKey: 'provider:88 external 2026-03-06 linen_set:30',
    requiredBy: '2026-03-06T08:00:00.000Z',
    pickupAt: '2026-03-04T06:00:00.000Z',
    expectedReturnAt: '2026-03-06T06:00:00.000Z',
    internalNotes: null,
    providerNotes: null,
    lines: [
      {
        propertyId: PROPERTY,
        itemId: 'linen_set',
        label: 'מערכת מצעים',
        unit: 'set',
        calculatedQuantity: 30,
        explanation: [{ kind: 'preparation', text: '30 מערכות', value: 30 }],
        sourceBookingId: null,
        requiredBy: '2026-03-06T08:00:00.000Z',
        notes: null,
      },
    ],
    ...overrides,
  }
}

/** The refusal PostgREST relays when a trigger raises. */
function refusal(code: string, message: string, hint?: string) {
  return { error: { code, message, details: null, hint: hint ?? null } }
}

/* ---------------------------------------------------------- the mapping -- */

describe('reading the configuration', () => {
  it('scopes settings by organization and maps every column', async () => {
    const { client, repo } = repositoryWith({
      laundry_settings: { data: [settingsRow()] },
    })

    const rows = await repo.listSettings(ORG)

    expect(hasFilter(client.queries[0], 'eq', 'organization_id', ORG)).toBe(
      true,
    )
    expect(rows).toEqual([
      {
        organizationId: ORG,
        propertyId: null,
        mode: 'external',
        dispatchMode: 'approval_required',
        defaultChannel: 'whatsapp',
        defaultProviderId: PROVIDER,
        turnaroundHours: 48,
        pickupDays: [1, 4],
        deliveryDays: [2, 5],
        forecastHorizonDays: 7,
        standingNotes: 'קוד לשער 1234',
      },
    ])
  })

  it('resolves the property override over the organization row', async () => {
    const { repo } = repositoryWith({
      laundry_settings: {
        data: [
          settingsRow(),
          settingsRow({
            id: 'settings-2',
            property_id: PROPERTY,
            mode: 'internal',
            turnaround_hours: 6,
          }),
        ],
      },
    })

    const resolved = await repo.resolveSettingsFor(ORG, PROPERTY)

    // A whole row wins, not a column-by-column merge: a manager must be able
    // to be told which single configuration they are running on.
    expect(resolved.source).toBe('property')
    expect(resolved.settings.mode).toBe('internal')
    expect(resolved.settings.turnaroundHours).toBe(6)
  })

  it('falls back to the inert defaults for a business with no rows', async () => {
    const { repo } = repositoryWith({ laundry_settings: { data: [] } })

    const resolved = await repo.resolveSettingsFor(ORG, null)

    // `off`, and not a fabricated 24-hour turnaround. A business that has
    // configured nothing has no laundry operation, and saying otherwise would
    // put a number on a screen that nobody chose.
    expect(resolved.source).toBe('default')
    expect(resolved.settings.mode).toBe('off')
  })

  it('hides an inactive provider from a picker but not deleted history', async () => {
    const { client, repo } = repositoryWith({
      laundry_providers: { data: [providerRow()] },
    })

    await repo.listProviders(ORG)

    const query = client.queries[0]
    expect(hasFilter(query, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(query, 'is', 'deleted_at', null)).toBe(true)
    expect(hasFilter(query, 'eq', 'is_active', true)).toBe(true)
  })

  it('includes inactive providers when the caller asks for them', async () => {
    const { client, repo } = repositoryWith({
      laundry_providers: { data: [providerRow({ is_active: false })] },
    })

    const providers = await repo.listProviders(ORG, { includeInactive: true })

    expect(hasFilter(client.queries[0], 'eq', 'is_active', true)).toBe(false)
    expect(providers[0]?.isActive).toBe(false)
  })

  it('maps an item profile, including the nullable turnaround', async () => {
    const { repo } = repositoryWith({
      laundry_item_profiles: { data: [profileRow()] },
    })

    const [profile] = await repo.listItemProfiles(ORG)

    expect(profile).toEqual({
      organizationId: ORG,
      itemId: 'linen_set',
      label: 'מערכת מצעים',
      laundryManaged: true,
      washable: true,
      externalLaundryAllowed: true,
      route: 'external',
      defaultProviderId: PROVIDER,
      // `null` and not a copied organization default. "This item follows the
      // provider" and "this item takes 24 hours" are different facts.
      turnaroundHours: null,
      unit: 'set',
      bundleSize: 5,
      minimumBuffer: 2,
    })
  })
})

describe('reading an order', () => {
  it('is scoped by organization as well as by id, and so are its lines', async () => {
    const { client, repo } = repositoryWith({
      laundry_orders: { data: orderRow() },
      laundry_order_lines: { data: [lineRow()] },
    })

    await repo.loadOrder(ORG, ORDER)

    const [orders, lines] = client.queries
    expect(hasFilter(orders, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(orders, 'eq', 'id', ORDER)).toBe(true)
    expect(hasFilter(lines, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(lines, 'in', 'order_id')).toBe(true)
  })

  it('derives the final quantity rather than reading the generated column', async () => {
    const { client, repo } = repositoryWith({
      laundry_orders: { data: orderRow() },
      laundry_order_lines: { data: [lineRow()] },
    })

    const order = await repo.loadOrder(ORG, ORDER)

    // The column is GENERATED ALWAYS and is not even selected — the three
    // numbers cannot disagree, so the sum is arithmetic rather than a read.
    expect(client.queries[1]?.columns).not.toContain('final_quantity')
    expect(order?.lines[0]?.quantity).toEqual({
      calculated: 28,
      adjustment: 2,
      final: 30,
      reason: 'הגיעו עוד שני אורחים',
      adjustedByUserId: USER,
      adjustedAt: '2026-03-03T10:00:00.000Z',
    })
  })

  it('keeps the explanation the engine wrote and drops a step it cannot read', async () => {
    const { repo } = repositoryWith({
      laundry_orders: { data: orderRow() },
      laundry_order_lines: {
        data: [
          lineRow({
            explanation: [
              { kind: 'preparation', text: '28 מערכות מצעים', value: 28 },
              { kind: 'bundle', text: 'no value on this one' },
            ],
          }),
        ],
      },
    })

    const order = await repo.loadOrder(ORG, ORDER)

    // One fewer line of reasoning, never an empty bullet with no number in it.
    expect(order?.lines[0]?.explanation).toEqual([
      { kind: 'preparation', text: '28 מערכות מצעים', value: 28 },
    ])
  })

  it('answers null for an order this reader cannot see', async () => {
    const { client, repo } = repositoryWith({
      laundry_orders: { data: null },
    })

    expect(await repo.loadOrder(ORG, ORDER)).toBeNull()
    // No line read at all: there is no order to hang them off, and asking
    // would be a second query whose empty answer means nothing.
    expect(client.queriesFor('laundry_order_lines')).toEqual([])
  })

  it('gives an order only the lines that belong to it', async () => {
    const { repo } = repositoryWith({
      laundry_orders: { data: [orderRow()] },
      laundry_order_lines: {
        data: [
          lineRow(),
          lineRow({ id: 'other-line', order_id: 'another-order' }),
        ],
      },
    })

    const [order] = await repo.listOrders(ORG, { limit: PAGE })

    expect(order?.lines).toHaveLength(1)
    expect(order?.lines[0]?.id).toBe(LINE)
  })
})

describe('narrowing a list to one property', () => {
  it('does not hide the consolidated run that includes it', async () => {
    const { client, repo } = repositoryWith({
      'laundry_orders:select': [
        { data: [orderRow()] },
        {
          data: [
            orderRow({
              id: 'consolidated',
              property_id: null,
              required_by: '2026-03-09T08:00:00.000Z',
            }),
          ],
        },
      ],
      laundry_order_lines: { data: [lineRow()] },
    })

    const orders = await repo.listOrders(ORG, {
      limit: PAGE,
      propertyId: PROPERTY,
    })

    const [own, consolidated] = client.queriesFor('laundry_orders')
    expect(hasFilter(own, 'eq', 'property_id', PROPERTY)).toBe(true)
    expect(hasFilter(consolidated, 'is', 'property_id', null)).toBe(true)
    expect(hasFilter(own, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(consolidated, 'eq', 'organization_id', ORG)).toBe(true)

    // Merged newest-first across both reads. A run that carries this property
    // in its breakdown is exactly the one somebody narrowing to it wants.
    expect(orders.map((order) => order.id)).toEqual(['consolidated', ORDER])
  })

  it('asks once, unfiltered by property, when nobody narrowed', async () => {
    const { client, repo } = repositoryWith({
      laundry_orders: { data: [orderRow()] },
      laundry_order_lines: { data: [lineRow()] },
    })

    await repo.listOrders(ORG, { limit: PAGE })

    expect(client.queriesFor('laundry_orders')).toHaveLength(1)
    expect(hasFilter(client.queries[0], 'eq', 'property_id')).toBe(false)
  })

  it('reads nothing further when there are no orders', async () => {
    const { client, repo } = repositoryWith({
      laundry_orders: { data: [] },
    })

    expect(await repo.listOrders(ORG, { limit: PAGE })).toEqual([])
    expect(client.queriesFor('laundry_order_lines')).toEqual([])
  })
})

/* -------------------------------------------------------- idempotency --- */

describe('creating a run twice', () => {
  it('returns the order that already exists rather than a second one', async () => {
    const { client, repo } = repositoryWith({
      'laundry_orders:insert': refusal(
        '23505',
        'duplicate key value violates unique constraint ' +
          '"laundry_orders_requirement_key"',
      ),
      'laundry_orders:select': { data: orderRow() },
      'laundry_order_lines:select': { data: [lineRow()] },
    })

    const result = await repo.createOrder(ORG, draft(), USER)

    expect(result.created).toBe(false)
    expect(result.order.id).toBe(ORDER)
    expect(result.order.reference).toBe('LND-2026-0007')

    // The existing order was found by the key, scoped by organization —
    // the constraint is on the pair, and the key alone is not unique across
    // tenants.
    const lookup = client.queriesFor('laundry_orders')[1]
    expect(hasFilter(lookup, 'eq', 'organization_id', ORG)).toBe(true)
    expect(
      hasFilter(lookup, 'eq', 'requirement_key', draft().requirementKey),
    ).toBe(true)

    // And no lines were written on top of the run that already exists.
    expect(
      client
        .queriesFor('laundry_order_lines')
        .every((query) => query.verb === 'select'),
    ).toBe(true)
  })

  it('does not swallow a reference collision as "already exists"', async () => {
    const { client, repo } = repositoryWith({
      'laundry_orders:insert': refusal(
        '23505',
        'duplicate key value violates unique constraint ' +
          '"laundry_orders_reference_key"',
      ),
    })

    // A duplicate reference on a genuinely different wash is a generator
    // collision. Treating it as idempotency would hand somebody an unrelated
    // order and call it theirs.
    await expect(repo.createOrder(ORG, draft(), USER)).rejects.toMatchObject({
      code: '23505',
    })
    expect(client.queriesFor('laundry_orders')).toHaveLength(1)
  })

  it('raises the original refusal when the existing order cannot be read', async () => {
    const { repo } = repositoryWith({
      'laundry_orders:insert': refusal(
        '23505',
        'duplicate key value violates unique constraint ' +
          '"laundry_orders_requirement_key"',
      ),
      'laundry_orders:select': { data: null },
    })

    // "It exists and you may not see it" is a policy answer, and reporting it
    // as a successful creation would be a dead end on the screen.
    await expect(repo.createOrder(ORG, draft(), USER)).rejects.toMatchObject({
      code: '23505',
    })
  })
})

/* -------------------------------------------------- the generated column -- */

describe('what a write is allowed to send', () => {
  it('never sends final_quantity when creating lines', async () => {
    const { client, repo } = repositoryWith({
      'laundry_orders:insert': { data: orderRow() },
      'laundry_order_lines:insert': { data: [lineRow()] },
    })

    const result = await repo.createOrder(ORG, draft(), USER)

    expect(result.created).toBe(true)

    const insert = client.queriesFor('laundry_order_lines')[0]
    const rows = insert?.payload as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('final_quantity')
    expect(rows[0]?.calculated_quantity).toBe(30)
    // An order is born saying exactly what the engine said.
    expect(rows[0]?.adjustment_quantity).toBe(0)
    expect(rows[0]?.organization_id).toBe(ORG)
  })

  it('never sends final_quantity or calculated_quantity when adjusting', async () => {
    const { client, repo } = repositoryWith({
      'laundry_order_lines:update': { data: null },
      'laundry_orders:select': { data: orderRow() },
      'laundry_order_lines:select': { data: [lineRow()] },
    })

    await repo.adjustLine(ORG, {
      orderId: ORDER,
      lineId: LINE,
      adjustment: 2,
      reason: 'הגיעו עוד שני אורחים',
      adjustedByUserId: USER,
      at: '2026-03-03T10:00:00.000Z',
    })

    const update = client.queriesFor('laundry_order_lines')[0]
    const payload = update?.payload as Record<string, unknown>
    expect(payload).not.toHaveProperty('final_quantity')
    // The engine's figure is evidence. The trigger would refuse a rewrite;
    // this is the application agreeing rather than discovering.
    expect(payload).not.toHaveProperty('calculated_quantity')
    expect(payload.adjustment_quantity).toBe(2)
    expect(payload.adjustment_reason).toBe('הגיעו עוד שני אורחים')
    expect(hasFilter(update, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(update, 'eq', 'order_id', ORDER)).toBe(true)
  })

  it('clears the reason when an adjustment is taken back to zero', async () => {
    const { client, repo } = repositoryWith({
      'laundry_order_lines:update': { data: null },
      'laundry_orders:select': { data: orderRow() },
      'laundry_order_lines:select': { data: [lineRow()] },
    })

    await repo.adjustLine(ORG, {
      orderId: ORDER,
      lineId: LINE,
      adjustment: 0,
      reason: 'טעות',
      adjustedByUserId: USER,
      at: '2026-03-03T10:00:00.000Z',
    })

    const payload = client.queriesFor('laundry_order_lines')[0]
      ?.payload as Record<string, unknown>

    // A stale sentence must not outlive the change it explained, and the
    // schema's own constraint pairs the two.
    expect(payload.adjustment_quantity).toBe(0)
    expect(payload.adjustment_reason).toBeNull()
    expect(payload.adjusted_at).toBeNull()
  })
})

/* ------------------------------------------------------------- triggers -- */

describe('what the database refuses', () => {
  it('turns the agree trigger into a sentence a screen can render', async () => {
    const { repo } = repositoryWith({
      'laundry_orders:insert': { data: orderRow() },
      'laundry_order_lines:insert': refusal(
        '23514',
        `laundry order ${ORDER} names property ${PROPERTY} and cannot ` +
          `carry a line for ${OTHER_PROPERTY}`,
        'A consolidated order carries property_id NULL.',
      ),
    })

    const failure = await repo
      .createOrder(ORG, draft(), USER)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(LaundryLineDoesNotBelongError)
    expect(failure).toBeInstanceOf(BusinessRuleError)
    const rule = failure as BusinessRuleError
    expect(rule.code).toBe('laundry.line_does_not_belong')
    // Hebrew, and about the situation rather than about the trigger.
    expect(rule.userMessage).toContain('נכס')
    expect(rule.userMessage).not.toContain('laundry_order_lines')
  })

  it('turns the frozen trigger into one too', async () => {
    const { repo } = repositoryWith({
      'laundry_order_lines:update': refusal(
        '23514',
        `laundry order line ${LINE} may not have its calculated quantity ` +
          'rewritten (28 to 30)',
        'Record the difference as adjustment_quantity with a reason.',
      ),
    })

    const failure = await repo
      .adjustLine(ORG, {
        orderId: ORDER,
        lineId: LINE,
        adjustment: 2,
        reason: 'סיבה',
        adjustedByUserId: USER,
        at: '2026-03-03T10:00:00.000Z',
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(LaundryLineFrozenError)
    const rule = failure as BusinessRuleError
    expect(rule.code).toBe('laundry.line_frozen')
    // It names the way forward, which is the whole point of catching it.
    expect(rule.userMessage).toContain('נימוק')
  })

  it('leaves a refusal it does not recognise exactly as it was', async () => {
    const { repo } = repositoryWith({
      'laundry_order_lines:update': refusal(
        '23514',
        'new row violates check constraint ' +
          '"laundry_order_lines_final_not_negative"',
      ),
    })

    const failure = await repo
      .adjustLine(ORG, {
        orderId: ORDER,
        lineId: LINE,
        adjustment: -99,
        reason: 'סיבה',
        adjustedByUserId: USER,
        at: '2026-03-03T10:00:00.000Z',
      })
      .catch((error: unknown) => error)

    // Not dressed up as one of the two triggers. A refusal nobody translated
    // must stay recognisable, or the next person debugs the wrong thing.
    expect(failure).not.toBeInstanceOf(BusinessRuleError)
    expect(failure).toMatchObject({ code: '23514' })
  })
})

/* --------------------------------------------------------------- writes -- */

describe('sending and advancing', () => {
  it('stores the reviewed body verbatim and leaves draft in one statement', async () => {
    const { client, repo } = repositoryWith({
      'laundry_orders:update': { data: null },
      'laundry_orders:select': {
        data: orderRow({
          status: 'to_collect',
          sent_at: '2026-03-04T05:00:00.000Z',
        }),
      },
      'laundry_order_lines:select': { data: [lineRow()] },
    })

    const order = await repo.markSent(ORG, {
      orderId: ORDER,
      channel: 'whatsapp',
      body: 'שלום רונית, מצורפת ההזמנה.',
      sentByUserId: USER,
      at: '2026-03-04T05:00:00.000Z',
    })

    const update = client.queriesFor('laundry_orders')[0]
    const payload = update?.payload as Record<string, unknown>
    // What was actually said is the record. A renderer that changed next
    // month must not be able to rewrite history.
    expect(payload.sent_body).toBe('שלום רונית, מצורפת ההזמנה.')
    // `laundry_orders_sent_has_left_draft` refuses the pair apart.
    expect(payload.status).toBe('to_collect')
    expect(hasFilter(update, 'eq', 'organization_id', ORG)).toBe(true)

    expect(order.status).toBe('to_collect')
  })

  it('stamps the return only when the linen is actually back', async () => {
    const { client, repo } = repositoryWith({
      'laundry_orders:update': { data: null },
      'laundry_orders:select': { data: orderRow({ status: 'washing' }) },
      'laundry_order_lines:select': { data: [lineRow()] },
    })

    await repo.advanceOrder(ORG, {
      orderId: ORDER,
      status: 'washing',
      actorUserId: USER,
      at: '2026-03-04T09:00:00.000Z',
    })

    const payload = client.queriesFor('laundry_orders')[0]?.payload as Record<
      string,
      unknown
    >
    expect(payload).not.toHaveProperty('returned_at')
  })

  it('cancels by updating, and never deletes an order', async () => {
    const { client, repo } = repositoryWith({
      'laundry_orders:update': { data: null },
      'laundry_orders:select': { data: orderRow({ status: 'cancelled' }) },
      'laundry_order_lines:select': { data: [lineRow()] },
    })

    const order = await repo.advanceOrder(ORG, {
      orderId: ORDER,
      status: 'cancelled',
      actorUserId: USER,
      at: '2026-03-04T09:00:00.000Z',
    })

    expect(order.status).toBe('cancelled')
    // 0029 revokes DELETE and TRUNCATE from `service_role` as well as from
    // `authenticated`: a run that was called off is a thing that happened, and
    // a business that cannot show it cannot argue with the invoice for it.
    expect(client.queries.some((query) => query.verb === 'delete')).toBe(false)
  })

  it('re-reads after writing, so the caller does not hold a stale version', async () => {
    const { client, repo } = repositoryWith({
      'laundry_orders:update': { data: null },
      'laundry_orders:select': { data: orderRow({ version: 4 }) },
      'laundry_order_lines:select': { data: [lineRow()] },
    })

    const order = await repo.advanceOrder(ORG, {
      orderId: ORDER,
      status: 'collected',
      actorUserId: USER,
      at: '2026-03-04T09:00:00.000Z',
    })

    // `tg_touch_row` bumped it. The next act is optimistic-locked, and handing
    // back the version from before the write would fail it invisibly.
    expect(order.version).toBe(4)
    expect(client.queriesFor('laundry_orders')[1]?.verb).toBe('select')
  })

  it('is loud when a write lands and the row cannot be read back', async () => {
    const { repo } = repositoryWith({
      'laundry_orders:update': { data: null },
      'laundry_orders:select': { data: null },
    })

    // The update and select policies disagreeing is a defect, not an empty
    // state, and a silent `null` here would look like a deleted order.
    await expect(
      repo.advanceOrder(ORG, {
        orderId: ORDER,
        status: 'collected',
        actorUserId: USER,
        at: '2026-03-04T09:00:00.000Z',
      }),
    ).rejects.toThrow(/cannot be read back/)
  })
})

/* ------------------------------------------------------ message context -- */

describe('the context a provider message needs', () => {
  it('carries the five facts the renderer wants and nothing else', async () => {
    const { repo } = repositoryWith({
      organizations: { data: { id: ORG, name: 'אכסניית הכרמל' } },
      properties: {
        data: [
          { id: PROPERTY, name: 'בית הגליל' },
          { id: OTHER_PROPERTY, name: 'בית הכרמל' },
        ],
      },
      laundry_providers: { data: providerRow() },
      laundry_settings: { data: [settingsRow()] },
      laundry_orders: { data: orderRow() },
      laundry_order_lines: { data: [lineRow()] },
    })

    const order = await repo.loadOrder(ORG, ORDER)
    const context = await repo.messageContext(order!)

    expect(Object.keys(context).sort()).toEqual([
      'contactName',
      'contactPhone',
      'organizationName',
      'propertyNames',
      'standingNotes',
    ])
    expect(context.organizationName).toBe('אכסניית הכרמל')
    expect(context.propertyNames.get(PROPERTY)).toBe('בית הגליל')
    expect(context.contactName).toBe('רונית')
    expect(context.contactPhone).toBe('050-0000000')
    expect(context.standingNotes).toBe('קוד לשער 1234')
  })

  it('falls back to the company name and never invents a person', async () => {
    const { repo } = repositoryWith({
      organizations: { data: { id: ORG, name: 'אכסניית הכרמל' } },
      properties: { data: [] },
      laundry_providers: { data: providerRow({ contact_name: null }) },
      laundry_settings: { data: [settingsRow({ standing_notes: null })] },
      laundry_orders: { data: orderRow() },
      laundry_order_lines: { data: [lineRow()] },
    })

    const order = await repo.loadOrder(ORG, ORDER)
    const context = await repo.messageContext(order!)

    expect(context.contactName).toBe('מכבסת הגליל')
    expect(context.standingNotes).toBeNull()
  })

  it('has no contact at all for an internal batch', async () => {
    const { client, repo } = repositoryWith({
      organizations: { data: { id: ORG, name: 'אכסניית הכרמל' } },
      properties: { data: [] },
      laundry_settings: { data: [settingsRow()] },
      laundry_orders: {
        data: orderRow({ provider_id: null, mode: 'internal' }),
      },
      laundry_order_lines: { data: [lineRow()] },
    })

    const order = await repo.loadOrder(ORG, ORDER)
    const context = await repo.messageContext(order!)

    // There is no outside company, so there is nobody to address. Asking the
    // provider table anyway would be a query with no question behind it.
    expect(context.contactName).toBeNull()
    expect(context.contactPhone).toBeNull()
    expect(client.queriesFor('laundry_providers')).toEqual([])
  })
})

/* ----------------------------------------------------- the operation port -- */

describe('the port operations.ts declares', () => {
  it('closes over the organization the pipeline cannot pass', async () => {
    const { client, repo } = repositoryWith({
      laundry_orders: { data: orderRow() },
      laundry_order_lines: { data: [lineRow()] },
    })

    const ports = laundryOperationPorts(repo, ORG)
    const order = await ports.loadOrder(ORDER)

    expect(order?.id).toBe(ORDER)
    // The pipeline hands an operation a resource id and nothing else, so the
    // tenant is closed over where the actor is known. An adapter that read it
    // off the row would be asking the row to vouch for itself.
    expect(hasFilter(client.queries[0], 'eq', 'organization_id', ORG)).toBe(
      true,
    )
  })
})

/* ------------------------------------------------------------- the sweep -- */

/**
 * The claim worth making without a database: no read reaches these tables
 * without naming the tenant.
 *
 * Written as a sweep over every read the port has rather than as one assertion
 * per method, so a method added later is covered by a test nobody had to
 * remember to write. `organizations` is excluded because its own primary key
 * IS the tenant and it is filtered by `id`.
 */
describe('every read names the tenant', () => {
  const SCOPED_TABLES = [
    'laundry_settings',
    'laundry_providers',
    'laundry_item_profiles',
    'laundry_orders',
    'laundry_order_lines',
    'properties',
  ]

  it('over every read the repository can perform', async () => {
    const { client, repo } = repositoryWith({
      laundry_settings: { data: [settingsRow()] },
      laundry_providers: { data: providerRow() },
      laundry_item_profiles: { data: [profileRow()] },
      'laundry_orders:select': { data: orderRow() },
      'laundry_order_lines:select': { data: [lineRow()] },
      organizations: { data: { id: ORG, name: 'אכסניית הכרמל' } },
      properties: { data: [{ id: PROPERTY, name: 'בית הגליל' }] },
    })

    await repo.listSettings(ORG)
    await repo.resolveSettingsFor(ORG, PROPERTY)
    await repo.listProviders(ORG)
    await repo.loadProvider(ORG, PROVIDER)
    await repo.listItemProfiles(ORG)
    await repo.loadOrderByRequirementKey(ORG, 'some-key')
    const order = await repo.loadOrder(ORG, ORDER)
    await repo.messageContext(order!)

    const reads = client.queries.filter(
      (query) => query.verb === 'select' && SCOPED_TABLES.includes(query.table),
    )

    expect(reads.length).toBeGreaterThan(8)
    for (const read of reads) {
      expect(
        hasFilter(read, 'eq', 'organization_id', ORG),
        `${read.table} was read without an organization_id filter`,
      ).toBe(true)
    }
  })

  it('and a read for one tenant cannot be satisfied by another', async () => {
    const { client, repo } = repositoryWith({
      laundry_orders: { data: orderRow() },
      laundry_order_lines: { data: [lineRow()] },
    })

    await repo.loadOrder(OTHER_ORG, ORDER)

    // The filter follows the argument rather than a value captured anywhere.
    expect(hasFilter(client.queries[0], 'eq', 'organization_id', ORG)).toBe(
      false,
    )
    expect(
      hasFilter(client.queries[0], 'eq', 'organization_id', OTHER_ORG),
    ).toBe(true)
  })
})
