'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. The stocktake write paths.
 *
 * ── Not one of these writes a row ─────────────────────────────────────────
 *
 * Each hands the request to an operation in `src/lib/inventory/counts.ts`,
 * which is the only path with authorization, validation, the business rule,
 * the transaction, the audit event and idempotency wired in that order. A
 * stocktake is exactly where that matters: "who wrote fifteen, and when" is
 * the question a disputed variance turns on, and an insert issued from here
 * would answer it with silence.
 *
 * ── `assertCan` is called here as well ────────────────────────────────────
 *
 * The policies the migration must carry already require the grant at the
 * database, and the operation checks it again. This is the third, independent
 * one: a Server Action is reachable by a crafted POST whatever the screen
 * rendered, and it must refuse on its own terms before it has read or written
 * anything.
 *
 * ── Nothing throws ────────────────────────────────────────────────────────
 *
 * A throw inside a Server Action reaches the browser as a digest and an empty
 * screen. Every failure becomes the `SafeErrorBody` `src/lib/errors` already
 * produces: a Hebrew sentence, whether the data was saved, whether retrying
 * is safe, and a correlation id matching the log.
 *
 * ── `recordCountAction` takes a number and nothing else ───────────────────
 *
 * No expected quantity, no variance, no "does this look right". A blind count
 * that echoed the ledger back through its own submit path would be blind in
 * the component and open everywhere that matters.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import { defineCountOperations } from '@/lib/inventory/counts'
import type { LossClass } from '@/lib/inventory/loss'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../../_lib/context'
import { auditActorFor, transactionRunner } from '../../../_lib/wiring'
import { SupabaseCountRepository } from './repository'
import { domainEventBus } from '../../../_lib/events'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

/**
 * The context, the operations and the services, or the refusal that replaces
 * them.
 *
 * One helper because seven actions need identically the same four objects,
 * and seven copies of the wiring is seven places for one of them to drift.
 */
async function ready() {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לבצע ספירת מלאי.'
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
  const repository = new SupabaseCountRepository(supabase)
  const { transactions } = transactionRunner(supabase)

  return {
    ok: true as const,
    context,
    operations: defineCountOperations(repository),
    services: {
      audit: new SupabaseAuditWriter(supabase),
      events: domainEventBus(supabase),
      idempotency: new SupabaseIdempotencyStore(supabase),
      transactions,
      onEventError(error: unknown) {
        // Never rethrown. A recorded count whose event failed to deliver is
        // still a recorded count. Logged so the loss is not silent.
        console.error('[inventory.counts] event delivery failed', error)
      },
    },
  }
}

function operationContext(
  gate: Extract<Awaited<ReturnType<typeof ready>>, { ok: true }>,
  correlationId: string,
  reason: string | null = null,
) {
  return {
    actor: gate.context.actor,
    auditActor: auditActorFor(gate.context.user),
    correlationId,
    reason,
  }
}

function refreshed(sessionId: string | null): void {
  revalidatePath('/inventory/counts')
  if (sessionId !== null) {
    revalidatePath(`/inventory/counts/${sessionId}`)
    revalidatePath(`/inventory/counts/${sessionId}/reconcile`)
  }
}

/* ---------------------------------------------------------- the session -- */

export async function openCountSessionAction(input: {
  propertyId: string
  label: string | null
  blind: boolean
  scheduledFor: string | null
  taskId: string | null
  note: string | null
  itemIds: readonly string[]
  idempotencyKey?: string
}): Promise<
  ActionResult<{ sessionId: string; lines: number; blind: boolean }>
> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.adjust', {
      organizationId: gate.context.actor.organizationId,
      propertyId: input.propertyId,
      family: 'operations',
    })

    const { idempotencyKey, ...draft } = input
    const outcome = await gate.operations.openSession.run({
      request: {
        input: { ...draft, itemIds: [...draft.itemIds] },
        idempotencyKey: idempotencyKey ?? null,
      },
      context: operationContext(gate, correlationId),
      services: gate.services,
    })

    refreshed(outcome.data.sessionId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function startCountingAction(input: {
  sessionId: string
}): Promise<ActionResult<{ itemsSnapshotted: number }>> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.adjust', {
      organizationId: gate.context.actor.organizationId,
      family: 'operations',
    })

    const outcome = await gate.operations.startCounting.run({
      request: { input, resourceId: input.sessionId },
      context: operationContext(gate, correlationId),
      services: gate.services,
    })

    refreshed(input.sessionId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ------------------------------------------------------------ the count -- */

/**
 * One number off one shelf.
 *
 * The signature is the promise: a session, an item, a quantity and an
 * optional note. There is nowhere in it to put the figure the counter was not
 * shown.
 */
export async function recordCountAction(input: {
  sessionId: string
  itemId: string
  countedQuantity: number
  note: string | null
  idempotencyKey?: string
}): Promise<ActionResult<{ saved: true }>> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.adjust', {
      organizationId: gate.context.actor.organizationId,
      family: 'operations',
    })

    const { idempotencyKey, ...count } = input
    const outcome = await gate.operations.recordCount.run({
      request: {
        input: count,
        resourceId: input.sessionId,
        idempotencyKey: idempotencyKey ?? null,
      },
      context: operationContext(gate, correlationId),
      services: gate.services,
    })

    refreshed(input.sessionId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* --------------------------------------------------------- the variance -- */

export async function reconcileCountAction(input: {
  sessionId: string
}): Promise<
  ActionResult<{
    variances: number
    matched: number
    uncounted: number
    unsnapshotted: number
  }>
> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.adjust', {
      organizationId: gate.context.actor.organizationId,
      family: 'operations',
    })

    const outcome = await gate.operations.reconcileSession.run({
      request: { input, resourceId: input.sessionId },
      context: operationContext(gate, correlationId),
      services: gate.services,
    })

    refreshed(input.sessionId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function classifyVarianceAction(input: {
  sessionId: string
  varianceId: string
  classification: LossClass
  note: string | null
}): Promise<ActionResult<{ movementId: string | null }>> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.adjust', {
      organizationId: gate.context.actor.organizationId,
      family: 'operations',
    })

    const outcome = await gate.operations.classifyVariance.run({
      request: {
        input: {
          varianceId: input.varianceId,
          classification: input.classification,
          note: input.note,
        },
        resourceId: input.varianceId,
      },
      context: operationContext(gate, correlationId),
      services: gate.services,
    })

    refreshed(input.sessionId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ----------------------------------------------------------- the ending -- */

/**
 * Close the count.
 *
 * `reason` is carried and is not always required: the operation demands one
 * only when differences remain unexplained, which is the moment a sentence is
 * actually worth something.
 */
export async function closeCountSessionAction(input: {
  sessionId: string
  reason: string | null
}): Promise<ActionResult<{ unexplained: number; itemsStamped: number }>> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.adjust', {
      organizationId: gate.context.actor.organizationId,
      family: 'operations',
    })

    const outcome = await gate.operations.closeSession.run({
      request: {
        input: { sessionId: input.sessionId },
        resourceId: input.sessionId,
      },
      context: operationContext(gate, correlationId, input.reason),
      services: gate.services,
    })

    refreshed(input.sessionId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function cancelCountSessionAction(input: {
  sessionId: string
  reason: string
}): Promise<ActionResult<null>> {
  const gate = await ready()
  if (!gate.ok) return gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, 'inventory.adjust', {
      organizationId: gate.context.actor.organizationId,
      family: 'operations',
    })

    const outcome = await gate.operations.cancelSession.run({
      request: {
        input: { sessionId: input.sessionId },
        resourceId: input.sessionId,
      },
      context: operationContext(gate, correlationId, input.reason),
      services: gate.services,
    })

    refreshed(input.sessionId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
