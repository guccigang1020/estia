/**
 * EXECUTION CONTEXT — SERVER ONLY. What a person can do to the rate card.
 *
 * Every write in this module goes through `defineOperation`, which is what
 * gives each of them the same eight things: the permission check before a row
 * is read, validation that reports every field at once, optimistic locking,
 * the idempotency key, the transaction, exactly one audit event, and the
 * refusal shaped as an `AppError` with a Hebrew `userMessage`. A write that
 * skipped this pipeline would have skipped one of those, and which one would
 * not be obvious until it mattered.
 *
 * ══ THERE IS NO `deleteRatePlan` AND THERE IS NO `repriceBooking` ═══════════
 *
 * **No delete.** `0072_pricing.sql` revokes DELETE on `rate_plans` from every
 * role. A plan is named by every price snapshot ever taken from it and by
 * `agent_commission_rules.rate_plan_ids`; deleting one would make a paid stay's
 * explanation point at nothing. `is_active = false` and `effective_to` already
 * say "stop selling this", and they say it without erasing anything.
 *
 * **No re-pricing.** Re-pricing a booking is `booking.amend_price` and belongs
 * to the booking module, which owns `booking_price_lines` and the total the
 * database maintains from them. An operation here that rewrote a booking's
 * money would be a second writer of a total, and two writers of one total is
 * how two screens end up disagreeing about a price. What this module offers
 * that path is `resolveStay` and `buildSnapshot` — inputs in, an explanation
 * out — and `public.capture_booking_price_snapshot` to freeze it.
 *
 * ══ A RULE IS NEVER EDITED IN PLACE (spec §6 rule 39) ═══════════════════════
 *
 * `replaceRateRule` closes the old row by setting `effective_to` and inserts a
 * new one starting there. The old row stays readable, which is what makes it
 * possible to answer "what did this season cost when that booking was taken"
 * a year later — and what makes §7.2's `effective_from desc` tie-breaker mean
 * something. An UPDATE would answer the question with today's number and look
 * completely convincing doing it.
 *
 * ══ AND A RECOMMENDATION IS APPROVED, NEVER APPLIED ═════════════════════════
 *
 * `approveSuggestion` writes a `rate_calendar` row carrying `suggestion_id`
 * AND `approved_by`, which a CHECK in 0072 enforces together. There is no
 * operation in this file that writes a price from a suggestion without a
 * person's id on it, and there is no code path in this module from the
 * suggestion table to the calendar that does not pass through here.
 */

import { BusinessRuleError, ConflictError } from '../errors'
import { clientFor, type Db } from '../persistence'
import { defineOperation, s, type Infer, type Operation } from '../service'
import { formatAgorotShort } from './labels'
import { approvalBlockers } from './suggestions'
import {
  MAX_SUGGESTION_BATCH,
  RATE_PLAN_KINDS,
  RATE_SCOPES,
  type DynamicPricingPolicy,
  type RateCalendarEntry,
  type RatePlan,
  type RateRule,
  type RateSuggestion,
} from './types'

const PLANS = 'rate_plans'
const RULES = 'rate_rules'
const CALENDAR = 'rate_calendar'
const SUGGESTIONS = 'rate_suggestions'
const POLICIES = 'dynamic_pricing_policies'

// ── Shared input pieces ───────────────────────────────────────────────────

/**
 * A calendar date, refused unless it is one.
 *
 * The pattern catches the shape; the refinement catches `2026-02-30`, which
 * matches the pattern perfectly and is not a day. Copied in spirit from
 * `booking/operations.ts` rather than imported, because importing a private
 * helper across module boundaries is a dependency that says something false
 * about how the two modules relate.
 */
const isoDate = (label: string) =>
  s.refine(
    s.string({
      label,
      pattern: /^\d{4}-\d{2}-\d{2}$/,
      patternMessage: 'תאריך חייב להיות בפורמט YYYY-MM-DD.',
    }),
    (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
    { code: 'invalid_date', message: 'התאריך אינו קיים בלוח השנה.' },
  )

/**
 * A nightly price, in agorot.
 *
 * `s.agorot` and never `s.number`, so the field is integer and non-negative by
 * type rather than by a check somebody remembered. The ceiling is a TYPO
 * limit, not a business limit: ₪1,450 typed in agorot is 145,000 and the same
 * finger slipping twice is 14,500,000.
 */
const nightlyAgorot = (label: string) => s.agorot({ label, max: 10_000_000 })

/** Spec §8: lowercase latin, digits, hyphen and underscore, 2–40. */
const planCode = s.string({
  label: 'קוד',
  min: 2,
  max: 40,
  pattern: /^[a-z0-9][a-z0-9_-]*$/,
  patternMessage: 'הקוד יכול להכיל אותיות אנגליות קטנות, ספרות, מקף וקו תחתון.',
})

/**
 * A stated justification, at least eight characters.
 *
 * Eight rather than one, for the reason `reviews/operations.ts` gives: a
 * one-character reason is a checkbox with extra steps, and the whole value of
 * storing the reason is that a person reads it later and judges.
 */
const reason = s.string({ label: 'נימוק', min: 8, max: 500 })

// ── Inputs ────────────────────────────────────────────────────────────────

const CREATE_PLAN_INPUT = s.object({
  propertyId: s.optional(s.uuid({ label: 'נכס' })),
  code: planCode,
  name: s.string({ label: 'שם', min: 1, max: 120 }),
  kind: s.enumOf(RATE_PLAN_KINDS, { label: 'סוג תוכנית' }),
  requiresGrant: s.optional(s.string({ label: 'הרשאה נדרשת', max: 64 })),
  minNights: s.optional(
    s.number({ label: 'מינימום לילות', integer: true, min: 1, max: 365 }),
  ),
  maxNights: s.optional(
    s.number({ label: 'מקסימום לילות', integer: true, min: 1, max: 365 }),
  ),
  floorAgorot: s.optional(s.agorot({ label: 'מחיר רצפה', max: 10_000_000 })),
  ceilingAgorot: s.optional(s.agorot({ label: 'מחיר תקרה', max: 10_000_000 })),
  priority: s.optional(s.number({ label: 'עדיפות', integer: true })),
  effectiveFrom: isoDate('בתוקף מ'),
  effectiveTo: s.optional(isoDate('בתוקף עד')),
})

const CREATE_RULE_INPUT = s.object({
  ratePlanId: s.uuid({ label: 'תוכנית תעריפים' }),
  propertyId: s.uuid({ label: 'נכס' }),
  scopeKind: s.enumOf(RATE_SCOPES, { label: 'רמת החוק' }),
  scopeId: s.uuid({ label: 'היעד' }),
  dateFrom: isoDate('מתאריך'),
  dateTo: isoDate('עד תאריך'),
  weekdays: s.optional(
    s.arrayOf(s.number({ label: 'יום', integer: true, min: 0, max: 6 }), {
      label: 'ימים בשבוע',
      max: 7,
    }),
  ),
  nightlyAgorot: nightlyAgorot('מחיר ללילה'),
  minNights: s.optional(
    s.number({ label: 'מינימום לילות', integer: true, min: 1, max: 365 }),
  ),
  priority: s.optional(s.number({ label: 'עדיפות', integer: true })),
  label: s.optional(s.string({ label: 'תיאור', max: 120 })),
  effectiveFrom: isoDate('בתוקף מ'),
})

const REPLACE_RULE_INPUT = s.object({
  ruleId: s.uuid({ label: 'חוק תעריף' }),
  /** The day the old row closes and the new one opens. One date, not two. */
  effectiveFrom: isoDate('בתוקף מ'),
  nightlyAgorot: nightlyAgorot('מחיר ללילה'),
  minNights: s.optional(
    s.number({ label: 'מינימום לילות', integer: true, min: 1, max: 365 }),
  ),
  priority: s.optional(s.number({ label: 'עדיפות', integer: true })),
  label: s.optional(s.string({ label: 'תיאור', max: 120 })),
})

const SET_NIGHT_INPUT = s.object({
  unitId: s.uuid({ label: 'יחידה' }),
  propertyId: s.uuid({ label: 'נכס' }),
  ratePlanId: s.uuid({ label: 'תוכנית תעריפים' }),
  date: isoDate('תאריך'),
  nightlyAgorot: nightlyAgorot('מחיר ללילה'),
  /**
   * The version the editor believes they are changing.
   *
   * Absent means "there is no row yet". Present and stale is a `ConflictError`
   * that is NOT retried automatically — spec §10 — because an automatic retry
   * here writes over the other person's edit, which is precisely the lost
   * update the column exists to prevent.
   */
  expectedVersion: s.optional(
    s.number({ label: 'גרסה', integer: true, min: 1 }),
  ),
})

const BULK_EDIT_INPUT = s.object({
  unitId: s.uuid({ label: 'יחידה' }),
  propertyId: s.uuid({ label: 'נכס' }),
  ratePlanId: s.uuid({ label: 'תוכנית תעריפים' }),
  from: isoDate('מתאריך'),
  to: isoDate('עד תאריך'),
  nightlyAgorot: nightlyAgorot('מחיר ללילה'),
})

const APPROVE_SUGGESTION_INPUT = s.object({
  suggestionId: s.uuid({ label: 'המלצה' }),
})

const REJECT_SUGGESTION_INPUT = s.object({
  suggestionId: s.uuid({ label: 'המלצה' }),
  reason,
})

const SET_POLICY_INPUT = s.object({
  propertyId: s.optional(s.uuid({ label: 'נכס' })),
  autoApply: s.boolean({ label: 'אישור אוטומטי' }),
  maxDeltaBps: s.number({
    label: 'פער מרבי',
    integer: true,
    min: 0,
    max: 10_000,
  }),
  maxDailyChanges: s.number({
    label: 'שינויים ליום',
    integer: true,
    min: 0,
    max: 24,
  }),
  floorAgorot: s.optional(s.agorot({ label: 'רצפה', max: 10_000_000 })),
  ceilingAgorot: s.optional(s.agorot({ label: 'תקרה', max: 10_000_000 })),
  reason,
})

// ── The surface ───────────────────────────────────────────────────────────

/**
 * Input types derived from the schemas rather than declared beside them.
 *
 * `Infer` keeps the two from drifting: a field added to a schema and forgotten
 * in an interface is a field that arrives validated and is then dropped on the
 * floor, and nothing about that failure looks like a failure.
 */
export type CreateRatePlanInput = Infer<typeof CREATE_PLAN_INPUT>
export type CreateRateRuleInput = Infer<typeof CREATE_RULE_INPUT>
export type ReplaceRateRuleInput = Infer<typeof REPLACE_RULE_INPUT>
export type SetCalendarNightInput = Infer<typeof SET_NIGHT_INPUT>
export type BulkEditCalendarInput = Infer<typeof BULK_EDIT_INPUT>
export type ApproveSuggestionInput = Infer<typeof APPROVE_SUGGESTION_INPUT>
export type RejectSuggestionInput = Infer<typeof REJECT_SUGGESTION_INPUT>
export type SetAutoPricingPolicyInput = Infer<typeof SET_POLICY_INPUT>

export interface PricingOperations {
  createRatePlan: Operation<CreateRatePlanInput, null, { id: string }>
  createRateRule: Operation<CreateRateRuleInput, null, { id: string }>
  replaceRateRule: Operation<
    ReplaceRateRuleInput,
    RateRuleWithProperty,
    { id: string; replaced: string }
  >
  setCalendarNight: Operation<
    SetCalendarNightInput,
    (RateCalendarEntry & { propertyId: string }) | null,
    { id: string; previousAgorot: number | null }
  >
  bulkEditCalendar: Operation<BulkEditCalendarInput, null, { nights: number }>
  approveSuggestion: Operation<
    ApproveSuggestionInput,
    RateSuggestion & { propertyId: string },
    { calendarId: string }
  >
  rejectSuggestion: Operation<
    RejectSuggestionInput,
    RateSuggestion & { propertyId: string },
    { id: string }
  >
  setAutoPricingPolicy: Operation<
    SetAutoPricingPolicyInput,
    DynamicPricingPolicy | null,
    { id: string }
  >
}

/**
 * A rule carries the property it was written against.
 *
 * Not decoration: `loadResource` hands it to the authorization engine as the
 * scope, so a manager restricted to one property cannot edit another
 * property's rate card by knowing a rule id. A rule loaded without it would
 * authorize against the organization alone, which is a wider check that looks
 * identical from the call site.
 */
export type RateRuleWithProperty = RateRule & { propertyId: string }

export interface PricingPorts {
  db: Db
  loadRatePlan: (organizationId: string, id: string) => Promise<RatePlan | null>
  loadRateRule: (
    organizationId: string,
    id: string,
  ) => Promise<RateRuleWithProperty | null>
  loadCalendarNight: (
    organizationId: string,
    key: { unitId: string; ratePlanId: string; date: string },
  ) => Promise<(RateCalendarEntry & { propertyId: string }) | null>
  loadSuggestion: (
    organizationId: string,
    id: string,
  ) => Promise<(RateSuggestion & { propertyId: string }) | null>
  /** The organization-wide policy when propertyId is null, else the property one. */
  loadPolicy: (
    organizationId: string,
    propertyId: string | null,
  ) => Promise<DynamicPricingPolicy | null>
  /** Spec §6 rule 25: is a booking occupying this unit on this night? */
  nightIsSold: (
    organizationId: string,
    unitId: string,
    date: string,
  ) => Promise<boolean>
  /** For the audit sentence. A price change nobody can locate is not a record. */
  unitName: (organizationId: string, unitId: string) => Promise<string>
  now?: () => Date
}

export function definePricingOperations(
  ports: PricingPorts,
): PricingOperations {
  const clock = ports.now ?? (() => new Date())

  /* ------------------------------------------------------------- plans -- */

  const createRatePlan = defineOperation<
    CreateRatePlanInput,
    null,
    { id: string }
  >({
    name: 'pricing.create_rate_plan',
    permission: 'pricing.manage',
    resourceType: 'rate_plan',
    input: CREATE_PLAN_INPUT,

    // A plan with a floor above its ceiling is refused by the database too
    // (0072). It is refused here as well so the person sees which two fields
    // are in conflict, rather than a constraint name.
    rule({ input }) {
      if (
        input.floorAgorot !== undefined &&
        input.ceilingAgorot !== undefined &&
        input.floorAgorot > input.ceilingAgorot
      ) {
        throw new BusinessRuleError({
          code: 'floor_above_ceiling',
          message: 'floor_agorot exceeds ceiling_agorot',
          userMessage: 'מחיר הרצפה לא יכול להיות גבוה ממחיר התקרה.',
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, ports.db)
      const { data, error } = await db
        .from(PLANS)
        .insert({
          organization_id: context.actor.organizationId,
          property_id: input.propertyId ?? null,
          code: input.code,
          name: input.name,
          kind: input.kind,
          requires_grant: input.requiresGrant ?? null,
          min_nights: input.minNights ?? null,
          max_nights: input.maxNights ?? null,
          floor_agorot: input.floorAgorot ?? null,
          ceiling_agorot: input.ceilingAgorot ?? null,
          priority: input.priority ?? 0,
          effective_from: input.effectiveFrom,
          effective_to: input.effectiveTo ?? null,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id')
        .single()

      if (error) {
        // 23505 on this table means `rate_plans_code_key`. The code is the
        // stable identifier a quote is reproduced from, so a duplicate is a
        // real problem and saying which field it is beats the constraint name.
        if ((error as { code?: string }).code === '23505') {
          throw new BusinessRuleError({
            code: 'rate_plan_code_taken',
            message: `rate plan code ${String(input.code)} already exists`,
            userMessage: 'כבר קיימת תוכנית תעריפים עם הקוד הזה.',
          })
        }
        throw error
      }
      return { id: String((data as { id: string }).id) }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        summary: `יצר תוכנית תעריפים '${String(input.name)}' (${String(input.code)}).`,
        after: { code: input.code, name: input.name, kind: input.kind },
      }
    },
  })

  /* ------------------------------------------------------------- rules -- */

  const createRateRule = defineOperation<
    CreateRateRuleInput,
    null,
    { id: string }
  >({
    name: 'pricing.create_rate_rule',
    permission: 'pricing.manage',
    resourceType: 'rate_rule',
    input: CREATE_RULE_INPUT,

    async loadResource({ input, context }) {
      return {
        resource: {
          organizationId: context.actor.organizationId,
          propertyId: String(input.propertyId),
        },
        entity: null,
      }
    },

    rule({ input }) {
      if (String(input.dateTo) <= String(input.dateFrom)) {
        throw new BusinessRuleError({
          code: 'range_not_ordered',
          message: 'dateTo must be after dateFrom',
          userMessage: 'תאריך הסיום חייב להיות אחרי תאריך ההתחלה.',
        })
      }
      const weekdays: number[] = input.weekdays ?? []
      if (new Set(weekdays).size !== weekdays.length) {
        throw new BusinessRuleError({
          code: 'weekdays_duplicated',
          message: 'duplicate weekday',
          userMessage: 'בחר ימים תקינים בשבוע, בלי כפילויות.',
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, ports.db)
      const { data, error } = await db
        .from(RULES)
        .insert({
          organization_id: context.actor.organizationId,
          property_id: input.propertyId,
          rate_plan_id: input.ratePlanId,
          scope_kind: input.scopeKind,
          scope_id: input.scopeId,
          date_from: input.dateFrom,
          date_to: input.dateTo,
          weekdays: input.weekdays ?? [],
          nightly_agorot: input.nightlyAgorot,
          min_nights: input.minNights ?? null,
          priority: input.priority ?? 0,
          label: input.label ?? null,
          effective_from: input.effectiveFrom,
          // `specificity` is deliberately absent. The database computes it
          // from the scope and the weekday set; sending a value would be
          // sending something that is about to be discarded.
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id')
        .single()

      if (error) {
        // 23P01 is the exclusion constraint: two rules that would tie on the
        // same night. The refusal names the situation rather than the
        // constraint, because the fix is a priority and the person has to
        // know that.
        if ((error as { code?: string }).code === '23P01') {
          throw new BusinessRuleError({
            code: 'rate_rule_ambiguous',
            message: 'overlapping rule at the same specificity and priority',
            userMessage:
              'כבר קיים חוק תעריף חופף באותה רמה ובאותה עדיפות. שני חוקים כאלה לא יכולים להתקיים יחד — שנה את העדיפות של אחד מהם.',
          })
        }
        throw error
      }
      return { id: String((data as { id: string }).id) }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        summary:
          `יצר חוק תעריף${input.label ? ` '${String(input.label)}'` : ''} · ` +
          `${String(input.dateFrom)}–${String(input.dateTo)} · ` +
          `${formatAgorotShort(Number(input.nightlyAgorot))} ללילה.`,
        after: {
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          nightlyAgorot: input.nightlyAgorot,
        },
      }
    },
  })

  const replaceRateRule = defineOperation<
    ReplaceRateRuleInput,
    RateRuleWithProperty,
    { id: string; replaced: string }
  >({
    name: 'pricing.replace_rate_rule',
    permission: 'pricing.manage',
    resourceType: 'rate_rule',
    input: REPLACE_RULE_INPUT,

    async loadResource({ input, context }) {
      const rule = await ports.loadRateRule(
        context.actor.organizationId,
        String(input.ruleId),
      )
      if (rule === null) return null
      return {
        resource: {
          organizationId: context.actor.organizationId,
          // The scope is the property the rule was written against. A manager
          // scoped to one property must not edit another's rate card by
          // knowing a rule id.
          propertyId: (rule as RateRule & { propertyId?: string }).propertyId,
        },
        entity: rule,
      }
    },

    rule({ entity, input }) {
      if (
        entity.effectiveTo !== null &&
        entity.effectiveTo <= String(input.effectiveFrom)
      ) {
        throw new BusinessRuleError({
          code: 'rule_already_closed',
          message: `rule ${entity.id} closed on ${entity.effectiveTo}`,
          userMessage:
            'החוק הזה כבר נסגר. אפשר ליצור חוק חדש, אבל אי אפשר להחליף חוק שכבר אינו בתוקף.',
        })
      }
      if (String(input.effectiveFrom) <= entity.effectiveFrom) {
        throw new BusinessRuleError({
          code: 'replacement_not_later',
          message: 'the replacement must start after the rule it replaces',
          userMessage:
            'החוק החדש חייב להתחיל אחרי היום שבו החוק הקודם נכנס לתוקף.',
        })
      }
    },

    // Two writes, and the order matters: close first, then open. The exclusion
    // constraint in 0072 forbids two rules whose SEASONS and whose VALIDITY
    // WINDOWS both overlap, so inserting the replacement before closing the
    // original would be refused by the database — which is the constraint
    // doing its job, and the reason this order is not a preference.
    async execute({ entity, input, context, tx }) {
      const db = clientFor(tx, ports.db)

      const closed = await db
        .from(RULES)
        .update({
          effective_to: input.effectiveFrom,
          updated_by: context.actor.userId,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', entity.id)
      if (closed.error) throw closed.error

      const { data, error } = await db
        .from(RULES)
        .insert({
          organization_id: context.actor.organizationId,
          property_id: (entity as RateRule & { propertyId?: string })
            .propertyId,
          rate_plan_id: entity.ratePlanId,
          scope_kind: entity.scopeKind,
          scope_id: entity.scopeId,
          date_from: entity.dateFrom,
          date_to: entity.dateTo,
          weekdays: entity.weekdays,
          nightly_agorot: input.nightlyAgorot,
          min_nights: input.minNights ?? entity.minNights,
          priority: input.priority ?? entity.priority,
          label: input.label ?? entity.label,
          effective_from: input.effectiveFrom,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id')
        .single()

      if (error) throw error
      return { id: String((data as { id: string }).id), replaced: entity.id }
    },

    audit({ entity, input, result }) {
      return {
        resourceId: result.id,
        summary:
          `החליף את חוק התעריף${entity.label ? ` '${entity.label}'` : ''} · ` +
          `מ-${formatAgorotShort(entity.nightlyAgorot)} ל-` +
          `${formatAgorotShort(Number(input.nightlyAgorot))} ללילה, ` +
          `החל מ-${String(input.effectiveFrom)}. החוק הקודם נסגר ונשאר קריא.`,
        before: { nightlyAgorot: entity.nightlyAgorot },
        after: {
          nightlyAgorot: input.nightlyAgorot,
          effectiveFrom: input.effectiveFrom,
        },
      }
    },
  })

  /* ---------------------------------------------------------- calendar -- */

  const setCalendarNight = defineOperation<
    SetCalendarNightInput,
    (RateCalendarEntry & { propertyId: string }) | null,
    { id: string; previousAgorot: number | null }
  >({
    name: 'pricing.set_calendar_night',
    permission: 'pricing.manage',
    resourceType: 'rate_calendar',
    input: SET_NIGHT_INPUT,

    async loadResource({ input, context }) {
      const existing = await ports.loadCalendarNight(
        context.actor.organizationId,
        {
          unitId: String(input.unitId),
          ratePlanId: String(input.ratePlanId),
          date: String(input.date),
        },
      )
      return {
        resource: {
          organizationId: context.actor.organizationId,
          propertyId: String(input.propertyId),
        },
        entity: existing,
      }
    },

    // Spec §10. The check is here rather than left to the pipeline's own
    // `expectedVersion` because there are two legitimate shapes — a night with
    // no row yet, and a night being changed — and only the second has a
    // version to state.
    rule({ entity, input }) {
      if (entity === null) return
      if (input.expectedVersion === undefined) {
        throw new ConflictError({
          resourceType: 'rate_calendar',
          resourceId: entity.id,
          expectedVersion: null,
          actualVersion: entity.version,
        })
      }
      if (input.expectedVersion !== entity.version) {
        throw new ConflictError({
          resourceType: 'rate_calendar',
          resourceId: entity.id,
          expectedVersion: Number(input.expectedVersion),
          actualVersion: entity.version,
        })
      }
    },

    async execute({ entity, input, context, tx }) {
      const db = clientFor(tx, ports.db)

      if (entity !== null) {
        const { error } = await db
          .from(CALENDAR)
          .update({
            nightly_agorot: input.nightlyAgorot,
            // A hand-typed price stops being an approved recommendation the
            // moment a person types over it. Leaving `ai_approved` would
            // credit the engine with a number it did not propose.
            source: 'manual',
            suggestion_id: null,
            updated_by: context.actor.userId,
          })
          .eq('organization_id', context.actor.organizationId)
          .eq('id', entity.id)
        if (error) throw error
        return { id: entity.id, previousAgorot: entity.nightlyAgorot }
      }

      const { data, error } = await db
        .from(CALENDAR)
        .insert({
          organization_id: context.actor.organizationId,
          property_id: input.propertyId,
          unit_id: input.unitId,
          rate_plan_id: input.ratePlanId,
          date: input.date,
          nightly_agorot: input.nightlyAgorot,
          source: 'manual',
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id')
        .single()
      if (error) throw error
      return { id: String((data as { id: string }).id), previousAgorot: null }
    },

    audit({ input, result }) {
      const to = formatAgorotShort(Number(input.nightlyAgorot))
      return {
        resourceId: result.id,
        summary:
          result.previousAgorot === null
            ? `קבע את מחיר הלילה ${String(input.date)} ל-${to}.`
            : `שינה את מחיר הלילה ${String(input.date)} מ-${formatAgorotShort(result.previousAgorot)} ל-${to}.`,
        before:
          result.previousAgorot === null
            ? undefined
            : { nightlyAgorot: result.previousAgorot },
        after: { nightlyAgorot: input.nightlyAgorot },
      }
    },
  })

  const bulkEditCalendar = defineOperation<
    BulkEditCalendarInput,
    null,
    { nights: number }
  >({
    name: 'pricing.bulk_edit',
    permission: 'pricing.manage',
    resourceType: 'rate_calendar',
    input: BULK_EDIT_INPUT,

    async loadResource({ input, context }) {
      return {
        resource: {
          organizationId: context.actor.organizationId,
          propertyId: String(input.propertyId),
        },
        entity: null,
      }
    },

    rule({ input }) {
      if (String(input.to) <= String(input.from)) {
        throw new BusinessRuleError({
          code: 'range_not_ordered',
          message: 'to must be after from',
          userMessage: 'תאריך הסיום חייב להיות אחרי תאריך ההתחלה.',
        })
      }
      const nights = datesBetween(String(input.from), String(input.to)).length
      // A year of nights in one dialogue is not a bulk edit, it is a rate card
      // replaced by somebody who did not read it. The screen shows the night
      // count and the cumulative difference before the button; this is the
      // floor under that.
      if (nights > 366) {
        throw new BusinessRuleError({
          code: 'bulk_range_too_wide',
          message: `${nights} nights in one bulk edit`,
          userMessage:
            'עריכה קבוצתית מוגבלת לשנה אחת בפעולה. טווח רחב יותר הוא מחירון שמישהו החליף בלי לקרוא אותו.',
        })
      }
    },

    // One statement, ordered by date ascending. Spec §10: two overlapping bulk
    // edits that lock rows in the same order cannot deadlock, and the order is
    // fixed here rather than left to whatever the planner chose that day.
    async execute({ input, context, tx }) {
      const db = clientFor(tx, ports.db)
      const nights = datesBetween(String(input.from), String(input.to))

      const rows = nights.map((date) => ({
        organization_id: context.actor.organizationId,
        property_id: input.propertyId,
        unit_id: input.unitId,
        rate_plan_id: input.ratePlanId,
        date,
        nightly_agorot: input.nightlyAgorot,
        source: 'manual' as const,
        created_by: context.actor.userId,
        updated_by: context.actor.userId,
      }))

      const { error } = await db
        .from(CALENDAR)
        .upsert(rows, { onConflict: 'unit_id,rate_plan_id,date' })
      if (error) throw error

      return { nights: nights.length }
    },

    audit({ input, result }) {
      return {
        resourceId: String(input.unitId),
        summary:
          `עדכן ${result.nights} לילות (${String(input.from)}–${String(input.to)}) ` +
          `ל-${formatAgorotShort(Number(input.nightlyAgorot))} ללילה.`,
        after: {
          from: input.from,
          to: input.to,
          nightlyAgorot: input.nightlyAgorot,
        },
      }
    },
  })

  /* ------------------------------------------------------- suggestions -- */

  const approveSuggestion = defineOperation<
    ApproveSuggestionInput,
    RateSuggestion & { propertyId: string },
    { calendarId: string }
  >({
    name: 'pricing.approve_suggestion',
    permission: 'pricing.manage',
    resourceType: 'rate_suggestion',
    input: APPROVE_SUGGESTION_INPUT,

    async loadResource({ input, context }) {
      const suggestion = await ports.loadSuggestion(
        context.actor.organizationId,
        String(input.suggestionId),
      )
      if (suggestion === null) return null
      return {
        resource: {
          organizationId: context.actor.organizationId,
          propertyId: suggestion.propertyId,
        },
        entity: suggestion,
      }
    },

    async rule({ entity, context }) {
      const sold = await ports.nightIsSold(
        context.actor.organizationId,
        entity.unitId,
        entity.date,
      )
      const blockers = approvalBlockers(entity, {
        nightIsSold: sold,
        now: clock(),
      })
      if (blockers.length > 0) {
        throw new BusinessRuleError({
          code: `suggestion_${blockers[0].code}`,
          message: `suggestion ${entity.id}: ${blockers.map((b) => b.code).join(', ')}`,
          userMessage:
            blockers[0].code === 'night_is_sold'
              ? 'הלילה כבר נמכר. המחיר של לילה שנמכר הוא עובדה, לא הגדרה.'
              : 'ההמלצה כבר אינה ניתנת לאישור.',
        })
      }
    },

    // 🔒 Two rows, and the second is the whole point: the calendar entry
    // carries `suggestion_id` AND `approved_by`, which a CHECK in 0072
    // enforces together. There is no path in this module that writes an
    // AI-originated price without a person's id on it.
    async execute({ entity, context, tx }) {
      const db = clientFor(tx, ports.db)

      const decided = await db
        .from(SUGGESTIONS)
        .update({
          status: 'approved',
          decided_by: context.actor.userId,
          decided_at: clock().toISOString(),
          updated_by: context.actor.userId,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', entity.id)
      if (decided.error) throw decided.error

      const { data, error } = await db
        .from(CALENDAR)
        .upsert(
          {
            organization_id: context.actor.organizationId,
            property_id: entity.propertyId,
            unit_id: entity.unitId,
            rate_plan_id: entity.ratePlanId,
            date: entity.date,
            nightly_agorot: entity.suggestedAgorot,
            source: 'ai_approved',
            suggestion_id: entity.id,
            approved_by: context.actor.userId,
            created_by: context.actor.userId,
            updated_by: context.actor.userId,
          },
          { onConflict: 'unit_id,rate_plan_id,date' },
        )
        .select('id')
        .single()
      if (error) throw error

      return { calendarId: String((data as { id: string }).id) }
    },

    audit({ entity, result }) {
      return {
        resourceId: result.calendarId,
        summary:
          `אישר את ההמלצה ל-${entity.date} · ` +
          `${formatAgorotShort(entity.suggestedAgorot)} ` +
          `(דטרמיניסטי ${formatAgorotShort(entity.deterministicAgorot)}).`,
        before: { nightlyAgorot: entity.deterministicAgorot },
        after: {
          nightlyAgorot: entity.suggestedAgorot,
          suggestionId: entity.id,
        },
      }
    },
  })

  const rejectSuggestion = defineOperation<
    RejectSuggestionInput,
    RateSuggestion & { propertyId: string },
    { id: string }
  >({
    name: 'pricing.reject_suggestion',
    permission: 'pricing.manage',
    resourceType: 'rate_suggestion',
    input: REJECT_SUGGESTION_INPUT,

    async loadResource({ input, context }) {
      const suggestion = await ports.loadSuggestion(
        context.actor.organizationId,
        String(input.suggestionId),
      )
      if (suggestion === null) return null
      return {
        resource: {
          organizationId: context.actor.organizationId,
          propertyId: suggestion.propertyId,
        },
        entity: suggestion,
      }
    },

    rule({ entity }) {
      if (entity.status !== 'pending') {
        throw new BusinessRuleError({
          code: 'suggestion_not_pending',
          message: `suggestion ${entity.id} is ${entity.status}`,
          userMessage: 'ההמלצה כבר הוכרעה.',
        })
      }
    },

    async execute({ entity, input, context, tx }) {
      const db = clientFor(tx, ports.db)
      const { error } = await db
        .from(SUGGESTIONS)
        .update({
          status: 'rejected',
          decided_by: context.actor.userId,
          decided_at: clock().toISOString(),
          decision_reason: input.reason,
          updated_by: context.actor.userId,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', entity.id)
      if (error) throw error
      return { id: entity.id }
    },

    audit({ entity, input }) {
      return {
        resourceId: entity.id,
        // The reason is on the row AND in the audit event. The row can be read
        // by anybody with the screen; the audit event is the copy that cannot
        // be changed afterwards.
        summary:
          `דחה את ההמלצה ל-${entity.date} ` +
          `(${formatAgorotShort(entity.suggestedAgorot)}) · נימוק: ${String(input.reason)}`,
        before: { status: entity.status },
        after: { status: 'rejected', reason: input.reason },
      }
    },
  })

  /* ------------------------------------------------------------ policy -- */

  const setAutoPricingPolicy = defineOperation<
    SetAutoPricingPolicyInput,
    DynamicPricingPolicy | null,
    { id: string }
  >({
    name: 'pricing.set_auto_policy',
    permission: 'pricing.manage',
    resourceType: 'dynamic_pricing_policy',
    input: SET_POLICY_INPUT,
    // Spec §13 asks for a stated reason on this one specifically: the floor is
    // the only barrier between a probabilistic suggestion and a loss, and
    // whoever moves it should have to say why. Set explicitly rather than left
    // to `SENSITIVE_ACTIONS`, because `pricing.manage` is not in that set
    // today and this operation must not depend on somebody adding it.
    requiresReason: true,

    async loadResource({ input, context }) {
      const existing = await ports.loadPolicy(
        context.actor.organizationId,
        input.propertyId ?? null,
      )
      return {
        resource: {
          organizationId: context.actor.organizationId,
          propertyId: input.propertyId,
        },
        entity: existing,
      }
    },

    // Read then write, deliberately NOT an upsert.
    //
    // 0072 enforces one policy per organization and one per property with two
    // PARTIAL unique indexes — the pair `automation_rules` uses in 0067, for
    // its reason: `unique nulls not distinct` needs the reader to already know
    // that a null property is a real key value here. A partial index cannot be
    // an ON CONFLICT target, so an upsert naming
    // `(organization_id, property_id)` would fail at the database with a
    // message about no matching constraint. Two statements say the same thing
    // and actually run.
    async execute({ entity, input, context, tx }) {
      const db = clientFor(tx, ports.db)

      const fields = {
        auto_apply: input.autoApply,
        max_delta_bps: input.maxDeltaBps,
        max_daily_changes: input.maxDailyChanges,
        floor_agorot: input.floorAgorot ?? null,
        ceiling_agorot: input.ceilingAgorot ?? null,
        // `enabled_by_user_id` and `enabled_at` are deliberately absent from
        // both branches: the trigger in 0072 takes them from the session. A
        // caller-supplied value could put an innocent person's name on every
        // automatic price change the policy ever makes.
      }

      if (entity !== null) {
        const { error } = await db
          .from(POLICIES)
          .update({ ...fields, updated_by: context.actor.userId })
          .eq('organization_id', context.actor.organizationId)
          .eq('id', entity.id)
        if (error) throw error
        return { id: entity.id }
      }

      const { data, error } = await db
        .from(POLICIES)
        .insert({
          organization_id: context.actor.organizationId,
          property_id: input.propertyId ?? null,
          ...fields,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id')
        .single()
      if (error) throw error
      return { id: String((data as { id: string }).id) }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        summary: input.autoApply
          ? `הפעיל תמחור אוטומטי · פער מרבי ${Number(input.maxDeltaBps) / 100}% · ` +
            `עד ${String(input.maxDailyChanges)} שינויים ליום · נימוק: ${String(input.reason)}`
          : `כיבה את התמחור האוטומטי · נימוק: ${String(input.reason)}`,
        after: {
          autoApply: input.autoApply,
          maxDeltaBps: input.maxDeltaBps,
          maxDailyChanges: input.maxDailyChanges,
        },
      }
    },
  })

  return {
    createRatePlan,
    createRateRule,
    replaceRateRule,
    setCalendarNight,
    bulkEditCalendar,
    approveSuggestion,
    rejectSuggestion,
    setAutoPricingPolicy,
  }
}

/**
 * Every date in `[from, to)`, ascending.
 *
 * Half-open, like every range in the product, and ascending because spec §10
 * makes the lock order the thing that stops two overlapping bulk edits
 * deadlocking. Not `eachNight` from the booking module: that takes a
 * `DateRange` shaped around a stay, and a calendar edit is not a stay.
 */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = []
  let cursor = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  // Bounded by the comparison rather than by a count, so a reversed range
  // yields nothing instead of looping.
  while (cursor < end && dates.length <= 400) {
    dates.push(new Date(cursor).toISOString().slice(0, 10))
    cursor += 86_400_000
  }
  return dates
}

export { MAX_SUGGESTION_BATCH }
