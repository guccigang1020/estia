'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Composing a role.
 *
 * ── What this closes ──────────────────────────────────────────────────────
 *
 * `custom_roles` is sold in the Management plan and `roles_insert` has always
 * admitted a customer's own role. Nothing in the product ever wrote one, so a
 * paid feature had no code behind it and this screen said, correctly, that
 * nothing on it was editable.
 *
 * ══ THE RULE THIS FILE EXISTS TO NOT BREAK ═════════════════════════════════
 *
 * A custom role may never carry a grant its author does not hold. It is
 * enforced three times and not once:
 *
 *   · `assertGrantable` inside the operation, against the resolved `Actor`;
 *   · `tg_role_permission_within_reach` (0069), against
 *     `public.has_permission()`, for every row written into
 *     `role_permissions` by any caller at all;
 *   · and the escalation is impossible to reach without `permission.edit`,
 *     which `role_permissions_insert` demands.
 *
 * The attack it stops is not hypothetical: `permission.edit` is itself a
 * grantable permission, so the person editing role grants need not be the
 * owner, and without the rule they could mint themselves
 * `organization.settings.edit` and have it assigned.
 *
 * ── The plan gate is the engine's, not this file's ────────────────────────
 *
 * `ENTITLEMENT_FOR_GRANT` maps both `role.create` and `permission.edit` to
 * `custom_roles`, so `authorize()` refuses a business without the feature with
 * `plan_does_not_include` rather than `missing_permission`. Nothing here
 * checks an entitlement, and nothing here should: a second copy of that map
 * would be a second answer to the same question.
 */

import { revalidatePath } from 'next/cache'

import {
  defineCustomRoleOperations,
  type CreateRoleInput,
} from '@/lib/authz/administration'
import { SupabaseAdministrationStore } from '@/lib/authz/administration-store'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { domainEventBus } from '../../_lib/events'
import { auditActorFor, transactionRunner } from '../../_lib/wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

const SCREEN = '/roles'

async function ready(correlationId: string) {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לנהל תפקידים.'
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

async function wire() {
  const db = await createClient()
  const { transactions } = transactionRunner(db)

  return {
    operations: defineCustomRoleOperations(new SupabaseAdministrationStore(db)),
    services: {
      audit: new SupabaseAuditWriter(db),
      events: domainEventBus(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
    },
  }
}

export async function createCustomRoleAction(
  input: CreateRoleInput & { idempotencyKey: string },
): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await wire()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.create.run({
      request: {
        input: { ...draft, grants: [...draft.grants] },
        idempotencyKey,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    // The roster prints the role name beside every person holding it.
    revalidatePath('/team')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/**
 * The whole grant set, replaced.
 *
 * `permission.edit` is in `SENSITIVE_ACTIONS`, so the pipeline refuses this
 * without a stated reason. The screen collects one rather than inventing a
 * placeholder — a `reason` of "עדכון" written by the code would make the
 * audit trail's most important column meaningless.
 */
export async function setRolePermissionsAction(input: {
  roleId: string
  grants: readonly string[]
  reason: string
}): Promise<ActionResult<{ id: string; grantCount: number }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await wire()

    const outcome = await wired.operations.setPermissions.run({
      request: {
        input: { roleId: input.roleId, grants: [...input.grants] },
        resourceId: input.roleId,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
        reason: input.reason,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    revalidatePath('/team')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function deleteCustomRoleAction(input: {
  roleId: string
  reason: string
}): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await wire()

    const outcome = await wired.operations.remove.run({
      request: { input: { roleId: input.roleId }, resourceId: input.roleId },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
        reason: input.reason,
      },
      services: wired.services,
    })

    revalidatePath(SCREEN)
    revalidatePath('/team')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
