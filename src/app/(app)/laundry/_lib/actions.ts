'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTION. The three writes the laundry screens make.
 *
 * ── Not one of these writes a row ─────────────────────────────────────────
 *
 * Each hands the request to an operation in `src/lib/laundry/operations.ts`,
 * which is the only path with authorization, validation, the domain rule, the
 * transaction, the audit event and idempotency wired in that order. What is
 * left here is the shape of the request: reading the form, naming the person
 * for the audit trail, and turning any failure into a sentence.
 *
 * ── Why `assertCan` is called here as well ────────────────────────────────
 *
 * `laundry_orders_update` requires `laundry.order_create` at the database and
 * the operations assert their own grants, so this is not the enforcement. It is
 * the independent one: a Server Action is reachable by a crafted POST whatever
 * the screen rendered, and it must refuse on its own terms before it has read
 * or written anything. Deny by default, twice.
 *
 * ── Approval is the safe default, and it is a real two-person split ───────
 *
 * `LAUNDRY_DISPATCH_MODES` defaults to `approval_required`, and the frozen
 * contract says why: an order sent automatically is a message in the
 * organization's name to an outside company, and a business must opt into that
 * rather than discover it.
 *
 * So `submitForApproval` and `sendOrder` are two actions behind two grants.
 * A housekeeping supervisor holds `laundry.order_create` and raises the run; a
 * manager holds `laundry.order_send` and is the one who talks to the provider.
 * Under `manual_send` the first step is skipped; under `auto_send` a business
 * has explicitly asked for it. Nothing here sends on its own.
 *
 * ── What a caller gets back ───────────────────────────────────────────────
 *
 * Never a thrown error. A throw inside a Server Action reaches the browser as
 * a digest and an empty screen. Every failure becomes the `SafeErrorBody`
 * `src/lib/errors` already produces — Hebrew sentence, whether the data was
 * saved, whether retrying is safe, and a correlation id matching the log.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import { previewOrderMessage } from '@/lib/laundry'
import type { LaundryChannel, LaundryStatus } from '@/lib/laundry'

import { shellContext } from '../../_lib/context'
import { auditActorFor } from '../../_lib/wiring'
import { loadOrder } from './queries'
import { laundryOperations, laundryPorts } from './wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

/* ------------------------------------------------------------ the gate -- */

/**
 * The context every action here needs, or the refusal that replaces it.
 *
 * A signed-out or workspace-less caller is refused before reaching a write
 * with a fabricated actor.
 */
async function requireReady() {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: 'unauthenticated',
        message: 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
        retryMessage: 'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId: crypto.randomUUID(),
      } satisfies SafeErrorBody,
    }
  }

  return { ok: true as const, context }
}

/** Refresh the two screens an order appears on. */
function revalidateOrder(orderId: string): void {
  revalidatePath('/laundry')
  revalidatePath('/laundry/orders')
  revalidatePath(`/laundry/orders/${orderId}`)
}

/* ------------------------------------------------------------- adjust -- */

export type AdjustLineResult = { lineId: string; final: number }

/**
 * Change a quantity, keeping the engine's figure and the reason.
 *
 * The reason is mandatory here, in `applyAdjustment`, and in a check
 * constraint. Three refusals for one rule, because a nullable reason column is
 * one nobody fills in — and what somebody said at the time is the only part of
 * an override that is still useful three weeks later.
 */
export async function adjustLineAction(
  orderId: string,
  formData: FormData,
): Promise<ActionResult<AdjustLineResult>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(context.actor, 'laundry.order_create')

    const { operations, services } = await laundryOperations(
      context.workspace.name,
    )

    const outcome = await operations.adjustLine.run({
      request: {
        resourceId: orderId,
        expectedVersion: Number(formData.get('version')),
        input: {
          lineId: String(formData.get('lineId') ?? ''),
          adjustment: Number(formData.get('adjustment')),
          reason: String(formData.get('reason') ?? ''),
        },
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
        reason: String(formData.get('reason') ?? ''),
      },
      services,
    })

    revalidateOrder(orderId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ------------------------------------------------- submit for approval -- */

/**
 * Raise the run for somebody else to send.
 *
 * Behind `laundry.order_create`, which the housekeeping supervisor holds. It
 * moves the order to `awaiting_approval` and does not talk to anybody outside
 * the organization — that is the next action, behind the other grant.
 */
export async function submitForApprovalAction(
  orderId: string,
  formData: FormData,
): Promise<ActionResult<{ id: string; status: LaundryStatus }>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(context.actor, 'laundry.order_create')

    const { operations, services } = await laundryOperations(
      context.workspace.name,
    )

    const outcome = await operations.advanceOrder.run({
      request: {
        resourceId: orderId,
        expectedVersion: Number(formData.get('version')),
        input: { status: 'awaiting_approval' },
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services,
    })

    revalidateOrder(orderId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* --------------------------------------------------------------- send -- */

export type SendOrderResult = { id: string; sentAt: string }

/**
 * The one act that leaves the building.
 *
 * Behind `laundry.order_send`, which a housekeeping supervisor does NOT hold.
 *
 * The body is rendered on the server immediately before the write rather than
 * taken from the form, and that is a security decision rather than a
 * convenience one: the form's textarea is attacker-controlled, and a body
 * accepted from it would let a crafted POST send arbitrary text to a supplier
 * in the organization's name — including the guest's name and telephone number
 * that the whole of `message.ts` exists to keep out of it. What the reviewer
 * saw on screen came from `previewOrderMessage`, and so does this.
 *
 * The cost is real: a person cannot hand-edit the message before it goes. That
 * is the correct trade for the one artefact in this product addressed to a
 * party with no relationship to the guest, and `providerNotes` is the field
 * for anything they need to add.
 */
export async function sendOrderAction(
  orderId: string,
  formData: FormData,
): Promise<ActionResult<SendOrderResult>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(context.actor, 'laundry.order_send')

    const { order } = await loadOrder(orderId)
    if (!order) {
      return {
        ok: false,
        error: toSafeResponse(
          new Error(`laundry order ${orderId} not found`),
          correlationId,
        ).error,
      }
    }

    const { operations, services } = await laundryOperations(
      context.workspace.name,
    )

    const channel =
      (formData.get('channel') as LaundryChannel | null) ?? order.channel

    // Rendered here, from the order. Never read from the form. See above.
    const body = await previewOrderMessage(
      order,
      laundryPorts(context.workspace.name),
      channel,
    )

    const outcome = await operations.sendOrder.run({
      request: {
        resourceId: orderId,
        expectedVersion: order.version,
        input: { channel, body },
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services,
    })

    revalidateOrder(orderId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
