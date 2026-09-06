/**
 * EXECUTION CONTEXT — SERVER ONLY. The rows a listing report is built from.
 *
 * ══ IT READS AND WRITES NOTHING ═════════════════════════════════════════════
 *
 * Every table here belongs to another module. This screen has no write path at
 * all — the fixes it recommends are made on `/properties` and `/units`, which
 * own those forms and their validation. A quality report that also edited the
 * thing it judges would be two sources of truth for what a valid listing is.
 *
 * ══ PHOTOS ARE COUNTED FROM `site_media`, AND THAT IS A LIMITATION ══════════
 *
 * `site_media` binds an image to a source through `bound_source`/`bound_id`,
 * so photos attached to a property or unit can be counted honestly. But it is
 * the WEBSITE's media table: a business that never built a site has no rows
 * there and will score zero on photo count while having plenty of pictures
 * somewhere else.
 *
 * That is reported as it is rather than smoothed over, because the alternative
 * — skipping the check when the table is empty — would hide the gap from
 * exactly the businesses that have it. The cover image is checked separately
 * from `cover_image_url` on the row itself, which every property has access to
 * regardless of the website module, so the two checks together tell a true
 * story: `cover_image` says whether there is a face, `photo_count` says
 * whether there is a gallery.
 */

import {
  reportForProperty,
  reportForUnit,
  weakestFirst,
  type ListingProperty,
  type ListingReport,
  type ListingUnit,
} from '@/lib/listing-quality'
import { toRows, type Db, type Row } from '@/lib/persistence'
import { summarise, type Review } from '@/lib/reviews'

export type ListingsScreen =
  | { readonly status: 'not_provisioned' }
  | {
      readonly status: 'ready'
      readonly reports: readonly ListingReport[]
      readonly propertiesWithNoUnits: number
    }

function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '42P01' || code === 'PGRST205'
}

const str = (row: Row, key: string): string | null =>
  typeof row[key] === 'string' && row[key].trim() !== ''
    ? (row[key] as string)
    : null

const num = (row: Row, key: string): number | null =>
  typeof row[key] === 'number' ? (row[key] as number) : null

/** Counts keyed by the id they belong to. Absent means zero, never unknown. */
function tally(rows: readonly Row[], key: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const id = str(row, key)
    if (id === null) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

export async function loadListingsScreen(
  db: Db,
  organizationId: string,
  propertyIds: readonly string[],
): Promise<ListingsScreen> {
  if (propertyIds.length === 0) {
    return { status: 'ready', reports: [], propertiesWithNoUnits: 0 }
  }

  try {
    const [
      properties,
      units,
      propertyAmenities,
      unitAmenities,
      media,
      reviews,
    ] = await Promise.all([
      db
        .from('properties')
        .select(
          'id, name, description, city, region, latitude, longitude, ' +
            'house_rules, cancellation_policy_text, cover_image_url',
        )
        .eq('organization_id', organizationId)
        .in('id', [...propertyIds])
        .is('deleted_at', null),
      db
        .from('units')
        .select(
          'id, property_id, name, description, max_guests, bedrooms, ' +
            'bathrooms, beds, size_sqm, base_price_agorot, ' +
            'cleaning_fee_agorot, deposit_agorot, min_nights, cover_image_url',
        )
        .eq('organization_id', organizationId)
        .in('property_id', [...propertyIds])
        .is('deleted_at', null),
      db
        .from('property_amenities')
        .select('property_id')
        .eq('organization_id', organizationId)
        .in('property_id', [...propertyIds]),
      db
        .from('unit_amenities')
        .select('unit_id')
        .eq('organization_id', organizationId)
        .in('property_id', [...propertyIds]),
      db
        .from('site_media')
        .select('bound_id')
        .eq('organization_id', organizationId),
      // `status` comes back with the rest rather than being filtered in the
      // query. `summarise` needs to COUNT the hidden ones — dropping them
      // here would let a business hide its way to a better score, which is
      // the one thing 0066 exists to prevent.
      db
        .from('guest_reviews')
        .select('property_id, status, overall')
        .eq('organization_id', organizationId)
        .in('property_id', [...propertyIds]),
    ])

    for (const result of [
      properties,
      units,
      propertyAmenities,
      unitAmenities,
      media,
      reviews,
    ]) {
      if (result.error) throw result.error
    }

    const propertyAmenityCount = tally(
      toRows(propertyAmenities.data),
      'property_id',
    )
    const unitAmenityCount = tally(toRows(unitAmenities.data), 'unit_id')
    const photoCount = tally(toRows(media.data), 'bound_id')

    // One `summarise` call per property rather than a hand-rolled average
    // here: the rules about hidden reviews and about too few to average live
    // in one place, and a second copy of them would drift.
    const reviewsByProperty = new Map<string, Review[]>()
    for (const row of toRows(reviews.data)) {
      const propertyId = str(row, 'property_id')
      const overall = num(row, 'overall')
      const status = str(row, 'status')
      if (propertyId === null || overall === null) continue

      const list = reviewsByProperty.get(propertyId) ?? []
      list.push({
        id: '',
        propertyId,
        unitId: null,
        bookingId: '',
        status: status === 'hidden' ? 'hidden' : 'published',
        source: 'guest_portal',
        overall,
        dimensions: {},
        comment: null,
        hostReply: null,
        stayedAt: '',
      })
      reviewsByProperty.set(propertyId, list)
    }

    const listingProperties = new Map<string, ListingProperty>()
    for (const row of toRows(properties.data)) {
      const id = str(row, 'id')
      if (id === null) continue
      const reviewSummary = summarise(reviewsByProperty.get(id) ?? [])
      listingProperties.set(id, {
        id,
        name: str(row, 'name') ?? id,
        description: str(row, 'description'),
        city: str(row, 'city'),
        region: str(row, 'region'),
        latitude: num(row, 'latitude'),
        longitude: num(row, 'longitude'),
        houseRules: str(row, 'house_rules'),
        cancellationPolicyText: str(row, 'cancellation_policy_text'),
        coverImageUrl: str(row, 'cover_image_url'),
        amenityCount: propertyAmenityCount.get(id) ?? 0,
        photoCount: photoCount.get(id) ?? 0,
        reviewCount: reviewSummary.counted,
        reviewAverage: reviewSummary.average,
        reviewsHidden: reviewSummary.hidden,
      })
    }

    const reports: ListingReport[] = []
    const propertiesWithUnits = new Set<string>()

    for (const row of toRows(units.data)) {
      const id = str(row, 'id')
      const propertyId = str(row, 'property_id')
      if (id === null || propertyId === null) continue

      const property = listingProperties.get(propertyId)
      if (property === undefined) continue
      propertiesWithUnits.add(propertyId)

      const unit: ListingUnit = {
        id,
        propertyId,
        name: str(row, 'name') ?? id,
        description: str(row, 'description'),
        maxGuests: num(row, 'max_guests'),
        bedrooms: num(row, 'bedrooms'),
        bathrooms: num(row, 'bathrooms'),
        beds: num(row, 'beds'),
        sizeSqm: num(row, 'size_sqm'),
        basePriceAgorot: num(row, 'base_price_agorot'),
        cleaningFeeAgorot: num(row, 'cleaning_fee_agorot'),
        depositAgorot: num(row, 'deposit_agorot'),
        minNights: num(row, 'min_nights'),
        coverImageUrl: str(row, 'cover_image_url'),
        amenityCount: unitAmenityCount.get(id) ?? 0,
        photoCount: photoCount.get(id) ?? 0,
      }

      reports.push(reportForUnit(property, unit))
    }

    // A property with no units is still a listing somebody may be about to
    // create units under, and its own failures are worth showing rather than
    // waiting for a unit to exist.
    for (const [id, property] of listingProperties) {
      if (!propertiesWithUnits.has(id))
        reports.push(reportForProperty(property))
    }

    return {
      status: 'ready',
      reports: weakestFirst(reports),
      propertiesWithNoUnits: listingProperties.size - propertiesWithUnits.size,
    }
  } catch (error) {
    if (isMissingSchema(error)) return { status: 'not_provisioned' }
    throw error
  }
}
