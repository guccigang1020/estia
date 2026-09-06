'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTION. Creating a guest.
 *
 * ── This writes no row. It hands the request to an operation ──────────────
 *
 * `bookings/_lib/actions.ts` opens by saying that not one of its functions
 * writes a row: each hands the request to an operation, which is the only path
 * with authorization, validation, the transaction, the audit event and
 * idempotency wired in that order. This file said the opposite for a while,
 * and said so honestly — there was no guest domain, so it inserted into
 * `guests` itself, with no audit event and no idempotency key. A second POST
 * of the same form created a second guest unless the telephone number happened
 * to collide with `guests_organization_phone_idx`.
 *
 * `defineGuestOperations` closed that. The insert, the duplicate-phone
 * translation and the "written but not readable back" case all moved into
 * `src/lib/guests`, where the pipeline records the audit event and the
 * idempotency key around them. What is left here is the shape of the request:
 * trimming the form's strings to `null`, naming the person for the audit
 * trail, and turning any failure into a sentence.
 *
 * ── Why `assertCan` is called here as well ────────────────────────────────
 *
 * `guests_insert` requires `guest.create` at the database, so this check is
 * not the enforcement. It is the independent one: a Server Action is reachable
 * by a crafted POST whatever the screen rendered, and it must refuse on its
 * own terms before it has read or written anything. Deny by default, twice.
 *
 * ── What a caller gets back ───────────────────────────────────────────────
 *
 * Never a thrown error. A throw inside a Server Action reaches the browser as
 * a digest and an empty screen. Every failure becomes the `SafeErrorBody`
 * `src/lib/errors` already produces — Hebrew sentence, whether the data was
 * saved, whether retrying is safe, and a correlation id matching the log.
 */

import { revalidatePath } from 'next/cache'

import { assertCan, holdsGrant } from '@/lib/authz/can'
import {
  ValidationError,
  toSafeResponse,
  type SafeErrorBody,
} from '@/lib/errors'
import { defineGuestOperations, normalizeTags } from '@/lib/guests'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { auditActorFor, transactionRunner } from '../../_lib/wiring'
import { shellContext } from '../../_lib/context'
import { validateGuest, type CreateGuestInput } from './schema'
import { domainEventBus } from '../../_lib/events'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

export type CreatedGuest = {
  id: string
  fullName: string
  /** False when the creator may not open the guest they just created. */
  mayView: boolean
}

/* ------------------------------------------------------------ the gate -- */

/**
 * The context this action needs, or the refusal that replaces it.
 *
 * The same gate `bookings/_lib/actions.ts` uses, and for the same reason: a
 * signed-out or workspace-less caller is refused here rather than allowed to
 * reach a write with a fabricated actor.
 */
async function requireReady() {
  const context = await shellContext()

  if (!context) {
    return {
      ok: false as const,
      error: {
        code: 'unauthenticated',
        message: 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
        retryMessage: 'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId: crypto.randomUUID(),
      },
    }
  }

  if (context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: 'membership_not_active',
        message: 'אין לך מרחב עבודה פעיל, ולכן לא ניתן ליצור כרטיס אורח.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
        retryMessage: 'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId: crypto.randomUUID(),
      },
    }
  }

  return { ok: true as const, context }
}

/* ---------------------------------------------------------- the action -- */

export async function createGuestAction(
  input: CreateGuestInput,
): Promise<ActionResult<CreatedGuest>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    // The independent refusal. Before anything is read or written, and
    // regardless of what the screen chose to render.
    assertCan(context.actor, 'guest.create', {
      organizationId: context.actor.organizationId,
      family: 'guest',
    })

    const issues = validateGuest(input)
    if (issues.length > 0) throw new ValidationError(issues)

    const supabase = await createClient()
    const { transactions } = transactionRunner(supabase)
    const operations = defineGuestOperations({ db: supabase })

    // `GuestDraft` says an absent value is `null` and never `''`, so the trim
    // happens here rather than in the domain: an empty string is a value, it
    // fails `guests_email_format`, and where it does not it reads on screen as
    // "we hold an address for this person" when we hold nothing at all.
    const orNull = (value: string): string | null => {
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : null
    }

    const outcome = await operations.createGuest.run({
      request: {
        input: {
          fullName: input.fullName.trim(),
          phone: orNull(input.phone),
          email: orNull(input.email),
          language: input.language.trim(),
          nationality: orNull(input.nationality.toUpperCase()),
          city: orNull(input.city),
          tags: normalizeTags(input.tags),
          notes: orNull(input.notes),
          marketingConsent: input.marketingConsent,
        },
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: {
        audit: new SupabaseAuditWriter(supabase),
        events: domainEventBus(supabase),
        idempotency: new SupabaseIdempotencyStore(supabase),
        transactions,
        onEventError(error) {
          // Never rethrown: a created guest whose event failed to deliver is
          // still a created guest. Logged so the loss is not silent.
          console.error('[guests] domain event delivery failed', error)
        },
      },
    })

    revalidatePath('/guests')

    return {
      ok: true,
      data: {
        id: outcome.data.id,
        fullName: outcome.data.fullName,
        // `guest.create` and `guest.view` are separate grants, and an external
        // sales agent holds the first without the second — see `roles.ts`.
        // Redirecting them to a page that would bounce them to the dashboard
        // is not a success screen, so the form is told and says so instead.
        mayView: holdsGrant(context.actor, 'guest.view'),
      },
    }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
