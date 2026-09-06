'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. The four writes the screen can make.
 *
 * ══ THE SECRET IS RETURNED HERE AND NOWHERE ELSE ════════════════════════════
 *
 * `registerEndpointAction` and `rotateSecretAction` return a signing secret in
 * their result. That is the only path in the product by which one reaches a
 * browser, it happens once, and it happens because the person on the other
 * side just asked for it and has to put it in their own server.
 *
 * `_lib/queries.ts` cannot fetch one — no method exists and `authenticated`
 * holds no privilege on the table — so a page refresh cannot show it again.
 * The screen must therefore say so at the moment it displays it, and the
 * component does.
 *
 * Every other action returns ids and states. None of them returns a secret,
 * and none should be made to.
 */

import { revalidatePath } from 'next/cache'

import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'
import { WebhookRepository } from '@/lib/webhooks/repository'
import { defineWebhookOperations } from '@/lib/webhooks/operations'
import type { DomainEventName } from '@/lib/contracts/events'

import { shellContext } from '../../../_lib/context'
import { auditActorFor, transactionRunner } from '../../../_lib/wiring'
import { domainEventBus } from '../../../_lib/events'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

const SCREEN = '/settings/webhooks'

async function ready(correlationId: string) {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לנהל יעדי webhook.'
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
  const repository = new WebhookRepository(db)

  return {
    db,
    operations: defineWebhookOperations({
      db,
      loadEndpoint: (organizationId, id) =>
        repository.endpoint(organizationId, id),
    }),
    services: {
      audit: new SupabaseAuditWriter(db),
      // The bus is wired here like everywhere else, even though nothing in
      // this module emits a domain event yet. Leaving it out would make this
      // the one services object in the app that is shaped differently, which
      // is how the next person concludes it was deliberate.
      events: domainEventBus(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
    },
  }
}

export async function registerEndpointAction(input: {
  url: string
  description: string | null
  events: readonly DomainEventName[]
  idempotencyKey: string
}): Promise<ActionResult<{ id: string; url: string; signingSecret: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.register.run({
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

export async function setSubscriptionAction(input: {
  endpointId: string
  events: readonly DomainEventName[]
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

    const outcome = await wired.operations.setSubscription.run({
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

/** Pause an active endpoint, or bring back a paused or disabled one. */
export async function togglePausedAction(input: {
  endpointId: string
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

    const outcome = await wired.operations.setPaused.run({
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

export async function rotateSecretAction(input: {
  endpointId: string
  expectedVersion: number
  idempotencyKey: string
}): Promise<ActionResult<{ id: string; signingSecret: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, expectedVersion, ...draft } = input

    const outcome = await wired.operations.rotateSecret.run({
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
