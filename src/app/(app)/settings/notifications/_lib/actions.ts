'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Saving what a business and a person
 * chose to be told.
 *
 * Three actions, and they are gated differently on purpose.
 *
 *   · `saveNotificationSettingsAction` changes the whole organization —
 *     which channels exist, when it is quiet — and goes through
 *     `defineNotificationOperations`, which carries authorization,
 *     validation, the domain rule, the transaction, the audit event and
 *     idempotency in that order. `assertCan` is called here as well and is not
 *     the enforcement: a Server Action is a public endpoint reachable by a
 *     crafted POST whatever the screen chose to render, and it must refuse on
 *     its own terms before reading or writing anything. 0043 demands the same
 *     grant at the database.
 *
 *   · `savePreferenceAction` and `markNotificationAction` are a person acting
 *     on their own rows. There is no grant in the catalogue that every member
 *     holds — a cleaner's whole preset is four — and the argument for not
 *     inventing one here is written out in `src/lib/notifications/
 *     operations.ts`. The floor that enforces these is 0043, where both
 *     tables are reachable only where `user_id = (select auth.uid())`.
 *
 * Nothing throws. A throw inside a Server Action reaches the browser as a
 * digest and a blank screen, so every failure becomes the `SafeErrorBody`
 * `src/lib/errors` already produces.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  SupabaseNotificationRepository,
  defineNotificationOperations,
  markNotificationState,
  setPreference,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationSeverity,
} from '@/lib/notifications'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../../_lib/context'
import { auditActorFor, transactionRunner } from '../../../_lib/wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

export type SettingsInput = {
  enabledChannels: readonly NotificationChannel[]
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
  timezone: string
  urgentOverridesQuietHours: boolean
  defaultEscalationMinutes: number
  retainReadDays: number
  idempotencyKey: string
}

export type PreferenceInput = {
  category: NotificationCategory
  channel: NotificationChannel
  enabled: boolean
  minSeverity: NotificationSeverity
}

export type MarkInput = {
  notificationId: string
  state: 'read' | 'dismissed' | 'acted'
}

const SCREEN = '/settings/notifications'

/**
 * The context, or a refusal a person can read.
 *
 * Written once because all three actions need it, and because a screen that
 * refuses three different ways for the same reason is a screen nobody trusts.
 */
async function ready(correlationId: string) {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לשנות את הגדרות ההתראות.'
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

export async function saveNotificationSettingsAction(
  input: SettingsInput,
): Promise<ActionResult<{ saved: true }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate

  const { context } = gate

  try {
    assertCan(context.actor, 'organization.settings.edit', {
      organizationId: context.actor.organizationId,
      family: 'settings',
    })

    const db = await createClient()
    const { transactions } = transactionRunner(db)
    const operations = defineNotificationOperations({
      repository: new SupabaseNotificationRepository(db),
    })

    await operations.setNotificationSettings.run({
      request: {
        input: {
          enabledChannels: input.enabledChannels,
          quietHoursEnabled: input.quietHoursEnabled,
          quietHoursStart: input.quietHoursStart,
          quietHoursEnd: input.quietHoursEnd,
          timezone: input.timezone,
          urgentOverridesQuietHours: input.urgentOverridesQuietHours,
          defaultEscalationMinutes: input.defaultEscalationMinutes,
          retainReadDays: input.retainReadDays,
        },
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: {
        audit: new SupabaseAuditWriter(db),
        idempotency: new SupabaseIdempotencyStore(db),
        transactions,
      },
    })

    revalidatePath(SCREEN)
    return { ok: true, data: { saved: true } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function savePreferenceAction(
  input: PreferenceInput,
): Promise<ActionResult<{ saved: true }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate

  const { context } = gate

  try {
    const db = await createClient()

    await setPreference(
      new SupabaseNotificationRepository(db),
      {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
        audit: new SupabaseAuditWriter(db),
      },
      {
        category: input.category,
        channel: input.channel,
        enabled: input.enabled,
        minSeverity: input.minSeverity,
      },
    )

    revalidatePath(SCREEN)
    return { ok: true, data: { saved: true } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function markNotificationAction(
  input: MarkInput,
): Promise<ActionResult<{ saved: true }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate

  const { context } = gate

  try {
    const db = await createClient()

    await markNotificationState(
      new SupabaseNotificationRepository(db),
      { actor: context.actor },
      input.notificationId,
      input.state,
    )

    revalidatePath(SCREEN)
    return { ok: true, data: { saved: true } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
