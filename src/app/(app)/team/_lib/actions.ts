'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Writing to `public.teams`.
 *
 * ── What this closes ──────────────────────────────────────────────────────
 *
 * `teams` was a table with policies, indexes and two inbound foreign keys and
 * no writer. `memberships.team_id` pointed at it and the `team` variant of
 * `membership_scopes` pointed at it, so team-scoped permission was expressible
 * in the schema and unreachable in the product: to scope somebody to a team
 * you first need a team.
 *
 * ── The permission on every one of these is `team.manage` ──────────────────
 *
 * Including the assignment, which writes a column on `memberships` — a table
 * whose update policy is written around `user.edit`. That is not a mismatch
 * that was overlooked; it is why `assign_membership_to_team` exists in 0069.
 * The alternative was widening `memberships_update` to admit `team.manage`,
 * which would have handed an operations manager the right to change an
 * administrator's *status*. Read the argument at the function itself.
 *
 * Every action asserts the grant again before touching an operation. A Server
 * Action is a public endpoint reachable by a crafted POST whatever the screen
 * chose to render, and the operations assert it a third time.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import {
  defineTeamOperations,
  type CreateTeamInput,
  type RenameTeamInput,
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

const SCREEN = '/team'

async function ready(correlationId: string) {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לנהל צוותים.'
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
    operations: defineTeamOperations(new SupabaseAdministrationStore(db)),
    services: {
      audit: new SupabaseAuditWriter(db),
      events: domainEventBus(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
    },
  }
}

export async function createTeamAction(
  input: CreateTeamInput & { idempotencyKey: string },
): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    assertCan(context.actor, 'team.manage', {
      organizationId: context.actor.organizationId,
      ...(input.propertyId === undefined
        ? {}
        : { propertyId: input.propertyId }),
      family: 'team',
    })

    const wired = await wire()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.create.run({
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

export async function renameTeamAction(
  input: RenameTeamInput & { version: number },
): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await wire()
    const { version, ...draft } = input

    const outcome = await wired.operations.rename.run({
      // The version the form was rendered from. Two supervisors editing the
      // same crew is not hypothetical on a shared screen, and the pipeline
      // refuses the second one rather than losing the first one's change.
      request: {
        input: draft,
        resourceId: input.teamId,
        expectedVersion: version,
      },
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
 * Archiving is a soft delete and it is refused while anybody is still in the
 * crew or scoped to it. The refusal is the point: a team archived under the
 * people in it leaves a live `membership_scopes` row naming a dead team.
 */
export async function archiveTeamAction(input: {
  teamId: string
}): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await wire()

    const outcome = await wired.operations.archive.run({
      request: { input, resourceId: input.teamId },
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
 * `teamId: null` takes somebody out of every team, and is a legitimate
 * request rather than a missing value.
 */
export async function assignMemberToTeamAction(input: {
  membershipId: string
  teamId: string | null
}): Promise<ActionResult<{ membershipId: string; teamId: string | null }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    assertCan(context.actor, 'team.manage', {
      organizationId: context.actor.organizationId,
      family: 'team',
    })

    const wired = await wire()

    const outcome = await wired.operations.assignMember.run({
      request: { input, resourceId: input.membershipId },
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
