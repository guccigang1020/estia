/**
 * EXECUTION CONTEXT — SERVER ONLY. Asking the provider to bring it forward.
 *
 * One command. It sends a second message about an order that has already gone
 * out — "the linen we ordered for Friday is now needed Thursday morning, can
 * you manage it" — and it is the answer to a `laundry.deadline_risk` that a
 * person, or Autopilot, has decided to act on.
 *
 * ══ Why `laundry.order_send` and not `laundry.manage` ═════════════════════
 *
 * The header of `operations.ts` makes the argument and this command inherits
 * it whole: `laundry.order_send` is the only grant in this module that gates a
 * single act, because sending is the only act that leaves the organization.
 * This leaves the organization. A supervisor who may mark a batch as folded
 * has not thereby been trusted to renegotiate a commercial commitment with an
 * outside company in the business's name, and a request for an earlier slot is
 * exactly that — the provider will reschedule a van, or refuse and say why.
 *
 * `body` is required for the same reason `sendOrder` requires it: what is
 * actually said to an outside party is reviewed before it is said, and stored
 * verbatim afterwards rather than re-rendered by whatever the renderer does
 * next month.
 *
 * ══ The original commitment is evidence and is never overwritten ══════════
 *
 * `expected_return_at` is what the provider committed to when the order was
 * sent. `required_by` is what the business needs. This command changes
 * NEITHER. A request is not an agreement: until the provider says yes, the
 * only true statement is "they promised Friday 14:00 and we have asked for
 * Thursday 09:00", and a column overwritten at the moment of asking destroys
 * the first half of that sentence — which is the half that matters when the
 * van arrives on Friday anyway and somebody asks what was agreed.
 *
 * So the request lands in `laundry_orders.metadata`, appended to a list, with
 * the original beside it. Appended rather than replaced because a second
 * chase is a second fact: "we asked twice and they did not answer" is the
 * thing a person needs on the day, and a single-slot field erases it.
 *
 * ══ What this command does NOT do ═════════════════════════════════════════
 *
 * It does not transmit. Nothing in this codebase does — `laundry.order.send`
 * records `sent_body` and emits `laundry.order_sent`, and delivery is
 * downstream of that event. This command is the same shape and has the same
 * gap. It records what was asked and raises the event; whatever carries a
 * message to a provider will carry this one too.
 */

import { BusinessRuleError } from '../errors'
import { clientFor, recordWrite } from '../persistence'
import type { Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import {
  LAUNDRY_CHANNELS,
  TERMINAL_LAUNDRY_STATUSES,
  type LaundryStatus,
} from '../contracts/states'

import {
  LaundryOrderClosedError,
  LaundryOrderHasNoProviderError,
  type LaundryOperationPorts,
} from './operations'
import type { LaundryChannel, LaundryOrder } from './types'

/* ---------------------------------------------------------------- input -- */

export interface RequestEarlierDeliveryInput {
  /** The moment we are asking for. Must be earlier than what was promised. */
  requestedReturnAt: Date
  channel: LaundryChannel
  /** What the sender actually reviewed. Stored verbatim. */
  body: string
}

const REQUEST_EARLIER_INPUT = s.object({
  requestedReturnAt: s.isoDateTime({ label: 'מועד אספקה מבוקש' }),
  channel: s.enumOf(LAUNDRY_CHANNELS, { label: 'ערוץ' }),
  // The same bound `operations.ts` puts on `providerNotes`, and for the same
  // reason: this is a sentence asking for a favour, not the order manifest
  // that `sendOrder` allows four times as much room for.
  body: s.string({ label: 'נוסח הבקשה', min: 1, max: 1000 }),
})

/* ------------------------------------------------------------- failures -- */

/**
 * The linen is already at the house.
 *
 * Distinct from `LaundryOrderClosedError` on purpose. "This order is closed"
 * and "this order already arrived" send a person to two different places: the
 * first to open a new order, the second to look in the cupboard.
 */
export class LaundryAlreadyDeliveredError extends BusinessRuleError {
  constructor(status: LaundryStatus) {
    super({
      code: 'laundry.already_delivered',
      message: `earlier delivery requested on an order that is ${status}`,
      userMessage:
        'הכביסה הזאת כבר סופקה, ולכן אין מה להקדים. אם חסר משהו בפועל, ' +
        'פתח הזמנה חדשה.',
    })
  }
}

/** The provider has never been told this order exists. */
export class LaundryOrderNotSentError extends BusinessRuleError {
  constructor() {
    super({
      code: 'laundry.not_sent_yet',
      message: 'earlier delivery requested on an order that was never sent',
      userMessage:
        'ההזמנה עדיין לא נשלחה לספק, ולכן אין ממי לבקש הקדמה. אפשר פשוט ' +
        'לשנות את מועד האיסוף לפני השליחה.',
    })
  }
}

/**
 * The requested moment is not earlier than the one already promised.
 *
 * Refused rather than accepted quietly, because a "request to bring it
 * forward" that asks for a later slot is a message the provider will read as a
 * cancellation of the original commitment.
 */
export class LaundryNotEarlierError extends BusinessRuleError {
  constructor(requested: string, promised: string) {
    super({
      code: 'laundry.not_earlier',
      message: `requested ${requested} is not earlier than promised ${promised}`,
      userMessage:
        'המועד שביקשת אינו מוקדם מהמועד שכבר סוכם עם הספק. אם צריך לדחות ' +
        'אספקה, זו בקשה אחרת ויש לפנות לספק ישירות.',
    })
  }
}

/** Asking for a slot that has already gone by. */
export class LaundryEarlierInThePastError extends BusinessRuleError {
  constructor() {
    super({
      code: 'laundry.earlier_in_the_past',
      message: 'requested return time is in the past',
      userMessage: 'המועד שביקשת כבר עבר. בחר מועד עתידי.',
    })
  }
}

/* ------------------------------------------------------------ the shape -- */

/** One request, as it is stored. The original sits inside it, not beside it. */
export interface EarlierDeliveryRequest {
  requestedAt: string
  requestedByUserId: string
  /** What the provider committed to. Copied at the moment of asking. */
  originalExpectedReturnAt: string | null
  /** What the business needs. Also unchanged by this command. */
  originalRequiredBy: string
  requestedReturnAt: string
  channel: LaundryChannel
  body: string
}

/** The metadata key this command owns. Nothing else in the module writes it. */
export const EARLIER_DELIVERY_KEY = 'earlierDeliveryRequests'

export type LaundryCommands = {
  requestEarlierDelivery: Operation<
    RequestEarlierDeliveryInput,
    LaundryOrder,
    { id: string; requestedReturnAt: string; requestCount: number }
  >
}

/* ------------------------------------------------------------ the build -- */

export function defineLaundryCommands(options: {
  db: Db
  ports: LaundryOperationPorts
}): LaundryCommands {
  const { ports } = options

  const requestEarlierDelivery = defineOperation<
    RequestEarlierDeliveryInput,
    LaundryOrder,
    { id: string; requestedReturnAt: string; requestCount: number }
  >({
    name: 'laundry.order.request_earlier_delivery',
    permission: 'laundry.order_send',
    resourceType: 'laundry_order',
    input: REQUEST_EARLIER_INPUT,
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
     * The five states in which asking is meaningless, in the order a person
     * would discover them.
     */
    rule({ entity, input, now }) {
      if (TERMINAL_LAUNDRY_STATUSES.includes(entity.status)) {
        throw new LaundryOrderClosedError(entity.status)
      }
      if (entity.status === 'delivered_to_property') {
        throw new LaundryAlreadyDeliveredError(entity.status)
      }
      // An internal batch has no outside company to ask. The same refusal
      // `sendOrder` makes, for the same reason.
      if (entity.providerId === null) {
        throw new LaundryOrderHasNoProviderError()
      }
      if (entity.sentAt === null) {
        throw new LaundryOrderNotSentError()
      }

      const requested = input.requestedReturnAt.getTime()
      if (requested <= now.getTime()) {
        throw new LaundryEarlierInThePastError()
      }

      // The commitment to beat is what the provider gave us; when the order
      // carries no expected return — a provider with no stated turnaround —
      // the business's own deadline is the only date there is to be earlier
      // than.
      const promised = entity.expectedReturnAt ?? entity.requiredBy
      if (requested >= Date.parse(promised)) {
        throw new LaundryNotEarlierError(
          input.requestedReturnAt.toISOString(),
          promised,
        )
      }
    },

    /**
     * Append to `metadata`, and touch nothing else.
     *
     * A read then a write rather than a jsonb merge in SQL, because the merge
     * would need a function this module may not add. The read is inside the
     * transaction and the operation carries `requiresVersion`, so a caller
     * editing a stale order is refused before this runs — the same guarantee
     * every other write in this module has.
     */
    async execute({ input, entity, context, tx, now }) {
      const client = clientFor(tx, options.db)

      const { data, error: readError } = await client
        .from('laundry_orders')
        .select('metadata')
        .eq('id', entity.id)
        .single()

      if (readError) throw readError

      const existing = metadataOf(data)
      const previous = requestsIn(existing)

      const request: EarlierDeliveryRequest = {
        requestedAt: now.toISOString(),
        requestedByUserId: context.actor.userId,
        originalExpectedReturnAt: entity.expectedReturnAt,
        originalRequiredBy: entity.requiredBy,
        requestedReturnAt: input.requestedReturnAt.toISOString(),
        channel: input.channel,
        body: input.body,
      }

      const { error } = await client
        .from('laundry_orders')
        .update({
          // `expected_return_at`, `required_by` and `status` are deliberately
          // absent. See the header: a request is not an agreement.
          metadata: {
            ...existing,
            [EARLIER_DELIVERY_KEY]: [...previous, request],
          },
          updated_by: context.actor.userId,
        })
        .eq('id', entity.id)

      if (error) throw error
      recordWrite(tx, 'laundry_orders.update')

      return {
        id: entity.id,
        requestedReturnAt: request.requestedReturnAt,
        requestCount: previous.length + 1,
      }
    },

    audit({ entity, input, result, context }) {
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        // `before` is deliberately absent, and it is not an oversight. The
        // audit pipeline stores the DIFFERENCE between the two halves, so
        // naming the promised time in both would make it vanish from the row
        // — and the promised time is the one fact this record exists to keep
        // beside the ask. Nothing was replaced here; something was added.
        after: {
          expectedReturnAt: entity.expectedReturnAt,
          requiredBy: entity.requiredBy,
          requestedReturnAt: result.requestedReturnAt,
          requestCount: result.requestCount,
        },
        summary:
          `${context.auditActor.label} ביקש מהספק להקדים את אספקת ההזמנה ` +
          `${entity.reference} ל-${result.requestedReturnAt} ` +
          `(סוכם: ${entity.expectedReturnAt ?? entity.requiredBy}) ` +
          `בערוץ ${input.channel}. ` +
          (result.requestCount > 1
            ? `זו בקשה מספר ${result.requestCount}. `
            : '') +
          'המועד שסוכם לא שונה — הבקשה ממתינה לתשובת הספק.',
      }
    },

    /**
     * `laundry.deadline_risk`, which is the closest thing the frozen event
     * catalogue has.
     *
     * It is true — an order somebody is asking to accelerate is an order whose
     * turnaround does not reach the arrival — but it is not the event that
     * happened. There is no `laundry.earlier_delivery_requested`, and the
     * catalogue is frozen. The payload names the request explicitly so a
     * handler can tell the two apart.
     */
    events({ entity, input, result }) {
      return [
        {
          name: 'laundry.earlier_delivery_requested' as const,
          propertyId: entity.propertyId,
          payload: {
            orderId: entity.id,
            reference: entity.reference,
            providerId: entity.providerId,
            requiredBy: entity.requiredBy,
            expectedReturnAt: entity.expectedReturnAt,
            earlierDeliveryRequested: true,
            requestedReturnAt: result.requestedReturnAt,
            requestCount: result.requestCount,
            channel: input.channel,
          },
        },
      ]
    },
  })

  return { requestEarlierDelivery }
}

/* --------------------------------------------------------------- reading -- */

/**
 * The order's metadata, or an empty object.
 *
 * `metadata` is `jsonb not null default '{}'` so a row always has one, but a
 * select that returned something else must not take the rest of the object
 * with it — anything unreadable is treated as empty and the append still
 * happens, because losing a colleague's note is better than refusing to
 * record the request.
 */
function metadataOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {}
  const metadata = (value as Record<string, unknown>)['metadata']
  if (metadata === null || typeof metadata !== 'object') return {}
  if (Array.isArray(metadata)) return {}
  return { ...(metadata as Record<string, unknown>) }
}

/** The requests already recorded. Read defensively; written by this file only. */
function requestsIn(
  metadata: Record<string, unknown>,
): readonly EarlierDeliveryRequest[] {
  const value = metadata[EARLIER_DELIVERY_KEY]
  return Array.isArray(value) ? (value as EarlierDeliveryRequest[]) : []
}
