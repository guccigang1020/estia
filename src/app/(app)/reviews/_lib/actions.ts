'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. What the reviews screen can write.
 *
 * ══ THERE IS NO EDIT ACTION AND THERE IS NO DELETE ACTION ═══════════════════
 *
 * Three actions: record one that arrived elsewhere, reply to one, hide one
 * with a reason. That is the entire surface, and the database agrees — 0066
 * refuses `delete` and `truncate` to every role, and a trigger rejects any
 * UPDATE touching the guest's words or scores. An action added here to do
 * either would fail at the database, which is exactly why the rule lives
 * there and not only in this file.
 *
 * `listing-quality` reads these rows and tells a business its listing is good.
 * A rating that can be quietly curated is marketing wearing the clothes of
 * data, and it would be worse than the `not_assessed` it replaced.
 */

import { revalidatePath } from 'next/cache'

import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { defineReviewOperations } from '@/lib/reviews/operations'
import { ReviewRepository } from '@/lib/reviews/repository'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { domainEventBus } from '../../_lib/events'
import { auditActorFor, transactionRunner } from '../../_lib/wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

const SCREEN = '/reviews'

async function ready(correlationId: string) {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לנהל ביקורות.'
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
  const repository = new ReviewRepository(db)

  return {
    operations: defineReviewOperations({
      db,
      loadReview: (organizationId, id) => repository.review(organizationId, id),
      loadBookingScope: (organizationId, bookingId) =>
        repository.bookingScope(organizationId, bookingId),
    }),
    services: {
      audit: new SupabaseAuditWriter(db),
      events: domainEventBus(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
    },
  }
}

/**
 * Write down a review that arrived by WhatsApp, by telephone, or on paper.
 *
 * `entered_by_host` is stamped on it by the operation, so nothing downstream
 * can mistake a typed-in review for one a guest submitted themselves.
 */
export async function recordReviewAction(input: {
  bookingId: string
  overall: number
  comment?: string
  cleanliness?: number
  accuracy?: number
  communication?: number
  location?: number
  valueForMoney?: number
  idempotencyKey: string
}): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.record.run({
      request: { input: draft, idempotencyKey },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    // The listing report reads these rows for `property.guest_rating`, so it
    // is stale the moment one lands.
    revalidatePath('/listings')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function replyToReviewAction(input: {
  reviewId: string
  reply: string
  idempotencyKey: string
}): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.reply.run({
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

/**
 * Stop displaying a review. The reason is required and it is stored twice —
 * on the row, where anybody with this screen can read it, and in the audit
 * event, which cannot be changed afterwards.
 */
export async function hideReviewAction(input: {
  reviewId: string
  reason: string
  idempotencyKey: string
}): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.hide.run({
      request: { input: draft, idempotencyKey },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    revalidatePath('/listings')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
