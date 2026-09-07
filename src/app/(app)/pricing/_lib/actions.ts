'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. What the pricing screen can write.
 *
 * Four actions, and the list is the argument:
 *
 *   setNight     — one night, one unit, with the version it was read at
 *   bulkEdit     — a range, one price, one idempotency key
 *   approve      — a recommendation becomes a price, carrying a name
 *   reject       — a recommendation is refused, carrying a reason
 *
 * ══ WHAT IS NOT HERE ════════════════════════════════════════════════════════
 *
 * **No delete.** The database refuses it on `rate_plans`, `rate_suggestions`
 * and `dynamic_pricing_policies` (0072). A rate card that priced a stay
 * somebody paid for is not something a screen may erase.
 *
 * **No re-pricing of a booking.** That is `booking.amend_price` and it belongs
 * to the booking module, which owns the price lines and the total the database
 * maintains from them. An action here that rewrote a booking's money would be
 * a second writer of one total.
 *
 * ══ THE VERSION IS NOT OPTIONAL WHEN A ROW EXISTS ═══════════════════════════
 *
 * `setNightAction` passes the version the editor read. A mismatch is a 409
 * that is deliberately NOT retried — spec §10 — because retrying is exactly
 * the lost update the column exists to prevent. Two people editing the same
 * night is the ordinary case on a rate calendar, not an exotic one.
 */

import { revalidatePath } from 'next/cache'

import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { PricingRepository, definePricingOperations } from '@/lib/pricing'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { domainEventBus } from '../../_lib/events'
import { auditActorFor, transactionRunner } from '../../_lib/wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

const SCREEN = '/pricing'

async function ready(correlationId: string) {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לשנות מחירון.'
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
  const repository = new PricingRepository(db)

  return {
    operations: definePricingOperations({
      db,
      loadRatePlan: (organizationId, id) => repository.plan(organizationId, id),
      loadRateRule: (organizationId, id) => repository.rule(organizationId, id),
      loadCalendarNight: (organizationId, key) =>
        repository.calendarNight(organizationId, key),
      loadSuggestion: (organizationId, id) =>
        repository.suggestion(organizationId, id),
      loadPolicy: (organizationId, propertyId) =>
        repository.policy(organizationId, propertyId),
      // Spec §6 rule 25. Asked of `unit_occupancy`, which 0009 maintains by
      // trigger from the bookings themselves — so this reads what the calendar
      // reads rather than a second opinion about which nights are taken.
      nightIsSold: async (organizationId, unitId, date) => {
        const { data, error } = await db
          .from('unit_occupancy')
          .select('unit_id')
          .eq('organization_id', organizationId)
          .eq('unit_id', unitId)
          .lte('check_in', date)
          .gt('check_out', date)
          .limit(1)
        // Fail closed: if the question cannot be answered, the night is
        // treated as sold and the approval is refused. The cost of that is a
        // person clicking again; the cost of the other direction is a price
        // moved on a stay somebody already agreed to.
        if (error) return true
        return Array.isArray(data) && data.length > 0
      },
      unitName: async (organizationId, unitId) => {
        const { data } = await db
          .from('units')
          .select('name')
          .eq('organization_id', organizationId)
          .eq('id', unitId)
          .maybeSingle()
        return (data as { name?: string } | null)?.name ?? 'יחידה'
      },
    }),
    services: {
      audit: new SupabaseAuditWriter(db),
      events: domainEventBus(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
    },
  }
}

/** One night. `expectedVersion` is absent only when there is no row yet. */
export async function setNightAction(input: {
  unitId: string
  propertyId: string
  ratePlanId: string
  date: string
  nightlyAgorot: number
  expectedVersion?: number
  idempotencyKey: string
}): Promise<ActionResult<{ id: string; previousAgorot: number | null }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.setCalendarNight.run({
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
 * A range of nights at one price.
 *
 * The key is the caller's, generated when the dialogue opened, so a double
 * click is one edit. Spec §10 derives it from the payload instead; a key from
 * the client is equivalent as long as it is not regenerated per attempt, and
 * the screen holds it for the life of the dialogue.
 */
export async function bulkEditAction(input: {
  unitId: string
  propertyId: string
  ratePlanId: string
  from: string
  to: string
  nightlyAgorot: number
  idempotencyKey: string
}): Promise<ActionResult<{ nights: number }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const { idempotencyKey, ...draft } = input

    const outcome = await wired.operations.bulkEditCalendar.run({
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
 * A recommendation becomes a price.
 *
 * 🔒 The written row carries `suggestion_id` and `approved_by` together — a
 * CHECK in 0072 will not store one without the other. The key is derived from
 * the suggestion, because approving is a once-per-recommendation act and a key
 * that changes on every attempt is not a key.
 */
export async function approveSuggestionAction(input: {
  suggestionId: string
}): Promise<ActionResult<{ calendarId: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()

    const outcome = await wired.operations.approveSuggestion.run({
      request: {
        input,
        idempotencyKey: `suggestion:${input.suggestionId}`,
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

/** A recommendation is refused, and the reason is stored on the row and in audit. */
export async function rejectSuggestionAction(input: {
  suggestionId: string
  reason: string
}): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()

    const outcome = await wired.operations.rejectSuggestion.run({
      request: {
        input,
        idempotencyKey: `suggestion:${input.suggestionId}`,
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
