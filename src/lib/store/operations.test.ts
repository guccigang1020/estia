/**
 * The simple end-to-end, driven through the real operations.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  Store on · live payments off · inventory off.
 *
 *  The owner creates "שולחן שוק — ₪1,500". An order is placed against it.
 *  The owner approves and records a manual payment. An operational task
 *  exists, and the price never moves.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * This is not a mock of the flow — it is `defineStoreOperations` itself,
 * running through the whole service pipeline: authorization, validation, the
 * domain rule, the transaction, the audit event and idempotency. Only the
 * database is a double, and it is `FakeSupabaseClient`, which records the
 * statements so the test can assert what was actually written.
 *
 * ── Why this exists in addition to the walkthrough on the running server ──
 *
 * The demo serves rows from memory and its table map is a file this module
 * does not own, so the same flow cannot be walked in the browser until those
 * tables are declared. That is a wiring gap, not a logic gap — and the way to
 * tell the difference is to prove the logic without the wiring. If this file
 * is green and the screens are not, the fault is in the demo's table map.
 *
 * ── What the fake can and cannot prove ───────────────────────────────────
 *
 * It proves the mapping and the sequence: which tables were written, in what
 * order, with which values, and that the tenant was on every filter. It
 * CANNOT prove the SQL is right — a column spelled wrongly here is spelled
 * wrongly consistently. `store_order_lines.line_total_agorot` is a generated
 * column, so the figure this test asserts is the one the application computed;
 * the database recomputing it identically is the migration's rehearsal block's
 * job, not this file's.
 */

import { describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import type { Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { FakeSupabaseClient } from '../persistence/fake-client'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  RecordingTransactionRunner,
} from '../service'
import { tasksForOrder } from './fulfilment'
import { defineStoreOperations } from './operations'
import type { OrderLineSnapshot, StoreOrder } from './types'

/* ---------------------------------------------------------------- actors -- */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const PROPERTY = '22222222-2222-4222-8222-222222222222'
const BOOKING = '33333333-3333-4333-8333-333333333333'
const ITEM = '44444444-4444-4444-8444-444444444444'
const ORDER = '55555555-5555-4555-8555-555555555555'

/** Every commerce grant, as an owner holds them. */
const OWNER_GRANTS: readonly Grant[] = [
  'product.view',
  'product.manage',
  'product.price_manage',
  'order.view',
  'order.manage',
  'order.fulfil',
  'order.discount_manage',
  'order.refund',
  'provider.manage',
]

function owner(grants: readonly Grant[] = OWNER_GRANTS): Actor {
  return {
    userId: '66666666-6666-4666-8666-666666666666',
    organizationId: ORGANIZATION,
    membershipStatus: 'active',
    grants: new Set(grants),
    scope: { kind: 'all_organization' },
    // The nine commerce grants map to `commerce` in `ENTITLEMENT_FOR_GRANT`,
    // so without this every one of them is refused for the plan rather than
    // for the permission — which is the failure the store's own gate exists
    // to explain rather than flatten.
    entitlements: new Set(['commerce'] as const),
  }
}

function context() {
  return {
    actor: owner(),
    auditActor: {
      type: 'user' as const,
      userId: '66666666-6666-4666-8666-666666666666',
      label: 'דנה, הבעלים',
    },
    correlationId: 'test-correlation',
    now: new Date('2026-03-01T09:00:00.000Z'),
  }
}

function services() {
  return {
    audit: new InMemoryAuditWriter(),
    // The bus keeps its own `published` array, so nothing here has to
    // subscribe to observe what fired — and `outcome.events` is the assertion
    // that matters, because it is what the pipeline actually handed on.
    events: new InMemoryEventBus(),
    idempotency: new InMemoryIdempotencyStore(),
    transactions: new RecordingTransactionRunner(),
  }
}

/* ------------------------------------------------------------- the store -- */

/** `simple`: a catalogue and orders by hand, and NO payment provider. */
const SETTINGS_ROW = {
  organization_id: ORGANIZATION,
  property_id: null,
  mode: 'simple',
  default_payment_mode: 'with_booking',
  payment_modes_enabled: ['with_booking', 'manual', 'on_arrival'],
  approval_required_default: true,
  guest_store_enabled: true,
  guest_store_heading: null,
  guest_store_intro: null,
  currency: 'ILS',
  order_reference_prefix: 'S',
  cart_ttl_hours: 72,
}

/** ₪1,500, in agorot. The figure the whole file is about. */
const FIFTEEN_HUNDRED = 150_000

const ITEM_ROW = {
  id: ITEM,
  organization_id: ORGANIZATION,
  category_id: null,
  name: 'שולחן שוק',
  slug: 'market-table',
  short_description: null,
  description: null,
  item_type: 'experience',
  status: 'active',
  pricing_model: 'fixed',
  base_price_agorot: FIFTEEN_HUNDRED,
  cost_agorot: null,
  supplier_reference: null,
  tax_rate_bps: null,
  min_quantity: 1,
  max_quantity: null,
  max_per_booking: null,
  unit_label: null,
  lead_time_hours: 48,
  capacity_per_day: null,
  requires_capability: null,
  min_guests: null,
  max_guests: null,
  visibility_rule: 'always',
  visibility_days_before: null,
  requires_approval: null,
  payment_mode: null,
  fulfilment_kind: 'staff_task',
  fulfilment_recipe: {
    taskType: 'guest_request',
    title: 'להכין שולחן שוק',
    dueOffsetHours: -3,
    checklist: ['לקנות במכולת', 'לסדר על השולחן'],
  },
  provider_id: null,
  customization_questions: [],
  cancellation_policy: { kind: 'free_until_hours', hoursBefore: 48 },
  media: [],
  tags: [],
  audience: {},
  is_featured: true,
  sort_order: 1,
}

/** What the catalogue reads need. Five flat queries — see `repository.ts`. */
function catalogueResponses() {
  return {
    store_settings: { data: [SETTINGS_ROW] },
    store_items: { data: [ITEM_ROW] },
    store_item_options: { data: [] },
    store_item_option_values: { data: [] },
    store_item_addons: { data: [] },
    store_item_property_overrides: { data: [] },
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */

describe('STEP 1 — the owner creates שולחן שוק at ₪1,500', () => {
  it('writes a DRAFT product with the price in agorot, and an audit event', async () => {
    const db = new FakeSupabaseClient({
      responses: {
        'store_items:insert': {
          data: { id: ITEM, name: 'שולחן שוק', slug: 'market-table' },
        },
      },
    })

    const kit = services()
    const outcome = await defineStoreOperations({
      db: db.asDb(),
    }).createProduct.run({
      request: {
        input: {
          name: 'שולחן שוק',
          slug: 'market-table',
          itemType: 'experience',
          pricingModel: 'fixed',
          basePriceAgorot: FIFTEEN_HUNDRED,
          shortDescription: null,
          categoryId: null,
          leadTimeHours: 48,
          requiresApproval: null,
        },
        idempotencyKey: 'create-market-table',
      },
      context: context(),
      services: kit,
    })

    expect(outcome.data.name).toBe('שולחן שוק')

    const insert = db.queriesFor('store_items')[0]
    const payload = insert.payload as Record<string, unknown>

    expect(payload.base_price_agorot).toBe(FIFTEEN_HUNDRED)
    expect(payload.organization_id).toBe(ORGANIZATION)
    // Born a draft: an active product with no availability and no photograph
    // is a listing somebody published by accident.
    expect(payload.status).toBe('draft')

    // The charter's rule: a change nobody can trace is not a change.
    expect(kit.audit.records).toHaveLength(1)
    expect(kit.audit.records[0].summary).toContain('שולחן שוק')
  })

  it('refuses to set a price without product.price_manage, holding product.manage', async () => {
    const db = new FakeSupabaseClient({ responses: {} })
    const kit = services()

    // 0012 separated the two deliberately: a person may be trusted to write a
    // description and not to move a price.
    const withoutPricing = {
      ...context(),
      actor: owner(OWNER_GRANTS.filter((g) => g !== 'product.price_manage')),
    }

    await expect(
      defineStoreOperations({ db: db.asDb() }).createProduct.run({
        request: {
          input: {
            name: 'שולחן שוק',
            slug: 'market-table',
            itemType: 'experience',
            pricingModel: 'fixed',
            basePriceAgorot: FIFTEEN_HUNDRED,
            shortDescription: null,
            categoryId: null,
            leadTimeHours: 48,
            requiresApproval: null,
          },
        },
        context: withoutPricing,
        services: kit,
      }),
    ).rejects.toThrow()

    // Nothing was written on the refusal.
    expect(db.queriesFor('store_items')).toHaveLength(0)
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('STEP 1b — the owner raises the price, and a placed order does not move', () => {
  const EIGHTEEN_HUNDRED = 180_000

  it('writes the new price to the catalogue and nothing else', async () => {
    const db = new FakeSupabaseClient({
      responses: {
        'store_items:update': {
          data: {
            id: ITEM,
            name: 'שולחן שוק',
            base_price_agorot: EIGHTEEN_HUNDRED,
            pricing_model: 'fixed',
          },
        },
      },
    })

    const kit = services()
    const outcome = await defineStoreOperations({
      db: db.asDb(),
    }).changeProductPrice.run({
      request: {
        input: {
          itemId: ITEM,
          pricingModel: 'fixed',
          basePriceAgorot: EIGHTEEN_HUNDRED,
        },
        idempotencyKey: 'reprice-market-table',
      },
      context: context(),
      services: kit,
    })

    expect(outcome.data.basePriceAgorot).toBe(EIGHTEEN_HUNDRED)

    // Exactly one table is written, and it is the catalogue. If a reprice ever
    // touched `store_order_lines`, every historical order would silently
    // restate itself and no test below this line would notice.
    const written = db.queries
      .filter((query) => query.verb === 'update')
      .map((query) => query.table)
    expect(written).toEqual(['store_items'])

    const update = db.queriesFor('store_items')[0]
    const payload = update.payload as Record<string, unknown>
    expect(payload.base_price_agorot).toBe(EIGHTEEN_HUNDRED)

    // Scoped by organization in the query, not only by policy. The demo has
    // no RLS, and a reprice crossing a tenant is the worst thing this column
    // could do.
    expect(
      update.filters.some(
        (filter) =>
          filter.column === 'organization_id' && filter.value === ORGANIZATION,
      ),
    ).toBe(true)

    // A price change with no author is the one audit row somebody wants in a
    // dispute.
    expect(payload.updated_by).toBeTruthy()
    expect(kit.audit.records).toHaveLength(1)
    expect(kit.audit.records[0].summary).toContain('שולחן שוק')
  })

  it('refuses a reprice from somebody holding only product.manage', async () => {
    const db = new FakeSupabaseClient({ responses: {} })

    await expect(
      defineStoreOperations({ db: db.asDb() }).changeProductPrice.run({
        request: {
          input: {
            itemId: ITEM,
            pricingModel: 'fixed',
            basePriceAgorot: EIGHTEEN_HUNDRED,
          },
          idempotencyKey: 'reprice-refused',
        },
        context: {
          ...context(),
          actor: owner(
            OWNER_GRANTS.filter((grant) => grant !== 'product.price_manage'),
          ),
        },
        services: services(),
      }),
    ).rejects.toThrow()

    // Refused before anything was written, not after.
    expect(db.queriesFor('store_items')).toHaveLength(0)
  })

  it('refuses to put a fixed price on a quote product, and the reverse', async () => {
    const db = new FakeSupabaseClient({ responses: {} })

    await expect(
      defineStoreOperations({ db: db.asDb() }).changeProductPrice.run({
        request: {
          input: {
            itemId: ITEM,
            pricingModel: 'quote',
            basePriceAgorot: EIGHTEEN_HUNDRED,
          },
          idempotencyKey: 'reprice-quote-with-price',
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toMatchObject({ code: 'store_quote_has_price' })

    await expect(
      defineStoreOperations({ db: db.asDb() }).changeProductPrice.run({
        request: {
          input: {
            itemId: ITEM,
            pricingModel: 'fixed',
            basePriceAgorot: null,
          },
          idempotencyKey: 'reprice-fixed-without-price',
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toMatchObject({ code: 'store_price_required' })
  })
})

describe('STEP 2 — an order is placed, and the price is SNAPSHOTTED onto the line', () => {
  function orderDb() {
    return new FakeSupabaseClient({
      responses: {
        ...catalogueResponses(),
        'store_orders:select': { data: null },
        'store_orders:insert': {
          data: { id: ORDER, reference: 'S-260301-KQ7' },
        },
        'store_order_lines:insert': { data: null },
      },
    })
  }

  it('writes the catalogue price onto the line, with its provenance', async () => {
    const db = orderDb()
    const kit = services()

    const outcome = await defineStoreOperations({
      db: db.asDb(),
    }).createOrder.run({
      request: {
        input: {
          propertyId: PROPERTY,
          bookingId: BOOKING,
          guestId: null,
          lines: [
            {
              itemId: ITEM,
              quantity: 1,
              optionValueIds: [],
              notes: null,
            },
          ],
          requestedForDate: '2026-03-11',
          guestNotes: null,
          paymentMode: null,
          submissionKey: 'stable-submission-key',
          source: 'guest_portal',
        },
      },
      context: context(),
      services: kit,
    })

    expect(outcome.data.totalAgorot).toBe(FIFTEEN_HUNDRED)

    const lines = db.queriesFor('store_order_lines')[0]
    const written = (lines.payload as Record<string, unknown>[])[0]

    // ── THE SNAPSHOT ────────────────────────────────────────────────────
    expect(written.unit_price_agorot).toBe(FIFTEEN_HUNDRED)
    expect(written.item_name_snapshot).toBe('שולחן שוק')
    expect(written.pricing_model_snapshot).toBe('fixed')
    expect(written.price_source).toBe('catalogue')
    // Frozen alongside the price, so §11 judges this order by what it was
    // sold under rather than by today's terms.
    expect(written.cancellation_policy_snapshot).toEqual({
      kind: 'free_until_hours',
      hoursBefore: 48,
    })
    expect(written.lead_time_hours_snapshot).toBe(48)
    expect(written.fulfilment_recipe_snapshot).toMatchObject({
      title: 'להכין שולחן שוק',
      dueOffsetHours: -3,
    })
  })

  /**
   * THE ORDER'S TOTAL IS THE SUM OF THE LINES IT WAS WRITTEN WITH.
   *
   * This originally asserted the money columns were ABSENT, on the reasoning
   * that `tg_store_order_totals` owns them. The trigger does own them — it
   * rewrites all four from the persisted lines and discards whatever was sent
   * — but "absent" turned out to be the wrong way to state it, and the demo
   * found out: with no defaults and no triggers, an order created through this
   * operation read back with no `total_agorot` at all and the money mapper
   * threw.
   *
   * So the operation writes them, from `draftOrderTotals(drafts)` — the same
   * drafts the lines are built from, one computation feeding both. The
   * invariant worth asserting was never "no total is sent"; it is that the
   * total AGREES with the lines. That is what this now checks, and it is the
   * property that would actually be violated by a bug.
   *
   * `line_total_agorot` stays absent, and for a different and harder reason:
   * it is GENERATED ALWAYS, and Postgres rejects an explicit write to it.
   */
  it('writes a total equal to the sum of its lines, and never the generated column', async () => {
    const db = orderDb()
    await defineStoreOperations({ db: db.asDb() }).createOrder.run({
      request: {
        input: {
          propertyId: PROPERTY,
          bookingId: BOOKING,
          guestId: null,
          lines: [
            { itemId: ITEM, quantity: 1, optionValueIds: [], notes: null },
          ],
          requestedForDate: null,
          guestNotes: null,
          paymentMode: null,
          submissionKey: null,
          source: 'staff',
        },
      },
      context: context(),
      services: services(),
    })

    const insert = db
      .queriesFor('store_orders')
      .find((q) => q.verb === 'insert')
    const payload = insert?.payload as Record<string, unknown>

    const written = db.queriesFor('store_order_lines')[0].payload as Record<
      string,
      unknown
    >[]

    // The same arithmetic 0032 declares for the generated column.
    const sum = written.reduce(
      (total, line) =>
        total +
        ((line.unit_price_agorot as number) +
          (line.options_agorot as number) +
          (line.addons_agorot as number)) *
          (line.quantity as number) -
        (line.line_discount_agorot as number),
      0,
    )

    expect(sum).toBe(FIFTEEN_HUNDRED)
    expect(payload.subtotal_agorot).toBe(sum)
    expect(payload.total_agorot).toBe(sum)
    expect(payload.discount_agorot).toBe(0)

    // Never sent: Postgres refuses an explicit write to a generated column,
    // and that refusal is what makes a line total unfakeable.
    expect(written[0]).not.toHaveProperty('line_total_agorot')
  })

  /**
   * The organization asks for approval, so the order waits — it is not
   * confirmed, and nothing is owed yet. The default payment mode asks nothing
   * of the guest, which is the whole point of `with_booking`.
   */
  it('starts awaiting approval and unpaid, on a store with no payment provider', async () => {
    const db = orderDb()
    const outcome = await defineStoreOperations({
      db: db.asDb(),
    }).createOrder.run({
      request: {
        input: {
          propertyId: PROPERTY,
          bookingId: BOOKING,
          guestId: null,
          lines: [
            { itemId: ITEM, quantity: 1, optionValueIds: [], notes: null },
          ],
          requestedForDate: null,
          guestNotes: null,
          paymentMode: null,
          submissionKey: null,
          source: 'guest_portal',
        },
      },
      context: context(),
      services: services(),
    })

    expect(outcome.data.status).toBe('awaiting_approval')

    const insert = db
      .queriesFor('store_orders')
      .find((q) => q.verb === 'insert')
    const payload = insert?.payload as Record<string, unknown>
    expect(payload.payment_mode).toBe('with_booking')
    expect(payload.payment_status).toBe('unpaid')
  })

  /**
   * THE DOUBLE-TAPPED SUBMIT.
   *
   * The second request finds the first order by its submission key and returns
   * it. One order, and — critically — NO second `store.order_created`, because
   * an event fired twice is a second operational task and a second message to
   * a provider.
   */
  it('returns the existing order for a second submit with the same key, and fires no second event', async () => {
    const db = new FakeSupabaseClient({
      responses: {
        ...catalogueResponses(),
        'store_orders:select': {
          data: {
            id: ORDER,
            reference: 'S-260301-KQ7',
            status: 'awaiting_approval',
            total_agorot: FIFTEEN_HUNDRED,
          },
        },
      },
    })

    const outcome = await defineStoreOperations({
      db: db.asDb(),
    }).createOrder.run({
      request: {
        input: {
          propertyId: PROPERTY,
          bookingId: BOOKING,
          guestId: null,
          lines: [
            { itemId: ITEM, quantity: 1, optionValueIds: [], notes: null },
          ],
          requestedForDate: '2026-03-11',
          guestNotes: null,
          paymentMode: null,
          submissionKey: 'stable-submission-key',
          source: 'guest_portal',
        },
      },
      context: context(),
      services: services(),
    })

    expect(outcome.data.deduplicated).toBe(true)
    expect(outcome.data.id).toBe(ORDER)
    expect(outcome.events).toHaveLength(0)

    // No second row, and no second line.
    expect(
      db.queriesFor('store_orders').filter((q) => q.verb === 'insert'),
    ).toHaveLength(0)
    expect(db.queriesFor('store_order_lines')).toHaveLength(0)
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

/** The order as it now stands, for the operations that load one. */
const PLACED_ORDER_ROW = {
  id: ORDER,
  organization_id: ORGANIZATION,
  property_id: PROPERTY,
  booking_id: BOOKING,
  guest_id: null,
  reference: 'S-260301-KQ7',
  source: 'guest_portal',
  status: 'awaiting_approval',
  payment_status: 'unpaid',
  payment_mode: 'with_booking',
  currency: 'ILS',
  subtotal_agorot: FIFTEEN_HUNDRED,
  discount_agorot: 0,
  tax_agorot: 0,
  total_agorot: FIFTEEN_HUNDRED,
  promo_code_id: null,
  promo_code_snapshot: null,
  requested_for_date: '2026-03-11',
  requested_for_time: null,
  guest_notes: null,
  internal_notes: null,
  approved_at: null,
  confirmed_at: null,
  fulfilled_at: null,
  cancelled_at: null,
  cancellation_reason: null,
  refunded_at: null,
  amendment_count: 0,
  created_at: '2026-03-01T09:00:00.000Z',
}

const PLACED_LINE_ROW = {
  id: '77777777-7777-4777-8777-777777777777',
  organization_id: ORGANIZATION,
  order_id: ORDER,
  item_id: ITEM,
  package_id: null,
  item_name_snapshot: 'שולחן שוק',
  item_type_snapshot: 'experience',
  pricing_model_snapshot: 'fixed',
  unit_price_agorot: FIFTEEN_HUNDRED,
  options_agorot: 0,
  addons_agorot: 0,
  line_discount_agorot: 0,
  quantity: 1,
  line_total_agorot: FIFTEEN_HUNDRED,
  price_snapshot_at: '2026-03-01T09:00:00.000Z',
  price_source: 'catalogue',
  customization_answers: {},
  fulfilment_kind_snapshot: 'staff_task',
  fulfilment_recipe_snapshot: ITEM_ROW.fulfilment_recipe,
  lead_time_hours_snapshot: 48,
  cancellation_policy_snapshot: { kind: 'free_until_hours', hoursBefore: 48 },
  provider_id: null,
  line_status: 'pending',
  notes: null,
  sort_order: 0,
}

function placedOrderDb(overrides: Record<string, unknown> = {}) {
  return new FakeSupabaseClient({
    responses: {
      store_orders: { data: { ...PLACED_ORDER_ROW, ...overrides } },
      store_order_lines: { data: [PLACED_LINE_ROW] },
      store_order_line_options: { data: [] },
      store_order_payments: { data: [] },
      ...catalogueResponses(),
    },
  })
}

describe('STEP 3 — the owner approves', () => {
  it('confirms the order and raises the approved and confirmed events', async () => {
    const db = placedOrderDb()
    const kit = services()

    const outcome = await defineStoreOperations({
      db: db.asDb(),
    }).approveOrder.run({
      request: { input: { orderId: ORDER }, resourceId: ORDER },
      context: context(),
      services: kit,
    })

    expect(outcome.data.id).toBe(ORDER)

    const update = db
      .queriesFor('store_orders')
      .find((query) => query.verb === 'update')
    const payload = update?.payload as Record<string, unknown>

    expect(payload.status).toBe('confirmed')
    expect(payload.approved_at).toBe('2026-03-01T09:00:00.000Z')

    // Both from the frozen catalogue. Nothing here invents an event name.
    expect(outcome.events.map((event) => event.name)).toEqual([
      'store.order_approved',
      'store.order_confirmed',
    ])

    expect(kit.audit.records[0].summary).toContain('S-260301-KQ7')
  })

  it('refuses to approve an order that is already cancelled', async () => {
    const db = placedOrderDb({ status: 'cancelled' })

    await expect(
      defineStoreOperations({ db: db.asDb() }).approveOrder.run({
        request: { input: { orderId: ORDER }, resourceId: ORDER },
        context: context(),
        services: services(),
      }),
    ).rejects.toMatchObject({ code: 'store_order_invalid_transition' })
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('STEP 4 — the owner marks a manual payment', () => {
  it('records the money and DERIVES the payment status from it', async () => {
    const db = placedOrderDb({ status: 'confirmed' })
    const kit = services()

    const outcome = await defineStoreOperations({
      db: db.asDb(),
    }).recordPayment.run({
      request: {
        input: {
          orderId: ORDER,
          amountAgorot: FIFTEEN_HUNDRED,
          method: 'bank_transfer',
          reference: '4471',
        },
        resourceId: ORDER,
      },
      context: context(),
      services: kit,
    })

    const payment = db.queriesFor('store_order_payments')[0]
    const payload = payment.payload as Record<string, unknown>

    expect(payload.amount_agorot).toBe(FIFTEEN_HUNDRED)
    expect(payload.method).toBe('bank_transfer')
    // A manual record is `paid`: a person looked at the bank and wrote it down.
    expect(payload.status).toBe('paid')
    // Never a card number or a token — a reference a person can point at.
    expect(payload.reference).toBe('4471')

    // Derived, never typed. See `paymentStatusFor`.
    expect(outcome.data.paymentStatus).toBe('paid')
    expect(outcome.events.map((event) => event.name)).toEqual([
      'store.order_paid',
    ])
  })

  it('refuses more money than the order is worth, which is almost always a typo', async () => {
    const db = placedOrderDb({ status: 'confirmed' })

    await expect(
      defineStoreOperations({ db: db.asDb() }).recordPayment.run({
        request: {
          input: {
            orderId: ORDER,
            amountAgorot: FIFTEEN_HUNDRED * 10,
            method: 'bank_transfer',
            reference: null,
          },
          resourceId: ORDER,
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toMatchObject({ code: 'store_payment_exceeds_total' })

    expect(db.queriesFor('store_order_payments')).toHaveLength(0)
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('STEP 5 — an operational task exists, from the SNAPSHOT recipe', () => {
  const order: StoreOrder = {
    id: ORDER,
    organizationId: ORGANIZATION,
    propertyId: PROPERTY,
    bookingId: BOOKING,
    guestId: null,
    reference: 'S-260301-KQ7',
    source: 'guest_portal',
    status: 'confirmed',
    paymentStatus: 'paid',
    paymentMode: 'with_booking',
    currency: 'ILS',
    subtotalAgorot: FIFTEEN_HUNDRED,
    discountAgorot: 0,
    taxAgorot: 0,
    totalAgorot: FIFTEEN_HUNDRED,
    promoCodeId: null,
    promoCodeSnapshot: null,
    requestedForDate: '2026-03-11',
    requestedForTime: null,
    guestNotes: null,
    internalNotes: null,
    approvedAt: '2026-03-01T09:00:00.000Z',
    confirmedAt: '2026-03-01T09:00:00.000Z',
    fulfilledAt: null,
    cancelledAt: null,
    cancellationReason: null,
    refundedAt: null,
    amendmentCount: 0,
    createdAt: '2026-03-01T09:00:00.000Z',
    lines: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        orderId: ORDER,
        itemId: ITEM,
        packageId: null,
        itemNameSnapshot: 'שולחן שוק',
        itemTypeSnapshot: 'experience',
        pricingModelSnapshot: 'fixed',
        unitPriceAgorot: FIFTEEN_HUNDRED,
        optionsAgorot: 0,
        addonsAgorot: 0,
        lineDiscountAgorot: 0,
        quantity: 1,
        lineTotalAgorot: FIFTEEN_HUNDRED,
        priceSnapshotAt: '2026-03-01T09:00:00.000Z',
        priceSource: 'catalogue',
        customizationAnswers: {},
        fulfilmentKindSnapshot: 'staff_task',
        fulfilmentRecipeSnapshot: {
          taskType: 'guest_request',
          title: 'להכין שולחן שוק',
          dueOffsetHours: -3,
          checklist: ['לקנות במכולת', 'לסדר על השולחן'],
        },
        leadTimeHoursSnapshot: 48,
        cancellationPolicySnapshot: {
          kind: 'free_until_hours',
          hoursBefore: 48,
        },
        providerId: null,
        lineStatus: 'confirmed',
        notes: null,
        sortOrder: 0,
        chosenOptions: [],
      } satisfies OrderLineSnapshot,
    ],
  }

  it('creates exactly one task, due three hours before the service', () => {
    const tasks = tasksForOrder({
      order,
      serviceAt: new Date('2026-03-11T16:00:00.000Z'),
    })

    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('להכין שולחן שוק')
    expect(tasks[0].dueAt).toBe('2026-03-11T13:00:00.000Z')
    expect(tasks[0].checklist).toEqual(['לקנות במכולת', 'לסדר על השולחן'])
    expect(tasks[0].bookingId).toBe(BOOKING)
  })

  /**
   * The key is derived from the line, so a retried confirmation, a
   * double-tapped approve and a replayed webhook all produce the SAME key —
   * which is what makes "two tasks for one purchase" impossible rather than
   * unlikely.
   */
  it('produces a stable dedupe key across repeated runs', () => {
    const first = tasksForOrder({
      order,
      serviceAt: new Date('2026-03-11T16:00:00.000Z'),
    })
    const second = tasksForOrder({
      order,
      serviceAt: new Date('2026-03-11T16:00:00.000Z'),
    })

    expect(first[0].dedupeKey).toBe(second[0].dedupeKey)
    expect(first[0].dedupeKey).toContain(order.lines[0].id)
  })
})
