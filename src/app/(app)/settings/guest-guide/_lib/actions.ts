'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Every write the guide screen makes.
 *
 * Four actions, each one line of work around a `defineOperation` — so each
 * carries authorization, validation, the domain rule, the transaction, the
 * audit event and idempotency in that order, and none of them can be reordered
 * or skipped by a caller. There is no direct table write anywhere in this
 * file, and adding one would skip all six.
 *
 * `assertCan` is called here as well and is NOT the enforcement. A Server
 * Action is a public endpoint reachable by a crafted POST whatever the screen
 * chose to render, so it refuses on its own terms before reading or writing
 * anything; the operation refuses again; row level security refuses a third
 * time.
 *
 * ══ THE SECRET HAS ITS OWN ACTION, AND THAT IS THE POINT ═══════════════════
 *
 * `setGuideSecretAction` is separate from `saveGuideEntryAction` rather than a
 * field on it. If a door code were one input on the entry form, every ordinary
 * edit to the pool hours would carry the code through the request body,
 * through validation, into the audit diff and into whatever logs the request.
 * It is a different form, a different action and a different audit line — and
 * the audit line records that a code changed, never what it changed to.
 *
 * There is deliberately no `readGuideSecretAction`. Nothing in the product
 * reads a stored code back to a person: the schema proposal grants
 * `select (entry_id)` on `guide_entry_secrets` and nothing more, so an
 * operator rotating a code types the new one. That is how door codes work
 * anyway, and it means a compromised session cannot exfiltrate the codes of
 * every property it can see.
 *
 * Nothing throws. A throw inside a Server Action reaches the browser as a
 * digest and a blank screen, so every failure becomes the `SafeErrorBody`
 * `src/lib/errors` already produces.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  GUIDE_GRANTS,
  defineGuestGuideOperations,
  type EntryDraft,
  type PublishInput,
  type RecommendationInput,
  type SecretDraft,
} from '@/lib/guest-guide/operations'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../../_lib/context'
import { auditActorFor, transactionRunner } from '../../../_lib/wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

const SCREEN = '/settings/guest-guide'

/**
 * The context, or a refusal a person can read.
 *
 * Written once because all four actions need it: a screen that refuses four
 * different ways for the same reason is a screen nobody trusts.
 */
async function ready(correlationId: string) {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לערוך את מדריך הנכס.'
          : 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
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

/** Everything an operation needs, assembled once. */
async function services() {
  const db = await createClient()
  const { transactions } = transactionRunner(db)

  return {
    db,
    operations: defineGuestGuideOperations({ db }),
    services: {
      audit: new SupabaseAuditWriter(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
    },
  }
}

export async function saveGuideEntryAction(
  input: EntryDraft & { idempotencyKey: string },
): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    assertCan(context.actor, GUIDE_GRANTS.edit, {
      organizationId: context.actor.organizationId,
      propertyId: input.propertyId,
      family: 'inventory',
    })

    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.saveEntry.run({
      request: { input: draft, idempotencyKey },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    return { ok: true, data: { id: outcome.data.id } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/**
 * Set or clear the code behind an entry.
 *
 * `value: null` clears it. There is no "leave unchanged" branch, because
 * leaving a code unchanged is not an edit and does not need an action — and a
 * form that could submit "unchanged" would have to have received the current
 * value to display, which is exactly what this module refuses to do.
 */
export async function setGuideSecretAction(
  input: SecretDraft & { idempotencyKey: string },
): Promise<ActionResult<{ set: boolean }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    assertCan(context.actor, GUIDE_GRANTS.reveal, {
      organizationId: context.actor.organizationId,
      propertyId: input.propertyId,
      family: 'inventory',
    })

    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.setEntrySecret.run({
      request: { input: draft, idempotencyKey },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    return { ok: true, data: { set: outcome.data.set } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/**
 * Add a local recommendation.
 *
 * The source is part of the input and the operation refuses without one —
 * §44's rule, enforced in `recommendations.ts` and again by the CHECK the
 * schema proposal asks for. A `business` source is stamped with this actor's
 * own user id inside the operation; the client cannot claim somebody else
 * vouched for it.
 */
export async function addGuideRecommendationAction(
  input: RecommendationInput & { idempotencyKey: string },
): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    assertCan(context.actor, GUIDE_GRANTS.edit, {
      organizationId: context.actor.organizationId,
      propertyId: input.propertyId,
      family: 'inventory',
    })

    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.addRecommendation.run({
      request: { input: draft, idempotencyKey },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    return { ok: true, data: { id: outcome.data.id } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/**
 * Publish the draft.
 *
 * `expectedVersion` is required by the operation, so two people publishing the
 * same guide from two tabs is a conflict a person is told about rather than a
 * silent last-write-wins over somebody else's afternoon.
 */
export async function publishGuideAction(
  input: PublishInput & { expectedVersion: number; idempotencyKey: string },
): Promise<ActionResult<{ versionNumber: number; entryCount: number }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    assertCan(context.actor, GUIDE_GRANTS.publish, {
      organizationId: context.actor.organizationId,
      propertyId: input.propertyId,
      family: 'inventory',
    })

    const wired = await services()
    const { idempotencyKey, expectedVersion, ...draft } = input

    const outcome = await wired.operations.publishGuide.run({
      request: { input: draft, expectedVersion, idempotencyKey },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    return {
      ok: true,
      data: {
        versionNumber: outcome.data.versionNumber,
        entryCount: outcome.data.entryCount,
      },
    }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
