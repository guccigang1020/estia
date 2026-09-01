/**
 * EXECUTION CONTEXT — SERVER ONLY. Every write this module performs.
 *
 * Four operations, all through `defineOperation`, which means all of them go
 * authorization → validation → domain rule → transaction → audit → events in
 * that order and with no way to reorder them. Nothing in the laundry screens
 * issues an `insert` or an `update` of its own.
 *
 * ── The idempotency key, and why the CALLER supplies it ───────────────────
 *
 * The pipeline reserves `request.idempotencyKey` before `execute` runs, so the
 * key has to exist before the work does — which means an operation cannot
 * compute its own. That is a constraint of the pipeline and it happens to be
 * the right shape here anyway: the key must be derived from the *requirement*,
 * not from the request, so that two different sessions computing the same wash
 * collide instead of both succeeding.
 *
 * So `createOrder`'s caller passes `orderRequirementKey(run)` — provider,
 * route, the day it is needed, and the sorted content of the lines. See the
 * header of `orders.ts` for why each of the four parts is in there and what
 * breaks when one is left out. `laundry_orders.requirement_key` carries the
 * same value under a unique constraint, which is the half that survives the
 * idempotency table being pruned.
 *
 * ── Why `sendOrder` is a separate operation and not a status update ───────
 *
 * `laundry.order_send` is the only grant in this module that gates a single
 * act, because sending is the only act that leaves the organization. A row
 * level security policy cannot tell an update that sets `status` from one that
 * sets `sent_at` — both are updates to the same row — so the policy admits
 * `laundry.order_create` for every update and this operation is where the
 * stricter grant is actually enforced. Putting the whole module behind
 * `order_send` would mean a supervisor could not mark a batch as folded.
 */

import { assertCan } from '../authz/can'
import { BusinessRuleError } from '../errors'
import {
  PG_ERROR,
  asString,
  clientFor,
  recordWrite,
  toRow,
} from '../persistence'
import type { Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import {
  LAUNDRY_CHANNELS,
  LAUNDRY_STATUSES,
  TERMINAL_LAUNDRY_STATUSES,
  type LaundryStatus,
} from '../contracts/states'

import { addHours } from './dates'
import {
  renderOrderMessage,
  toMessageView,
  type MessageViewInput,
} from './message'
import { applyAdjustment } from './override'
import { orderReference, orderRequirementKey } from './orders'
import { assessOne, deadlineRiskPayload } from './turnaround'
import type {
  ConsolidatedRun,
  LaundryChannel,
  LaundryOrder,
  LaundrySettings,
} from './types'

/* ---------------------------------------------------------------- input -- */

export interface CreateOrderInput {
  /**
   * When the van is expected. Drives the deadline-risk check.
   *
   * A `Date` rather than a string, because that is what `s.isoDateTime`
   * produces after validating — and restating it as a string here would mean
   * every caller parsed the same value twice, with the second parse being the
   * one nobody checked.
   */
  pickupAt: Date
  channel: LaundryChannel
  providerNotes: string | null
  internalNotes: string | null
}

export interface AdjustLineInput {
  lineId: string
  /** Signed. Replaces any previous adjustment; it does not add to it. */
  adjustment: number
  reason: string
}

export interface SendOrderInput {
  channel: LaundryChannel
  /** What the sender actually reviewed. Stored verbatim as `sent_body`. */
  body: string
}

export interface AdvanceOrderInput {
  status: LaundryStatus
}

const CREATE_INPUT = s.object({
  pickupAt: s.isoDateTime({ label: 'מועד איסוף' }),
  channel: s.enumOf(LAUNDRY_CHANNELS, { label: 'ערוץ' }),
  providerNotes: s.nullable(s.string({ label: 'הערה לספק', max: 1000 })),
  internalNotes: s.nullable(s.string({ label: 'הערה פנימית', max: 1000 })),
})

const ADJUST_INPUT = s.object({
  lineId: s.uuid({ label: 'שורה' }),
  adjustment: s.number({ label: 'שינוי כמות', integer: true }),
  // `min: 3` is not a business number — it is the shortest string that can
  // carry a reason, and the database's own constraint is `length(btrim()) > 0`.
  // A reason of one character satisfies the column and helps nobody.
  reason: s.string({ label: 'נימוק', min: 3, max: 500 }),
})

const SEND_INPUT = s.object({
  channel: s.enumOf(LAUNDRY_CHANNELS, { label: 'ערוץ' }),
  body: s.string({ label: 'נוסח ההודעה', min: 1, max: 4000 }),
})

const ADVANCE_INPUT = s.object({
  status: s.enumOf(LAUNDRY_STATUSES, { label: 'סטטוס' }),
})

/* ------------------------------------------------------------- failures -- */

/**
 * `laundry_orders_requirement_key` already holds this wash.
 *
 * Reported as a business rule rather than a conflict, because reloading will
 * not help: the order exists, and the right action is to open it. The existing
 * reference is in the message so the person can.
 */
export class LaundryOrderAlreadyExistsError extends BusinessRuleError {
  constructor(reference: string, cause: unknown) {
    super({
      code: 'laundry.order_exists',
      message: `laundry_orders_requirement_key rejected a duplicate run: ${reference}`,
      userMessage:
        `הזמנת הכביסה הזאת כבר קיימת (${reference}). לא נוצרה הזמנה נוספת — ` +
        'פתח את ההזמנה הקיימת כדי לראות אותה או לשנות כמויות.',
      publicDetails: { reference },
      cause,
    })
  }
}

/** An order that has finished, or been cancelled, is not edited further. */
export class LaundryOrderClosedError extends BusinessRuleError {
  constructor(status: LaundryStatus) {
    super({
      code: 'laundry.order_closed',
      message: `laundry order is ${status}, which is terminal`,
      userMessage:
        'ההזמנה הזאת סגורה ולא ניתן לשנות אותה. אם צריך כביסה נוספת, צור הזמנה חדשה.',
    })
  }
}

/** An internal batch has nobody to be sent to. */
export class LaundryOrderHasNoProviderError extends BusinessRuleError {
  constructor() {
    super({
      code: 'laundry.order_no_provider',
      message: 'send was attempted on an order with no provider',
      userMessage:
        'אין ספק משויך להזמנה הזאת, ולכן אין למי לשלוח אותה. זהו מחזור כביסה פנימי.',
    })
  }
}

function isDuplicateRun(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as {
    code?: unknown
    message?: unknown
    details?: unknown
  }
  if (record.code !== PG_ERROR.UNIQUE_VIOLATION) return false
  const haystack = `${String(record.message ?? '')} ${String(record.details ?? '')}`
  return haystack.includes('laundry_orders_requirement_key')
}

/* ---------------------------------------------------------------- ports -- */

/**
 * What the operations read that they do not write.
 *
 * Supplied rather than queried inside `execute`, so the domain stays testable
 * without a database and so the reads happen once per request instead of once
 * per operation.
 */
export interface LaundryOperationPorts {
  loadOrder(orderId: string): Promise<LaundryOrder | null>
  /** Everything the message renderer needs that is not on the order. */
  messageContext(order: LaundryOrder): Promise<Omit<MessageViewInput, 'order'>>
}

export type LaundryOperations = {
  createOrder: Operation<
    CreateOrderInput,
    null,
    { id: string; reference: string }
  >
  adjustLine: Operation<
    AdjustLineInput,
    LaundryOrder,
    { lineId: string; final: number }
  >
  sendOrder: Operation<
    SendOrderInput,
    LaundryOrder,
    { id: string; sentAt: string }
  >
  advanceOrder: Operation<
    AdvanceOrderInput,
    LaundryOrder,
    { id: string; status: LaundryStatus }
  >
}

/* ------------------------------------------------------------ the build -- */

export function defineLaundryOperations(options: {
  db: Db
  ports: LaundryOperationPorts
  /** The run being ordered. Held here because `execute` gets no extra args. */
  run: ConsolidatedRun
  settings: LaundrySettings
  orderId: string
  lineIds: readonly string[]
}): LaundryOperations {
  const { ports, run, settings } = options

  /* ------------------------------------------------------------ create -- */

  const createOrder = defineOperation<
    CreateOrderInput,
    null,
    { id: string; reference: string }
  >({
    name: 'laundry.order.create',
    permission: 'laundry.order_create',
    resourceType: 'laundry_order',
    input: CREATE_INPUT,

    /**
     * Scope, asserted by hand because there is nothing to load yet.
     *
     * A consolidated run names its properties, and somebody narrowed to two
     * properties may not order a wash that includes a third. Checked per
     * property rather than once, because a run that mixes one in scope and one
     * out is the case a single check would pass.
     */
    rule({ context }) {
      for (const property of run.properties) {
        assertCan(context.actor, 'laundry.order_create', {
          organizationId: context.actor.organizationId,
          propertyId: property.propertyId,
          family: 'operations',
        })
      }
    },

    async execute({ input, context, tx }) {
      const client = clientFor(tx, options.db)
      const reference = orderReference(run)
      const requirementKey = orderRequirementKey(run)

      const { data, error } = await client
        .from('laundry_orders')
        .insert({
          organization_id: context.actor.organizationId,
          property_id:
            run.properties.length === 1
              ? (run.properties[0]?.propertyId ?? null)
              : null,
          provider_id: run.providerId,
          status: 'draft',
          mode: settings.mode === 'hybrid' ? run.route : settings.mode,
          dispatch_mode: settings.dispatchMode,
          channel: input.channel,
          reference,
          requirement_key: requirementKey,
          required_by: run.requiredBy,
          pickup_at: input.pickupAt.toISOString(),
          // Stored rather than re-derived later, because a provider's
          // turnaround may change between building the order and reading it,
          // and the number that matters is the one the deadline was checked
          // against.
          expected_return_at: addHours(
            input.pickupAt.toISOString(),
            run.properties[0]?.lines[0]?.turnaroundHours ??
              settings.turnaroundHours,
          ),
          internal_notes: input.internalNotes,
          provider_notes: input.providerNotes,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id, reference')
        .single()

      if (isDuplicateRun(error)) {
        throw new LaundryOrderAlreadyExistsError(reference, error)
      }
      if (error) throw error
      if (!data) throw new LaundryOrderClosedError('draft')

      recordWrite(tx, 'laundry_orders.insert')

      const row = toRow(data)
      const orderId = asString(row, 'id')

      let index = 0
      for (const property of run.properties) {
        for (const line of property.lines) {
          const { error: lineError } = await client
            .from('laundry_order_lines')
            .insert({
              id: options.lineIds[index] ?? undefined,
              organization_id: context.actor.organizationId,
              order_id: orderId,
              property_id: property.propertyId,
              item_id: line.itemId,
              label: line.label,
              unit: line.unit,
              calculated_quantity: line.quantity,
              adjustment_quantity: 0,
              explanation: line.explanation,
              source_booking_id: line.sourceBookingId,
              required_by: line.requiredBy,
              created_by: context.actor.userId,
              updated_by: context.actor.userId,
            })

          if (lineError) throw lineError
          recordWrite(tx, 'laundry_order_lines.insert')
          index += 1
        }
      }

      return { id: orderId, reference: asString(row, 'reference') }
    },

    audit({ result, context }) {
      const units = run.properties.reduce(
        (sum, property) => sum + property.units,
        0,
      )
      const houses = run.properties.length

      return {
        resourceId: result.id,
        propertyId:
          run.properties.length === 1
            ? (run.properties[0]?.propertyId ?? null)
            : null,
        after: {
          reference: result.reference,
          providerId: run.providerId,
          route: run.route,
          requiredBy: run.requiredBy,
          properties: run.properties.map((property) => ({
            propertyId: property.propertyId,
            units: property.units,
          })),
        },
        summary:
          `${context.auditActor.label} יצר את הזמנת הכביסה ${result.reference} — ` +
          `${units} פריטים מ-${houses} נכסים, נדרש עד ${run.requiredBy}.`,
      }
    },

    events({ input, result }) {
      const drafts = [
        {
          name: 'laundry.requirements_generated' as const,
          payload: {
            orderId: result.id,
            reference: result.reference,
            requiredBy: run.requiredBy,
            properties: run.properties.map((property) => ({
              propertyId: property.propertyId,
              units: property.units,
            })),
          },
        },
        {
          name: 'laundry.order_ready' as const,
          payload: {
            orderId: result.id,
            reference: result.reference,
            providerId: run.providerId,
            requiredBy: run.requiredBy,
          },
        },
      ]

      // THE TURNAROUND CHECK, at the moment the order is created rather than
      // when somebody opens a screen. A risk nobody looked at is a risk nobody
      // was told about, and the whole point is to raise it before anybody is
      // standing in an unmade bedroom.
      const risks = run.properties
        .flatMap((property) => property.lines)
        .map((line) => assessOne(line, input.pickupAt.toISOString()))
        .filter((assessment) => assessment.atRisk)

      return [
        ...drafts,
        ...risks.map((assessment) => ({
          name: 'laundry.deadline_risk' as const,
          propertyId: assessment.propertyId,
          payload: deadlineRiskPayload(assessment),
        })),
      ]
    },
  })

  /* ------------------------------------------------------------ adjust -- */

  const adjustLine = defineOperation<
    AdjustLineInput,
    LaundryOrder,
    { lineId: string; final: number }
  >({
    name: 'laundry.order.adjust_line',
    permission: 'laundry.order_create',
    resourceType: 'laundry_order',
    input: ADJUST_INPUT,
    requiresVersion: true,

    async loadResource({ request }) {
      const order = await ports.loadOrder(request.resourceId ?? '')
      if (!order) return null

      return {
        resource: {
          organizationId: order.organizationId,
          propertyId: order.propertyId ?? undefined,
          family: 'operations',
        },
        entity: order,
        version: order.version,
      }
    },

    /**
     * A terminal order is not adjusted.
     *
     * A COMMITTED one still is, deliberately. The van arriving and finding four
     * fewer sheets than the note said is exactly when somebody must be able to
     * write down what really went — refusing it would mean the record stops
     * matching reality precisely when it starts to matter. Only `completed`
     * and `cancelled` are closed, and `applyAdjustment` refuses the rest.
     */
    rule({ entity, input }) {
      if (TERMINAL_LAUNDRY_STATUSES.includes(entity.status)) {
        throw new LaundryOrderClosedError(entity.status)
      }

      const line = entity.lines.find(
        (candidate) => candidate.id === input.lineId,
      )
      if (!line) {
        throw new BusinessRuleError({
          code: 'laundry.line_not_found',
          message: `line ${input.lineId} is not on order ${entity.id}`,
          userMessage:
            'השורה שביקשת לשנות אינה קיימת בהזמנה הזאת. רענן ונסה שוב.',
        })
      }

      // Throws when there is no reason, or when the result would go negative.
      // Called here rather than only in `execute` so the refusal happens
      // before the transaction opens.
      applyAdjustment(line.quantity, {
        adjustment: input.adjustment,
        reason: input.reason,
        adjustedByUserId: '',
        at: new Date().toISOString(),
      })
    },

    async execute({ input, entity, context, tx, now }) {
      const client = clientFor(tx, options.db)
      const line = entity.lines.find(
        (candidate) => candidate.id === input.lineId,
      )

      // `rule` already refused a missing line; this is narrowing rather than a
      // second decision.
      if (!line) throw new LaundryOrderClosedError(entity.status)

      const next = applyAdjustment(line.quantity, {
        adjustment: input.adjustment,
        reason: input.reason,
        adjustedByUserId: context.actor.userId,
        at: now.toISOString(),
      })

      const { error } = await client
        .from('laundry_order_lines')
        .update({
          // `calculated_quantity` is deliberately absent. The database refuses
          // a rewrite of it by trigger; this is the application agreeing.
          adjustment_quantity: next.adjustment,
          adjustment_reason: next.reason,
          adjusted_by: next.adjustedByUserId,
          adjusted_at: next.adjustedAt,
          updated_by: context.actor.userId,
        })
        .eq('id', input.lineId)

      if (error) throw error
      recordWrite(tx, 'laundry_order_lines.update')

      return { lineId: input.lineId, final: next.final }
    },

    audit({ input, entity, result, context }) {
      const line = entity.lines.find(
        (candidate) => candidate.id === input.lineId,
      )

      return {
        resourceId: entity.id,
        propertyId: line?.propertyId ?? entity.propertyId ?? null,
        before: { final: line?.quantity.final ?? null },
        after: {
          calculated: line?.quantity.calculated ?? null,
          adjustment: input.adjustment,
          final: result.final,
        },
        reason: input.reason,
        summary:
          `${context.auditActor.label} שינה את הכמות של ${line?.label ?? input.lineId} ` +
          `בהזמנה ${entity.reference} מ-${line?.quantity.final ?? '?'} ל-${result.final}. ` +
          `הנימוק: ${input.reason}`,
      }
    },
  })

  /* -------------------------------------------------------------- send -- */

  const sendOrder = defineOperation<
    SendOrderInput,
    LaundryOrder,
    { id: string; sentAt: string }
  >({
    name: 'laundry.order.send',
    permission: 'laundry.order_send',
    resourceType: 'laundry_order',
    input: SEND_INPUT,
    requiresVersion: true,

    async loadResource({ request }) {
      const order = await ports.loadOrder(request.resourceId ?? '')
      if (!order) return null

      return {
        resource: {
          organizationId: order.organizationId,
          propertyId: order.propertyId ?? undefined,
          family: 'operations',
        },
        entity: order,
        version: order.version,
      }
    },

    rule({ entity }) {
      if (TERMINAL_LAUNDRY_STATUSES.includes(entity.status)) {
        throw new LaundryOrderClosedError(entity.status)
      }
      if (entity.providerId === null) {
        throw new LaundryOrderHasNoProviderError()
      }
      if (entity.sentAt !== null) {
        throw new BusinessRuleError({
          code: 'laundry.already_sent',
          message: `order ${entity.id} was already sent at ${entity.sentAt}`,
          userMessage:
            'ההזמנה כבר נשלחה. שליחה חוזרת עלולה להביא רכב נוסף — אם צריך לעדכן את הספק, צור קשר ישירות.',
        })
      }
    },

    async execute({ input, entity, context, tx, now }) {
      const client = clientFor(tx, options.db)

      const { error } = await client
        .from('laundry_orders')
        .update({
          status: 'to_collect',
          channel: input.channel,
          sent_at: now.toISOString(),
          sent_by: context.actor.userId,
          // Verbatim, as reviewed. Not re-rendered: what was actually said is
          // the record, and a renderer that changed next month would otherwise
          // rewrite history.
          sent_body: input.body,
          updated_by: context.actor.userId,
        })
        .eq('id', entity.id)

      if (error) throw error
      recordWrite(tx, 'laundry_orders.update')

      return { id: entity.id, sentAt: now.toISOString() }
    },

    audit({ entity, result, input, context }) {
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        before: { status: entity.status, sentAt: null },
        after: { status: 'to_collect', sentAt: result.sentAt },
        summary:
          `${context.auditActor.label} שלח את הזמנת הכביסה ${entity.reference} ` +
          `לספק בערוץ ${input.channel}.`,
      }
    },

    events({ entity, result, input }) {
      return [
        {
          name: 'laundry.order_sent' as const,
          propertyId: entity.propertyId,
          payload: {
            orderId: entity.id,
            reference: entity.reference,
            providerId: entity.providerId,
            channel: input.channel,
            sentAt: result.sentAt,
            requiredBy: entity.requiredBy,
          },
        },
      ]
    },
  })

  /* ----------------------------------------------------------- advance -- */

  const advanceOrder = defineOperation<
    AdvanceOrderInput,
    LaundryOrder,
    { id: string; status: LaundryStatus }
  >({
    name: 'laundry.order.advance',
    permission: 'laundry.order_create',
    resourceType: 'laundry_order',
    input: ADVANCE_INPUT,
    requiresVersion: true,

    async loadResource({ request }) {
      const order = await ports.loadOrder(request.resourceId ?? '')
      if (!order) return null

      return {
        resource: {
          organizationId: order.organizationId,
          propertyId: order.propertyId ?? undefined,
          family: 'operations',
        },
        entity: order,
        version: order.version,
      }
    },

    rule({ entity, input }) {
      if (TERMINAL_LAUNDRY_STATUSES.includes(entity.status)) {
        throw new LaundryOrderClosedError(entity.status)
      }

      // An external order that has not been sent cannot be collected. The
      // states are not a strict chain — a `simple` operation jumps from draft
      // to completed and the frozen contract says so explicitly — so this is
      // the one transition that is genuinely refused rather than a general
      // ordering rule.
      if (
        entity.providerId !== null &&
        entity.sentAt === null &&
        input.status !== 'cancelled' &&
        input.status !== 'awaiting_approval'
      ) {
        throw new BusinessRuleError({
          code: 'laundry.not_sent_yet',
          message: `order ${entity.id} has a provider and has not been sent`,
          userMessage:
            'ההזמנה עדיין לא נשלחה לספק, ולכן לא ניתן לקדם אותה. שלח אותה קודם.',
        })
      }
    },

    async execute({ input, entity, context, tx, now }) {
      const client = clientFor(tx, options.db)

      const { error } = await client
        .from('laundry_orders')
        .update({
          status: input.status,
          returned_at:
            input.status === 'delivered_to_property'
              ? now.toISOString()
              : entity.returnedAt,
          updated_by: context.actor.userId,
        })
        .eq('id', entity.id)

      if (error) throw error
      recordWrite(tx, 'laundry_orders.update')

      return { id: entity.id, status: input.status }
    },

    audit({ entity, result, context }) {
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        before: { status: entity.status },
        after: { status: result.status },
        summary:
          `${context.auditActor.label} עדכן את הזמנת הכביסה ${entity.reference} ` +
          `מ-${entity.status} ל-${result.status}.`,
      }
    },

    events({ entity, result }) {
      if (result.status !== 'ready') return []

      return [
        {
          name: 'laundry.ready' as const,
          propertyId: entity.propertyId,
          payload: {
            orderId: entity.id,
            reference: entity.reference,
            requiredBy: entity.requiredBy,
          },
        },
      ]
    },
  })

  return { createOrder, adjustLine, sendOrder, advanceOrder }
}

/**
 * Render what will be sent, so a person can review it before pressing send.
 *
 * Not part of an operation: rendering writes nothing, and putting it behind
 * the pipeline would mean a preview required an idempotency key. It is here
 * rather than in `message.ts` because assembling the view needs the ports, and
 * `message.ts` deliberately knows nothing about a database.
 */
export async function previewOrderMessage(
  order: LaundryOrder,
  ports: LaundryOperationPorts,
  channel?: LaundryChannel,
): Promise<string> {
  const context = await ports.messageContext(order)
  return renderOrderMessage(
    toMessageView({ ...context, order }),
    channel ?? order.channel,
  )
}
