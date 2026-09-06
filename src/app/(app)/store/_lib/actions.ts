'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Every write the store screens perform.
 *
 * ── These write no rows ───────────────────────────────────────────────────
 *
 * Each one hands its request to `defineStoreOperations`, which is the only
 * path to a store row that carries authorization, validation, the domain rule,
 * the transaction, the audit event and idempotency in that order. An `insert`
 * from here would look identical to a person and skip all six.
 *
 * ── Why `assertCan` is called here as well ───────────────────────────────
 *
 * The operation asserts it, and row level security asserts it again at the
 * database. This is the independent third: a Server Action is a public
 * endpoint reachable by a crafted POST whatever the screen chose to render,
 * and it must refuse on its own terms before reading or writing anything.
 *
 * ── What a caller gets back ───────────────────────────────────────────────
 *
 * Never a thrown error. A throw inside a Server Action reaches the browser as
 * a digest and a blank screen, so every failure becomes the `SafeErrorBody`
 * `src/lib/errors` already produces: a Hebrew sentence, whether the data was
 * saved, whether retrying is safe, and a correlation id matching the log.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
  type Db,
} from '@/lib/persistence'
import {
  defineStoreOperations,
  operationIdempotencyKey,
  type CreatedOrder,
  type CreatedProduct,
} from '@/lib/store'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { auditActorFor, transactionRunner } from '../../_lib/wiring'
import { domainEventBus } from '../../_lib/events'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

/**
 * The shell, resolved once, or a refusal shaped like every other one.
 *
 * Extracted because five actions need the identical four lines, and five
 * copies is five chances for one of them to forget the `status !== 'ready'`
 * branch and act as a person with no active membership.
 */
async function resolveContext(correlationId: string) {
  const resolved = await shellContext()

  if (!resolved || resolved.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: resolved ? 'membership_not_active' : 'unauthenticated',
        message: resolved
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לבצע את הפעולה.'
          : 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
        retryMessage: resolved
          ? 'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.'
          : 'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId,
      },
    }
  }

  return { ok: true as const, shell: resolved }
}

function servicesFor(db: Db) {
  const { transactions } = transactionRunner(db)
  return {
    audit: new SupabaseAuditWriter(db),
    events: domainEventBus(db),
    idempotency: new SupabaseIdempotencyStore(db),
    transactions,
    onEventError(error: unknown) {
      // A created order whose event failed to deliver is still a created
      // order. Logged so the loss is not silent.
      console.error('[store] domain event delivery failed', error)
    },
  }
}

/**
 * Shekels to agorot, refused rather than rounded.
 *
 * The form asks for ₪1,500 because that is what an owner types. `s.agorot`
 * would refuse `"1500"` for being a string and would name a type at somebody
 * who filled in a price field, so the parse happens here — and a fraction of
 * an agora is refused rather than quietly rounded away, which is the charter's
 * rule about money arriving as `52.005`.
 *
 * Returns `null` for "nothing was typed" and `NaN` for "that is not a price".
 * The two are different answers and the caller treats them differently.
 */
function toAgorot(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0) return Number.NaN

  const agorot = parsed * 100
  return Math.abs(agorot - Math.round(agorot)) < 1e-9
    ? Math.round(agorot)
    : Number.NaN
}

function priceRefusal(
  correlationId: string,
  field: 'המחיר' | 'הסכום',
): SafeErrorBody {
  return {
    code: 'amount_invalid',
    message: `${field} חייב להיות מספר בשקלים, עד שתי ספרות אחרי הנקודה. למשל 1500 או 1500.50.`,
    dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
    retryMessage: `תקן את ${field} ונסה שוב.`,
    dataOutcome: 'not_saved',
    retryable: false,
    correlationId,
  }
}

/* ---------------------------------------------------------- the catalogue -- */

export type NewProductInput = {
  name: string
  slug: string
  itemType: string
  pricingModel: string
  /** Shekels, as the form asks for them. */
  priceShekels: string
  shortDescription: string
  leadTimeHours: string
  idempotencyKey: string
}

export async function createProductAction(
  input: NewProductInput,
): Promise<ActionResult<CreatedProduct>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return resolved

  try {
    assertCan(resolved.shell.actor, 'product.manage', {
      organizationId: resolved.shell.actor.organizationId,
    })

    const priceAgorot =
      input.pricingModel === 'quote' ? null : toAgorot(input.priceShekels)

    if (priceAgorot !== null && Number.isNaN(priceAgorot)) {
      return { ok: false, error: priceRefusal(correlationId, 'המחיר') }
    }

    const db = await createClient()
    const operations = defineStoreOperations({ db })

    const outcome = await operations.createProduct.run({
      request: {
        input: {
          name: input.name.trim(),
          slug: input.slug.trim().toLowerCase(),
          itemType: input.itemType,
          pricingModel: input.pricingModel,
          basePriceAgorot: priceAgorot,
          shortDescription:
            input.shortDescription.trim().length > 0
              ? input.shortDescription.trim()
              : null,
          categoryId: null,
          leadTimeHours: Number.parseInt(input.leadTimeHours, 10) || 0,
          requiresApproval: null,
        },
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/store')
    revalidatePath('/store/products')
    revalidatePath('/store/services')

    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* -------------------------------------------------------------- settings -- */

export type StoreSettingsInput = {
  mode: string
  defaultPaymentMode: string
  approvalRequiredDefault: boolean
  guestStoreEnabled: boolean
  guestStoreHeading: string
  guestStoreIntro: string
  idempotencyKey: string
}

export async function updateStoreSettingsAction(
  input: StoreSettingsInput,
): Promise<ActionResult<{ mode: string }>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return resolved

  try {
    assertCan(resolved.shell.actor, 'product.manage', {
      organizationId: resolved.shell.actor.organizationId,
    })

    const db = await createClient()
    const operations = defineStoreOperations({ db })

    const outcome = await operations.updateSettings.run({
      request: {
        input: {
          mode: input.mode,
          defaultPaymentMode: input.defaultPaymentMode,
          approvalRequiredDefault: input.approvalRequiredDefault,
          guestStoreEnabled: input.guestStoreEnabled,
          guestStoreHeading:
            input.guestStoreHeading.trim().length > 0
              ? input.guestStoreHeading.trim()
              : null,
          guestStoreIntro:
            input.guestStoreIntro.trim().length > 0
              ? input.guestStoreIntro.trim()
              : null,
        },
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/store')
    revalidatePath('/store/settings')

    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ---------------------------------------------------------------- orders -- */

/**
 * "The guest rang up and asked for pool heating."
 *
 * A first-class path and not an afterthought — §7. It is the same operation a
 * guest's own submission takes, with `source: 'staff'`, so an order created at
 * the desk is indistinguishable from one created in the portal in every way
 * that matters afterwards: the same snapshot, the same audit event, the same
 * approval rules.
 */
export type StaffOrderInput = {
  propertyId: string
  bookingId: string | null
  guestId: string | null
  itemId: string
  quantity: string
  optionValueIds: string[]
  requestedForDate: string
  guestNotes: string
  /** From `submissionKey`. Two taps at the desk produce one order too. */
  submissionKey: string
  idempotencyKey: string
}

export async function createStaffOrderAction(
  input: StaffOrderInput,
): Promise<ActionResult<CreatedOrder>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return resolved

  try {
    assertCan(resolved.shell.actor, 'order.manage', {
      organizationId: resolved.shell.actor.organizationId,
      propertyId: input.propertyId,
      family: 'operations',
    })

    const db = await createClient()
    const operations = defineStoreOperations({ db })

    const outcome = await operations.createOrder.run({
      request: {
        input: {
          propertyId: input.propertyId,
          bookingId: input.bookingId,
          guestId: input.guestId,
          lines: [
            {
              itemId: input.itemId,
              quantity: Number.parseInt(input.quantity, 10) || 1,
              optionValueIds: input.optionValueIds,
              notes: null,
            },
          ],
          requestedForDate:
            input.requestedForDate.trim().length > 0
              ? input.requestedForDate.trim()
              : null,
          guestNotes:
            input.guestNotes.trim().length > 0 ? input.guestNotes.trim() : null,
          paymentMode: null,
          submissionKey: input.submissionKey,
          source: 'staff',
        },
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/store')
    revalidatePath('/store/orders')

    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function approveOrderAction(input: {
  orderId: string
}): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return resolved

  try {
    const db = await createClient()
    const operations = defineStoreOperations({ db })

    const outcome = await operations.approveOrder.run({
      request: {
        input: { orderId: input.orderId },
        resourceId: input.orderId,
        // Derived from the order rather than generated per click, so a
        // double-tapped approve replays instead of approving twice.
        idempotencyKey: operationIdempotencyKey(
          'store.order.approve',
          input.orderId,
        ),
      },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/store')
    revalidatePath('/store/orders')
    revalidatePath(`/store/orders/${input.orderId}`)

    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export type RecordPaymentInput = {
  orderId: string
  amountShekels: string
  method: 'card' | 'bit' | 'bank_transfer' | 'cash' | 'paybox' | 'other'
  reference: string
}

export async function recordPaymentAction(
  input: RecordPaymentInput,
): Promise<ActionResult<{ id: string; paymentStatus: string }>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return resolved

  const amountAgorot = toAgorot(input.amountShekels)

  if (amountAgorot === null || Number.isNaN(amountAgorot)) {
    return { ok: false, error: priceRefusal(correlationId, 'הסכום') }
  }

  try {
    const db = await createClient()
    const operations = defineStoreOperations({ db })

    const outcome = await operations.recordPayment.run({
      request: {
        input: {
          orderId: input.orderId,
          amountAgorot,
          method: input.method,
          reference:
            input.reference.trim().length > 0 ? input.reference.trim() : null,
        },
        resourceId: input.orderId,
        // The amount IS in this key, deliberately and unlike the order
        // submission key: two payments of the same amount on one order is a
        // real thing — two guests each paying half — and a key that swallowed
        // the second would lose money the business actually received.
        idempotencyKey: operationIdempotencyKey(
          'store.order.record_payment',
          input.orderId,
          `${amountAgorot}:${input.reference.trim()}`,
        ),
      },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/store')
    revalidatePath(`/store/orders/${input.orderId}`)

    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function cancelOrderAction(input: {
  orderId: string
  cancellationReason: string
}): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return resolved

  try {
    const db = await createClient()
    const operations = defineStoreOperations({ db })

    const outcome = await operations.cancelOrder.run({
      request: {
        input: {
          orderId: input.orderId,
          cancellationReason: input.cancellationReason.trim(),
        },
        resourceId: input.orderId,
        idempotencyKey: operationIdempotencyKey(
          'store.order.cancel',
          input.orderId,
        ),
      },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
        // The operation sets `requiresReason`, and the reason reaches both the
        // `cancellation_reason` column and the audit row from here.
        reason: input.cancellationReason.trim(),
      },
      services: servicesFor(db),
    })

    revalidatePath('/store')
    revalidatePath('/store/orders')
    revalidatePath(`/store/orders/${input.orderId}`)

    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
