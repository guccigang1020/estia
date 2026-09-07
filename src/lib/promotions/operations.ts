/**
 * EXECUTION CONTEXT — SERVER ONLY. What a person may do to a campaign.
 *
 * Four operations, and the shape of the list is the argument.
 *
 *   create  — declare a campaign
 *   pause   — stop offering it, with a reason that is stored
 *   issue   — cut a batch of coupons from it
 *   redeem  — spend one against a booking
 *
 * **There is no `delete` and there is no `edit` of the discount terms.** Not an
 * oversight: 0073 refuses `delete` and `truncate` to every role, for 0067's
 * reason and one more. A campaign explains a price. Delete the campaign and
 * the question "why did this guest pay ₪278 less in March" has no answer, and
 * it is a question an accountant asks in a year, not a week. Pausing leaves the
 * row and stamps who stopped it and when.
 *
 * Editing the terms is refused one level up, in the product: `update` here
 * changes the WINDOW, the CEILINGS and the PRIORITY — the levers a revenue
 * manager pulls — and never `discount_kind`, `discount_value` or `applies_to`.
 * A campaign whose percentage can be edited is a campaign that meant something
 * different last week, and §12's list of what the AI may not do says the same
 * thing in the other direction: changing a promotion's terms is changing a
 * commercial promise. A new promise is a new promotion.
 *
 * ── redeem is a database function, and that is the whole point ─────────────
 *
 * `redeem` calls `public.redeem_discount`. It does NOT read the ledger, count,
 * compare and insert — that sequence loses a race by construction, and no
 * amount of care in this file changes it. The counting happens inside a
 * SECURITY DEFINER function under a row lock, and the ordinal it allocates is
 * refused by a unique index if two callers ever compute the same one. See the
 * header of `0073_promotions_and_coupons.sql`.
 *
 * The consequence for this file: there is no `rule()` on `redeem` that checks
 * the limit. Writing one would suggest the limit is checked here, and the next
 * person to read it would believe that.
 */

import { BusinessRuleError } from '../errors'
import { clientFor, type Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import { isCouponCode, isPromotionCode } from './codes'
import { REDEMPTION_MESSAGES } from './labels'
import {
  NO_CONDITION,
  PROMOTION_APPLIES_TO,
  PROMOTION_DISCOUNT_KINDS,
  PROMOTION_KINDS,
} from './types'
import type {
  Promotion,
  PromotionAppliesTo,
  PromotionDiscountKind,
  PromotionKind,
} from './types'

/**
 * How many coupons one batch may cut.
 *
 * Two hundred, matching the operational fact rather than a technical one: a
 * batch is printed, put in an envelope and handed out at an event, and a
 * business that wants a thousand wants a bearer code instead. The ceiling also
 * bounds the blast radius of a mistyped quantity — §17's whole subject — since
 * every coupon in a batch is money the business has committed.
 */
export const MAX_COUPON_BATCH = 200

/**
 * A discount above this needs a second look on screen.
 *
 * Thirty percent, from §17: the classic error is 50 typed where 5 was meant,
 * and the validation ceiling of 100% does not catch it. Exported so the screen
 * and this module cannot disagree about where the line is.
 */
export const CONFIRMATION_THRESHOLD_BPS = 3_000

const CREATE_INPUT = s.object({
  code: s.string({ label: 'קוד המבצע', min: 2, max: 40 }),
  name: s.string({ label: 'שם המבצע', min: 2, max: 120 }),
  kind: s.enumOf(PROMOTION_KINDS, { label: 'סוג המבצע' }),
  discountKind: s.enumOf(PROMOTION_DISCOUNT_KINDS, { label: 'סוג ההנחה' }),
  // Not `s.agorot`: the number means basis points, agorot or nights depending
  // on the kind beside it, and the per-kind range is checked in `rule` where
  // both fields are in hand. A schema that guessed one meaning would reject
  // two of the three legitimate ones.
  discountValue: s.number({ label: 'ערך ההנחה', min: 1, integer: true }),
  appliesTo: s.enumOf(PROMOTION_APPLIES_TO, { label: 'חל על' }),
  stackable: s.boolean({ label: 'מצטבר' }),
  exclusiveGroup: s.optional(
    s.string({ label: 'קבוצת בלעדיות', min: 2, max: 40 }),
  ),
  priority: s.number({ label: 'עדיפות', min: 0, max: 1000, integer: true }),
  maxRedemptions: s.optional(
    s.number({ label: 'מספר מימושים מרבי', min: 1, integer: true }),
  ),
  maxPerGuest: s.optional(
    s.number({ label: 'מימושים לכל אורח', min: 1, integer: true }),
  ),
  budgetAgorot: s.optional(s.agorot({ label: 'תקציב ההנחה' })),
  effectiveFrom: s.isoDateTime({ label: 'תחילת תוקף' }),
  effectiveTo: s.optional(s.isoDateTime({ label: 'סיום תוקף' })),
})

export interface CreatePromotionInput {
  code: string
  name: string
  kind: PromotionKind
  discountKind: PromotionDiscountKind
  discountValue: number
  appliesTo: PromotionAppliesTo
  stackable: boolean
  exclusiveGroup?: string
  priority: number
  maxRedemptions?: number
  maxPerGuest?: number
  budgetAgorot?: number
  effectiveFrom: Date
  effectiveTo?: Date
}

const PAUSE_INPUT = s.object({
  promotionId: s.uuid({ label: 'מבצע' }),
  // Eight characters, the same floor `review.hide` uses and for the same
  // reason: a one-character reason is a checkbox with extra steps, and the
  // whole value of storing it is that somebody reads it later and judges.
  reason: s.string({ label: 'נימוק', min: 8, max: 500 }),
})

const ISSUE_INPUT = s.object({
  promotionId: s.uuid({ label: 'מבצע' }),
  codes: s.arrayOf(s.string({ label: 'קוד קופון', min: 4, max: 24 }), {
    label: 'קודי הקופונים',
    min: 1,
    max: MAX_COUPON_BATCH,
  }),
  issuedToGuestId: s.optional(s.uuid({ label: 'אורח' })),
  singleUse: s.boolean({ label: 'חד־פעמי' }),
  expiresAt: s.optional(s.isoDateTime({ label: 'פג תוקף' })),
})

export interface IssueCouponsInput {
  promotionId: string
  codes: readonly string[]
  issuedToGuestId?: string
  singleUse: boolean
  expiresAt?: Date
}

const REDEEM_INPUT = s.object({
  bookingId: s.uuid({ label: 'הזמנה' }),
  propertyId: s.uuid({ label: 'נכס' }),
  amountAgorot: s.number({ label: 'סכום ההנחה', min: 1, integer: true }),
  promotionId: s.optional(s.uuid({ label: 'מבצע' })),
  couponId: s.optional(s.uuid({ label: 'קופון' })),
  guestId: s.optional(s.uuid({ label: 'אורח' })),
  priceLineId: s.optional(s.uuid({ label: 'שורת מחיר' })),
})

export interface RedeemInput {
  bookingId: string
  propertyId: string
  amountAgorot: number
  promotionId?: string
  couponId?: string
  guestId?: string
  priceLineId?: string
}

export interface PromotionOperations {
  create: Operation<CreatePromotionInput, null, { id: string }>
  pause: Operation<
    { promotionId: string; reason: string },
    Promotion,
    { id: string }
  >
  issue: Operation<IssueCouponsInput, Promotion, { issued: number }>
  redeem: Operation<RedeemInput, null, { id: string }>
}

/**
 * The per-kind range for `discountValue`.
 *
 * §8, and it has to live where both fields are visible: 500 is 5% as bps, five
 * agorot as a fixed amount and five nights as free nights, and no single range
 * is right for all three.
 */
function assertDiscountValue(
  discountKind: PromotionDiscountKind,
  discountValue: number,
): void {
  const limits: Record<PromotionDiscountKind, [number, number, string]> = {
    // 1 bps to 100%. Above 100% is a refund, and §6 rule 23 says a price
    // calculator does not invent refunds.
    percent: [1, 10_000, 'אחוז ההנחה חייב להיות בין 0.01% ל-100%.'],
    // No ceiling in agorot: a ₪5,000 voucher is a real thing a business
    // issues, and §6 rule 23 clamps it against the stay rather than here.
    fixed: [
      1,
      Number.MAX_SAFE_INTEGER,
      'סכום ההנחה חייב להיות לפחות אגורה אחת.',
    ],
    free_nights: [1, 365, 'מספר הלילות החינם חייב להיות בין 1 ל-365.'],
  }
  const [min, max, userMessage] = limits[discountKind]
  if (discountValue < min || discountValue > max) {
    throw new BusinessRuleError({
      code: 'promotion_discount_value_out_of_range',
      message: `discount_value ${discountValue} is outside ${min}..${max} for ${discountKind}`,
      userMessage,
    })
  }
}

export function definePromotionOperations(options: {
  db: Db
  loadPromotion: (
    organizationId: string,
    id: string,
  ) => Promise<Promotion | null>
}): PromotionOperations {
  const loadPromotionResource = async ({
    input,
    context,
  }: {
    input: { promotionId: string }
    context: { actor: { organizationId: string } }
  }) => {
    const promotion = await options.loadPromotion(
      context.actor.organizationId,
      input.promotionId,
    )
    if (promotion === null) return null
    // A campaign has no property — §3.5 scopes it to the organization — so the
    // resource names only the tenant. That is not a gap in the check: it is
    // the shape of the thing being checked, and inventing a property here
    // would narrow a campaign to somewhere it does not live.
    return {
      resource: { organizationId: context.actor.organizationId },
      entity: promotion,
    }
  }

  /* ----------------------------------------------------------- creating -- */

  const create = defineOperation<CreatePromotionInput, null, { id: string }>({
    name: 'promotion.create',
    permission: 'pricing.manage',
    resourceType: 'promotion',
    input: CREATE_INPUT,

    rule({ input }) {
      if (!isPromotionCode(input.code)) {
        throw new BusinessRuleError({
          code: 'promotion_code_shape',
          message: `promotion code ${input.code} is not a machine identifier`,
          userMessage:
            'הקוד יכול להכיל אותיות אנגליות קטנות, ספרות, מקף וקו תחתון.',
        })
      }
      assertDiscountValue(input.discountKind, input.discountValue)

      if (
        input.effectiveTo !== undefined &&
        input.effectiveTo.getTime() <= input.effectiveFrom.getTime()
      ) {
        throw new BusinessRuleError({
          code: 'promotion_window_ordered',
          message: 'effective_to must be after effective_from',
          userMessage: 'תאריך הסיום חייב להיות אחרי תאריך ההתחלה.',
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      const { data, error } = await db
        .from('promotions')
        .insert({
          organization_id: context.actor.organizationId,
          // As typed. `code_folded` is generated by the database and carries
          // the unique index — see `codes.ts`.
          code: input.code.trim(),
          name: input.name.trim(),
          kind: input.kind,
          // A campaign is created with no condition and gains them by editing.
          // Building a condition tree and a campaign in one form is how people
          // save a half-written rule that gives money away.
          conditions: NO_CONDITION,
          discount_kind: input.discountKind,
          discount_value: input.discountValue,
          applies_to: input.appliesTo,
          stackable: input.stackable,
          exclusive_group: input.exclusiveGroup ?? null,
          priority: input.priority,
          max_redemptions: input.maxRedemptions ?? null,
          max_per_guest: input.maxPerGuest ?? null,
          budget_agorot: input.budgetAgorot ?? null,
          effective_from: input.effectiveFrom.toISOString(),
          effective_to: input.effectiveTo?.toISOString() ?? null,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id')
        .single()

      if (error) {
        // 23505 on this table means exactly one thing: the folded code is
        // taken. Naming the code is more use than naming the constraint, and
        // it also tells the reader that case does not distinguish two codes.
        if ((error as { code?: string }).code === '23505') {
          throw new BusinessRuleError({
            code: 'promotion_code_taken',
            message: `promotion code ${input.code} already exists`,
            userMessage: `כבר קיים מבצע עם הקוד ${input.code}. הקוד אינו תלוי באותיות גדולות או קטנות.`,
          })
        }
        throw error
      }

      return { id: String((data as { id: string }).id) }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        summary: `יצר מבצע '${input.name}' (${input.code}).`,
        after: {
          code: input.code,
          discountKind: input.discountKind,
          discountValue: input.discountValue,
          maxRedemptions: input.maxRedemptions ?? null,
          budgetAgorot: input.budgetAgorot ?? null,
        },
      }
    },
  })

  /* -------------------------------------------------------------- pausing -- */

  const pause = defineOperation<
    { promotionId: string; reason: string },
    Promotion,
    { id: string }
  >({
    name: 'promotion.pause',
    permission: 'pricing.manage',
    resourceType: 'promotion',
    input: PAUSE_INPUT,
    loadResource: loadPromotionResource,

    rule({ entity }) {
      if (!entity.isActive) {
        // Pausing twice is not worth an error in itself, but it must not
        // overwrite the first reason with a second one — especially when the
        // first was `max_redemptions_reached`, written by the database. That
        // sentence is the record of why a campaign stopped selling.
        throw new BusinessRuleError({
          code: 'promotion_already_paused',
          message: `promotion ${entity.id} is already paused`,
          userMessage: 'המבצע כבר מושהה, והנימוק המקורי נשמר.',
        })
      }
    },

    async execute({ input, context, tx, now }) {
      const db = clientFor(tx, options.db)

      const { error } = await db
        .from('promotions')
        .update({
          is_active: false,
          deactivated_at: now.toISOString(),
          deactivated_by: context.actor.userId,
          deactivation_reason: input.reason,
          updated_by: context.actor.userId,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', input.promotionId)

      if (error) throw error
      return { id: input.promotionId }
    },

    audit({ entity, input }) {
      return {
        resourceId: entity.id,
        summary: `השהה את המבצע '${entity.name}'. נימוק: ${input.reason}`,
        before: { isActive: true },
        after: { isActive: false, reason: input.reason },
      }
    },
  })

  /* --------------------------------------------------------------- issuing -- */

  const issue = defineOperation<
    IssueCouponsInput,
    Promotion,
    { issued: number }
  >({
    name: 'coupon.issue',
    permission: 'pricing.manage',
    resourceType: 'promotion',
    input: ISSUE_INPUT,
    loadResource: loadPromotionResource,

    rule({ input, entity }) {
      if (!entity.isActive) {
        throw new BusinessRuleError({
          code: 'promotion_not_active',
          message: `promotion ${entity.id} is paused`,
          userMessage: 'לא ניתן להנפיק קופונים ממבצע מושהה.',
        })
      }

      const bad = input.codes.find((code) => !isCouponCode(code))
      if (bad !== undefined) {
        throw new BusinessRuleError({
          code: 'coupon_code_shape',
          message: `coupon code ${bad} is not a typeable code`,
          userMessage:
            'קוד קופון מכיל אותיות אנגליות, ספרות ומקפים בלבד, באורך 4 עד 24 תווים.',
        })
      }

      // Duplicates within the batch itself, folded. The database would
      // refuse them one at a time, but the batch is a single insert and the
      // refusal would name a constraint rather than the two codes that
      // collided — and it would fail after the rest had been prepared.
      const seen = new Set<string>()
      for (const code of input.codes) {
        const folded = code.trim().toUpperCase()
        if (seen.has(folded)) {
          throw new BusinessRuleError({
            code: 'coupon_code_repeated',
            message: `coupon code ${code} appears twice in one batch`,
            userMessage: `הקוד ${code} מופיע פעמיים באותה אצווה. קוד אינו תלוי באותיות גדולות או קטנות.`,
          })
        }
        seen.add(folded)
      }
    },

    async execute({ input, entity, context, tx }) {
      const db = clientFor(tx, options.db)

      const { error } = await db.from('coupons').insert(
        input.codes.map((code) => ({
          organization_id: context.actor.organizationId,
          promotion_id: entity.id,
          code: code.trim(),
          issued_to_guest_id: input.issuedToGuestId ?? null,
          // COPIED, not inherited. A campaign whose percentage is edited
          // next month must not change what a card handed out today is
          // worth — the freezing law, one level above a booking.
          discount_kind: entity.discountKind,
          discount_value: entity.discountValue,
          applies_to: entity.appliesTo,
          conditions: entity.conditions,
          single_use: input.singleUse,
          // `single_use` implies exactly one — the CHECK in 0073 refuses any
          // other pairing, and this is the one place that decides the pair.
          max_redemptions: input.singleUse ? 1 : (entity.maxRedemptions ?? 1),
          max_per_guest: entity.maxPerGuest,
          budget_agorot: null,
          effective_from: entity.effectiveFrom,
          effective_to: entity.effectiveTo,
          expires_at: input.expiresAt?.toISOString() ?? null,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })),
      )

      if (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new BusinessRuleError({
            code: 'coupon_code_taken',
            message: 'a coupon code in this batch already exists',
            userMessage:
              'אחד הקודים באצווה כבר קיים. אף קופון לא הונפק — יש לתקן ולנסות שוב.',
          })
        }
        throw error
      }

      return { issued: input.codes.length }
    },

    audit({ entity, result }) {
      return {
        resourceId: entity.id,
        summary: `הנפיק ${result.issued} קופונים מהמבצע '${entity.name}'.`,
        after: { promotionCode: entity.code, issued: result.issued },
      }
    },
  })

  /* ------------------------------------------------------------ redeeming -- */

  const redeem = defineOperation<RedeemInput, null, { id: string }>({
    name: 'promotion.redeem',
    // Redeeming happens while a booking is being taken, by whoever is taking
    // it. `pricing.manage` would put every reservation behind the revenue
    // manager; `redeem_discount` asks for the same grant inside itself, which
    // is the floor that survives this one being wrong.
    permission: 'booking.create',
    resourceType: 'promotion',
    input: REDEEM_INPUT,

    async loadResource({ input, context }) {
      // The property, so the authorization scope is the booking's and not the
      // whole organization's. A manager confined to two properties must not be
      // able to spend a campaign against a third by knowing a booking id.
      return {
        resource: {
          organizationId: context.actor.organizationId,
          propertyId: input.propertyId,
        },
        entity: null,
      }
    },

    rule({ input }) {
      const named = [input.promotionId, input.couponId].filter(
        (value) => value !== undefined,
      )
      if (named.length !== 1) {
        throw new BusinessRuleError({
          code: 'redemption_one_subject',
          message: 'a redemption names exactly one promotion or one coupon',
          userMessage: 'יש לבחור מבצע אחד או קופון אחד, לא שניהם ולא אף אחד.',
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      // The ceiling is NOT checked here. See this file's header: counting in
      // TypeScript loses the race by construction. `redeem_discount` allocates
      // the ordinal under a row lock and a unique index refuses a repeat.
      const { data, error } = await db.rpc('redeem_discount', {
        p_organization_id: context.actor.organizationId,
        p_booking_id: input.bookingId,
        p_property_id: input.propertyId,
        p_amount_agorot: input.amountAgorot,
        p_terms: {},
        p_promotion_id: input.promotionId ?? null,
        p_coupon_id: input.couponId ?? null,
        p_guest_id: input.guestId ?? null,
        p_price_line_id: input.priceLineId ?? null,
      })

      if (error) throw redemptionError(error)
      return { id: String(data) }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        // §14 words this as the money, because that is what a person reading
        // the trail wants: "הנחה ₪278", not "redemption 4f2a".
        summary: `מימש הנחה של ₪${(input.amountAgorot / 100).toLocaleString('he-IL')} בהזמנה.`,
        after: {
          bookingId: input.bookingId,
          promotionId: input.promotionId ?? null,
          couponId: input.couponId ?? null,
          amountAgorot: input.amountAgorot,
        },
      }
    },
  })

  return { create, pause, issue, redeem }
}

/**
 * The database's refusal, said in Hebrew.
 *
 * `redeem_discount` raises with a SQLSTATE chosen for what happened, so the
 * translation is a lookup rather than string matching on a message. 23505 —
 * the ordinal was taken, or the count was already at the ceiling — becomes ONE
 * phrase for both, because to the person holding the phone they are the same
 * event: the code is spent.
 */
function redemptionError(error: unknown): Error {
  const code = (error as { code?: string }).code
  const message = String((error as { message?: string }).message ?? '')

  if (code === '23505') {
    return new BusinessRuleError({
      code: 'discount_already_redeemed',
      message: message || 'the redemption ordinal was taken',
      userMessage: REDEMPTION_MESSAGES.alreadyRedeemed,
    })
  }
  if (code === 'P0002') {
    return new BusinessRuleError({
      code: 'discount_not_found',
      message: message || 'no such promotion or coupon',
      userMessage: REDEMPTION_MESSAGES.notFound,
    })
  }
  if (code === '23514') {
    // Three refusals share this code: paused, out of window, budget spent. The
    // function's message says which, and it is the only thing that can — so it
    // is read here rather than duplicating the three tests in TypeScript,
    // where they would be a second opinion that can disagree with the first.
    if (message.includes('budget')) {
      return new BusinessRuleError({
        code: 'discount_budget_spent',
        message,
        userMessage: REDEMPTION_MESSAGES.budgetSpent,
      })
    }
    if (message.includes('window')) {
      return new BusinessRuleError({
        code: 'discount_outside_window',
        message,
        userMessage: REDEMPTION_MESSAGES.outsideWindow,
      })
    }
    return new BusinessRuleError({
      code: 'discount_inactive',
      message,
      userMessage: REDEMPTION_MESSAGES.inactive,
    })
  }
  if (code === '22023') {
    return new BusinessRuleError({
      code: 'discount_guest_required',
      message,
      userMessage: REDEMPTION_MESSAGES.guestUnknown,
    })
  }
  // Anything else — 42501 above all — is not a business rule. It is an
  // authorization failure or a bug, and dressing it as "the coupon is spent"
  // would send somebody looking in the wrong place.
  return error as Error
}
