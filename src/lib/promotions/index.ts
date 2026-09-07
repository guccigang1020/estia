/**
 * Promotions and coupons, in one import.
 *
 * The contract in `types.ts` is re-exported alongside the logic so that a
 * caller needs one path, matching `src/lib/booking/index.ts`.
 *
 * `repository.ts` and `operations.ts` are NOT re-exported here, and that is
 * deliberate: both are server-only — one holds a Supabase client, the other
 * writes through the operation pipeline — and a screen that imported them from
 * a barrel would pull a database client into a bundle that must not have one.
 * They are imported by their own path, which is where a reviewer notices.
 */

export * from './types'

export {
  codesMatch,
  foldCode,
  isCouponCode,
  isPromotionCode,
  COUPON_CODE_PATTERN,
  PROMOTION_CODE_PATTERN,
} from './codes'

export {
  evaluateCondition,
  MAX_CONDITION_DEPTH,
  type ConditionFailure,
  type ConditionResult,
} from './conditions'

export {
  discountAgorot,
  toDiscountRequest,
  type DiscountAmount,
  type DiscountBase,
} from './discount'

export {
  assessCoupon,
  isLive,
  selectPromotions,
  type IneligibleReason,
  type PromotionSelection,
  type RejectedPromotion,
  type SelectedPromotion,
} from './select'

export {
  APPLIES_TO_LABEL,
  DISCOUNT_KIND_LABEL,
  PROMOTION_KIND_LABEL,
  REDEMPTION_MESSAGES,
  describeConditionFailure,
  describeDiscount,
  describeIneligible,
} from './labels'
