/**
 * The accommodation enums, declared once.
 *
 * `public.property_type` and `public.property_status` come from
 * `supabase/migrations/0008_accommodation.sql`. They used to be declared in
 * `app/(app)/properties/_lib/labels.ts`, whose own header said they lived
 * there only because nothing in `src/lib` had needed to name a property type
 * yet. `property.create` needs to — its input schema has to refuse a type the
 * enum does not carry — so the tuples move here and `labels.ts` re-exports
 * them.
 *
 * That is deliberately a move and not a copy. The test beside `labels.ts`
 * reads the migration and asserts these tuples still match it, so a second
 * declaration would be a second thing to keep in step with 0008 and only one
 * of them would be checked.
 */

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

export const PROPERTY_STATUSES = [
  'draft',
  'active',
  'inactive',
  'archived',
] as const

export type PropertyStatus = (typeof PROPERTY_STATUSES)[number]
