'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTION. Creating a property.
 *
 * ── This writes no row ────────────────────────────────────────────────────
 *
 * The request goes to `definePropertyOperations`, which is the only path to a
 * `properties` row that carries authorization, validation, the domain rule,
 * the transaction, the audit event and idempotency in that order.
 *
 * The form shipped before this action existed, with its submit deliberately
 * disabled and the reason stated on screen. That was the right call: an
 * `insert` from a route handler would have looked identical to a person and
 * skipped all six, and the one that matters most is the audit event — a
 * property created with no row in `audit_events` is a change nobody can trace,
 * on the very record the audit screen next door presents as evidence.
 *
 * ── Why `assertCan` is called here as well ────────────────────────────────
 *
 * `properties_insert` requires `property.create` at the database and the
 * operation asserts it again, so this is not the enforcement. It is the
 * independent one: a Server Action is a public endpoint reachable by a crafted
 * POST whatever the screen chose to render, and it must refuse on its own
 * terms before reading or writing anything.
 *
 * ── What a caller gets back ───────────────────────────────────────────────
 *
 * Never a thrown error. A throw inside a Server Action reaches the browser as
 * a digest and a blank screen, so every failure becomes the `SafeErrorBody`
 * `src/lib/errors` already produces: a Hebrew sentence, whether the data was
 * saved, whether retrying is safe, and a correlation id matching the log.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import {
  ValidationError,
  toSafeResponse,
  type SafeErrorBody,
} from '@/lib/errors'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import {
  PROPERTY_TYPES,
  definePropertyOperations,
  type PropertyType,
} from '@/lib/properties'
import { createClient } from '@/lib/supabase/server'

import { auditActorFor, transactionRunner } from '../../_lib/wiring'
import { shellContext } from '../../_lib/context'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

export type CreatedPropertyResult = {
  id: string
  name: string
  slug: string
}

/**
 * The form's own shape, before the domain sees it.
 *
 * Everything arrives as a string because a form is strings. The numbers are
 * parsed here rather than in the domain: `s.integer` would refuse `"3"` and
 * the message a person read would name a type rather than a field they filled
 * in.
 */
export type NewPropertyInput = {
  name: string
  slug: string
  propertyType: string
  city: string
  description: string
  defaultCheckInTime: string
  defaultCheckOutTime: string
  minNights: string
  /**
   * Basis points, as the field on screen already asks for.
   *
   * The form's own description says "1700 is 17%, and not 17", and the column
   * is `properties.tax_rate_bps`. Accepting a percent here and converting
   * would mean two units of tax in one flow and one of them invisible — which
   * is how a stay ends up taxed at a hundredth of its rate.
   */
  taxRateBps: string
  idempotencyKey: string
}

function isPropertyType(value: string): value is PropertyType {
  return (PROPERTY_TYPES as readonly string[]).includes(value)
}

/** Absent is `null`, never `''` — an empty string is a value and reads as one. */
function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export async function createPropertyAction(
  input: NewPropertyInput,
): Promise<ActionResult<CreatedPropertyResult>> {
  const context = await shellContext()
  const correlationId = crypto.randomUUID()

  if (!context || context.status !== 'ready') {
    return {
      ok: false,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן ליצור נכס.'
          : 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
        retryMessage: context
          ? 'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.'
          : 'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
        dataOutcome: 'not_saved',
        retryable: false,
        correlationId,
      },
    }
  }

  try {
    assertCan(context.actor, 'property.create', {
      organizationId: context.actor.organizationId,
    })

    // Refused here rather than left to the schema: `s.enum` would name the
    // whole vocabulary at somebody who chose from a list of five.
    if (!isPropertyType(input.propertyType)) {
      throw new ValidationError([
        {
          field: 'propertyType',
          code: 'unknown_property_type',
          message: 'סוג הנכס שנבחר אינו מוכר. בחר מהרשימה.',
        },
      ])
    }

    const minNights = Number.parseInt(input.minNights, 10)
    if (!Number.isInteger(minNights) || minNights < 1) {
      throw new ValidationError([
        {
          field: 'minNights',
          code: 'min_nights_invalid',
          message: 'מינימום לילות חייב להיות מספר שלם, אחד לפחות.',
        },
      ])
    }

    const taxRateBps = Number.parseInt(input.taxRateBps, 10)
    if (!Number.isInteger(taxRateBps) || taxRateBps < 0) {
      throw new ValidationError([
        {
          field: 'taxRateBps',
          code: 'tax_rate_invalid',
          message: 'שיעור המע״מ חייב להיות מספר שלם אי-שלילי בנקודות בסיס.',
        },
      ])
    }

    const db = await createClient()
    const { transactions } = transactionRunner(db)
    const operations = definePropertyOperations({ db })

    const outcome = await operations.createProperty.run({
      request: {
        input: {
          name: input.name.trim(),
          slug: input.slug.trim().toLowerCase(),
          propertyType: input.propertyType,
          city: orNull(input.city),
          description: orNull(input.description),
          defaultCheckInTime: input.defaultCheckInTime.trim(),
          defaultCheckOutTime: input.defaultCheckOutTime.trim(),
          minNights,
          taxRateBps,
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
        onEventError(error) {
          // A created property whose event failed to deliver is still a
          // created property. Logged so the loss is not silent.
          console.error('[properties] domain event delivery failed', error)
        },
      },
    })

    revalidatePath('/properties')
    revalidatePath('/units')

    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
