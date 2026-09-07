/**
 * Promotions and coupons — the contract.
 *
 * A promotion is a commercial campaign: who qualifies, what they get, and how
 * much of it the business is willing to give away. A coupon is one issued
 * instance of a campaign, with its terms **copied** rather than inherited —
 * because a card handed to a guest in March must still be worth what it said
 * when the campaign is edited in April.
 *
 * ── What this module is not ────────────────────────────────────────────────
 *
 * It is not a price. `priceStay` in `src/lib/booking/pricing.ts` is the only
 * thing in ESTIA that produces money and lines, and nothing here duplicates
 * it. This module decides **which discounts apply and what they are worth**,
 * and hands `priceStay` a `DiscountRequest` — the same division
 * `docs/spec/20-pricing.md` §7.1 draws for the rate engine: the resolver
 * produces input, `priceStay` produces the number.
 *
 * The consequence worth stating: there is no rounding in this file, and only
 * one in the module — `discount.ts`, using `roundAgorot` from
 * `booking/pricing.ts`. A second definition of rounding is how a total stops
 * equalling the sum of its lines.
 */

import type { BookingSource } from '../booking/types'
import type { FactBasis } from '../preparation/types'

// ── The vocabularies ──────────────────────────────────────────────────────
// Transcribed from `promotion_kind`, `promotion_discount_kind` and
// `promotion_applies_to` in `0073_promotions_and_coupons.sql`, in the same
// order. A value here that the enum does not carry is a row that cannot be
// written, so the two lists are one list kept in two places.

export const PROMOTION_KINDS = [
  'early_bird',
  'last_minute',
  'midweek',
  'long_stay',
  'repeat_guest',
  'direct_booking',
  'agent_campaign',
] as const

export type PromotionKind = (typeof PROMOTION_KINDS)[number]

export const PROMOTION_DISCOUNT_KINDS = [
  /** `discountValue` is basis points. 500 = 5%. */
  'percent',
  /** `discountValue` is agorot. */
  'fixed',
  /** `discountValue` is a whole number of nights. */
  'free_nights',
] as const

export type PromotionDiscountKind = (typeof PROMOTION_DISCOUNT_KINDS)[number]

/**
 * What the discount is taken off.
 *
 * Never VAT, and never the security deposit — §6 rule 32. The first is not the
 * business's money to discount and the second is the guest's own, held.
 */
export const PROMOTION_APPLIES_TO = [
  'stay_total',
  'accommodation_only',
] as const

export type PromotionAppliesTo = (typeof PROMOTION_APPLIES_TO)[number]

/**
 * Basis points, not a fraction.
 *
 * The same argument as `properties.tax_rate_bps`: a rate stored as `0.05`
 * eventually produces an invoice that does not add up. Ten thousand bps is
 * 100%, and §6 rule 23 is why nothing may exceed it — a discount larger than
 * the thing discounted is a refund, and a price calculator does not invent
 * refunds.
 */
export const BPS_PER_UNIT = 10_000

// ── The condition language ────────────────────────────────────────────────
// §7.6, closed on purpose. Six shapes, and what they cannot express is a
// SECOND PROMOTION rather than a bigger grammar — the same argument as
// `QuantityExpression` in `preparation/types.ts`. A condition language that
// grows to fit every campaign becomes a program stored in a column, deciding
// what customers pay, that nobody can audit.

export const CONDITION_COMPARATORS = ['lt', 'lte', 'eq', 'gte', 'gt'] as const

export type ConditionComparator = (typeof CONDITION_COMPARATORS)[number]

/** `nights >= 5`. `basis` is shared with the preparation rules deliberately. */
export interface CompareCondition {
  kind: 'compare'
  basis: FactBasis
  comparator: ConditionComparator
  value: number
}

/**
 * `advance_days >= 90` — early bird, and last minute with the comparator
 * turned round.
 *
 * §6 rule 36: measured from the day the booking was CREATED, in the property's
 * local time, and never from `now()`. Measured from now, an early-bird
 * discount would evaporate the first time the booking was repriced.
 */
export interface AdvanceCondition {
  kind: 'advance'
  comparator: ConditionComparator
  days: number
}

/** Every night of the stay falls on one of these weekdays. 0 = Sunday. */
export interface WeekdaySetCondition {
  kind: 'weekday_set'
  allOf: readonly number[]
}

export interface SourceCondition {
  kind: 'source'
  anyOf: readonly BookingSource[]
}

/**
 * §6 rule 35: completed stays **within this organization**. A guest who
 * returns to a different business is not a returning guest here, and counting
 * them as one would be a discount funded by somebody else's hospitality.
 */
export interface GuestHistoryCondition {
  kind: 'guest_history'
  minCompletedBookings: number
}

export interface AllCondition {
  kind: 'all'
  of: readonly PromotionCondition[]
}

export interface AnyCondition {
  kind: 'any'
  of: readonly PromotionCondition[]
}

export interface NotCondition {
  kind: 'not'
  of: PromotionCondition
}

export type PromotionCondition =
  | CompareCondition
  | AdvanceCondition
  | WeekdaySetCondition
  | SourceCondition
  | GuestHistoryCondition
  | AllCondition
  | AnyCondition
  | NotCondition

/**
 * The empty conjunction: a campaign with nothing to test.
 *
 * A real and common shape — a flat 5% off direct bookings has no condition
 * beyond the channel, and often not even that. Spelled as an empty `all`
 * rather than as `null` so that every reader of the column receives the same
 * shape and nobody writes a null check that a second reader forgets.
 */
export const NO_CONDITION: AllCondition = { kind: 'all', of: [] }

// ── The facts a condition is evaluated against ────────────────────────────

/**
 * What is known about the booking being priced.
 *
 * **Every field is nullable, and that is the design.** A fact that was not
 * measured is absent, not zero — `nights: 0` and "we did not count the nights"
 * are different statements, and only the first should make a long-stay
 * discount fail. `evaluateCondition` fails CLOSED on an absent fact: the
 * condition is not met, and the promotion is not applied. The opposite default
 * gives money away on missing data, which is the one failure mode a discount
 * engine must not have.
 */
export interface PromotionFacts {
  /**
   * The measured quantities, by basis. A basis absent from the record is
   * absent — never defaulted. `booking` is always 1 where it is known, which
   * is what lets "per booking" be ordinary arithmetic.
   */
  measures: Readonly<Partial<Record<FactBasis, number>>>
  /** Days between the booking's creation day and check-in, in local time. */
  advanceDays: number | null
  /** The weekday of every night in the stay. 0 = Sunday. */
  nightWeekdays: readonly number[] | null
  source: BookingSource | null
  /** Completed stays this guest has had with THIS organization. */
  completedBookings: number | null
}

// ── The rows ──────────────────────────────────────────────────────────────

/** The three columns that decide what a discount is worth. */
export interface DiscountTerms {
  discountKind: PromotionDiscountKind
  discountValue: number
  appliesTo: PromotionAppliesTo
}

export interface Promotion extends DiscountTerms {
  id: string
  organizationId: string
  /** As typed. Compared folded — see `codes.ts`. */
  code: string
  name: string
  kind: PromotionKind
  conditions: PromotionCondition
  /** §7.9: a non-stackable campaign that is chosen ends the list. */
  stackable: boolean
  /** Two campaigns in one group never appear on the same booking. */
  exclusiveGroup: string | null
  priority: number
  /** Null is no limit. Never zero — zero is a campaign that cannot fire. */
  maxRedemptions: number | null
  maxPerGuest: number | null
  budgetAgorot: number | null
  /** Instants, not dates: a campaign ends at midnight, and midnight is a moment. */
  effectiveFrom: string
  effectiveTo: string | null
  isActive: boolean
  deactivatedAt: string | null
  deactivationReason: string | null
  version: number
}

/**
 * One issued instance of a campaign.
 *
 * No `kind`, `stackable`, `exclusiveGroup` or `priority`: those four exist to
 * order campaigns against each other in §7.9, and §6 rule 30 says a coupon is
 * a separate axis applied after them, at most one per booking. A coupon never
 * enters that ordering, so columns describing its place in it would be columns
 * nothing could read.
 */
export interface Coupon extends DiscountTerms {
  id: string
  organizationId: string
  promotionId: string
  code: string
  issuedToGuestId: string | null
  conditions: PromotionCondition
  singleUse: boolean
  maxRedemptions: number
  maxPerGuest: number | null
  budgetAgorot: number | null
  effectiveFrom: string
  effectiveTo: string | null
  /** When this card stops working — a different fact from the campaign window. */
  expiresAt: string | null
  isActive: boolean
  deactivatedAt: string | null
  deactivationReason: string | null
  version: number
}

/**
 * One act of giving money away.
 *
 * `terms` is a copy and not a pointer, for the reason `FinanceSnapshot.lines`
 * gives in `finance/snapshot.ts`: a pointer survives only as long as nobody
 * edits or renumbers the thing it points at, and both happen.
 */
export interface DiscountRedemption {
  id: string
  organizationId: string
  propertyId: string
  bookingId: string
  promotionId: string | null
  couponId: string | null
  guestId: string | null
  redemptionIndex: number
  /** Positive. The same money is negative on `booking_price_lines`. */
  amountAgorot: number
  terms: DiscountTerms & { code: string; name: string }
  priceLineId: string | null
  redeemedAt: string
}
