/**
 * EXECUTION CONTEXT — SERVER ONLY. What a business can do to an agency.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * `agencies` has existed since 0015 and had no write path anywhere in the
 * product. `/leads` and `/promotions` read it, `bookings.agency_id` and
 * `commissions.agency_id` reference it, and `agent_network` — the entitlement
 * that unlocks the screen — is sold in the Direct, Pro and Management plans.
 * A record that is read in four places, referenced by two ledgers, and cannot
 * be created is a paid feature that was never delivered.
 *
 * Five operations, each through `defineOperation`, so none of them reaches a
 * write without having passed authorization, validation, the version check, the
 * domain rule and the audit trail — in that order, with no way to reorder them.
 *
 * ── DEACTIVATION IS A STATUS, AND SOFT-DELETE IS SEALED SHUT ──────────────
 *
 * `agencies` carries `deleted_at`/`deleted_by`. Nothing here writes them, and
 * after `0070_agencies_write_path.sql` nothing can — a trigger refuses the
 * write outright. The reasoning, because it is the decision this module was
 * asked to make deliberately:
 *
 *   · `bookings.agency_id` and `commissions.agency_id` are `on delete restrict`
 *     and no role holds DELETE on `agencies`. The row is permanent either way.
 *     The only thing `deleted_at` changes is **visibility**.
 *   · `agencies_tax_id_idx` and `agencies_name_idx` are both
 *     `where deleted_at is null`. A soft-delete therefore frees the agency's
 *     tax id — the state's own identifier for a legal entity — for re-entry.
 *     The same agency then exists twice with its commission history split
 *     between the two rows, which is the exact failure the unique index was
 *     added to prevent.
 *   · **A deactivated agency's commissions still resolve**, and that is not an
 *     accident of this code: 0015 wrote
 *     `agencies_my_organizations_work_with()` against *non-draft* agreements
 *     rather than active ones, precisely so "an agency that stopped working
 *     with a business in March is still owed money on stays happening in
 *     August". Deactivation here ends the agreement — `terminated`, which is
 *     still non-draft — so the agency stays readable, stays nameable on a
 *     statement, and every historical commission keeps its payee.
 *   · `status = 'inactive'` is a commercial statement: we no longer trade with
 *     them. `deleted_at` would be an existence statement. Only the first is
 *     true.
 *
 * ── "Deactivate" means two different things, and both are modelled ────────
 *
 * `agencies.status` is global — the agency has no `organization_id`, by design
 * — while `agency_agreements.status` is per-business. One guesthouse must not
 * be able to mark an agency dead for a rival that still sells through it. So
 * `deactivate` always ends **this** business's agreements, and marks the entity
 * itself inactive only when this business is its last non-draft counterparty
 * and no agency manager has ever claimed the record. Which of the two happened
 * comes back from the database and is put in the audit sentence, because the
 * screen must not guess.
 *
 * ── The terms are written twice on purpose, and never twice by hand ───────
 *
 * `agency_agreements.rule` is the commercial **document** — it is what the
 * agencies screen renders. `agent_commission_rules` is what
 * `selectCommissionRule` actually resolves when a commission is calculated;
 * nothing in the product reads the agreement's rule to compute money. Setting
 * the terms in only the first would produce a screen that shows 12% beside an
 * agency that earns nothing, which is worse than showing nothing. So
 * `setTerms` writes both, in one operation, and there is no second path to
 * either — the one thing that keeps the document and the resolver from drifting
 * apart.
 *
 * ── No new personal data ──────────────────────────────────────────────────
 *
 * `docs/PERSONAL_DATA_INVENTORY.md` already lists `agencies` as holding
 * כתובת · דוא״ל · טלפון. Every field these operations write existed in 0015.
 * Nothing here adds a personal column, and `contact_phone_e164` is a generated
 * column so no write path can store an un-normalised spelling of a number.
 */

import { assertCan, type Resource } from '../authz/can'
import { BusinessRuleError } from '../errors'
import { defineOperation, s, type Operation } from '../service'
import {
  COMMISSION_BASES,
  COMMISSION_CONDITIONS,
  COMMISSION_RULE_KINDS,
  type CommissionBase,
  type CommissionCondition,
  type CommissionRule,
} from './commission'
import type {
  AgencyContactDraft,
  AgencyRecord,
  AgencyStore,
  AgencyTermsTarget,
} from './agency-store'

/* ------------------------------------------------------------ thresholds -- */

/**
 * A commission rate is a percentage of a booking, so 100 is the ceiling.
 *
 * Not a stylistic bound: above it the business pays out more than the guest
 * paid in on every single sale. That is a decision somebody could genuinely
 * make once, as a loss-leader — and it is a typo a thousand times more often,
 * so it is refused with a sentence rather than accepted in silence.
 */
const MAX_COMMISSION_PERCENT = 100

/**
 * A year. `payment_terms_days` is how long the business has to pay an approved
 * commission, and a term beyond a year is not a negotiation anybody in this
 * market has — it is a slipped keystroke on a two-digit field.
 */
const MAX_PAYMENT_TERMS_DAYS = 365

/**
 * Eight characters, matching `review.hide` and the
 * `agencies_deactivation_reason_meaningful` constraint in 0070.
 *
 * A one-character reason is a checkbox with extra steps. Eight is the point at
 * which somebody has to write a short phrase rather than press a key, and the
 * entire value of storing the reason is that a person reads it later and
 * judges.
 */
const MIN_REASON_LENGTH = 8

/**
 * What a commission waits for when nobody says otherwise.
 *
 * `commission.ts` is explicit: "Paying on `estimated` means paying for stays
 * that never happened." An empty condition list is a real arrangement and the
 * database defaults to it, so the *screen's* default has to be the safe one
 * rather than the column's.
 */
export const DEFAULT_AGENCY_ELIGIBILITY: readonly CommissionCondition[] = [
  'stay_completed',
]

/* -------------------------------------------------------------- resource -- */

/**
 * The resource an authorization question about an agency is asked about.
 *
 * `family: 'team'` — an agency is the commercial counterparty of a
 * *relationship with people*, not a piece of inventory and not a financial
 * document. No property is carried, because an agreement is organization-wide:
 * a property-scoped membership does not reach it, which is the correct answer
 * and the reason `can()` is asked at all.
 *
 * Defined here and imported by the screen's read side, so the read and the
 * write cannot come to disagree about what is being authorized.
 */
export function agencyResource(organizationId: string): Resource {
  return { organizationId, family: 'team' }
}

/* ---------------------------------------------------------------- input -- */

const CONTACT_SHAPE = {
  name: s.string({ label: 'שם הסוכנות', min: 2, max: 200 }),
  taxId: s.optional(s.nullable(s.string({ label: 'ח.פ. / ע.מ.', max: 40 }))),
  contactPhone: s.optional(s.nullable(s.string({ label: 'טלפון', max: 32 }))),
  contactEmail: s.optional(
    s.nullable(
      s.string({
        label: 'דוא״ל',
        max: 200,
        // The same expression as `agencies_email_format` in 0015. Checked here
        // as well so the person is told which field is wrong, rather than
        // meeting a constraint name.
        pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
        patternMessage: 'כתובת הדוא״ל אינה בפורמט תקין.',
      }),
    ),
  ),
  addressLine1: s.optional(s.nullable(s.string({ label: 'כתובת', max: 200 }))),
  city: s.optional(s.nullable(s.string({ label: 'עיר', max: 100 }))),
  country: s.optional(
    s.string({
      label: 'מדינה',
      pattern: /^[A-Za-z]{2}$/,
      patternMessage: 'קוד מדינה בן שתי אותיות, למשל IL.',
    }),
  ),
  note: s.optional(s.nullable(s.string({ label: 'הערה', max: 2000 }))),
}

const TIER_INPUT = s.object({
  fromAgorot: s.agorot({ label: 'מדרגה מסכום' }),
  percent: s.number({
    label: 'אחוז',
    min: 0,
    max: MAX_COMMISSION_PERCENT,
  }),
})

/**
 * The rule as a form sends it: a kind plus the fields that kind needs.
 *
 * Flat rather than a discriminated union because a schema cannot branch, and
 * `toCommissionRule` below is what turns it into the domain's own union. The
 * refusals it raises are the same shape the database's
 * `agency_agreements_rule_shape` check enforces — a percentage rule with no
 * percentage is the row 0017 exists because of.
 */
const RULE_INPUT = s.object({
  kind: s.enumOf(COMMISSION_RULE_KINDS, { label: 'סוג העמלה' }),
  percent: s.optional(
    s.number({ label: 'אחוז עמלה', min: 0, max: MAX_COMMISSION_PERCENT }),
  ),
  amountAgorot: s.optional(s.agorot({ label: 'סכום קבוע' })),
  mode: s.optional(
    s.enumOf(['marginal', 'whole'] as const, { label: 'אופן הדירוג' }),
  ),
  tiers: s.optional(s.arrayOf(TIER_INPUT, { label: 'מדרגות', max: 20 })),
})

export type CommissionRuleInput = {
  kind: (typeof COMMISSION_RULE_KINDS)[number]
  percent?: number
  amountAgorot?: number
  mode?: 'marginal' | 'whole'
  tiers?: readonly { fromAgorot: number; percent: number }[]
}

/**
 * The form's fields, rebuilt as the domain's union — or refused.
 *
 * Never a cast. `SupabaseAgentRepository.toCommissionRuleRecord` casts stored
 * JSON with `as unknown as CommissionRule`, which is tolerable for an adapter
 * feeding a function that will reject the shape anyway. It is not tolerable on
 * a write: a `{kind:'percentage'}` with no percent stored here is a rule that
 * silently pays nothing, and the agent finds out on payday.
 */
export function toCommissionRule(input: CommissionRuleInput): CommissionRule {
  switch (input.kind) {
    case 'none':
      return { kind: 'none' }

    case 'percentage':
      if (typeof input.percent !== 'number') {
        throw new BusinessRuleError({
          code: 'agency.percentage_without_percent',
          message: 'A percentage rule was submitted with no percent',
          userMessage: 'עמלה באחוזים חייבת לכלול אחוז.',
        })
      }
      return { kind: 'percentage', percent: input.percent }

    case 'fixed':
      if (
        typeof input.amountAgorot !== 'number' ||
        !Number.isInteger(input.amountAgorot)
      ) {
        throw new BusinessRuleError({
          code: 'agency.fixed_without_amount',
          message: 'A fixed rule was submitted with no integer amount',
          userMessage: 'עמלה בסכום קבוע חייבת לכלול סכום.',
        })
      }
      return { kind: 'fixed', amountAgorot: input.amountAgorot }

    case 'tiered': {
      const tiers = input.tiers ?? []
      if (input.mode === undefined || tiers.length === 0) {
        throw new BusinessRuleError({
          code: 'agency.tiered_without_tiers',
          message: 'A tiered rule was submitted with no mode or no tiers',
          userMessage: 'עמלה מדורגת חייבת לכלול אופן דירוג ולפחות מדרגה אחת.',
        })
      }
      // The lowest bracket must start at zero. `commission.ts` says why: a
      // ladder with a hole at the bottom silently pays nothing on small
      // bookings, which is the failure nobody notices until it has happened
      // fifty times.
      const sorted = [...tiers].sort((a, b) => a.fromAgorot - b.fromAgorot)
      if (sorted[0].fromAgorot !== 0) {
        throw new BusinessRuleError({
          code: 'agency.tiered_has_a_hole_at_the_bottom',
          message: 'The lowest tier does not start at zero',
          userMessage:
            'המדרגה הנמוכה ביותר חייבת להתחיל מאפס, אחרת הזמנות קטנות לא ישלמו עמלה כלל.',
        })
      }
      return { kind: 'tiered', mode: input.mode, tiers: sorted }
    }
  }
}

const TERMS_SHAPE = {
  rule: RULE_INPUT,
  base: s.enumOf(COMMISSION_BASES, { label: 'בסיס חישוב' }),
  eligibility: s.arrayOf(
    s.enumOf(COMMISSION_CONDITIONS, { label: 'תנאי זכאות' }),
    { label: 'תנאי זכאות', max: COMMISSION_CONDITIONS.length },
  ),
  activeFrom: s.string({
    label: 'בתוקף מ־',
    pattern: /^\d{4}-\d{2}-\d{2}$/,
    patternMessage: 'תאריך בפורמט YYYY-MM-DD.',
  }),
  activeUntil: s.optional(
    s.nullable(
      s.string({
        label: 'בתוקף עד',
        pattern: /^\d{4}-\d{2}-\d{2}$/,
        patternMessage: 'תאריך בפורמט YYYY-MM-DD.',
      }),
    ),
  ),
  paymentTermsDays: s.number({
    label: 'ימי תשלום',
    min: 0,
    max: MAX_PAYMENT_TERMS_DAYS,
    integer: true,
  }),
  note: s.optional(s.nullable(s.string({ label: 'הערה להסכם', max: 2000 }))),
}

const CREATE_INPUT = s.object({ ...CONTACT_SHAPE, ...TERMS_SHAPE })

const EDIT_INPUT = s.object({
  agencyId: s.uuid({ label: 'סוכנות' }),
  ...CONTACT_SHAPE,
})

const TERMS_INPUT = s.object({
  agencyId: s.uuid({ label: 'סוכנות' }),
  ...TERMS_SHAPE,
})

const STATUS_INPUT = s.object({
  agencyId: s.uuid({ label: 'סוכנות' }),
  reason: s.string({
    label: 'נימוק',
    min: MIN_REASON_LENGTH,
    max: 500,
  }),
})

/* ------------------------------------------------------------- the types -- */

/**
 * The contact block as a *form* sends it: every field but the name may be
 * absent or explicitly null.
 *
 * `contactOf` collapses both to null before the store sees it, because on this
 * screen they mean the same thing — the form always submits the whole block, so
 * an absent field is a cleared field and not an unmentioned one.
 */
export type AgencyContactInput = {
  name: string
  taxId?: string | null
  contactPhone?: string | null
  contactEmail?: string | null
  addressLine1?: string | null
  city?: string | null
  country?: string
  note?: string | null
}

export type CreateAgencyInput = AgencyContactInput & AgencyTermsInput
export type EditAgencyContactInput = { agencyId: string } & AgencyContactInput
export type SetAgencyTermsInput = { agencyId: string } & AgencyTermsInput
export type AgencyStatusInput = { agencyId: string; reason: string }

export type AgencyTermsInput = {
  rule: CommissionRuleInput
  base: CommissionBase
  eligibility: readonly CommissionCondition[]
  activeFrom: string
  activeUntil?: string | null
  paymentTermsDays: number
  note?: string | null
}

export type AgencyDeactivated = {
  /** How many live agreements this business had with the agency. */
  agreementsEnded: number
  /**
   * Whether the agency row itself was marked inactive.
   *
   * False when another business still holds a non-draft agreement with it, or
   * when somebody from the agency manages the record — in both cases the
   * global flag is not this business's to write, and the relationship ending
   * is the whole of what happened.
   */
  entityMarkedInactive: boolean
}

export interface AgencyOperations {
  create: Operation<CreateAgencyInput, null, { id: string }>
  editContact: Operation<
    EditAgencyContactInput,
    AgencyRecord,
    { id: string; version: number }
  >
  setTerms: Operation<
    SetAgencyTermsInput,
    AgencyTermsTarget,
    { agreementId: string; ruleId: string }
  >
  deactivate: Operation<AgencyStatusInput, AgencyRecord, AgencyDeactivated>
  reactivate: Operation<
    AgencyStatusInput,
    AgencyRecord,
    { agreementId: string }
  >
}

/* ----------------------------------------------------------- the factory -- */

export function defineAgencyOperations(store: AgencyStore): AgencyOperations {
  /**
   * Load the agency, scoped by an agreement with the caller's organization.
   *
   * `agencies` has no `organization_id` and cannot have one, so the tenant
   * confinement is the agreement: the store starts from
   * `agency_agreements` for this organization and only then reads the agency
   * rows those agreements name. An agency this business has never signed with
   * is `null` here and becomes a `NotFoundError` in the pipeline, which is the
   * same answer a nonexistent id gets — deliberately indistinguishable.
   */
  const loadAgency = async ({
    input,
    context,
  }: {
    input: { agencyId: string }
    context: { actor: { organizationId: string } }
  }) => {
    const agency = await store.loadAgency(
      context.actor.organizationId,
      input.agencyId,
    )
    if (agency === null) return null
    return {
      resource: agencyResource(context.actor.organizationId),
      entity: agency,
      version: agency.version,
    }
  }

  /**
   * The refusal an unwritable agency earns.
   *
   * `agencies_update` in 0070 passes for a manager of the agency, or for a
   * business holding `agency.manage` when **nobody from the agency manages the
   * record**. A business editing an agency that has its own manager therefore
   * matches zero rows — and an UPDATE that matches zero rows succeeds. A
   * button that reports success having changed nothing is the failure mode
   * this check exists to convert into a sentence.
   */
  function assertWritableByThisBusiness(agency: AgencyRecord): void {
    if (agency.unclaimed) return
    throw new BusinessRuleError({
      code: 'agency.claimed_by_its_own_manager',
      message: `Agency ${agency.id} has an active manager of its own`,
      userMessage:
        'לסוכנות הזו יש מנהל משלה, ולכן פרטי הקשר שלה נערכים על ידה ולא על ידך. אפשר לעדכן את תנאי ההסכם שלך איתה.',
    })
  }

  /* -------------------------------------------------------------- create -- */

  /**
   * Create an agency, and the first agreement with it, together.
   *
   * The two are inseparable and the store makes that one database call: at the
   * moment of the INSERT the caller is neither a member of the agency nor a
   * party to an agreement with it, so `agencies_select` refuses the row —
   * and Postgres applies SELECT policies to `INSERT … RETURNING`, so the
   * insert *raises* rather than returning something invisible. Writing the two
   * rows sequentially from here would risk an agency no policy will ever show
   * and no role can delete. See `0070_agencies_write_path.sql`.
   */
  const create = defineOperation<CreateAgencyInput, null, { id: string }>({
    name: 'agency.create',
    permission: 'agency.manage',
    resourceType: 'agency',
    input: CREATE_INPUT,

    // Both grants, named separately. `agency.manage` gets the operation to
    // here; the agreement this also writes is policed by
    // `agent_agreement.manage`, which is in SENSITIVE_ACTIONS because it is the
    // price of every future sale. Refusing here with the *missing* grant's name
    // is the difference between an answer somebody can act on and "you cannot
    // create an agency".
    rule({ context, input }) {
      assertCan(
        context.actor,
        'agency.manage',
        agencyResource(context.actor.organizationId),
      )
      assertCan(
        context.actor,
        'agent_agreement.manage',
        agencyResource(context.actor.organizationId),
      )
      assertTermsCoherent(input)
    },

    async execute({ input, context, tx }) {
      return store.createAgency(
        {
          organizationId: context.actor.organizationId,
          contact: contactOf(input),
          terms: {
            rule: toCommissionRule(input.rule),
            base: input.base,
            activeFrom: input.activeFrom,
            paymentTermsDays: input.paymentTermsDays,
          },
        },
        tx,
      )
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        summary: `הקים את הסוכנות ${input.name} וחתם איתה הסכם ${describeRule(
          toCommissionRule(input.rule),
        )}.`,
        after: {
          name: input.name,
          base: input.base,
          paymentTermsDays: input.paymentTermsDays,
        },
      }
    },
  })

  /* --------------------------------------------------------- edit contact -- */

  const editContact = defineOperation<
    EditAgencyContactInput,
    AgencyRecord,
    { id: string; version: number }
  >({
    name: 'agency.edit_contact',
    permission: 'agency.manage',
    resourceType: 'agency',
    input: EDIT_INPUT,
    // `agencies.version` is owned by `tg_touch_row`. Two people correcting the
    // same phone number from two tabs must not have the later blank field win.
    requiresVersion: true,
    loadResource: loadAgency,

    rule({ entity }) {
      assertWritableByThisBusiness(entity)
    },

    async execute({ input, entity, version, tx }) {
      return store.saveContact(
        { agencyId: entity.id, contact: contactOf(input) },
        version ?? entity.version,
        tx,
      )
    },

    audit({ entity, input }) {
      return {
        resourceId: entity.id,
        summary: `עדכן את פרטי הסוכנות ${entity.name}.`,
        before: redactedContact(entity),
        after: redactedContact({ ...entity, ...contactOf(input) }),
      }
    },
  })

  /* ----------------------------------------------------------- set terms -- */

  /**
   * The commission the agency earns, written to the document and the resolver.
   *
   * `agent_agreement.manage` is in `SENSITIVE_ACTIONS`, so the pipeline demands
   * a stated reason without this file asking for one — which is right: "why did
   * our rate with this agency change in April" is the question the audit trail
   * exists to answer.
   */
  const setTerms = defineOperation<
    SetAgencyTermsInput,
    AgencyTermsTarget,
    { agreementId: string; ruleId: string }
  >({
    name: 'agency.set_terms',
    permission: 'agent_agreement.manage',
    resourceType: 'agency',
    input: TERMS_INPUT,
    requiresVersion: true,

    async loadResource({ input, context }) {
      const target = await store.loadTermsTarget(
        context.actor.organizationId,
        input.agencyId,
      )
      if (target === null) return null
      return {
        resource: agencyResource(context.actor.organizationId),
        entity: target,
        // The agreement's version, not the agency's: the agreement is the row
        // this operation edits, and locking against the wrong one would let two
        // people overwrite each other's rates while the check passed.
        version: target.agreement.version,
      }
    },

    rule({ entity, input }) {
      assertTermsCoherent(input)

      if (entity.agreement.status === 'terminated') {
        throw new BusinessRuleError({
          code: 'agency.agreement_is_over',
          message: `Agreement ${entity.agreement.id} is terminated`,
          userMessage:
            'ההסכם עם הסוכנות הזו הסתיים, ולכן אי אפשר לשנות את תנאיו. העמלות שנכתבו תחתיו עדיין חייבות. יש להחזיר את ההסכם לפעילות לפני עדכון תנאים.',
        })
      }
    },

    async execute({ input, entity, context, version, tx }) {
      return store.saveTerms(
        {
          organizationId: context.actor.organizationId,
          agencyId: entity.agency.id,
          agreementId: entity.agreement.id,
          existingRuleId: entity.defaultRuleId,
          rule: toCommissionRule(input.rule),
          base: input.base,
          eligibility: input.eligibility,
          activeFrom: input.activeFrom,
          activeUntil: input.activeUntil ?? null,
          paymentTermsDays: input.paymentTermsDays,
          note: input.note ?? null,
        },
        version ?? entity.agreement.version,
        tx,
      )
    },

    audit({ entity, input }) {
      return {
        resourceId: entity.agency.id,
        summary:
          `שינה את תנאי העמלה של ${entity.agency.name} ל־` +
          `${describeRule(toCommissionRule(input.rule))}, ` +
          `תשלום תוך ${input.paymentTermsDays} יום.`,
        before: {
          rule: entity.agreement.rule,
          base: entity.agreement.base,
          paymentTermsDays: entity.agreement.paymentTermsDays,
        },
        after: {
          rule: toCommissionRule(input.rule),
          base: input.base,
          eligibility: [...input.eligibility],
          paymentTermsDays: input.paymentTermsDays,
        },
      }
    },
  })

  /* ---------------------------------------------------------- deactivate -- */

  const deactivate = defineOperation<
    AgencyStatusInput,
    AgencyRecord,
    AgencyDeactivated
  >({
    name: 'agency.deactivate',
    permission: 'agency.manage',
    resourceType: 'agency',
    input: STATUS_INPUT,
    // `agency.manage` is not in SENSITIVE_ACTIONS, so this says so itself.
    // Ending a commercial relationship is exactly the act somebody reads about
    // six months later while working out why an agency stopped selling.
    requiresReason: true,
    loadResource: loadAgency,

    // No `requiresVersion`, deliberately. What this changes is the agreement,
    // whose id the caller does not hold, and both writes are guarded by the
    // status they are moving away from — so a second run ends nothing and
    // reports zero rather than overwriting a colleague's newer decision.
    rule({ entity }) {
      if (entity.status === 'inactive' && entity.liveAgreements === 0) {
        throw new BusinessRuleError({
          code: 'agency.already_inactive',
          message: `Agency ${entity.id} is already inactive with no live agreement`,
          userMessage:
            'הסוכנות כבר אינה פעילה ואין לך איתה הסכם בתוקף. הנימוק המקורי נשמר.',
        })
      }
    },

    async execute({ input, entity, context, tx }) {
      return store.deactivate(
        {
          agencyId: entity.id,
          organizationId: context.actor.organizationId,
          reason: input.reason.trim(),
        },
        tx,
      )
    },

    audit({ entity, input, result }) {
      return {
        resourceId: entity.id,
        summary: result.entityMarkedInactive
          ? `סיים את ההתקשרות עם ${entity.name} וסימן אותה כלא פעילה. נימוק: ${input.reason.trim()}`
          : `סיים את ההתקשרות עם ${entity.name} (${result.agreementsEnded} הסכמים). הסוכנות עצמה נותרה פעילה — עסק אחר עדיין עובד איתה או שיש לה מנהל משלה. נימוק: ${input.reason.trim()}`,
        before: { status: entity.status },
        after: {
          agreementsEnded: result.agreementsEnded,
          entityMarkedInactive: result.entityMarkedInactive,
        },
      }
    },
  })

  /* ---------------------------------------------------------- reactivate -- */

  /**
   * Undo a deactivation.
   *
   * Present because the alternative is a one-way door: deactivation ends the
   * agreement, and nothing else in this module signs one. An owner who pressed
   * the button on the wrong row would otherwise be permanently unable to work
   * with that agency again.
   *
   * It reopens the agreement this business most recently ended and clears the
   * agency's own deactivation stamp — `agencies_inactive_pair` in 0070 makes
   * the second unavoidable rather than optional, which is the point of writing
   * the constraint as an equality.
   */
  const reactivate = defineOperation<
    AgencyStatusInput,
    AgencyRecord,
    { agreementId: string }
  >({
    name: 'agency.reactivate',
    permission: 'agency.manage',
    resourceType: 'agency',
    input: STATUS_INPUT,
    requiresReason: true,
    loadResource: loadAgency,

    rule({ entity }) {
      if (entity.liveAgreements > 0) {
        // `agency_agreements_live_idx` is unique on (agency_id,
        // organization_id) where status = 'active'. Two live agreements would
        // be two commission rules for one sale with no principled way to
        // choose, which is why the index exists and why this is refused here
        // with a sentence instead of a constraint name.
        throw new BusinessRuleError({
          code: 'agency.already_live',
          message: `Agency ${entity.id} already has a live agreement`,
          userMessage: 'כבר יש לך הסכם בתוקף עם הסוכנות הזו.',
        })
      }
      if (entity.terminatedAgreements === 0) {
        throw new BusinessRuleError({
          code: 'agency.nothing_to_reopen',
          message: `Agency ${entity.id} has no terminated agreement with this organization`,
          userMessage: 'אין הסכם שהסתיים שאפשר להחזיר לתוקף.',
        })
      }
    },

    async execute({ entity, context, tx }) {
      return store.reactivate(
        {
          agencyId: entity.id,
          organizationId: context.actor.organizationId,
        },
        tx,
      )
    },

    audit({ entity, input }) {
      return {
        resourceId: entity.id,
        summary: `החזיר את ההתקשרות עם ${entity.name} לתוקף. נימוק: ${input.reason.trim()}`,
        before: { status: entity.status },
        after: { status: 'active' },
      }
    },
  })

  return { create, editContact, setTerms, deactivate, reactivate }
}

/* --------------------------------------------------------------- pieces -- */

function contactOf(input: AgencyContactInput): AgencyContactDraft {
  return {
    name: input.name,
    taxId: input.taxId ?? null,
    contactPhone: input.contactPhone ?? null,
    contactEmail: input.contactEmail ?? null,
    addressLine1: input.addressLine1 ?? null,
    city: input.city ?? null,
    country: (input.country ?? 'IL').toUpperCase(),
    note: input.note ?? null,
  }
}

/**
 * What goes in the audit trail's before/after for a contact edit.
 *
 * The address, the telephone number and the email are personal data —
 * `docs/PERSONAL_DATA_INVENTORY.md` lists this table for exactly those three —
 * and `audit_events` is append-only by trigger, so anything written there
 * cannot be erased for a deletion request. The trail records *that the contact
 * block changed* and the fields nobody would call personal; the values
 * themselves stay on the row, where they can still be corrected or cleared.
 */
function redactedContact(agency: {
  name: string
  taxId: string | null
  city: string | null
  country: string
  contactPhone: string | null
  contactEmail: string | null
  addressLine1: string | null
}): Record<string, unknown> {
  return {
    name: agency.name,
    taxId: agency.taxId,
    city: agency.city,
    country: agency.country,
    hasPhone: agency.contactPhone !== null,
    hasEmail: agency.contactEmail !== null,
    hasAddress: agency.addressLine1 !== null,
  }
}

/** Dates that describe a window, checked before either row is touched. */
function assertTermsCoherent(input: AgencyTermsInput): void {
  const until = input.activeUntil ?? null
  if (until !== null && until < input.activeFrom) {
    throw new BusinessRuleError({
      code: 'agency.agreement_ends_before_it_starts',
      message: `Agreement window ${input.activeFrom}..${until} is inverted`,
      userMessage: 'תאריך סיום ההסכם מוקדם מתאריך תחילתו.',
    })
  }
  // Builds the union, which is where a percentage with no percent is refused.
  toCommissionRule(input.rule)
}

/** The rule as a Hebrew phrase, for the audit sentence. */
export function describeRule(rule: CommissionRule): string {
  switch (rule.kind) {
    case 'none':
      return 'ללא עמלה'
    case 'percentage':
      return `${rule.percent}% עמלה`
    case 'fixed':
      return `עמלה קבועה של ₪${(rule.amountAgorot / 100).toLocaleString(
        'he-IL',
        {
          maximumFractionDigits: 2,
        },
      )}`
    case 'tiered':
      return `עמלה מדורגת ב-${rule.tiers.length} מדרגות`
  }
}
