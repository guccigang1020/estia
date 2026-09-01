'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. The stock write paths.
 *
 * ── Not one of these writes a row ─────────────────────────────────────────
 *
 * Each hands the request to an operation in `src/lib/inventory/operations.ts`,
 * which is the only path with authorization, validation, the business rule,
 * the transaction, the audit event and idempotency wired in that order. Stock
 * is exactly where that matters: "who changed the count from forty to
 * thirty-two, and why" is the question a stocktake dispute turns on, and an
 * insert issued from here would answer it with silence.
 *
 * ── `assertCan` is called here as well ────────────────────────────────────
 *
 * The policies in 0030 already require the grant at the database, and the
 * operation checks it again. This is the third, independent one: a Server
 * Action is reachable by a crafted POST whatever the screen rendered, and it
 * must refuse on its own terms before it has read or written anything.
 *
 * ── Nothing throws ────────────────────────────────────────────────────────
 *
 * A throw inside a Server Action reaches the browser as a digest and an empty
 * screen. Every failure becomes the `SafeErrorBody` `src/lib/errors` already
 * produces: a Hebrew sentence, whether the data was saved, whether retrying is
 * safe, and a correlation id matching the log.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  defineInventoryOperations,
  type InventoryPorts,
  type MovementDraft,
  type NewItem,
} from '@/lib/inventory/operations'
import type { ImportRow, InventorySettings } from '@/lib/inventory'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { SupabaseInventoryRepository } from '@/lib/persistence/inventory'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { auditActorFor, transactionRunner } from '../../_lib/wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

/**
 * The context, the operations and the services, or the refusal that replaces
 * them.
 *
 * One helper because five actions need identically the same four objects, and
 * five copies of the wiring is five places for one of them to drift.
 */
async function ready() {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לשנות מלאי.'
          : 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
        retryMessage: 'ניסיון חוזר לא יעזור עד שהמצב הזה ישתנה.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId: crypto.randomUUID(),
      },
    }
  }

  const supabase = await createClient()
  const repository = new SupabaseInventoryRepository(supabase)
  const { transactions } = transactionRunner(supabase)

  return {
    ok: true as const,
    context,
    operations: defineInventoryOperations(
      repository as unknown as InventoryPorts,
    ),
    services: {
      audit: new SupabaseAuditWriter(supabase),
      idempotency: new SupabaseIdempotencyStore(supabase),
      transactions,
      onEventError(error: unknown) {
        // Never rethrown. A recorded movement whose event failed to deliver is
        // still a recorded movement. Logged so the loss is not silent.
        console.error('[inventory] domain event delivery failed', error)
      },
    },
  }
}

function operationContext(
  gate: Extract<Awaited<ReturnType<typeof ready>>, { ok: true }>,
  correlationId: string,
) {
  return {
    actor: gate.context.actor,
    auditActor: auditActorFor(gate.context.user),
    correlationId,
  }
}

/* -------------------------------------------------------------- settings -- */

export async function saveInventorySettingsAction(
  settings: InventorySettings,
): Promise<ActionResult<InventorySettings>> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.edit', {
      organizationId: gate.context.actor.organizationId,
      family: 'operations',
    })

    const outcome = await gate.operations.configure.run({
      request: {
        // The organization is taken from the actor and never from the form: a
        // tenant id a browser can set is a tenant selector.
        input: {
          ...settings,
          organizationId: gate.context.actor.organizationId,
        },
      },
      context: operationContext(gate, correlationId),
      services: gate.services,
    })

    revalidatePath('/inventory')
    revalidatePath('/inventory/settings')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ------------------------------------------------------------------ item -- */

export async function addInventoryItemAction(
  input: NewItem & { idempotencyKey?: string },
): Promise<ActionResult<{ id: string }>> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.edit', {
      organizationId: gate.context.actor.organizationId,
      propertyId: input.propertyId,
      family: 'operations',
    })

    const { idempotencyKey, ...item } = input
    const outcome = await gate.operations.addItem.run({
      request: { input: item, idempotencyKey: idempotencyKey ?? null },
      context: operationContext(gate, correlationId),
      services: gate.services,
    })

    revalidatePath('/inventory')
    revalidatePath('/inventory/items')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ---------------------------------------------------------------- import -- */

/**
 * Apply the rows a person has already seen classified.
 *
 * The plan — what will be created, what changed, what is identical, and every
 * refusal with its line number — was computed and rendered before this ran.
 * This receives the rows they agreed to, which is why there is no second
 * chance to be surprised by row nineteen.
 */
export async function applyInventoryImportAction(input: {
  propertyId: string
  rows: readonly ImportRow[]
  idempotencyKey?: string
}): Promise<ActionResult<{ created: number; updated: number }>> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.import', {
      organizationId: gate.context.actor.organizationId,
      propertyId: input.propertyId,
      family: 'operations',
    })

    const outcome = await gate.operations.applyImport.run({
      request: {
        input: { propertyId: input.propertyId, rows: input.rows },
        idempotencyKey: input.idempotencyKey ?? null,
      },
      context: operationContext(gate, correlationId),
      services: gate.services,
    })

    revalidatePath('/inventory')
    revalidatePath('/inventory/items')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ------------------------------------------------------------- adjustment -- */

export async function recordAdjustmentAction(
  input: MovementDraft & { idempotencyKey?: string },
): Promise<ActionResult<{ id: string }>> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.adjust', {
      organizationId: gate.context.actor.organizationId,
      propertyId: input.propertyId,
      family: 'operations',
    })

    const { idempotencyKey, ...movement } = input
    const outcome = await gate.operations.adjust.run({
      request: { input: movement, idempotencyKey: idempotencyKey ?? null },
      context: operationContext(gate, correlationId),
      services: gate.services,
    })

    revalidatePath('/inventory')
    revalidatePath('/inventory/adjustments')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ------------------------------------------------------------ reservation -- */

export async function reserveInventoryAction(input: {
  itemId: string
  propertyId: string
  quantity: number
  neededFrom: string
  neededTo: string
  bookingId: string | null
  note: string | null
  idempotencyKey?: string
}): Promise<ActionResult<{ reservationId: string; freeAfter: number }>> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.adjust', {
      organizationId: gate.context.actor.organizationId,
      propertyId: input.propertyId,
      family: 'operations',
    })

    const outcome = await gate.operations.reserve.run({
      request: {
        input: {
          itemId: input.itemId,
          quantity: input.quantity,
          neededFrom: input.neededFrom,
          neededTo: input.neededTo,
          bookingId: input.bookingId,
          note: input.note,
        },
        idempotencyKey: input.idempotencyKey ?? null,
      },
      context: operationContext(gate, correlationId),
      services: gate.services,
    })

    revalidatePath('/inventory')
    revalidatePath('/inventory/forecast')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* --------------------------------------------------------------- transfer -- */

export async function requestTransferAction(input: {
  itemId: string
  fromPropertyId: string
  toPropertyId: string
  quantity: number
  neededBy: string | null
  reason: string
}): Promise<ActionResult<{ id: string }>> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.transfer', {
      organizationId: gate.context.actor.organizationId,
      propertyId: input.fromPropertyId,
      family: 'operations',
    })

    const outcome = await gate.operations.proposeTransfer.run({
      request: { input },
      context: operationContext(gate, correlationId),
      services: gate.services,
    })

    revalidatePath('/inventory/shortages')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
