/**
 * EXECUTION CONTEXT — SERVER ONLY. Creating a guest card.
 *
 * ── What this closes ──────────────────────────────────────────────────────
 *
 * `guests/_lib/actions.ts` used to write `public.guests` directly, and said so
 * in its own header: no audit event, and no idempotency key, so a second POST
 * of the same form created a second guest unless the telephone number happened
 * to collide with `guests_organization_phone_idx`. Both gaps existed for one
 * reason — there was no guest operation to call. This is that operation.
 *
 * ── Why the client is passed in rather than a repository ──────────────────
 *
 * `src/lib/booking` sits behind a `BookingRepository` port with a Supabase
 * adapter in `src/lib/persistence`. That is the better shape and it is not
 * available here: the persistence layer is owned by another worker for the
 * duration of this work, so a `SupabaseGuestRepository` could not be written
 * without reaching outside this claim.
 *
 * So this follows the other precedent the codebase already set for exactly
 * this situation — `tasks/_lib/operations.ts` — and takes the request-scoped
 * `Db`, writing through `clientFor(tx, db)` so the row lands inside whatever
 * unit of work the pipeline opened. Every write still runs as the signed-in
 * person under row level security, which is the floor beneath `assertCan`.
 * When a `GuestRepository` port exists this operation moves behind it with no
 * change to its rules.
 *
 * ── The rules the database owns are not re-implemented ────────────────────
 *
 * `guests_full_name_not_blank`, `guests_email_format`,
 * `guests_nationality_format` and `guests_organization_phone_idx` are in 0009
 * and 0020 and all still apply. The schema below refuses the same values
 * earlier and in Hebrew, naming the field a person actually filled in; the
 * constraint remains the authority.
 *
 * `phone_e164` is deliberately never written: it is a generated column
 * computed from `phone` by `normalize_phone_il`, precisely so that no write
 * path — including this one — can skip the deduplication key.
 */

import { assertCan } from '../authz/can'
import { BusinessRuleError } from '../errors'
import {
  PG_ERROR,
  asString,
  clientFor,
  recordWrite,
  toRow,
} from '../persistence'
import type { Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'

/* ---------------------------------------------------------------- input -- */

/**
 * A guest card as the domain accepts it.
 *
 * Absent values are `null` and never `''`. The distinction is load-bearing on
 * the way to the database: an empty string is a value, it fails
 * `guests_email_format`, and where it does not it reads on a screen as "we
 * hold an address for this person" when we hold nothing at all.
 */
export type GuestDraft = {
  fullName: string
  phone: string | null
  email: string | null
  /** Matches `guests.language`, which is `text not null default 'he'`. */
  language: string
  /** ISO-3166 alpha-2, upper case. */
  nationality: string | null
  city: string | null
  tags: readonly string[]
  notes: string | null
  marketingConsent: boolean
}

export type CreatedGuest = {
  id: string
  fullName: string
}

/** `guests_email_format`, as 0009 writes it. Copied, not invented. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** `guests_nationality_format`. */
const ALPHA2 = /^[A-Z]{2}$/

const INPUT = s.object({
  fullName: s.string({ label: 'שם מלא', min: 2, max: 200 }),
  phone: s.nullable(s.string({ label: 'טלפון', min: 1, max: 40 })),
  email: s.nullable(
    s.string({
      label: 'אימייל',
      min: 3,
      max: 254,
      pattern: EMAIL,
      patternMessage: 'כתובת האימייל אינה בפורמט תקין.',
    }),
  ),
  language: s.string({ label: 'שפה', min: 1, max: 20 }),
  nationality: s.nullable(
    s.string({
      label: 'אזרחות',
      min: 2,
      max: 2,
      pattern: ALPHA2,
      patternMessage:
        'אזרחות נשמרת כקוד מדינה בן שתי אותיות לטיניות, למשל IL או FR.',
    }),
  ),
  city: s.nullable(s.string({ label: 'עיר', min: 1, max: 120 })),
  tags: s.arrayOf(s.string({ label: 'תווית', min: 1, max: 40 }), {
    label: 'תוויות',
    max: 20,
  }),
  notes: s.nullable(s.string({ label: 'הערות', max: 4000 })),
  marketingConsent: s.boolean({ label: 'הסכמה לדיוור' }),
})

export type GuestCreationOperation = Operation<GuestDraft, null, CreatedGuest>

export type GuestOperations = {
  createGuest: GuestCreationOperation
}

/* ------------------------------------------------------------- failures -- */

/**
 * Is this the deduplication index refusing a telephone number it already
 * holds?
 *
 * Narrow on purpose. A `23505` from any other index is a different fact and is
 * rethrown untouched — turning every unique violation into "this guest already
 * exists" would one day tell somebody their guest exists because an unrelated
 * constraint fired.
 */
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

/** The one guest already on file, named rather than reported as a constraint. */
export class GuestPhoneTakenError extends BusinessRuleError {
  constructor(cause: unknown) {
    super({
      code: 'guest.phone_taken',
      message: 'guests_organization_phone_idx rejected a duplicate phone',
      userMessage:
        'כבר קיים אורח עם מספר הטלפון הזה בארגון. חפש אותו ברשימת האורחים ' +
        'ועדכן את הכרטיס הקיים, במקום לפתוח כרטיס שני לאותו אדם.',
      cause,
    })
  }
}

/**
 * The insert was accepted and the row could not be read back.
 *
 * `.single()` with no error and no row means `guests_insert` admitted the
 * write and `guests_select` then refused to return it — an external sales
 * agent holds `guest.create` without `guest.view`. Saying "failed" would be a
 * lie and saying nothing would be another, so the failure names what actually
 * happened and reports the data as saved.
 */
export class GuestNotReadableError extends BusinessRuleError {
  constructor() {
    super({
      code: 'guest.not_readable',
      message: 'guests insert returned no row; guests_select refused the read',
      userMessage:
        'האורח נשמר אך לא ניתן להציג אותו בהרשאות שלך. חפש אותו ברשימת ' +
        'האורחים או פנה למנהל המערכת.',
    })
  }
}

/* ------------------------------------------------------------ the build -- */

/**
 * The one path a guest row is written along.
 *
 * A factory rather than a module-level constant, because `db` carries the
 * caller's session: one shared instance would be one shared identity.
 */
export function defineGuestOperations(options: { db: Db }): GuestOperations {
  const createGuest = defineOperation<GuestDraft, null, CreatedGuest>({
    name: 'guest.create',
    permission: 'guest.create',
    resourceType: 'guest',
    input: INPUT,

    /**
     * Scope, asserted by hand because there is nothing to load.
     *
     * The pipeline checks tenant and scope against the *loaded* resource, and
     * a creation has none. Without this an agent narrowed to two properties —
     * who holds `guest.create` and whose guest scope is those properties —
     * would reach the insert. `family: 'guest'` is what makes a per-family
     * narrowing apply, and it is the same resource shape the guests screen
     * already asks about.
     */
    rule({ context }) {
      assertCan(context.actor, 'guest.create', {
        organizationId: context.actor.organizationId,
        family: 'guest',
      })
    },

    async execute({ input, context, now, tx }) {
      const db = clientFor(tx, options.db)

      const { data, error } = await db
        .from('guests')
        .insert({
          organization_id: context.actor.organizationId,
          full_name: input.fullName,
          email: input.email,
          phone: input.phone,
          language: input.language,
          nationality: input.nationality,
          city: input.city,
          tags: normalizeTags(input.tags),
          notes: input.notes,
          marketing_consent: input.marketingConsent,
          // The date is the evidence, not decoration: consent with no date is
          // a claim nobody can defend later. Written only when consent was
          // given, which is what keeps it truthful when it is withdrawn.
          marketing_consent_at: input.marketingConsent
            ? now.toISOString()
            : null,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id, full_name')
        .single()

      if (isDuplicatePhone(error)) throw new GuestPhoneTakenError(error)
      if (error) throw error
      if (!data) throw new GuestNotReadableError()

      recordWrite(tx, 'guests.insert')

      const row = toRow(data)
      return {
        id: asString(row, 'id'),
        fullName: asString(row, 'full_name'),
      }
    },

    /**
     * The sentence the timeline keeps.
     *
     * The name and nothing else. A telephone number in an audit summary is a
     * telephone number in every export of that timeline, and the summary's job
     * is to say who did what — the card itself holds the contact details,
     * behind `guest.view_phone`.
     */
    audit({ input, result, context }) {
      return {
        resourceId: result.id,
        after: {
          fullName: result.fullName,
          language: input.language,
          hasPhone: input.phone !== null,
          hasEmail: input.email !== null,
          marketingConsent: input.marketingConsent,
          tags: normalizeTags(input.tags),
        },
        summary: `${context.auditActor.label} יצרה כרטיס אורח עבור ${result.fullName}`,
      }
    },

    events({ result }) {
      return [
        {
          name: 'guest.created',
          payload: { guestId: result.id },
        },
      ]
    },
  })

  return { createGuest }
}

/**
 * The tags as they will be stored.
 *
 * Trimmed, de-duplicated and stripped of blanks — an empty label is a tag
 * nobody can filter on and every guest silently carries.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()))].filter(
    (tag) => tag.length > 0,
  )
}
