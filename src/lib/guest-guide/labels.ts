/**
 * The Hebrew a person reads.
 *
 * One file so the settings screen, the completeness report and — later — the
 * guest portal say the same words for the same value. Two components each
 * choosing their own translation of `after_deposit` is how an operator sets a
 * rule on one screen and reads a different promise on another.
 *
 * No `"use client"` and no import beyond the vocabularies: this is a table of
 * strings, and a Client Component may import it directly.
 *
 * ── The release labels are written from the guest's side ──────────────────
 *
 * `after_deposit` is "אחרי תשלום המקדמה" and not "לאחר סליקת מקדמה". The
 * operator setting the rule is imagining the guest reading the result, and a
 * label in the product's vocabulary rather than the guest's makes them
 * imagine wrong.
 */

import type { GapSeverity, GapKind } from './completeness'
import type { WithholdReason } from './release'
import type {
  GuideLanguage,
  GuideMediaKind,
  GuideReleaseMode,
  GuideStage,
  GuideStatus,
  GuideTopic,
  RecommendationCategory,
} from './types'

export const STAGE_LABEL: Readonly<Record<GuideStage, string>> = Object.freeze({
  before_arrival: 'לפני ההגעה',
  during_stay: 'במהלך השהות',
  after_checkout: 'אחרי העזיבה',
})

export const STAGE_SUMMARY: Readonly<Record<GuideStage, string>> =
  Object.freeze({
    before_arrival:
      'מה שאורח צריך לדעת כדי להגיע ולהיכנס — הדרך, החניה, שעת הכניסה ולמי מתקשרים.',
    during_stay:
      'מה שאורח צריך כדי להשתמש בבית — ויי-פיי, מיזוג, בריכה, מטבח, שעות שקט.',
    after_checkout: 'מה שקורה אחרי — פינוי, חפצים שנשכחו, ביקורת.',
  })

export const TOPIC_LABEL: Readonly<Record<GuideTopic, string>> = Object.freeze({
  directions: 'הגעה ודרכים',
  parking: 'חניה',
  check_in_time: 'שעת כניסה',
  what_to_bring: 'מה להביא',
  arrival_contact: 'איש קשר להגעה',
  wifi: 'ויי-פיי',
  access: 'כניסה לנכס',
  pool: 'בריכה',
  jacuzzi: 'ג׳קוזי',
  air_conditioning: 'מיזוג אוויר',
  tv: 'טלוויזיה',
  barbecue: 'מנגל',
  hot_water: 'מים חמים',
  kitchen: 'מטבח',
  shabbat_equipment: 'ציוד לשבת',
  quiet_hours: 'שעות שקט',
  waste: 'פינוי אשפה',
  emergency_contact: 'טלפון לחירום',
  checkout: 'עזיבה',
  forgotten_items: 'חפצים שנשכחו',
  feedback: 'משוב וביקורת',
  custom: 'תוכן משלכם',
})

export const GUIDE_STATUS_LABEL: Readonly<Record<GuideStatus, string>> =
  Object.freeze({
    draft: 'טיוטה',
    published: 'פורסם',
    unpublished: 'הורד מפרסום',
  })

export const RELEASE_MODE_LABEL: Readonly<Record<GuideReleaseMode, string>> =
  Object.freeze({
    immediate: 'מיד',
    after_confirmation: 'אחרי אישור ההזמנה',
    after_contract: 'אחרי חתימה על ההסכם',
    after_deposit: 'אחרי תשלום המקדמה',
    after_full_payment: 'אחרי תשלום מלא',
    hours_before: 'שעות לפני הכניסה',
    manual: 'רק בשחרור ידני',
    after_check_in: 'אחרי הצ׳ק-אין',
  })

/** What the portal tells a guest about something they cannot see yet. */
export const WITHHOLD_REASON_LABEL: Readonly<Record<WithholdReason, string>> =
  Object.freeze({
    inactive: 'הערך כבוי ואינו מוצג לאורחים',
    awaiting_confirmation: 'ייחשף אחרי אישור ההזמנה',
    awaiting_contract: 'ייחשף אחרי חתימה על ההסכם',
    awaiting_deposit: 'ייחשף אחרי תשלום המקדמה',
    awaiting_full_payment: 'ייחשף אחרי תשלום מלא',
    awaiting_time: 'ייחשף לקראת מועד הכניסה',
    awaiting_check_in: 'ייחשף עם תחילת השהות',
    awaiting_manual_release: 'ייחשף כשבית האירוח ישחרר אותו ידנית',
  })

export const CATEGORY_LABEL: Readonly<Record<RecommendationCategory, string>> =
  Object.freeze({
    restaurant: 'מסעדות',
    attraction: 'אטרקציות',
    supermarket: 'סופרמרקט',
    pharmacy: 'בית מרקחת',
    religious_service: 'בתי כנסת ושירותי דת',
    beach: 'חופים',
    hike: 'מסלולי הליכה',
    custom: 'אחר',
  })

export const MEDIA_KIND_LABEL: Readonly<Record<GuideMediaKind, string>> =
  Object.freeze({ photo: 'תמונה', video: 'סרטון' })

export const LANGUAGE_LABEL: Readonly<Record<GuideLanguage, string>> =
  Object.freeze({
    he: 'עברית',
    en: 'אנגלית',
    ar: 'ערבית',
    ru: 'רוסית',
    fr: 'צרפתית',
  })

export const GAP_SEVERITY_LABEL: Readonly<Record<GapSeverity, string>> =
  Object.freeze({
    essential: 'חובה',
    expected: 'מומלץ',
    optional: 'לא דחוף',
  })

export const GAP_KIND_LABEL: Readonly<Record<GapKind, string>> = Object.freeze({
  topic_missing: 'אין ערך בנושא הזה',
  entry_empty: 'הערך קיים וריק',
  secret_missing: 'סומן כמכיל קוד ואין ערך',
  translation_missing: 'חסר תרגום',
  media_alt_missing: 'אין תיאור חלופי למדיה',
  no_recommendations: 'אין המלצות מקומיות',
})
