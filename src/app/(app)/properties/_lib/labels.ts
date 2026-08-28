/**
 * Hebrew wording for the accommodation enums.
 *
 * The values are `public.property_type`, `public.property_status`,
 * `public.unit_type` and `public.unit_status`, declared in
 * `supabase/migrations/0008_accommodation.sql`. They are restated here because
 * nothing in `src/lib` declares them yet — the domain has never needed to name
 * a unit type, only to ask whether a unit is sellable — and a screen that
 * printed the raw `boutique_hotel` at a Hebrew-speaking manager would be
 * unfinished.
 *
 * THE TEST BESIDE THIS FILE IS THE POINT. It asserts that every member of every
 * tuple has a label, so adding `'glamping'` to the enum in a migration without
 * wording it here fails the suite rather than shipping an English word into a
 * Hebrew screen. It cannot assert the tuples still match the database — only a
 * generated type could — so each one names the migration it was read from.
 *
 * `statusTone` exists so status is never conveyed by colour alone: the label is
 * always rendered, and the tone is the second signal.
 */

import type { BadgeTone } from '@/components/ui/badge'

/* ------------------------------------------------------------- property -- */

export const PROPERTY_TYPES = [
  'zimmer',
  'villa',
  'apartment',
  'boutique_hotel',
  'hostel',
  'complex',
  'camping',
  'other',
] as const

export type PropertyType = (typeof PROPERTY_TYPES)[number]

export const PROPERTY_TYPE_LABEL: Record<PropertyType, string> = {
  zimmer: 'צימר',
  villa: 'וילה',
  apartment: 'דירה',
  boutique_hotel: 'מלון בוטיק',
  hostel: 'הוסטל',
  complex: 'מתחם',
  camping: 'קמפינג',
  other: 'אחר',
}

export const PROPERTY_STATUSES = [
  'draft',
  'active',
  'inactive',
  'archived',
] as const

export type PropertyStatus = (typeof PROPERTY_STATUSES)[number]

export const PROPERTY_STATUS_LABEL: Record<PropertyStatus, string> = {
  draft: 'טיוטה',
  active: 'פעיל',
  inactive: 'לא פעיל',
  archived: 'בארכיון',
}

/* ----------------------------------------------------------------- unit -- */

export const UNIT_TYPES = [
  'room',
  'suite',
  'studio',
  'apartment',
  'cabin',
  'villa',
  'dorm_bed',
  'tent',
  'pitch',
  'other',
] as const

export type UnitType = (typeof UNIT_TYPES)[number]

export const UNIT_TYPE_LABEL: Record<UnitType, string> = {
  room: 'חדר',
  suite: 'סוויטה',
  studio: 'סטודיו',
  apartment: 'דירה',
  cabin: 'בקתה',
  villa: 'וילה',
  dorm_bed: 'מיטה בחדר משותף',
  tent: 'אוהל',
  pitch: 'מגרש',
  other: 'אחר',
}

export const UNIT_STATUSES = [
  'draft',
  'active',
  'maintenance',
  'inactive',
  'archived',
] as const

export type UnitStatus = (typeof UNIT_STATUSES)[number]

export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = {
  draft: 'טיוטה',
  active: 'פעילה',
  maintenance: 'בתחזוקה',
  inactive: 'לא פעילה',
  archived: 'בארכיון',
}

/**
 * What a non-`active` unit means for the calendar, in the domain's own terms.
 *
 * `loadRules` in `persistence/booking.ts` returns `null` for any unit whose
 * status is not `active`, and `checkAvailability` turns that into a refusal:
 * the engine cannot vouch for the unit, so it is not sellable. Saying so on the
 * screen is what stops somebody wondering why a unit shows as blocked all
 * month.
 */
export const UNIT_SELLABILITY_NOTE: Record<UnitStatus, string | null> = {
  draft: 'יחידה בטיוטה אינה נמכרת, ומופיעה ביומן כחסומה.',
  active: null,
  maintenance: 'יחידה בתחזוקה אינה נמכרת, ומופיעה ביומן כחסומה.',
  inactive: 'יחידה לא פעילה אינה נמכרת, ומופיעה ביומן כחסומה.',
  archived: 'יחידה בארכיון אינה נמכרת, ומופיעה ביומן כחסומה.',
}

/* ----------------------------------------------------------------- tone -- */

/**
 * The badge tone for a status.
 *
 * Redundant with the label, deliberately. The label is the message; this is a
 * second, weaker signal for a reader scanning a long list, and the screen is
 * complete without it.
 */
export function statusTone(status: string): BadgeTone {
  return status === 'active' ? 'brand' : 'neutral'
}

/** A label for a value the database returned that this file does not know. */
export function labelOr<T extends string>(
  labels: Record<T, string>,
  value: string,
): string {
  return value in labels ? labels[value as T] : value
}
