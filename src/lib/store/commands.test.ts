/**
 * The two store commands Autopilot names, driven through the real pipeline.
 *
 * Two claims are load-bearing and each has a test named after it:
 *
 *   · **The chase never says it contacted anybody.** There is no messaging
 *     transport in this product. What the chase does is move the request into
 *     `unconfirmed` and raise the event that reaches a person who can pick up
 *     a telephone, and it says `contactMade: false` in as many words.
 *
 *   · **The upsell refuses what the property cannot deliver.** Pool heating at
 *     a house with no pool, and a chef for last Tuesday, are the two shapes of
 *     that, and both are refused with a Hebrew sentence the owner can read to
 *     the guest instead.
 *
 * Only the database is a double — `FakeSupabaseClient`, which records the
 * statements so a test can assert what was actually written, and refuses an
 * unseeded query so a passing test cannot be one that read nothing.
 */

import { describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import { AuthorizationError, type Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { BusinessRuleError } from '../errors'
import { FakeSupabaseClient } from '../persistence/fake-client'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  RecordingTransactionRunner,
} from '../service'
import { defineStoreCommands } from './commands'
import type { BookingFacts } from './types'

/* ---------------------------------------------------------------- world -- */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const PROPERTY = '22222222-2222-4222-8222-222222222222'
const BOOKING = '33333333-3333-4333-8333-333333333333'
const ITEM = '44444444-4444-4444-8444-444444444444'
const ORDER = '55555555-5555-4555-8555-555555555555'
const USER = '66666666-6666-4666-8666-666666666666'
const PROVIDER = '77777777-7777-4777-8777-777777777777'
const REQUEST = '88888888-8888-4888-8888-888888888888'

const NOW = new Date('2026-03-01T09:00:00.000Z')

const OWNER_GRANTS: readonly Grant[] = [
  'product.view',
  'product.manage',
  'order.view',
  'order.manage',
  'order.fulfil',
  'provider.manage',
]

function owner(grants: readonly Grant[] = OWNER_GRANTS): Actor {
  return {
    userId: USER,
    organizationId: ORGANIZATION,
    membershipStatus: 'active',
    grants: new Set(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set(['commerce'] as const),
  }
}

function context(actor: Actor = owner(), now: Date = NOW) {
  return {
    actor,
    auditActor: {
      type: 'user' as const,
      userId: USER,
      label: 'דנה, הבעלים',
    },
    correlationId: 'test-correlation',
    now,
  }
}

function services() {
  return {
    audit: new InMemoryAuditWriter(),
    events: new InMemoryEventBus(),
    idempotency: new InMemoryIdempotencyStore(),
    transactions: new RecordingTransactionRunner(),
  }
}

/* ------------------------------------------------------------- the rows -- */

function providerRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST,
    organization_id: ORGANIZATION,
    order_id: ORDER,
    order_line_id: null,
    provider_id: PROVIDER,
    property_id: PROPERTY,
    status: 'sent',
    channel: 'whatsapp',
    service_name: 'תקליטן לערב',
    service_date: '2026-03-14',
    service_time: '20:00:00',
    duration_minutes: 180,
    quantity: 1,
    operational_notes: null,
    reference: 'P-ABCD2345',
    sent_at: '2026-02-20T10:00:00.000Z',
    confirmed_at: null,
    ...overrides,
  }
}

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROVIDER,
    organization_id: ORGANIZATION,
    name: 'דיג׳יי אבי',
    contact_name: 'אבי',
    phone: '+972501234567',
    email: null,
    service_types: ['dj'],
    default_channel: 'whatsapp',
    lead_time_hours: 48,
    notes: null,
    is_active: true,
    ...overrides,
  }
}

const SETTINGS_ROW = {
  organization_id: ORGANIZATION,
  property_id: null,
  mode: 'simple',
  default_payment_mode: 'with_booking',
  payment_modes_enabled: ['with_booking', 'manual'],
  approval_required_default: true,
  guest_store_enabled: true,
  guest_store_heading: null,
  guest_store_intro: null,
  currency: 'ILS',
  order_reference_prefix: 'S',
  cart_ttl_hours: 72,
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM,
    organization_id: ORGANIZATION,
    category_id: null,
    name: 'חימום בריכה',
    slug: 'pool-heating',
    short_description: null,
    description: null,
    item_type: 'property_addon',
    status: 'active',
    pricing_model: 'fixed',
    base_price_agorot: 45_000,
    cost_agorot: null,
    supplier_reference: null,
    tax_rate_bps: null,
    min_quantity: 1,
    max_quantity: null,
    max_per_booking: null,
    unit_label: null,
    lead_time_hours: 24,
    capacity_per_day: null,
    requires_capability: 'heated_pool',
    min_guests: null,
    max_guests: null,
    visibility_rule: 'always',
    visibility_days_before: null,
    requires_approval: null,
    payment_mode: null,
    fulfilment_kind: 'staff_task',
    fulfilment_recipe: {},
    provider_id: null,
    customization_questions: [],
    cancellation_policy: {},
    media: [],
    tags: [],
    audience: {},
    is_featured: false,
    sort_order: 1,
    ...overrides,
  }
}

function bookingFacts(overrides: Partial<BookingFacts> = {}): BookingFacts {
  return {
    id: BOOKING,
    organizationId: ORGANIZATION,
    propertyId: PROPERTY,
    reference: '8892',
    status: 'confirmed',
    checkIn: '2026-03-20',
    checkOut: '2026-03-23',
    adults: 2,
    children: 0,
    infants: 0,
    propertyCapabilities: ['heated_pool'],
    balanceAgorot: 0,
    isConfirmed: true,
    isPaid: false,
    occasion: null,
    ...overrides,
  }
}

/** Every read `offerUpsell` makes, seeded. */
function catalogueResponses(item: Record<string, unknown> = itemRow()) {
  return {
    store_settings: { data: [SETTINGS_ROW] },
    store_items: { data: [item] },
    store_item_options: { data: [] },
    store_item_option_values: { data: [] },
    store_item_addons: { data: [] },
    store_item_property_overrides: { data: [] },
    store_availability_rules: { data: [] },
    store_orders: { data: [] },
  }
}

function commandsWith(
  db: FakeSupabaseClient,
  facts: BookingFacts | null = bookingFacts(),
) {
  return defineStoreCommands({
    db: db.asDb(),
    bookingFacts: async () => facts,
  })
}

function rejection<E>(promise: Promise<unknown>): Promise<E> {
  return promise.then(
    () => {
      throw new Error('expected the command to be refused, but it succeeded')
    },
    (error: unknown) => error as E,
  )
}

/* ══════════════════════════════════════════════════════════════════════════ */

describe('store.provider.chase', () => {
  it('marks the request unconfirmed and NEVER claims the provider was contacted', async () => {
    const db = new FakeSupabaseClient({
      responses: {
        'store_provider_requests:select': { data: providerRequestRow() },
        store_providers: { data: [providerRow()] },
        'store_provider_requests:update': {
          data: { id: REQUEST, status: 'unconfirmed' },
        },
      },
    })
    const kit = services()

    const outcome = await commandsWith(db).chaseProvider.run({
      request: { input: { requestId: REQUEST } },
      context: context(),
      services: kit,
    })

    // The claim that matters. Nothing left the building.
    expect(outcome.data.contactMade).toBe(false)
    expect(outcome.data.handoff).toBe('manual')
    expect(outcome.data.status).toBe('unconfirmed')
    expect(outcome.data.reachable).toBe(true)

    const update = db
      .queriesFor('store_provider_requests')
      .find((query) => query.verb === 'update')
    const payload = update?.payload as Record<string, unknown>
    expect(payload.status).toBe('unconfirmed')
    // Compare-and-set: a provider who confirmed thirty seconds ago is not
    // overwritten with "nobody answered".
    expect(update?.filters).toContainEqual({
      op: 'in',
      column: 'status',
      value: ['sent', 'unconfirmed'],
    })
    expect(update?.filters).toContainEqual({
      op: 'eq',
      column: 'organization_id',
      value: ORGANIZATION,
    })

    // The event IS the chase: urgent, escalating, to every holder of order.view.
    expect(kit.events.published).toHaveLength(1)
    expect(kit.events.published[0].name).toBe('store.provider_unconfirmed')
    expect(kit.events.published[0].payload).toMatchObject({
      contactMade: false,
      reachable: true,
    })

    expect(kit.audit.records).toHaveLength(1)
    expect(kit.audit.records[0].summary).toContain('לא נשלחה הודעה')
  })

  it('reports an unreachable provider rather than pretending, and still raises the alarm', async () => {
    const db = new FakeSupabaseClient({
      responses: {
        'store_provider_requests:select': { data: providerRequestRow() },
        // Set to WhatsApp with the telephone number since deleted.
        store_providers: { data: [providerRow({ phone: null })] },
        'store_provider_requests:update': {
          data: { id: REQUEST, status: 'unconfirmed' },
        },
      },
    })
    const kit = services()

    const outcome = await commandsWith(db).chaseProvider.run({
      request: { input: { requestId: REQUEST } },
      context: context(),
      services: kit,
    })

    expect(outcome.data.reachable).toBe(false)
    expect(outcome.data.contactMade).toBe(false)
    // Refusing here would swallow the one thing the team needs to know.
    expect(kit.events.published[0].name).toBe('store.provider_unconfirmed')
  })

  it('refuses a request that was never sent, and says to send it', async () => {
    const db = new FakeSupabaseClient({
      responses: {
        'store_provider_requests:select': {
          data: providerRequestRow({ status: 'draft', sent_at: null }),
        },
        store_providers: { data: [providerRow()] },
      },
    })

    const error = await rejection<BusinessRuleError>(
      commandsWith(db).chaseProvider.run({
        request: { input: { requestId: REQUEST } },
        context: context(),
        services: services(),
      }),
    )

    expect(error.code).toBe('store.provider_request_never_sent')
    expect(
      db.queriesFor('store_provider_requests').some((q) => q.verb === 'update'),
    ).toBe(false)
  })

  it('refuses a request the provider already confirmed', async () => {
    const db = new FakeSupabaseClient({
      responses: {
        'store_provider_requests:select': {
          data: providerRequestRow({
            status: 'confirmed',
            confirmed_at: '2026-02-21T08:00:00.000Z',
          }),
        },
        store_providers: { data: [providerRow()] },
      },
    })

    const error = await rejection<BusinessRuleError>(
      commandsWith(db).chaseProvider.run({
        request: { input: { requestId: REQUEST } },
        context: context(),
        services: services(),
      }),
    )

    expect(error.code).toBe('store.provider_already_confirmed')
  })

  it('refuses without provider.manage, before reading anything', async () => {
    const db = new FakeSupabaseClient({ responses: {} })

    const error = await rejection<AuthorizationError>(
      commandsWith(db).chaseProvider.run({
        request: { input: { requestId: REQUEST } },
        context: context(
          owner(OWNER_GRANTS.filter((grant) => grant !== 'provider.manage')),
        ),
        services: services(),
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
    expect(db.queries).toHaveLength(0)
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('store.upsell.offer', () => {
  it('prepares an offer and does not send it, order it or price it into a line', async () => {
    const db = new FakeSupabaseClient({ responses: catalogueResponses() })
    const kit = services()

    const outcome = await commandsWith(db).offerUpsell.run({
      request: {
        input: {
          bookingId: BOOKING,
          itemId: ITEM,
          quantity: 1,
          serviceDate: '2026-03-20',
        },
      },
      context: context(),
      services: kit,
    })

    expect(outcome.data.sent).toBe(false)
    expect(outcome.data.itemName).toBe('חימום בריכה')
    expect(outcome.data.unitPriceAgorot).toBe(45_000)
    expect(outcome.data.priceSource).toBe('catalogue')

    // An offer is not an order. Nothing was written to any store table.
    const writes = db.queries.filter((query) => query.verb !== 'select')
    expect(writes).toEqual([])

    // The audit row is the whole durable record, and it says so.
    expect(kit.audit.records).toHaveLength(1)
    expect(kit.audit.records[0].summary).toContain('ההצעה טרם נשלחה')

    // No event: the frozen catalogue has no name for an offer, and the nearest
    // ones would announce an order that does not exist.
    expect(kit.events.published).toEqual([])
  })

  it('refuses a service the property cannot provide', async () => {
    const db = new FakeSupabaseClient({ responses: catalogueResponses() })

    const error = await rejection<BusinessRuleError>(
      commandsWith(
        db,
        bookingFacts({ propertyCapabilities: [] }),
      ).offerUpsell.run({
        request: {
          input: {
            bookingId: BOOKING,
            itemId: ITEM,
            quantity: 1,
            serviceDate: '2026-03-20',
          },
        },
        context: context(),
        services: services(),
      }),
    )

    expect(error).toBeInstanceOf(BusinessRuleError)
    expect(error.code).toBe('store.upsell_not_available')
    expect(error.userMessage).toContain('חימום בריכה')
    expect(error.userMessage).toContain('הנכס הזה אינו מצויד')
  })

  it('refuses a product the owner has switched off at this house', async () => {
    const db = new FakeSupabaseClient({
      responses: {
        ...catalogueResponses(),
        store_item_property_overrides: {
          data: [
            {
              item_id: ITEM,
              organization_id: ORGANIZATION,
              property_id: PROPERTY,
              is_available: false,
              price_override_agorot: null,
              lead_time_hours_override: null,
              capacity_per_day_override: null,
              provider_override_id: null,
              notes: null,
            },
          ],
        },
      },
    })

    const error = await rejection<BusinessRuleError>(
      commandsWith(db).offerUpsell.run({
        request: {
          input: {
            bookingId: BOOKING,
            itemId: ITEM,
            quantity: 1,
            serviceDate: '2026-03-20',
          },
        },
        context: context(),
        services: services(),
      }),
    )

    expect(error.code).toBe('store.upsell_not_available')
    expect(error.userMessage).toContain('אינו מוצע בנכס הזה')
  })

  it('refuses a date that has already gone', async () => {
    const db = new FakeSupabaseClient({ responses: catalogueResponses() })

    const error = await rejection<BusinessRuleError>(
      commandsWith(db).offerUpsell.run({
        request: {
          input: {
            bookingId: BOOKING,
            itemId: ITEM,
            quantity: 1,
            serviceDate: '2026-02-14',
          },
        },
        context: context(),
        services: services(),
      }),
    )

    expect(error.code).toBe('store.upsell_date_past')
    expect(error.userMessage).toContain('התאריך כבר עבר')
  })

  it('refuses when the store is switched off', async () => {
    const db = new FakeSupabaseClient({
      responses: {
        ...catalogueResponses(),
        store_settings: { data: [{ ...SETTINGS_ROW, mode: 'off' }] },
      },
    })

    const error = await rejection<BusinessRuleError>(
      commandsWith(db).offerUpsell.run({
        request: {
          input: {
            bookingId: BOOKING,
            itemId: ITEM,
            quantity: 1,
            serviceDate: '2026-03-20',
          },
        },
        context: context(),
        services: services(),
      }),
    )

    expect(error.code).toBe('store.upsell_not_available')
  })

  it('refuses without order.manage, before reading anything', async () => {
    const db = new FakeSupabaseClient({ responses: {} })

    const error = await rejection<AuthorizationError>(
      commandsWith(db).offerUpsell.run({
        request: {
          input: {
            bookingId: BOOKING,
            itemId: ITEM,
            quantity: 1,
            serviceDate: '2026-03-20',
          },
        },
        context: context(
          owner(OWNER_GRANTS.filter((grant) => grant !== 'order.manage')),
        ),
        services: services(),
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
    expect(db.queries).toHaveLength(0)
  })
})
