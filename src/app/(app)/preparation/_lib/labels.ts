/**
 * The Hebrew words for the preparation vocabulary.
 *
 * Every list here is keyed off a frozen constant in
 * `src/lib/preparation/types.ts` and typed as a total record, so adding a
 * category, a unit or a measurable basis to the domain fails to compile until
 * somebody has said what it is called in Hebrew. A `?? key` fallback would
 * compile and put `sleeping_places` in front of a villa owner.
 *
 * Section headings are deliberately absent. They are not a fixed vocabulary —
 * they live on the catalogue so a business can rename them — so the screen
 * reads them from the draft rather than from here.
 */

import {
  CONDITION_COMPARATORS,
  EVENT_TYPES,
  FACT_BASES,
  REQUIREMENT_CATEGORIES,
  REQUIREMENT_UNITS,
  type ConditionComparator,
  type EventType,
  type FactBasis,
  type RequirementCategory,
  type RequirementUnit,
} from '@/lib/preparation'

export const CATEGORY_LABEL: Readonly<Record<RequirementCategory, string>> = {
  sleeping: 'מקומות שינה',
  linen: 'מצעים',
  towels: 'מגבות',
  bathrooms: 'חדרי רחצה',
  kitchen: 'מטבח',
  event: 'אירוע',
  cleaning: 'ניקיון',
  consumables: 'מתכלים',
  special_setup: 'סידור מיוחד',
}

export const UNIT_LABEL: Readonly<Record<RequirementUnit, string>> = {
  piece: 'יחידה',
  set: 'סט',
  pack: 'חבילה',
  person: 'איש',
  hour: 'שעה',
}

/**
 * What a quantity is measured against.
 *
 * The two that matter most are the two that are *outputs* of the bed
 * allocation: pillows are counted per sleeping place, and a sleeping place is
 * the answer to how the party was laid out — not an input to it. The wording
 * says so, because a person choosing "לפי אורחים" for pillows gets a different
 * and quietly wrong number.
 */
export const BASIS_LABEL: Readonly<Record<FactBasis, string>> = {
  guests: 'לכל אורח',
  adults: 'לכל מבוגר',
  children: 'לכל ילד',
  nights: 'לכל לילה',
  bedrooms: 'לכל חדר שינה',
  bathrooms: 'לכל חדר רחצה',
  permanent_capacity: 'לכל מקום שינה קבוע',
  sleeping_places: 'לכל מקום שינה בפועל',
  extra_beds: 'לכל מיטה נוספת',
  booking: 'פעם אחת להזמנה',
}

export const COMPARATOR_LABEL: Readonly<Record<ConditionComparator, string>> = {
  lt: 'קטן מ־',
  lte: 'קטן או שווה ל־',
  eq: 'שווה ל־',
  gte: 'גדול או שווה ל־',
  gt: 'גדול מ־',
}

export const EVENT_TYPE_LABEL: Readonly<Record<EventType, string>> = {
  accommodation: 'לינה רגילה',
  day_event: 'אירוע יום',
  overnight_event: 'אירוע עם לינה',
  wedding: 'חתונה',
  birthday: 'יום הולדת',
  retreat: 'ריטריט',
  corporate: 'אירוע חברה',
  shabbat: 'שבת',
  family_event: 'אירוע משפחתי',
  custom: 'אחר',
}

/** The lists, re-exported so a component imports one module and not five. */
export const CATEGORIES = REQUIREMENT_CATEGORIES
export const UNITS = REQUIREMENT_UNITS
export const BASES = FACT_BASES
export const COMPARATORS = CONDITION_COMPARATORS
export const EVENTS = EVENT_TYPES

/** `95 דקות` reads worse than `שעה ו־35 דקות` on a duration a person plans by. */
export function describeMinutes(minutes: number): string {
  if (minutes <= 0) return 'ללא זמן משוער'

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  if (hours === 0) return `${rest} דקות`
  if (rest === 0) return hours === 1 ? 'שעה' : `${hours} שעות`

  return `${hours === 1 ? 'שעה' : `${hours} שעות`} ו־${rest} דקות`
}
