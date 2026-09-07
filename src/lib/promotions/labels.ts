/**
 * The Hebrew a person reads.
 *
 * Kept apart from the logic for the reason `reviews/labels.ts` gives: a screen
 * that needs a word should not have to import a module that decides money, and
 * a translator changing a phrase should not be editing a file that computes a
 * discount.
 *
 * Every phrase states the FACT rather than the rule. "הקופון כבר מומש" tells a
 * receptionist what happened; "unique constraint violation" tells them that
 * somebody else's job went wrong.
 */

import { BPS_PER_UNIT } from './types'
import type {
  PromotionAppliesTo,
  PromotionDiscountKind,
  PromotionKind,
} from './types'
import type { ConditionFailure } from './conditions'
import type { IneligibleReason } from './select'

export const PROMOTION_KIND_LABEL: Readonly<Record<PromotionKind, string>> = {
  early_bird: 'הזמנה מוקדמת',
  last_minute: 'רגע לפני',
  midweek: 'אמצע שבוע',
  long_stay: 'שהות ארוכה',
  repeat_guest: 'אורח חוזר',
  direct_booking: 'הזמנה ישירה',
  agent_campaign: 'קמפיין סוכנים',
}

export const DISCOUNT_KIND_LABEL: Readonly<
  Record<PromotionDiscountKind, string>
> = {
  percent: 'אחוזים',
  fixed: 'סכום קבוע',
  free_nights: 'לילות חינם',
}

export const APPLIES_TO_LABEL: Readonly<Record<PromotionAppliesTo, string>> = {
  stay_total: 'סך השהות',
  accommodation_only: 'לינה בלבד',
}

/**
 * The discount, as a business would say it aloud.
 *
 * Basis points are divided by 100 for display and never for arithmetic — the
 * money is computed in `discount.ts` from the integer. A formatter that
 * rounded would be a second rounding site, which §7.5 says does not exist.
 */
export function describeDiscount(terms: {
  discountKind: PromotionDiscountKind
  discountValue: number
}): string {
  switch (terms.discountKind) {
    case 'percent': {
      const percent = terms.discountValue / (BPS_PER_UNIT / 100)
      return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`
    }
    case 'fixed':
      // Shekels for reading, agorot for counting. The ₪ sign is attached so a
      // number can never be mistaken for the agorot it is stored as — the
      // exact confusion §17 lists first among the mistakes people make here.
      return `₪${(terms.discountValue / 100).toLocaleString('he-IL')}`
    case 'free_nights':
      return terms.discountValue === 1
        ? 'לילה אחד חינם'
        : `${terms.discountValue} לילות חינם`
  }
}

const CONDITION_FAILURE_LABEL: Readonly<Record<string, string>> = {
  not_qualified: 'ההזמנה אינה עומדת בתנאי המבצע.',
  fact_absent: 'חסר נתון שהמבצע נבחן מולו, ולכן הוא לא הוחל.',
  malformed: 'תנאי המבצע שמור בצורה שהמנוע אינו מכיר. יש לערוך אותו מחדש.',
}

export function describeConditionFailure(failure: ConditionFailure): string {
  return (
    CONDITION_FAILURE_LABEL[failure.reason] ??
    CONDITION_FAILURE_LABEL.not_qualified
  )
}

/** Why a campaign that exists did not reach a quote. */
export function describeIneligible(because: IneligibleReason): string {
  switch (because.reason) {
    case 'inactive':
      return 'המבצע מושהה.'
    case 'outside_window':
      return 'המבצע אינו בתוקף בתאריכים האלה.'
    case 'condition':
      return describeConditionFailure(because.failure)
    case 'worth_nothing':
      // Stated rather than hidden: a promotion worth nothing usually means the
      // basis it applies to is empty — an accommodation-only discount on a
      // booking with no accommodation lines — and that is worth seeing.
      return 'ההנחה יצאה אפס, ולכן לא נוספה שורה.'
    case 'excluded_by':
      return because.code === ''
        ? 'מבצע אחר מאותה קבוצה נבחר לפניו.'
        : `המבצע ${because.code} מאותה קבוצה נבחר לפניו.`
    case 'not_stackable':
      return 'נבחר מבצע שאינו מצטבר, ולכן הרשימה נעצרה.'
  }
}

/**
 * What a person is told when a code cannot be spent.
 *
 * There is deliberately ONE phrase for "already redeemed", and it covers both
 * a full coupon and a race lost to another window. To the person holding the
 * phone those are the same event — the code is spent — and inventing a second
 * message for the race would tell them about our concurrency instead of about
 * their coupon.
 */
export const REDEMPTION_MESSAGES = {
  alreadyRedeemed: 'הקופון כבר מומש.',
  notFound: 'הקוד אינו קיים או שאינו שייך לעסק הזה.',
  inactive: 'המבצע מושהה ואינו ניתן למימוש.',
  outsideWindow: 'הקוד אינו בתוקף בתאריכים האלה.',
  budgetSpent: 'תקציב המבצע נוצל במלואו.',
  guestLimit: 'האורח כבר מימש את ההנחה הזאת את מספר הפעמים המותר.',
  guestUnknown:
    'ההנחה מוגבלת לכל אורח, ולכן לא ניתן לממש אותה בלי לשייך אותה לאורח.',
  nothingToDiscount: 'אין ממה להוריד את ההנחה בהזמנה הזאת.',
} as const
