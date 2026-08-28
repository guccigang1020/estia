/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Properties and their units, read from `public.properties` and `public.units`.
 *
 * TWO FLOORS, THE SAME AS EVERYWHERE. `properties_select` narrows by
 * membership and `property_in_scope()`, so a member scoped to two properties
 * cannot make the third appear by asking a different way — the enforcement is
 * in the query, never a filter on the result. And, exactly as with units, that
 * policy carries no permission check: `properties_insert` requires
 * `property.create` and `properties_select` requires nothing beyond scope. So
 * the grant question belongs to the application, is asked by `requireGrant` at
 * the route and by `can()` per row here, and neither floor is redundant.
 *
 * WHAT IS DELIBERATELY NOT READ. Contact name, phone and email are columns on
 * `properties` and are not selected: nothing on these screens needs them, and
 * the cheapest way to keep personal data off a page is not to fetch it.
 */

import { can, type Actor } from '@/lib/authz/can'
import type { Db } from '@/lib/persistence'
import {
  asAgorot,
  asBoolean,
  asNumber,
  asString,
  asStringOrNull,
  toRow,
  toRows,
} from '@/lib/persistence'

/* ----------------------------------------------------------- properties -- */

export interface PropertyRecord {
  id: string
  name: string
  slug: string
  propertyType: string
  status: string
  city: string | null
  addressLine1: string | null
  region: string | null
  country: string
  timezone: string
  currency: string
  defaultCheckInTime: string
  defaultCheckOutTime: string
  minNights: number
  /** VAT in basis points. 1700 is 17%. */
  taxRateBps: number
  taxIncludedInPrice: boolean
  touristVatExempt: boolean
  description: string | null
  houseRules: string | null
}

export interface PropertyListRow extends PropertyRecord {
  /**
   * Units this reader can actually see, counted from the rows themselves.
   *
   * Not a stored counter and not a database aggregate: row level security
   * narrows `units` for this reader, so counting the visible rows is the only
   * count that matches what the detail page will then show them. A number that
   * disagreed with the list under it is worse than no number.
   */
  visibleUnitCount: number
}

const PROPERTY_COLUMNS =
  'id, name, slug, property_type, status, city, address_line1, region, ' +
  'country, timezone, currency, default_check_in_time, ' +
  'default_check_out_time, min_nights, tax_rate_bps, tax_included_in_price, ' +
  'tourist_vat_exempt, description, house_rules, sort_order'

export interface LoadPropertiesArgs {
  db: Db
  actor: Actor
  organizationId: string
}

/** Every property this person may view, in display order. */
export async function loadProperties(
  args: LoadPropertiesArgs,
): Promise<PropertyListRow[]> {
  const { db, actor, organizationId } = args

  const { data, error } = await db
    .from('properties')
    .select(PROPERTY_COLUMNS)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })

  if (error) throw error

  const properties = toRows(data)
    .map(toPropertyRecord)
    .filter((property) =>
      can(actor, 'property.view', {
        organizationId,
        propertyId: property.id,
        family: 'inventory',
      }),
    )

  if (properties.length === 0) return []

  const counts = await countUnitsByProperty(
    db,
    organizationId,
    properties.map((property) => property.id),
  )

  return properties.map((property) => ({
    ...property,
    visibleUnitCount: counts.get(property.id) ?? 0,
  }))
}

/** One property, or `null` when it does not exist for this reader. */
export async function loadProperty(args: {
  db: Db
  actor: Actor
  organizationId: string
  propertyId: string
}): Promise<PropertyRecord | null> {
  const { db, actor, organizationId, propertyId } = args

  const { data, error } = await db
    .from('properties')
    .select(PROPERTY_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('id', propertyId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const property = toPropertyRecord(toRow(data))

  // Out of scope reads as "not found", exactly as `assertAgentReach` decided
  // for inventory: answering "you may not see וילה הגליל" confirms that וילה
  // הגליל is on this business's books.
  const allowed = can(actor, 'property.view', {
    organizationId,
    propertyId: property.id,
    family: 'inventory',
  })

  return allowed ? property : null
}

/* ---------------------------------------------------------------- units -- */

export interface UnitRecord {
  id: string
  code: string
  name: string
  description: string | null
  unitType: string
  status: string
  maxGuests: number
  standardGuests: number
  bedrooms: number
  bathrooms: number
  beds: number
  sizeSqm: number | null
  minNights: number
  maxNights: number | null
  checkInTime: string
  checkOutTime: string
  basePriceAgorot: number
  extraGuestPriceAgorot: number
  cleaningFeeAgorot: number
  depositAgorot: number
}

const UNIT_COLUMNS =
  'id, code, name, description, unit_type, status, max_guests, ' +
  'standard_guests, bedrooms, bathrooms, beds, size_sqm, min_nights, ' +
  'max_nights, check_in_time, check_out_time, base_price_agorot, ' +
  'extra_guest_price_agorot, cleaning_fee_agorot, deposit_agorot, sort_order'

/** The units of one property, in display order. */
export async function loadUnits(args: {
  db: Db
  organizationId: string
  propertyId: string
}): Promise<UnitRecord[]> {
  const { db, organizationId, propertyId } = args

  const { data, error } = await db
    .from('units')
    .select(UNIT_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('code', { ascending: true })

  if (error) throw error

  return toRows(data).map((row) => ({
    id: asString(row, 'id'),
    code: asString(row, 'code'),
    name: asString(row, 'name'),
    description: asStringOrNull(row, 'description'),
    unitType: asString(row, 'unit_type'),
    status: asString(row, 'status'),
    maxGuests: asNumber(row, 'max_guests'),
    standardGuests: asNumber(row, 'standard_guests'),
    bedrooms: asNumber(row, 'bedrooms'),
    // `numeric(3,1)`, so PostgREST sends it as a string. 2.5 bathrooms is a
    // real listing and rounding it in either direction is a complaint.
    bathrooms: asNumber(row, 'bathrooms'),
    beds: asNumber(row, 'beds'),
    sizeSqm: readNumberOrNull(row, 'size_sqm'),
    minNights: asNumber(row, 'min_nights'),
    maxNights: readNumberOrNull(row, 'max_nights'),
    checkInTime: asString(row, 'check_in_time'),
    checkOutTime: asString(row, 'check_out_time'),
    basePriceAgorot: asAgorot(row, 'base_price_agorot'),
    extraGuestPriceAgorot: asAgorot(row, 'extra_guest_price_agorot'),
    cleaningFeeAgorot: asAgorot(row, 'cleaning_fee_agorot'),
    depositAgorot: asAgorot(row, 'deposit_agorot'),
  }))
}

/* ------------------------------------------------------------ internals -- */

function toPropertyRecord(row: Record<string, unknown>): PropertyRecord {
  return {
    id: asString(row, 'id'),
    name: asString(row, 'name'),
    // `citext`, and still a string on the wire.
    slug: asString(row, 'slug'),
    propertyType: asString(row, 'property_type'),
    status: asString(row, 'status'),
    city: asStringOrNull(row, 'city'),
    addressLine1: asStringOrNull(row, 'address_line1'),
    region: asStringOrNull(row, 'region'),
    country: asString(row, 'country'),
    timezone: asString(row, 'timezone'),
    currency: asString(row, 'currency'),
    // `time`, sent as `HH:MM:SS`.
    defaultCheckInTime: asString(row, 'default_check_in_time'),
    defaultCheckOutTime: asString(row, 'default_check_out_time'),
    minNights: asNumber(row, 'min_nights'),
    taxRateBps: asNumber(row, 'tax_rate_bps'),
    taxIncludedInPrice: asBoolean(row, 'tax_included_in_price'),
    touristVatExempt: asBoolean(row, 'tourist_vat_exempt'),
    description: asStringOrNull(row, 'description'),
    houseRules: asStringOrNull(row, 'house_rules'),
  }
}

/**
 * Units per property, counted from the rows row level security admitted.
 *
 * One query for the whole list rather than one per property. It selects the
 * foreign key and nothing else, so it carries no rate, no name and no guest
 * data — a count should not be an excuse to read a table.
 */
async function countUnitsByProperty(
  db: Db,
  organizationId: string,
  propertyIds: readonly string[],
): Promise<Map<string, number>> {
  const { data, error } = await db
    .from('units')
    .select('property_id')
    .eq('organization_id', organizationId)
    .in('property_id', [...propertyIds])
    .is('deleted_at', null)

  if (error) throw error

  const counts = new Map<string, number>()
  for (const row of toRows(data)) {
    const propertyId = asString(row, 'property_id')
    counts.set(propertyId, (counts.get(propertyId) ?? 0) + 1)
  }
  return counts
}

/** `null` stays `null`; a numeric string becomes a number. */
function readNumberOrNull(
  row: Record<string, unknown>,
  column: string,
): number | null {
  return row[column] === null || row[column] === undefined
    ? null
    : asNumber(row, column)
}
