/**
 * The Hebrew every store screen reads from.
 *
 * One table per frozen vocabulary, and every table is a
 * `Record<TheUnion, string>` rather than a lookup with a fallback. That is the
 * point: TypeScript refuses a record that is missing a member, so adding a
 * status to `src/lib/contracts/states.ts` makes this file fail to compile
 * rather than making one screen render a raw English enum value at a customer.
 *
 * Labels live here and not beside each screen because the same status appears
 * on the order list, the order detail, the guest portal and the dashboard, and
 * four copies of "ממתין לאישור" is four chances for one of them to say
 * something slightly different about the same row.
 */

import type {
  StoreFulfilmentKind,
  StoreItemStatus,
  StoreItemType,
  StoreOrderStatus,
  StorePaymentMode,
  StorePaymentStatus,
  StorePricingModel,
  StoreVisibilityRule,
} from '../contracts/states'
import type { EligibilityCaveat } from './eligibility'
import type { OrderAttention } from './orders'
import type { StoreOrderSource, StorePriceSource } from './types'

export const STORE_ITEM_TYPE_LABEL: Record<StoreItemType, string> = {
  physical: 'מוצר',
  service: 'שירות',
  experience: 'חוויה',
  property_addon: 'תוספת לנכס',
  package: 'חבילה',
  custom: 'אחר',
}

export const STORE_ITEM_STATUS_LABEL: Record<StoreItemStatus, string> = {
  draft: 'טיוטה',
  active: 'פעיל',
  paused: 'מושהה',
  archived: 'בארכיון',
}

/**
 * How a price is stated to a person.
 *
 * `starting_from` and `quote` are the two that matter: both are honest answers
 * and both must read as such rather than as a missing number.
 */
export const STORE_PRICING_MODEL_LABEL: Record<StorePricingModel, string> = {
  fixed: 'מחיר קבוע',
  per_guest: 'לאורח',
  per_child: 'לילד',
  per_night: 'ללילה',
  per_hour: 'לשעה',
  per_unit: 'ליחידה',
  starting_from: 'החל מ־',
  quote: 'לפי הצעת מחיר',
}

/** The suffix beside a number: "₪1,500 לאורח". Empty where none is right. */
export const STORE_PRICING_SUFFIX: Record<StorePricingModel, string> = {
  fixed: '',
  per_guest: 'לאורח',
  per_child: 'לילד',
  per_night: 'ללילה',
  per_hour: 'לשעה',
  per_unit: 'ליחידה',
  starting_from: '',
  quote: '',
}

export const STORE_ORDER_STATUS_LABEL: Record<StoreOrderStatus, string> = {
  draft: 'טיוטה',
  pending: 'התקבלה',
  awaiting_approval: 'ממתינה לאישור',
  awaiting_payment: 'ממתינה לתשלום',
  confirmed: 'מאושרת',
  in_preparation: 'בהכנה',
  ready: 'מוכנה',
  fulfilled: 'בוצעה',
  completed: 'הושלמה',
  cancelled: 'בוטלה',
  refunded: 'הוחזר תשלום',
}

export const STORE_PAYMENT_STATUS_LABEL: Record<StorePaymentStatus, string> = {
  unpaid: 'לא שולם',
  pending_verification: 'ממתין לאימות',
  partially_paid: 'שולם חלקית',
  paid: 'שולם',
  refunded: 'הוחזר',
}

export const STORE_PAYMENT_MODE_LABEL: Record<StorePaymentMode, string> = {
  with_booking: 'מתווסף לחשבון השהות',
  pay_now: 'תשלום מקוון',
  manual: 'העברה, ביט או פייבוקס',
  on_arrival: 'תשלום בהגעה',
  pay_later: 'תשלום בהמשך',
  approval_first: 'אישור לפני תשלום',
  custom: 'סידור אחר',
}

/** What the owner reads when choosing a mode. One line each, no jargon. */
export const STORE_PAYMENT_MODE_SUMMARY: Record<StorePaymentMode, string> = {
  with_booking:
    'הסכום מצטרף ליתרת ההזמנה. זו ברירת המחדל, והיא אינה דורשת ספק תשלומים.',
  pay_now: 'האורח משלם מיד בכרטיס. דורש ספק תשלומים פעיל.',
  manual: 'שולחים לאורח פרטי תשלום, ומסמנים כשקיבלתם.',
  on_arrival: 'משלמים במקום, בהגעה.',
  pay_later: 'סוגרים את התשלום בהמשך, בלי לחייב את האורח עכשיו.',
  approval_first: 'קודם מאשרים שאפשר לספק, ורק אחר כך מדברים על כסף.',
  custom: 'סידור שסוכם מול האורח.',
}

export const STORE_FULFILMENT_KIND_LABEL: Record<StoreFulfilmentKind, string> =
  {
    none: 'ללא פעולה תפעולית',
    staff_task: 'משימה לצוות',
    external_provider: 'ספק חיצוני',
    inventory: 'מתוך המלאי',
    custom: 'מותאם',
  }

export const STORE_VISIBILITY_RULE_LABEL: Record<StoreVisibilityRule, string> =
  {
    always: 'תמיד',
    after_confirmation: 'אחרי אישור ההזמנה',
    after_payment: 'אחרי התשלום',
    days_before_arrival: 'מספר ימים לפני ההגעה',
    during_stay: 'במהלך השהות',
  }

export const STORE_ORDER_SOURCE_LABEL: Record<StoreOrderSource, string> = {
  guest_portal: 'האורח, מהפורטל',
  staff: 'הצוות',
  automation: 'אוטומציה',
}

/**
 * Where a line's price came from.
 *
 * Shown on the order detail, because a figure whose provenance is unknown is a
 * figure nobody can defend in an argument three weeks later.
 */
export const STORE_PRICE_SOURCE_LABEL: Record<StorePriceSource, string> = {
  catalogue: 'מחיר הקטלוג בזמן ההזמנה',
  override: 'מחיר שנקבע לנכס הזה',
  manual: 'מחיר שנרשם ידנית',
  quote: 'מחיר שסוכם בהצעה',
}

export const ORDER_ATTENTION_LABEL: Record<OrderAttention, string> = {
  awaiting_approval: 'ממתינה לאישורך',
  awaiting_payment: 'ממתינה לתשלום',
  awaiting_provider: 'הספק טרם אישר',
  overdue: 'עבר המועד',
  ready_to_fulfil: 'מוכנה לביצוע',
  none: '',
}

/**
 * What the guest is told when the product is offered but something is not
 * known.
 *
 * These exist because the null occupancy port answers "unknown" — see
 * `eligibility.ts`. Saying so is the honest middle between hiding a product an
 * owner can sell and promising one the calendar has not confirmed.
 */
export const ELIGIBILITY_CAVEAT_LABEL: Record<EligibilityCaveat, string> = {
  occupancy_unknown: 'נאשר מול לוח ההגעות ונחזור אליך.',
  cleaning_unknown: 'נתאם מול צוות הניקיון ונעדכן.',
  capacity_unknown: 'נוודא זמינות ונאשר.',
}

/**
 * The Hebrew for one price, given its model.
 *
 * The formatting of the number itself belongs to `formatAgorot` in
 * `src/lib/plans/plan.ts` — the product's one ₪ formatter — and this function
 * takes the already-formatted string so that nothing here divides by a hundred.
 */
export function priceCaption(
  model: StorePricingModel,
  formatted: string,
): string {
  if (model === 'quote') return 'לפי הצעת מחיר'
  if (model === 'starting_from') return `החל מ־${formatted}`

  const suffix = STORE_PRICING_SUFFIX[model]
  return suffix ? `${formatted} ${suffix}` : formatted
}
