/**
 * The Hebrew a person reads.
 *
 * The hidden-review line is the one that matters: it is shown whenever the
 * count is above zero, so a business cannot look at its own average without
 * also seeing what is not in it.
 */

import type { ReviewDimension, ReviewSource } from './types'

export const DIMENSION_LABEL: Readonly<Record<ReviewDimension, string>> =
  Object.freeze({
    cleanliness: 'ניקיון',
    accuracy: 'תאימות לתיאור',
    communication: 'תקשורת',
    location: 'מיקום',
    value_for_money: 'תמורה למחיר',
  })

export const SOURCE_LABEL: Readonly<Record<ReviewSource, string>> =
  Object.freeze({
    guest_portal: 'האורח כתב בפורטל',
    entered_by_host: 'הוזן ידנית',
    channel_import: 'יובא מערוץ',
  })

export const REVIEW_NOTE = Object.freeze({
  tooFew:
    'פחות משלוש ביקורות. ממוצע על ביקורת אחת או שתיים הוא הטלת מטבע — אורח אחד לא מרוצה מוריד ליסטינג מ-5.0 ל-3.0 והמספר לא אומר דבר על המקום.',
  hidden:
    'ביקורות מוסתרות אינן נכללות בממוצע, אבל הן נספרות ומוצגות כאן תמיד. דירוג שאפשר לנקות בשקט אינו דירוג — הוא שיווק.',
  immutable:
    'אי אפשר לערוך את מילות האורח או את הציון, ואי אפשר למחוק ביקורת. מה שאפשר: להשיב, ולהסתיר עם נימוק שנרשם.',
  noReviews:
    'אין עדיין ביקורות. זה מצב של עסק חדש, לא של עסק גרוע — ולכן הוא לא מוריד ציון.',
})
