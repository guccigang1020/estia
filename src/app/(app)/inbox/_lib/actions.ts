'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. What the inbox screen can write.
 *
 * ══ THERE IS NO `reply` ACTION ══════════════════════════════════════════════
 *
 * An outbound message must reference a `guest_messages` row, and that row is
 * written by `src/lib/messaging`, whose send takes `{ bookingId, kind,
 * channel }` for one of three templated kinds. There is no free-text kind, so
 * a person typing a sentence here has nothing to send it as.
 *
 * The two things needed to close that are named in `inbox/operations.ts` and
 * neither is this module's to invent: a `GuestMessageKind` for free
 * correspondence, and a domain event for it. Offering a reply box that failed
 * would be worse than not offering one, so the screen says so instead.
 */

import { revalidatePath } from 'next/cache'

import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import { InboxRepository } from '@/lib/inbox/repository'
import { defineInboxOperations } from '@/lib/inbox/operations'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { auditActorFor, transactionRunner } from '../../_lib/wiring'
import { domainEventBus } from '../../_lib/events'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

const SCREEN = '/inbox'

async function ready(correlationId: string) {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לנהל שיחות.'
          : 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'שום דבר לא נשמר.',
        retryMessage: context
          ? 'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.'
          : 'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId,
      },
    }
  }

  return { ok: true as const, context }
}

async function services() {
  const db = await createClient()
  const { transactions } = transactionRunner(db)
  const repository = new InboxRepository(db)

  return {
    operations: defineInboxOperations({
      db,
      loadConversation: (organizationId, id) =>
        repository.conversation(organizationId, id),
    }),
    services: {
      audit: new SupabaseAuditWriter(db),
      events: domainEventBus(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
    },
  }
}

/** Turn a website enquiry into a thread. Idempotent by intent: adopting twice
 *  would split one enquiry across two threads. */
export async function adoptSiteRequestAction(input: {
  siteRequestId: string
  idempotencyKey: string
}): Promise<ActionResult<{ id: string; alreadyOpen: boolean }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.openFromSiteRequest.run({
      request: { input: draft, idempotencyKey },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function adoptGuestRequestAction(input: {
  guestRequestId: string
  idempotencyKey: string
}): Promise<ActionResult<{ id: string; alreadyOpen: boolean }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.openFromGuestRequest.run({
      request: { input: draft, idempotencyKey },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/** `null` hands it back to the shared queue, which must stay expressible. */
export async function assignConversationAction(input: {
  conversationId: string
  assignToUserId: string | null
  expectedVersion: number
  idempotencyKey: string
}): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, expectedVersion, ...draft } = input

    const outcome = await wired.operations.assign.run({
      request: { input: draft, idempotencyKey, expectedVersion },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function closeConversationAction(input: {
  conversationId: string
  expectedVersion: number
  idempotencyKey: string
}): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, expectedVersion, ...draft } = input

    const outcome = await wired.operations.close.run({
      request: { input: draft, idempotencyKey, expectedVersion },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/**
 * Mark it read for THIS person.
 *
 * No `expectedVersion`: reading is not an edit of the conversation and must
 * not conflict with somebody replying at the same moment. And no `userId` —
 * the operation takes it from the actor, and the row's policy pins it to
 * `auth.uid()`, so there is no shape of this call that marks a thread read
 * for a colleague.
 */
export async function markConversationReadAction(input: {
  conversationId: string
  idempotencyKey: string
}): Promise<ActionResult<{ at: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.markRead.run({
      request: { input: draft, idempotencyKey },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
