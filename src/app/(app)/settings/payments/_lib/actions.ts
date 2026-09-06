'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Saving the collection policy.
 *
 * Both actions go through `definePaymentPolicyOperations`, which is the only
 * path to these tables that carries authorization, validation, the domain
 * rule, the transaction, the audit event and idempotency in that order.
 *
 * `assertCan` is called here as well, and it is not the enforcement — the
 * operation asserts it, and `payment_collection_settings_update` demands the
 * same grant at the database. It is the independent one: a Server Action is a
 * public endpoint reachable by a crafted POST whatever the screen chose to
 * render, and it must refuse on its own terms before reading or writing
 * anything.
 *
 * Nothing throws. A throw inside a Server Action reaches the browser as a
 * digest and a blank screen, so every failure becomes the `SafeErrorBody`
 * `src/lib/errors` already produces.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import type {
  ConfirmationRequirement,
  PaymentCollectionPolicy,
} from '@/lib/contracts/states'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  SupabasePaymentPolicyRepository,
  definePaymentPolicyOperations,
  type ManualPaymentChannel,
} from '@/lib/payments'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../../_lib/context'
import { auditActorFor, transactionRunner } from '../../../_lib/wiring'
import { domainEventBus } from '../../../_lib/events'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

export type CollectionPolicyInput = {
  policy: PaymentCollectionPolicy
  requirements: readonly ConfirmationRequirement[]
  depositPercentBps: number | null
  depositFixedAgorot: number | null
  balanceDueDaysBefore: number | null
  livePaymentsEnabled: boolean
  liveProvider: string | null
  guestInstructions: string | null
  idempotencyKey: string
}

export type ManualChannelInput = {
  channel: ManualPaymentChannel
  enabled: boolean
  displayName: string | null
  instructions: string | null
  sortOrder: number
  idempotencyKey: string
}

/**
 * The context, or a refusal a person can read.
 *
 * Written once because both actions need it and because a screen that refuses
 * two different ways for the same reason is a screen nobody trusts.
 */
async function ready(correlationId: string) {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לשנות את מדיניות הגבייה.'
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

async function operationsFor() {
  const db = await createClient()
  const { transactions } = transactionRunner(db)
  const repository = new SupabasePaymentPolicyRepository(db)

  const operations = definePaymentPolicyOperations({
    repository,
    /**
     * Which property a booking belongs to, read rather than trusted.
     *
     * The override action is not on this screen — it lives beside a booking —
     * but the operations are defined together, and a lookup that returned a
     * caller-supplied property would let somebody scope an override to a
     * property they can reach and attach it to a booking they cannot.
     */
    async bookingProperty(organizationId, bookingId) {
      const { data, error } = await db
        .from('bookings')
        .select('property_id')
        .eq('organization_id', organizationId)
        .eq('id', bookingId)
        .maybeSingle()

      if (error || !data) return null
      return { propertyId: data.property_id as string }
    },
  })

  return {
    db,
    operations,
    services: {
      audit: new SupabaseAuditWriter(db),
      events: domainEventBus(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
      onEventError(error: unknown) {
        // The policy is saved whether or not the alert was delivered. Logged
        // so a `security.payment_config_changed` nobody received is not
        // silently lost.
        console.error('[payments] domain event delivery failed', error)
      },
    },
  }
}

export async function saveCollectionPolicyAction(
  input: CollectionPolicyInput,
): Promise<ActionResult<{ policy: PaymentCollectionPolicy }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate

  const { context } = gate

  try {
    assertCan(context.actor, 'payment.policy_manage', {
      organizationId: context.actor.organizationId,
      family: 'finance',
    })

    const { operations, services } = await operationsFor()

    const outcome = await operations.setCollectionPolicy.run({
      request: {
        input: {
          policy: input.policy,
          requirements: input.requirements,
          depositPercentBps: input.depositPercentBps,
          depositFixedAgorot: input.depositFixedAgorot,
          balanceDueDaysBefore: input.balanceDueDaysBefore,
          livePaymentsEnabled: input.livePaymentsEnabled,
          liveProvider: input.liveProvider,
          guestInstructions: input.guestInstructions,
        },
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services,
    })

    revalidatePath('/settings/payments')

    return { ok: true, data: { policy: outcome.data.policy } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function saveManualChannelAction(
  input: ManualChannelInput,
): Promise<ActionResult<{ channel: ManualPaymentChannel; enabled: boolean }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate

  const { context } = gate

  try {
    assertCan(context.actor, 'payment.policy_manage', {
      organizationId: context.actor.organizationId,
      family: 'finance',
    })

    const { operations, services } = await operationsFor()

    const outcome = await operations.setManualChannel.run({
      request: {
        input: {
          channel: input.channel,
          enabled: input.enabled,
          displayName: input.displayName,
          instructions: input.instructions,
          sortOrder: input.sortOrder,
        },
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services,
    })

    revalidatePath('/settings/payments')

    return {
      ok: true,
      data: { channel: outcome.data.channel, enabled: outcome.data.enabled },
    }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
