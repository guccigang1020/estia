'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Saving and removing a business's wording.
 *
 * `validateTemplate` runs in the editor too, so a person sees the problem
 * while they are still typing. **This path is the one that counts** — the
 * editor can be bypassed, and the database cannot enforce the placeholder rule
 * because that list is a property of `compose.ts` and a CHECK constraint
 * copying it would go stale. `template-operations.ts` runs it in `rule()`.
 */

import { revalidatePath } from 'next/cache'

import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import { defineMessageTemplateOperations } from '@/lib/messaging/template-operations'
import { MessageTemplateRepository } from '@/lib/messaging/template-repository'
import type { GuestChannel, GuestMessageKind } from '@/lib/messaging/types'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../../_lib/context'
import { domainEventBus } from '../../../_lib/events'
import { auditActorFor, transactionRunner } from '../../../_lib/wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

const SCREEN = '/settings/messages'

async function ready(correlationId: string) {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לערוך נוסחים.'
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
  const repository = new MessageTemplateRepository(db)

  return {
    operations: defineMessageTemplateOperations({
      db,
      loadTemplate: (organizationId, id) => repository.byId(organizationId, id),
    }),
    services: {
      audit: new SupabaseAuditWriter(db),
      events: domainEventBus(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
    },
  }
}

export async function saveTemplateAction(input: {
  kind: GuestMessageKind
  channel: GuestChannel | null
  subject: string | null
  body: string
  isActive: boolean
  idempotencyKey: string
}): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.save.run({
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

/** Removing one restores the built-in Hebrew. That is why delete is offered. */
export async function removeTemplateAction(input: {
  templateId: string
  idempotencyKey: string
}): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.remove.run({
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
