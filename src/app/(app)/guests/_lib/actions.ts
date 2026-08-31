'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTION. Creating a guest.
 *
 * ── This writes a row directly, and that is a compromise, not a pattern ───
 *
 * `bookings/_lib/actions.ts` opens by saying that not one of its functions
 * writes a row: each hands the request to an operation from
 * `defineBookingOperations`, which is the only path with authorization,
 * validation, optimistic locking, the transaction, the audit event and
 * idempotency wired in that order. There is no equivalent for a guest —
 * `src/lib/guests` does not exist, there is no `GuestRepository` port, and the
 * only guest write anywhere in the codebase is the private `createGuest`
 * inside `SupabaseBookingRepository`, which creates a guest carrying nothing
 * but a name. So this action is written the way
 * `settings/organization/_lib/actions.ts` is: the signed-in user's client,
 * `assertCan` first and independently, validation before the write, and the
 * database's own constraints as the final authority.
 *
 * WHAT THAT COSTS, STATED RATHER THAN HIDDEN. No audit event is recorded for a
 * guest created here, and no idempotency key protects a resubmission — a
 * second POST of the same form creates a second guest unless the telephone
 * number collides with `guests_organization_phone_idx`, in which case the
 * database refuses it and the person is told exactly that. Both are closed by
 * a `createGuest` operation in the service pipeline, which is the gap this
 * screen reports rather than papers over.
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
  BusinessRuleError,
  ValidationError,
  toSafeResponse,
  type SafeErrorBody,
} from '@/lib/errors'
import { PG_ERROR } from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { normalizeTags, validateGuest, type CreateGuestInput } from './schema'

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

/** Is this the deduplication index refusing a telephone number it already holds? */
function isDuplicatePhone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as {
    code?: unknown
    message?: unknown
    details?: unknown
  }
  if (record.code !== PG_ERROR.UNIQUE_VIOLATION) return false
  const haystack = `${String(record.message ?? '')} ${String(record.details ?? '')}`
  return haystack.includes('guests_organization_phone_idx')
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

    const email = input.email.trim()
    const phone = input.phone.trim()
    const nationality = input.nationality.trim().toUpperCase()
    const city = input.city.trim()
    const notes = input.notes.trim()
    const fullName = input.fullName.trim()

    const { data, error } = await supabase
      .from('guests')
      .insert({
        organization_id: context.actor.organizationId,
        full_name: fullName,
        // Written only where a value was actually given. An empty string is a
        // value: it would fail the format check, and where it did not it would
        // read on screen as "we hold an address for this person" when we hold
        // nothing at all.
        email: email.length > 0 ? email : null,
        phone: phone.length > 0 ? phone : null,
        language: input.language.trim(),
        nationality: nationality.length > 0 ? nationality : null,
        city: city.length > 0 ? city : null,
        tags: normalizeTags(input.tags),
        notes: notes.length > 0 ? notes : null,
        marketing_consent: input.marketingConsent,
        // The date is the evidence, not decoration: consent with no date is a
        // claim nobody can defend later. Written only when consent was given,
        // which is also what keeps it truthful when it is withdrawn.
        marketing_consent_at: input.marketingConsent
          ? new Date().toISOString()
          : null,
        created_by: context.user.id,
        // `phone_e164` is deliberately absent: it is a generated column and
        // Postgres refuses a write to it. The deduplication key is computed
        // from `phone` by `normalize_phone_il` precisely so that no write path
        // can skip it — including this one.
      })
      .select('id, full_name')
      .single()

    if (isDuplicatePhone(error)) {
      throw new BusinessRuleError({
        code: 'guest_phone_taken',
        message: 'guests_organization_phone_idx rejected a duplicate phone',
        userMessage:
          'כבר קיים אורח עם מספר הטלפון הזה בארגון. חפש אותו ברשימת האורחים ' +
          'ועדכן את הכרטיס הקיים, במקום לפתוח כרטיס שני לאותו אדם.',
        cause: error,
      })
    }
    if (error) throw error
    if (!data) {
      // `.single()` with no error and no row means the insert was written and
      // the policy then refused to return it. Saying "created" would be a lie
      // and saying "failed" would be a different one, so the failure names
      // what actually happened.
      throw new BusinessRuleError({
        code: 'guest_not_returned',
        userMessage:
          'האורח נשמר אך לא ניתן להציג אותו בהרשאות שלך. חפש אותו ברשימת ' +
          'האורחים או פנה למנהל המערכת.',
      })
    }

    revalidatePath('/guests')

    return {
      ok: true,
      data: {
        id: data.id as string,
        fullName: data.full_name as string,
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
