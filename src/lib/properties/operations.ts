/**
 * EXECUTION CONTEXT — SERVER ONLY. Adding a property.
 *
 * ── What this closes ──────────────────────────────────────────────────────
 *
 * `/properties/new` shipped as a complete form with its submit disabled and
 * the reason printed beside it: nothing in `src/lib` defined an operation that
 * creates a property, and an `insert` issued from the route would have
 * committed a change with no row in `audit_events` — on the same record the
 * audit screen next door presents as evidence. This is the operation that was
 * missing, so the button can be enabled without that becoming untrue.
 *
 * ── Every default is the column's own ─────────────────────────────────────
 *
 * The check-in and check-out times, the minimum stay and the VAT rate are the
 * defaults `0008_accommodation.sql` writes, and the form states them as such.
 * They are accepted as input rather than assumed here — a business that opens
 * at 16:00 says so once — but nothing invents a plausible-looking number that
 * the database would not have chosen.
 *
 * `status` is not an input. A property is born `draft`, which is the column's
 * default and the only honest starting state: a property with no units cannot
 * be sold, and offering `active` on a creation form would let somebody publish
 * an empty listing in one click.
 *
 * ── What this does not do ─────────────────────────────────────────────────
 *
 * The plan carries a `properties` quota and this operation does not declare
 * one. `defineOperation` reads the allowance from `OperationContext.limits`,
 * which `resolveActor` returns and `ShellContext` then drops, so a screen has
 * no honest way to supply it. Declaring the quota anyway would make every
 * property creation fail with a wiring error. The gap is reported rather than
 * worked around; it closes when `ShellContext` carries `limits`.
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

import { PROPERTY_TYPES, type PropertyType } from './types'

/* ---------------------------------------------------------------- input -- */

export type PropertyDraft = {
  name: string
  /** Lower-case latin and hyphens. Unique per organization among live rows. */
  slug: string
  propertyType: PropertyType
  city: string | null
  description: string | null
  /** `HH:MM`, matching `properties.default_check_in_time`. */
  defaultCheckInTime: string
  defaultCheckOutTime: string
  minNights: number
  /** VAT in basis points. 1700 is 17%, and never 17. */
  taxRateBps: number
}

export type CreatedProperty = {
  id: string
  name: string
  slug: string
}

/** `properties_slug_format`, as 0008 writes it. Copied, not invented. */
const SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** A `time` column accepts more than this; a form collects exactly this. */
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

const INPUT = s.object({
  name: s.string({ label: 'שם הנכס', min: 2, max: 200 }),
  slug: s.string({
    label: 'מזהה באתר',
    min: 2,
    max: 63,
    pattern: SLUG,
    patternMessage:
      'המזהה מורכב מאותיות לטיניות קטנות, ספרות ומקפים, ואינו מתחיל או מסתיים במקף.',
  }),
  propertyType: s.enumOf(PROPERTY_TYPES, { label: 'סוג הנכס' }),
  city: s.nullable(s.string({ label: 'עיר', min: 1, max: 120 })),
  description: s.nullable(s.string({ label: 'תיאור', max: 4000 })),
  defaultCheckInTime: s.string({
    label: 'שעת כניסה',
    pattern: CLOCK,
    patternMessage: 'שעה בפורמט HH:MM, למשל 15:00.',
  }),
  defaultCheckOutTime: s.string({
    label: 'שעת יציאה',
    pattern: CLOCK,
    patternMessage: 'שעה בפורמט HH:MM, למשל 11:00.',
  }),
  // `properties_min_nights_positive`.
  minNights: s.number({
    label: 'מינימום לילות',
    integer: true,
    min: 1,
    max: 365,
  }),
  // `properties_tax_rate_range`.
  taxRateBps: s.number({
    label: 'שיעור מע״מ',
    integer: true,
    min: 0,
    max: 10000,
  }),
})

export type PropertyCreationOperation = Operation<
  PropertyDraft,
  null,
  CreatedProperty
>

export type PropertyOperations = {
  createProperty: PropertyCreationOperation
}

/* ------------------------------------------------------------- failures -- */

/**
 * `properties_organization_slug_idx` already holds this identifier.
 *
 * A business rule and not a conflict: `ConflictError` says "somebody changed
 * the record you were editing, reload and try again", and reloading will not
 * help here. The identifier is taken and the person has to choose another.
 */
export class PropertySlugTakenError extends BusinessRuleError {
  constructor(slug: string, cause: unknown) {
    super({
      code: 'property.slug_taken',
      message: `properties_organization_slug_idx rejected a duplicate slug: ${slug}`,
      userMessage:
        `המזהה "${slug}" כבר תפוס על ידי נכס אחר בארגון. בחר מזהה אחר — ` +
        'הוא מופיע בכתובת של עמוד הנכס וחייב להיות ייחודי.',
      publicDetails: { slug },
      cause,
    })
  }
}

/**
 * The insert was accepted and the row could not be read back.
 *
 * `properties_select` narrows by `property_in_scope()`, and a member narrowed
 * to a list of properties does not reach the one they have just created — the
 * new id is in no `membership_scopes` row. Reported as saved, because it was.
 */
export class PropertyNotReadableError extends BusinessRuleError {
  constructor() {
    super({
      code: 'property.not_readable',
      message:
        'properties insert returned no row; properties_select refused the read',
      userMessage:
        'הנכס נשמר אך אינו בטווח ההרשאות שלך ולכן לא ניתן להציג אותו. פנה ' +
        'למנהל המערכת כדי לקבל גישה אליו.',
    })
  }
}

function isDuplicateSlug(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as {
    code?: unknown
    message?: unknown
    details?: unknown
  }
  if (record.code !== PG_ERROR.UNIQUE_VIOLATION) return false
  const haystack = `${String(record.message ?? '')} ${String(record.details ?? '')}`
  return haystack.includes('properties_organization_slug_idx')
}

/* ------------------------------------------------------------ the build -- */

export function definePropertyOperations(options: {
  db: Db
}): PropertyOperations {
  const createProperty = defineOperation<PropertyDraft, null, CreatedProperty>({
    name: 'property.create',
    permission: 'property.create',
    resourceType: 'property',
    input: INPUT,

    /**
     * Scope, asserted by hand because there is nothing to load.
     *
     * A property that does not exist yet has no id, so the resource carries
     * none — and `withinScope` answers `false` for a `properties` scope asked
     * about a resource with no property. That is the correct answer and it is
     * the rule: somebody narrowed to two properties may not mint a third,
     * because the new one would fall outside their own reach the moment it
     * existed. Only an organization-wide scope passes here.
     */
    rule({ context }) {
      assertCan(context.actor, 'property.create', {
        organizationId: context.actor.organizationId,
        family: 'inventory',
      })
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      const { data, error } = await db
        .from('properties')
        .insert({
          organization_id: context.actor.organizationId,
          name: input.name,
          slug: input.slug,
          property_type: input.propertyType,
          // Born a draft. See the header: an active property with no units is
          // an empty listing somebody published by accident.
          status: 'draft',
          city: input.city,
          description: input.description,
          default_check_in_time: input.defaultCheckInTime,
          default_check_out_time: input.defaultCheckOutTime,
          min_nights: input.minNights,
          tax_rate_bps: input.taxRateBps,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id, name, slug')
        .single()

      if (isDuplicateSlug(error)) {
        throw new PropertySlugTakenError(input.slug, error)
      }
      if (error) throw error
      if (!data) throw new PropertyNotReadableError()

      recordWrite(tx, 'properties.insert')

      const row = toRow(data)
      return {
        id: asString(row, 'id'),
        name: asString(row, 'name'),
        slug: asString(row, 'slug'),
      }
    },

    audit({ input, result, context }) {
      return {
        resourceId: result.id,
        // The property this event is about is the one just created, so the
        // audit timeline can be filtered to it from the moment it exists.
        propertyId: result.id,
        after: {
          name: result.name,
          slug: result.slug,
          propertyType: input.propertyType,
          status: 'draft',
          city: input.city,
          minNights: input.minNights,
          taxRateBps: input.taxRateBps,
        },
        summary:
          `${context.auditActor.label} יצרה את הנכס ${result.name} ` +
          `(${result.slug}) במצב טיוטה`,
      }
    },

    // No domain event. `DOMAIN_EVENTS` in `contracts/events.ts` carries no
    // `property.created`, and that file is a frozen vocabulary owned by the
    // coordinator — inventing a name locally would emit an event nothing can
    // subscribe to and would widen a union this module does not own. The name
    // is proposed in the report accompanying this work; until it is added,
    // the operation emits nothing rather than something wrong.
  })

  return { createProperty }
}
