/**
 * EXECUTION CONTEXT — SERVER ONLY. Every write the store performs.
 *
 * Each one is a `defineOperation`, which means each one goes through
 * authorization → validation → domain rule → transaction → audit event →
 * idempotency, in that order, with no way for a caller to reorder or skip a
 * step. An `insert` from a route handler would look identical to a person and
 * skip all six; the one that matters most here is the audit event, because a
 * price that changed with no row in `audit_events` is exactly the argument
 * nobody can settle three weeks later.
 *
 * ── The events these emit ─────────────────────────────────────────────────
 *
 * All from `DOMAIN_EVENTS` in the frozen catalogue: `store.order_created`,
 * `store.order_approved`, `store.order_paid`, `store.order_cancelled`. Nothing
 * here invents a name, because an invented name is an event nothing can
 * subscribe to.
 *
 * There is deliberately no event for creating a product. The catalogue has
 * none — a product is configuration, and the audit row is the record of it.
 *
 * ── What is NOT here ──────────────────────────────────────────────────────
 *
 * The guest's own order submission. A guest holds a capability token and no
 * membership, so `assertCan` has nothing to check and this pipeline is the
 * wrong shape for them. That path is a port — see `portal.ts` — and its
 * production implementation belongs with the guest-portal session the
 * coordinator is building.
 */

import { assertCan } from '../authz/can'
import {
  STORE_ITEM_TYPES,
  STORE_MODES,
  STORE_PAYMENT_MODES,
  STORE_PRICING_MODELS,
  type StoreOrderStatus,
} from '../contracts/states'
import { BusinessRuleError } from '../errors'
import {
  asString,
  clientFor,
  recordWrite,
  toRow,
  type Db,
} from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import { assertTransition, initialStatusFor } from './orders'
import { manualPaymentPort, paymentStatusFor } from './payment'
import { StoreRepository } from './repository'
import { snapshotLine, type LineSnapshotDraft } from './snapshot'
import type { StoreOrder, StoreSettings } from './types'

/* ------------------------------------------------------------ the schemas -- */

const SLUG = /^[a-z0-9][a-z0-9_-]*$/

const PRODUCT_INPUT = s.object({
  name: s.string({ label: 'שם המוצר', min: 2, max: 200 }),
  slug: s.string({
    label: 'מזהה',
    min: 2,
    max: 80,
    pattern: SLUG,
    patternMessage:
      'המזהה מורכב מאותיות לטיניות קטנות, ספרות, מקפים וקווים תחתונים.',
  }),
  itemType: s.enumOf(STORE_ITEM_TYPES, { label: 'סוג' }),
  pricingModel: s.enumOf(STORE_PRICING_MODELS, { label: 'אופן התמחור' }),
  // Agorot. `s.agorot` refuses a fraction, which is what stops ₪52.005
  // arriving and being rounded away silently.
  basePriceAgorot: s.nullable(s.agorot({ label: 'מחיר' })),
  shortDescription: s.nullable(s.string({ label: 'תיאור קצר', max: 300 })),
  categoryId: s.nullable(s.uuid({ label: 'קטגוריה' })),
  leadTimeHours: s.number({
    label: 'זמן התראה',
    integer: true,
    min: 0,
    max: 8760,
  }),
  requiresApproval: s.nullable(s.boolean({ label: 'דורש אישור' })),
})

export type ProductDraft = {
  name: string
  slug: string
  itemType: (typeof STORE_ITEM_TYPES)[number]
  pricingModel: (typeof STORE_PRICING_MODELS)[number]
  basePriceAgorot: number | null
  shortDescription: string | null
  categoryId: string | null
  leadTimeHours: number
  requiresApproval: boolean | null
}

export type CreatedProduct = { id: string; name: string; slug: string }

const ORDER_LINE_INPUT = s.object({
  itemId: s.uuid({ label: 'מוצר' }),
  quantity: s.number({ label: 'כמות', integer: true, min: 1, max: 999 }),
  optionValueIds: s.arrayOf(s.uuid(), { label: 'אפשרויות', max: 20 }),
  notes: s.nullable(s.string({ label: 'הערה', max: 1000 })),
})

const ORDER_INPUT = s.object({
  propertyId: s.uuid({ label: 'נכס' }),
  bookingId: s.nullable(s.uuid({ label: 'הזמנה' })),
  guestId: s.nullable(s.uuid({ label: 'אורח' })),
  lines: s.arrayOf(ORDER_LINE_INPUT, { label: 'פריטים', min: 1, max: 40 }),
  requestedForDate: s.nullable(s.string({ label: 'תאריך', max: 10 })),
  guestNotes: s.nullable(s.string({ label: 'הערת אורח', max: 2000 })),
  paymentMode: s.nullable(s.enumOf(STORE_PAYMENT_MODES, { label: 'תשלום' })),
  /** See `idempotency.ts`. Derived from the purchase, not from the request. */
  submissionKey: s.nullable(s.string({ label: 'מפתח שליחה', max: 128 })),
  source: s.enumOf(['guest_portal', 'staff', 'automation'] as const),
})

export type OrderDraft = {
  propertyId: string
  bookingId: string | null
  guestId: string | null
  lines: {
    itemId: string
    quantity: number
    optionValueIds: string[]
    notes: string | null
  }[]
  requestedForDate: string | null
  guestNotes: string | null
  paymentMode: (typeof STORE_PAYMENT_MODES)[number] | null
  submissionKey: string | null
  source: 'guest_portal' | 'staff' | 'automation'
}

export type CreatedOrder = {
  id: string
  reference: string
  status: StoreOrderStatus
  totalAgorot: number
  /** True when an existing order with the same submission key was returned. */
  deduplicated: boolean
}

const APPROVE_INPUT = s.object({
  orderId: s.uuid({ label: 'הזמנה' }),
})

const PAYMENT_INPUT = s.object({
  orderId: s.uuid({ label: 'הזמנה' }),
  amountAgorot: s.agorot({ label: 'סכום' }),
  method: s.enumOf(
    ['card', 'bit', 'bank_transfer', 'cash', 'paybox', 'other'] as const,
    { label: 'אמצעי' },
  ),
  reference: s.nullable(s.string({ label: 'אסמכתה', max: 120 })),
})

const CANCEL_INPUT = s.object({
  orderId: s.uuid({ label: 'הזמנה' }),
  cancellationReason: s.string({ label: 'סיבה', min: 3, max: 500 }),
})

const SETTINGS_INPUT = s.object({
  mode: s.enumOf(STORE_MODES, { label: 'מצב החנות' }),
  defaultPaymentMode: s.enumOf(STORE_PAYMENT_MODES, {
    label: 'ברירת מחדל לתשלום',
  }),
  approvalRequiredDefault: s.boolean({ label: 'דורש אישור' }),
  guestStoreEnabled: s.boolean({ label: 'חנות לאורח' }),
  guestStoreHeading: s.nullable(s.string({ label: 'כותרת', max: 120 })),
  guestStoreIntro: s.nullable(s.string({ label: 'טקסט פתיחה', max: 600 })),
})

export type SettingsDraft = {
  mode: (typeof STORE_MODES)[number]
  defaultPaymentMode: (typeof STORE_PAYMENT_MODES)[number]
  approvalRequiredDefault: boolean
  guestStoreEnabled: boolean
  guestStoreHeading: string | null
  guestStoreIntro: string | null
}

/* --------------------------------------------------------------- helpers -- */

/**
 * An order reference a person can read over the telephone.
 *
 * The prefix comes from the organization's own settings, then the day, then
 * four characters of entropy. Not a sequence: a per-organization counter is a
 * second table and a lock, and the only thing it buys is that references look
 * consecutive — which also tells anybody holding one how many orders the
 * business takes.
 */
function mintOrderReference(prefix: string, now: Date): string {
  const day = now.toISOString().slice(2, 10).replace(/-/g, '')
  const bytes = new Uint8Array(3)
  crypto.getRandomValues(bytes)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let tail = ''
  for (const byte of bytes) tail += alphabet[byte % alphabet.length]
  return `${prefix}-${day}-${tail}`
}

export type StoreOperations = {
  createProduct: Operation<ProductDraft, null, CreatedProduct>
  createOrder: Operation<OrderDraft, null, CreatedOrder>
  approveOrder: Operation<{ orderId: string }, StoreOrder, { id: string }>
  recordPayment: Operation<
    {
      orderId: string
      amountAgorot: number
      method: 'card' | 'bit' | 'bank_transfer' | 'cash' | 'paybox' | 'other'
      reference: string | null
    },
    StoreOrder,
    { id: string; paymentStatus: string }
  >
  cancelOrder: Operation<
    { orderId: string; cancellationReason: string },
    StoreOrder,
    { id: string }
  >
  updateSettings: Operation<SettingsDraft, null, { mode: string }>
}

/* ------------------------------------------------------------- the build -- */

export function defineStoreOperations(options: { db: Db }): StoreOperations {
  const repository = new StoreRepository(options.db)

  /* ------------------------------------------------------------ product -- */

  const createProduct = defineOperation<ProductDraft, null, CreatedProduct>({
    name: 'store.product.create',
    permission: 'product.manage',
    resourceType: 'store_item',
    input: PRODUCT_INPUT,

    /**
     * A price is `product.price_manage`, which is a different grant.
     *
     * 0012 separated the two deliberately: a person may be trusted to write a
     * description and not to move a price. Creating a product WITH a price is
     * therefore both acts, and this is where the second one is checked.
     */
    rule({ input, context }) {
      if (input.basePriceAgorot !== null) {
        assertCan(context.actor, 'product.price_manage', {
          organizationId: context.actor.organizationId,
        })
      }

      // `store_items_price_present`, checked here so the person reads a
      // sentence about their form rather than a constraint name.
      if (input.pricingModel === 'quote' && input.basePriceAgorot !== null) {
        throw new BusinessRuleError({
          code: 'store_quote_has_price',
          userMessage:
            'מוצר שנמכר לפי הצעת מחיר אינו יכול לשאת מחיר קבוע. השאר את שדה המחיר ריק.',
          message: 'quote-priced item was given a base price',
        })
      }
      if (input.pricingModel !== 'quote' && input.basePriceAgorot === null) {
        throw new BusinessRuleError({
          code: 'store_price_required',
          userMessage:
            'צריך לרשום מחיר. אם המחיר נקבע מול כל אורח בנפרד, בחר ״לפי הצעת מחיר״.',
          message: 'non-quote item was given no base price',
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      const { data, error } = await db
        .from('store_items')
        .insert({
          organization_id: context.actor.organizationId,
          category_id: input.categoryId,
          name: input.name,
          slug: input.slug,
          short_description: input.shortDescription,
          item_type: input.itemType,
          // Born a draft, like a property is. An active product with no price
          // check, no availability and no photograph is a listing somebody
          // published by accident.
          status: 'draft',
          pricing_model: input.pricingModel,
          base_price_agorot: input.basePriceAgorot,
          lead_time_hours: input.leadTimeHours,
          requires_approval: input.requiresApproval,

          // ── Every remaining NOT NULL column, stated ────────────────────
          //
          // All of these carry a DEFAULT in 0032, so against Postgres omitting
          // them works. It was still wrong to omit them, and the demo is what
          // proved it: `DemoDatabase` stores exactly the object it is handed
          // and applies no defaults, so a product created through this
          // operation read back with `min_quantity` absent and the mapper
          // threw on the very next render — the catalogue screen went from
          // three items to an error card.
          //
          // The general rule this is an instance of: an operation that leans
          // on a default writes a row whose shape depends on WHICH database
          // answered. Stating the columns costs nothing and makes the insert
          // readable as the row it actually produces.
          min_quantity: 1,
          max_quantity: null,
          max_per_booking: null,
          unit_label: null,
          capacity_per_day: null,
          requires_capability: null,
          min_guests: null,
          max_guests: null,
          cost_agorot: null,
          supplier_reference: null,
          tax_rate_bps: null,
          description: null,
          provider_id: null,
          visibility_rule: 'always',
          visibility_days_before: null,
          payment_mode: null,
          fulfilment_kind: 'none',
          fulfilment_recipe: {},
          customization_questions: [],
          cancellation_policy: {},
          media: [],
          tags: [],
          audience: {},
          is_featured: false,
          sort_order: 0,
          metadata: {},
          version: 1,
          deleted_at: null,

          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id, name, slug')
        .single()

      if (error) throw error
      if (!data) {
        throw new BusinessRuleError({
          code: 'store_product_not_readable',
          userMessage:
            'המוצר נשמר אך אינו גלוי לך. פנה למנהל המערכת כדי לקבל גישה.',
          message:
            'store_items insert returned no row; the select policy refused',
        })
      }

      recordWrite(tx, 'store_items.insert')

      const row = toRow(data)
      return {
        id: asString(row, 'id'),
        name: asString(row, 'name'),
        slug: asString(row, 'slug'),
      }
    },

    audit({ input, result, context }) {
      return {
        resourceId: result.id,
        after: {
          name: result.name,
          slug: result.slug,
          itemType: input.itemType,
          pricingModel: input.pricingModel,
          basePriceAgorot: input.basePriceAgorot,
          status: 'draft',
        },
        summary:
          `${context.auditActor.label} יצרה את המוצר ${result.name} ` +
          `במצב טיוטה`,
      }
    },
  })

  /* -------------------------------------------------------------- order -- */

  const createOrder = defineOperation<OrderDraft, null, CreatedOrder>({
    name: 'store.order.create',
    permission: 'order.manage',
    resourceType: 'store_order',
    input: ORDER_INPUT,

    rule({ input, context }) {
      // The property, checked against the actor's own scope. A manager
      // narrowed to the Carmel flat may not sell into the Galilee villa.
      assertCan(context.actor, 'order.manage', {
        organizationId: context.actor.organizationId,
        propertyId: input.propertyId,
        family: 'operations',
      })
    },

    async execute({ input, context, tx, now }) {
      const db = clientFor(tx, options.db)
      const organizationId = context.actor.organizationId

      // ── The second net against a double-tapped submit ─────────────────
      // The pipeline's idempotency key covers a replay of the same request.
      // This covers two different requests that mean the same purchase — see
      // `idempotency.ts`. Checked before anything is written, and the unique
      // index on the column is what actually decides a race.
      if (input.submissionKey) {
        const { data: existing } = await db
          .from('store_orders')
          .select('id, reference, status, total_agorot')
          .eq('organization_id', organizationId)
          .eq('submission_key', input.submissionKey)
          .maybeSingle()

        if (existing) {
          const row = toRow(existing)
          return {
            id: asString(row, 'id'),
            reference: asString(row, 'reference'),
            status: asString(row, 'status') as StoreOrderStatus,
            totalAgorot: Number(row.total_agorot ?? 0),
            deduplicated: true,
          }
        }
      }

      const settings = await repository.settings({
        organizationId,
        propertyId: input.propertyId,
      })

      if (settings.mode === 'off') {
        throw new BusinessRuleError({
          code: 'store_off',
          userMessage: 'החנות כבויה, ולכן אי אפשר ליצור הזמנה.',
          message: 'store.order.create called while the store mode is off',
        })
      }

      const catalogue = await repository.items({ organizationId })
      const overrides = await repository.propertyOverrides({
        organizationId,
        propertyId: input.propertyId,
      })

      // ── THE SNAPSHOT ──────────────────────────────────────────────────
      // The one place a catalogue price is read to produce an order figure,
      // and it happens exactly here, once, at the moment of purchase.
      const drafts: LineSnapshotDraft[] = []
      for (const line of input.lines) {
        const item = catalogue.find((candidate) => candidate.id === line.itemId)
        if (!item) {
          throw new BusinessRuleError({
            code: 'store_item_missing',
            userMessage:
              'אחד הפריטים שנבחרו כבר אינו קיים. רענן את הדף ונסה שוב.',
            message: `store.order.create: item ${line.itemId} is not in the catalogue`,
          })
        }

        drafts.push(
          snapshotLine({
            item,
            booking: null,
            override: overrides[item.id] ?? null,
            options: line.optionValueIds.map((valueId) => ({
              optionId:
                item.options.find((option) =>
                  option.values.some((value) => value.id === valueId),
                )?.id ?? '',
              optionValueId: valueId,
            })),
            quantity: { requested: line.quantity },
            now,
          }),
        )
      }

      // The one computation. Feeds the guest's instruction, the order's money
      // columns and — through `drafts` — the lines the database then sums.
      const totals = draftOrderTotals(drafts)

      const paymentMode = input.paymentMode ?? settings.defaultPaymentMode
      const instruction = await manualPaymentPort.prepare({
        organizationId,
        orderId: 'pending',
        bookingId: input.bookingId,
        mode: paymentMode,
        amountAgorot: totals.totalAgorot,
        currency: settings.currency,
      })

      const status = initialStatusFor({
        requiresApproval: null,
        settings,
        paymentMode,
      })

      const reference = mintOrderReference(settings.orderReferencePrefix, now)

      const { data, error } = await db
        .from('store_orders')
        .insert({
          organization_id: organizationId,
          property_id: input.propertyId,
          booking_id: input.bookingId,
          guest_id: input.guestId,
          reference,
          source: input.source,
          status,
          payment_status: instruction.initialPaymentStatus,
          payment_mode: paymentMode,
          currency: settings.currency,
          requested_for_date: input.requestedForDate,
          requested_for_time: null,
          guest_notes: input.guestNotes,
          internal_notes: null,
          submission_key: input.submissionKey,

          // ── The money, from the SAME computation as the lines ──────────
          //
          // `tg_store_order_totals` rewrites these from the persisted lines
          // after every line write, so against Postgres whatever is written
          // here is immediately replaced. That is the guarantee, and it is
          // unchanged.
          //
          // They are written anyway, and from `draftOrderTotals(drafts)` —
          // the very drafts the lines below are built from, so this is ONE
          // computation feeding both and not a second opinion. Two reasons.
          // The row has to be readable the instant it exists, and a NOT NULL
          // money column left to a default is a column the demo (which has
          // neither defaults nor triggers) returns as absent. And an insert
          // that states a total the reader can check against the lines is one
          // somebody can audit; an insert that quietly relies on a trigger
          // reads as if the total were unknown at write time, which it is not.
          //
          // If these ever disagreed with the trigger's figure, THE DATABASE IS
          // RIGHT — it summed the rows that actually landed.
          subtotal_agorot: totals.subtotalAgorot,
          discount_agorot: totals.discountAgorot,
          tax_agorot: totals.taxAgorot,
          total_agorot: totals.totalAgorot,

          promo_code_id: null,
          promo_code_snapshot: null,
          approved_at: null,
          approved_by: null,
          confirmed_at: null,
          fulfilled_at: null,
          cancelled_at: null,
          cancellation_reason: null,
          refunded_at: null,
          amendment_count: 0,
          metadata: {},
          version: 1,

          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id, reference')
        .single()

      if (error) throw error
      if (!data) {
        throw new BusinessRuleError({
          code: 'store_order_not_readable',
          userMessage:
            'ההזמנה נשמרה אך אינה גלויה לך. פנה למנהל המערכת כדי לקבל גישה.',
          message: 'store_orders insert returned no row',
        })
      }

      recordWrite(tx, 'store_orders.insert')

      const row = toRow(data)
      const orderId = asString(row, 'id')

      // The lines. `tg_store_order_totals` rewrites the order's money columns
      // from these on every insert, which is why nothing above sets a total.
      const { error: linesError } = await db.from('store_order_lines').insert(
        drafts.map((draft, index) => ({
          organization_id: organizationId,
          order_id: orderId,
          item_id: draft.itemId,
          item_name_snapshot: draft.itemNameSnapshot,
          item_type_snapshot: draft.itemTypeSnapshot,
          pricing_model_snapshot: draft.pricingModelSnapshot,
          unit_price_agorot: draft.unitPriceAgorot,
          options_agorot: draft.optionsAgorot,
          addons_agorot: draft.addonsAgorot,
          line_discount_agorot: draft.lineDiscountAgorot,
          quantity: draft.quantity,
          price_snapshot_at: draft.priceSnapshotAt,
          price_source: draft.priceSource,
          customization_answers: draft.customizationAnswers,
          fulfilment_kind_snapshot: draft.fulfilmentKindSnapshot,
          fulfilment_recipe_snapshot: draft.fulfilmentRecipeSnapshot,
          lead_time_hours_snapshot: draft.leadTimeHoursSnapshot,
          cancellation_policy_snapshot: draft.cancellationPolicySnapshot,
          provider_id: draft.providerId,
          notes: input.lines[index]?.notes ?? null,
          sort_order: index,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })),
      )

      if (linesError) throw linesError
      recordWrite(tx, 'store_order_lines.insert')

      return {
        id: orderId,
        reference: asString(row, 'reference'),
        status,
        totalAgorot: drafts.reduce(
          (sum, draft) => sum + draft.lineTotalAgorot,
          0,
        ),
        deduplicated: false,
      }
    },

    audit({ result, input, context }) {
      return {
        resourceId: result.id,
        propertyId: input.propertyId,
        after: {
          reference: result.reference,
          status: result.status,
          totalAgorot: result.totalAgorot,
          lines: input.lines.length,
          source: input.source,
        },
        summary: result.deduplicated
          ? `${context.auditActor.label} שלחה שוב את הזמנה ${result.reference}, והיא כבר הייתה קיימת`
          : `${context.auditActor.label} יצרה את הזמנת החנות ${result.reference} על סך ${(result.totalAgorot / 100).toFixed(2)} ש״ח`,
      }
    },

    events({ result, input }) {
      // A deduplicated submit is not a second order and must not fire a second
      // "order created" — that is the whole point of the key.
      if (result.deduplicated) return []
      return [
        {
          name: 'store.order_created',
          propertyId: input.propertyId,
          payload: {
            orderId: result.id,
            reference: result.reference,
            bookingId: input.bookingId,
            totalAgorot: result.totalAgorot,
          },
        },
      ]
    },
  })

  /* ------------------------------------------------------------ approve -- */

  const approveOrder = defineOperation<
    { orderId: string },
    StoreOrder,
    { id: string }
  >({
    name: 'store.order.approve',
    permission: 'order.manage',
    resourceType: 'store_order',
    input: APPROVE_INPUT,

    async loadResource({ input, context }) {
      const order = await repository.order({
        organizationId: context.actor.organizationId,
        orderId: input.orderId,
      })
      if (!order) return null

      return {
        resource: {
          organizationId: order.organizationId,
          propertyId: order.propertyId,
          family: 'operations',
        },
        entity: order,
      }
    },

    rule({ entity }) {
      // The graph decides, not this function. `assertTransition` is the one
      // place that knows what may follow what.
      assertTransition(entity.status, 'confirmed')
    },

    async execute({ entity, context, tx, now }) {
      const db = clientFor(tx, options.db)

      const { error } = await db
        .from('store_orders')
        .update({
          status: 'confirmed',
          approved_at: now.toISOString(),
          approved_by: context.actor.userId,
          confirmed_at: now.toISOString(),
          updated_by: context.actor.userId,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', entity.id)

      if (error) throw error
      recordWrite(tx, 'store_orders.update')

      return { id: entity.id }
    },

    audit({ entity, context }) {
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        before: { status: entity.status },
        after: { status: 'confirmed' },
        summary: `${context.auditActor.label} אישרה את הזמנת החנות ${entity.reference}`,
      }
    },

    events({ entity }) {
      return [
        {
          name: 'store.order_approved',
          propertyId: entity.propertyId,
          payload: { orderId: entity.id, reference: entity.reference },
        },
        {
          name: 'store.order_confirmed',
          propertyId: entity.propertyId,
          payload: { orderId: entity.id, reference: entity.reference },
        },
      ]
    },
  })

  /* ------------------------------------------------------------ payment -- */

  const recordPayment = defineOperation<
    {
      orderId: string
      amountAgorot: number
      method: 'card' | 'bit' | 'bank_transfer' | 'cash' | 'paybox' | 'other'
      reference: string | null
    },
    StoreOrder,
    { id: string; paymentStatus: string }
  >({
    name: 'store.order.record_payment',
    permission: 'order.manage',
    resourceType: 'store_order',
    input: PAYMENT_INPUT,

    async loadResource({ input, context }) {
      const order = await repository.order({
        organizationId: context.actor.organizationId,
        orderId: input.orderId,
      })
      if (!order) return null
      return {
        resource: {
          organizationId: order.organizationId,
          propertyId: order.propertyId,
          family: 'finance',
        },
        entity: order,
      }
    },

    rule({ input, entity }) {
      if (input.amountAgorot === 0) {
        throw new BusinessRuleError({
          code: 'store_payment_zero',
          userMessage: 'סכום התשלום חייב להיות גדול מאפס.',
          message: 'record_payment was given zero',
        })
      }
      // More than the order is worth is almost always a typo, and recording it
      // silently produces an owner statement nobody can reconcile.
      if (input.amountAgorot > entity.totalAgorot) {
        throw new BusinessRuleError({
          code: 'store_payment_exceeds_total',
          userMessage:
            'הסכום גדול מסכום ההזמנה. תקן את הסכום, או תקן את ההזמנה עצמה.',
          message: `record_payment ${input.amountAgorot} exceeds total ${entity.totalAgorot}`,
        })
      }
    },

    async execute({ input, entity, context, tx, now }) {
      const db = clientFor(tx, options.db)

      const recorded = await manualPaymentPort.record({
        organizationId: context.actor.organizationId,
        orderId: entity.id,
        mode: entity.paymentMode,
        method: input.method,
        amountAgorot: input.amountAgorot,
        reference: input.reference,
        notes: null,
        recordedAt: now,
      })

      const { error } = await db.from('store_order_payments').insert({
        organization_id: context.actor.organizationId,
        order_id: entity.id,
        mode: recorded.mode,
        method: recorded.method,
        amount_agorot: recorded.amountAgorot,
        status: recorded.status,
        reference: recorded.reference,
        recorded_at: now.toISOString(),
        recorded_by: context.actor.userId,
        created_by: context.actor.userId,
        updated_by: context.actor.userId,
      })

      if (error) throw error
      recordWrite(tx, 'store_order_payments.insert')

      // Derived from the money, never typed. See `paymentStatusFor`.
      const previous = await repository.payments({
        organizationId: context.actor.organizationId,
        orderId: entity.id,
      })
      const total =
        previous.reduce((sum, payment) => sum + payment.amountAgorot, 0) +
        // The row just written may not be visible to this read when the unit
        // of work is sequential rather than transactional, so it is added
        // explicitly rather than assumed present.
        (previous.some((payment) => payment.recordedAt === now.toISOString())
          ? 0
          : recorded.amountAgorot)

      const paymentStatus = paymentStatusFor({
        totalAgorot: entity.totalAgorot,
        recordedAgorot: total,
        hasRefund: total < 0,
      })

      const { error: statusError } = await db
        .from('store_orders')
        .update({
          payment_status: paymentStatus,
          updated_by: context.actor.userId,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', entity.id)

      if (statusError) throw statusError
      recordWrite(tx, 'store_orders.update')

      return { id: entity.id, paymentStatus }
    },

    audit({ input, entity, result, context }) {
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        before: { paymentStatus: entity.paymentStatus },
        after: {
          paymentStatus: result.paymentStatus,
          amountAgorot: input.amountAgorot,
          method: input.method,
        },
        summary:
          `${context.auditActor.label} רשמה תשלום של ` +
          `${(input.amountAgorot / 100).toFixed(2)} ש״ח על הזמנה ${entity.reference}`,
      }
    },

    events({ entity, result }) {
      return result.paymentStatus === 'paid'
        ? [
            {
              name: 'store.order_paid',
              propertyId: entity.propertyId,
              payload: { orderId: entity.id, reference: entity.reference },
            },
          ]
        : []
    },
  })

  /* ------------------------------------------------------------- cancel -- */

  const cancelOrder = defineOperation<
    { orderId: string; cancellationReason: string },
    StoreOrder,
    { id: string }
  >({
    name: 'store.order.cancel',
    permission: 'order.manage',
    resourceType: 'store_order',
    input: CANCEL_INPUT,
    // A cancellation states why. `store_orders_cancelled_pair` says the same
    // thing at the database, and a reason typed here reaches the audit row.
    requiresReason: true,

    async loadResource({ input, context }) {
      const order = await repository.order({
        organizationId: context.actor.organizationId,
        orderId: input.orderId,
      })
      if (!order) return null
      return {
        resource: {
          organizationId: order.organizationId,
          propertyId: order.propertyId,
          family: 'operations',
        },
        entity: order,
      }
    },

    rule({ entity }) {
      assertTransition(entity.status, 'cancelled')
    },

    async execute({ input, entity, context, tx, now }) {
      const db = clientFor(tx, options.db)

      const { error } = await db
        .from('store_orders')
        .update({
          status: 'cancelled',
          cancelled_at: now.toISOString(),
          cancellation_reason: input.cancellationReason,
          updated_by: context.actor.userId,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', entity.id)

      if (error) throw error
      recordWrite(tx, 'store_orders.update')

      return { id: entity.id }
    },

    audit({ input, entity, context }) {
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        before: { status: entity.status },
        after: { status: 'cancelled' },
        reason: input.cancellationReason,
        summary: `${context.auditActor.label} ביטלה את הזמנת החנות ${entity.reference}`,
      }
    },

    events({ entity }) {
      return [
        {
          name: 'store.order_cancelled',
          propertyId: entity.propertyId,
          payload: { orderId: entity.id, reference: entity.reference },
        },
      ]
    },
  })

  /* ----------------------------------------------------------- settings -- */

  const updateSettings = defineOperation<SettingsDraft, null, { mode: string }>(
    {
      name: 'store.settings.update',
      permission: 'product.manage',
      resourceType: 'store_settings',
      input: SETTINGS_INPUT,

      rule({ input }) {
        // The schema's `store_settings_no_live_payment_in_simple`, checked
        // here so the owner reads a sentence rather than a constraint name.
        if (input.mode === 'simple' && input.defaultPaymentMode === 'pay_now') {
          throw new BusinessRuleError({
            code: 'store_live_payment_needs_commerce',
            userMessage:
              'תשלום מקוון אינו חלק מהחנות הפשוטה. בחר מצב ״עם תשלום״ אם אתם רוצים לגבות אונליין.',
            message: 'simple mode cannot default to pay_now',
          })
        }
      },

      async execute({ input, context, tx }) {
        const db = clientFor(tx, options.db)

        // `store_settings_one_per_scope_idx` makes this exactly one row per
        // organization default, so an upsert is the honest write: the first
        // save creates it and every later one edits it.
        const { error } = await db.from('store_settings').upsert(
          {
            organization_id: context.actor.organizationId,
            property_id: null,
            mode: input.mode,
            default_payment_mode: input.defaultPaymentMode,
            approval_required_default: input.approvalRequiredDefault,
            guest_store_enabled: input.guestStoreEnabled,
            guest_store_heading: input.guestStoreHeading,
            guest_store_intro: input.guestStoreIntro,
            created_by: context.actor.userId,
            updated_by: context.actor.userId,
          },
          { onConflict: 'organization_id,property_id' },
        )

        if (error) throw error
        recordWrite(tx, 'store_settings.upsert')

        return { mode: input.mode }
      },

      audit({ input, context }) {
        return {
          after: {
            mode: input.mode,
            defaultPaymentMode: input.defaultPaymentMode,
            guestStoreEnabled: input.guestStoreEnabled,
          },
          summary: `${context.auditActor.label} עדכנה את הגדרות החנות למצב ${input.mode}`,
        }
      },
    },
  )

  return {
    createProduct,
    createOrder,
    approveOrder,
    recordPayment,
    cancelOrder,
    updateSettings,
  }
}

/** Re-exported so a caller can build the same settings shape for a preview. */
export type { StoreSettings }
