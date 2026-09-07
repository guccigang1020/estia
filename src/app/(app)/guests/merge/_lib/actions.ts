'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTION. Joining two guest profiles, and undoing it.
 *
 * ── Neither function writes a row ─────────────────────────────────────────
 *
 * Both hand the request to an operation in `src/lib/leads`, which calls
 * `public.guest_merge_apply` / `public.guest_merge_undo`. The header of
 * `0074_leads_and_guest_merges.sql` sets out why the work happens in the
 * database: the person merging holds `guest.update` and `guest.delete` and
 * need not hold `booking.update` or `review.manage`, so moving a booking's
 * `guest_id` under their own row level security would fail for exactly the
 * people who are supposed to be doing this — and the alternative, a
 * service-role client in a request path, puts a credential that bypasses every
 * policy into a screen.
 *
 * ── ח40-19 · both grants, checked here as well ────────────────────────────
 *
 * `guest.merge` is not in the permission catalogue. Until it is, a merge needs
 * `guest.update` AND `guest.delete` together, and it is treated as a sensitive
 * action: a reason is mandatory, and the whole thing is audited. Both grants
 * are asserted here, again in the operation's `rule`, and again inside the
 * SECURITY DEFINER function — three times, because a Server Action is
 * reachable by a crafted POST and because inside a definer function the
 * explicit check is the only boundary left.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import { defineLeadOperations, type MergeChoices } from '@/lib/leads'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
  asNumber,
  asString,
  asStringOrNull,
  toRow,
  toRows,
  type Db,
} from '@/lib/persistence'
import type { BookingStatusName } from '@/lib/revenue/types'
import { createClient } from '@/lib/supabase/server'

import { domainEventBus } from '../../../_lib/events'
import { shellContext } from '../../../_lib/context'
import { auditActorFor, transactionRunner } from '../../../_lib/wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

function refusal(
  code: string,
  message: string,
): { ok: false; error: SafeErrorBody } {
  return {
    ok: false,
    error: {
      code,
      message,
      dataMessage: 'שום דבר לא מוזג. הפרופילים נשארו כפי שהיו.',
      retryMessage: 'ניסיון חוזר לא יעזור עד שהבעיה תיפתר.',
      dataOutcome: 'not_saved',
      retryable: false,
      correlationId: crypto.randomUUID(),
    },
  }
}

async function requireReady() {
  const context = await shellContext()
  if (!context) {
    return refusal(
      'unauthenticated',
      'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
    )
  }
  if (context.status !== 'ready') {
    return refusal(
      'membership_not_active',
      'אין לך מרחב עבודה פעיל, ולכן לא ניתן למזג פרופילים.',
    )
  }
  return { ok: true as const, context }
}

/**
 * The operations, wired with the four reads they need.
 *
 * Only `loadMergeTargets` is exercised by this file; the other three belong to
 * the lead operations that share the factory. They are supplied rather than
 * stubbed, because a factory that returns half-built operations is a factory
 * whose other half fails the first time somebody calls it.
 */
function buildOperations(db: Db) {
  return defineLeadOperations({
    db,

    async loadLead(organizationId, leadId) {
      const { data, error } = await db
        .from('leads')
        .select(
          'id, property_id, status, version, raw_name, assigned_to_user_id, ' +
            'created_by, first_response_at',
        )
        .eq('organization_id', organizationId)
        .eq('id', leadId)
        .is('deleted_at', null)
        .maybeSingle()

      if (error) throw error
      if (!data) return null
      const row = toRow(data)
      return {
        id: asString(row, 'id'),
        propertyId: asStringOrNull(row, 'property_id'),
        status: asString(row, 'status') as never,
        version: asNumber(row, 'version'),
        displayName: asStringOrNull(row, 'raw_name') ?? 'פנייה ללא שם',
        assignedToUserId: asStringOrNull(row, 'assigned_to_user_id'),
        createdByUserId: asStringOrNull(row, 'created_by'),
        firstResponseAt: asStringOrNull(row, 'first_response_at'),
      }
    },

    async resolveGuest() {
      return null
    },

    async loadBookingStatus(organizationId, bookingId) {
      const { data, error } = await db
        .from('bookings')
        .select('status')
        .eq('organization_id', organizationId)
        .eq('id', bookingId)
        .is('deleted_at', null)
        .maybeSingle()
      if (error) throw error
      if (!data) return null
      return asString(toRow(data), 'status') as BookingStatusName
    },

    async loadMergeTargets(organizationId, survivorId, mergedId) {
      const { data, error } = await db
        .from('guests')
        .select('id, full_name, version')
        .eq('organization_id', organizationId)
        .in('id', [survivorId, mergedId])

      if (error) throw error
      const rows = toRows(data)
      const survivor = rows.find((row) => asString(row, 'id') === survivorId)
      const merged = rows.find((row) => asString(row, 'id') === mergedId)
      if (!survivor || !merged) return null

      return {
        survivorName: asStringOrNull(survivor, 'full_name') ?? '',
        survivorVersion: asNumber(survivor, 'version'),
        mergedVersion: asNumber(merged, 'version'),
      }
    },
  })
}

/* ----------------------------------------------------------- the merge -- */

export type MergeGuestsInput = {
  survivorGuestId: string
  mergedGuestId: string
  survivorVersion: number
  mergedVersion: number
  typedSurvivorName: string
  reason: string
  choices: MergeChoices
  idempotencyKey: string
}

export async function mergeGuestsAction(
  input: MergeGuestsInput,
): Promise<ActionResult<{ mergeId: string }>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    const resource = {
      organizationId: context.actor.organizationId,
      family: 'guest' as const,
    }
    assertCan(context.actor, 'guest.update', resource)
    assertCan(context.actor, 'guest.delete', resource)

    const supabase = await createClient()
    const { transactions } = transactionRunner(supabase)
    const operations = buildOperations(supabase)

    const outcome = await operations.mergeGuests.run({
      request: {
        input: {
          survivorGuestId: input.survivorGuestId,
          mergedGuestId: input.mergedGuestId,
          survivorVersion: input.survivorVersion,
          mergedVersion: input.mergedVersion,
          typedSurvivorName: input.typedSurvivorName,
          choices: input.choices,
        },
        resourceId: input.survivorGuestId,
        // §10 lists a merge among the operations that must carry a key: a
        // double-submitted merge would otherwise attempt a second merge of a
        // profile that is already merged, and be refused with a confusing
        // sentence instead of returning the first result.
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
        reason: input.reason,
      },
      services: {
        audit: new SupabaseAuditWriter(supabase),
        events: domainEventBus(supabase),
        idempotency: new SupabaseIdempotencyStore(supabase),
        transactions,
        onEventError(error) {
          console.error('[guests] domain event delivery failed', error)
        },
      },
    })

    revalidatePath('/guests')
    revalidatePath('/guests/merge')
    return { ok: true, data: { mergeId: outcome.data.mergeId } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ------------------------------------------------------------ the undo -- */

export async function undoGuestMergeAction(input: {
  mergeId: string
  reason: string
  idempotencyKey: string
}): Promise<ActionResult<{ mergeId: string }>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    const resource = {
      organizationId: context.actor.organizationId,
      family: 'guest' as const,
    }
    assertCan(context.actor, 'guest.update', resource)
    assertCan(context.actor, 'guest.delete', resource)

    const supabase = await createClient()
    const { transactions } = transactionRunner(supabase)
    const operations = buildOperations(supabase)

    const outcome = await operations.undoMerge.run({
      request: {
        input: { mergeId: input.mergeId },
        resourceId: input.mergeId,
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
        reason: input.reason,
      },
      services: {
        audit: new SupabaseAuditWriter(supabase),
        idempotency: new SupabaseIdempotencyStore(supabase),
        transactions,
      },
    })

    revalidatePath('/guests')
    revalidatePath('/guests/merge')
    return { ok: true, data: { mergeId: outcome.data.mergeId } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
