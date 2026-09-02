'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Saving the guest journey's configuration.
 *
 * Both writes go through `defineJourneySettingsOperations` in
 * `src/lib/guest-journey/settings.ts`, which is the only path to
 * `guest_journey_settings` that carries authorization, validation, the domain
 * rule, the transaction, the audit event and idempotency in that order.
 * Nothing in this directory writes a row itself, and there is no second
 * repository here — an earlier draft of this screen had one, and a second
 * write path into a table whose `arrival_release` column decides when a door
 * code becomes visible is exactly the thing the operation pipeline exists to
 * prevent.
 *
 * `assertCan` is called here as well, and it is not the enforcement — the
 * operation asserts the same grant twice (once before any read, once against
 * the loaded scope) and `guest_journey_settings_write` demands it at the
 * database. It is the independent one: a Server Action is a public endpoint
 * reachable by a crafted POST whatever the screen chose to render, and it must
 * refuse on its own terms before reading or writing anything.
 *
 * Nothing throws. A throw inside a Server Action reaches the browser as a
 * digest and a blank screen, so every failure becomes the `SafeErrorBody`
 * `src/lib/errors` already produces: a Hebrew sentence, whether the data was
 * saved, whether retrying is safe, and a correlation id matching the log.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import type { JourneyPresetId } from '@/lib/guest-journey/presets'
import {
  SupabaseJourneySettingsRepository,
  defineJourneySettingsOperations,
} from '@/lib/guest-journey/settings'
import type { GuestJourneySettings } from '@/lib/guest-journey/types'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../../_lib/context'
import { auditActorFor, transactionRunner } from '../../../_lib/wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

export type SaveJourneySettingsInput = GuestJourneySettings & {
  /**
   * The version the browser believes it is editing, or `null` when this
   * organization has no row and the save will create one.
   *
   * Sent so two people on this screen at once cannot silently overwrite each
   * other's answer to "when is the door code released". The pipeline turns a
   * mismatch into a `ConflictError` naming both versions.
   */
  expectedVersion: number | null
  idempotencyKey: string
}

export type ApplyPresetActionInput = {
  presetId: JourneyPresetId
  expectedVersion: number | null
  idempotencyKey: string
}

/**
 * The context, or a refusal a person can read.
 *
 * Written once because both actions need it, and because a screen that refuses
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
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לשנות את הגדרות מסע האורח.'
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

async function wiring() {
  const db = await createClient()
  const { transactions } = transactionRunner(db)

  return {
    operations: defineJourneySettingsOperations({
      repository: new SupabaseJourneySettingsRepository(db),
    }),
    services: {
      audit: new SupabaseAuditWriter(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
      onEventError(error: unknown) {
        // The settings are saved whether or not a subscriber heard about it.
        // Logged so the loss is not silent.
        console.error('[guest-journey] domain event delivery failed', error)
      },
    },
  }
}

export async function saveJourneySettingsAction(
  input: SaveJourneySettingsInput,
): Promise<ActionResult<{ version: number }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate

  const { context } = gate

  try {
    assertCan(context.actor, 'organization.settings.edit', {
      organizationId: context.actor.organizationId,
      family: 'settings',
    })

    const { operations, services } = await wiring()

    const outcome = await operations.saveSettings.run({
      request: {
        input: {
          // Null is the organization-wide row, not a missing value. This screen
          // edits that row and only that row — see the header of `queries.ts`.
          propertyId: null,
          contractMode: input.contractMode,
          requireGuestConfirmation: input.requireGuestConfirmation,
          requiredDetailFields: input.requiredDetailFields,
          optionalDetailFields: input.optionalDetailFields,
          arrivalRelease: input.arrivalRelease,
          arrivalReleaseHours: input.arrivalReleaseHours,
          duringStayTopics: input.duringStayTopics,
          requestsEnabled: input.requestsEnabled,
          requestCategories: input.requestCategories,
          checkoutDeclarationEnabled: input.checkoutDeclarationEnabled,
          reviewEnabled: input.reviewEnabled,
          reviewUrl: input.reviewUrl,
          rebookEnabled: input.rebookEnabled,
          reconfirmationTriggers: input.reconfirmationTriggers,
        },
        // `undefined`, never `null`: the pipeline skips the check when the key
        // is absent, and an organization saving for the first time has no
        // version to state.
        expectedVersion: input.expectedVersion ?? undefined,
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services,
    })

    revalidatePath('/settings/guest-journey')

    return { ok: true, data: { version: outcome.data.version } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/**
 * Apply a named starting point.
 *
 * The screen has already shown, from `resolvePreset`, exactly which fields
 * would move and where the preset could not have its way. This writes the same
 * resolution — the operation calls `resolvePreset` itself against the row it
 * loads, so the button cannot save something other than what was displayed —
 * and records one audit event naming the preset, which is better provenance
 * than fourteen field changes with no reason attached.
 *
 * Nothing is locked afterwards. Every field the preset set is editable in the
 * form on the same screen, and the row it wrote is indistinguishable from one
 * somebody assembled switch by switch.
 */
export async function applyJourneyPresetAction(
  input: ApplyPresetActionInput,
): Promise<ActionResult<{ changed: number; notes: readonly string[] }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate

  const { context } = gate

  try {
    assertCan(context.actor, 'organization.settings.edit', {
      organizationId: context.actor.organizationId,
      family: 'settings',
    })

    const { operations, services } = await wiring()

    const outcome = await operations.applyPreset.run({
      request: {
        input: { propertyId: null, presetId: input.presetId },
        expectedVersion: input.expectedVersion ?? undefined,
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services,
    })

    revalidatePath('/settings/guest-journey')

    return {
      ok: true,
      data: {
        changed: outcome.data.changes.length,
        notes: outcome.data.notes,
      },
    }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
