/**
 * TURNING CANONICAL ROWS INTO CLAIMS.
 *
 * The only place in the module that reads a property, a unit or an amenity and
 * produces something a page can say. Every function here goes through
 * `claimFromRow`, so every sentence it produces knows which table and which
 * column it came from.
 *
 * ── The absent-column rule ────────────────────────────────────────────────
 *
 * A property with no `description` produces no description claim. Not an empty
 * string, not a placeholder, not "אחוזה מקסימה בגליל" — nothing. The section
 * renders without that line and the content quality pass reports it as
 * something worth filling in.
 *
 * That is the whole discipline. Every temptation to be helpful here is a
 * temptation to publish a sentence nobody wrote.
 *
 * ── What is offered to a generator ────────────────────────────────────────
 *
 * `factsForSection` is also what `ai.ts` hands a model as its closed world. So
 * a model literally cannot be told about a heated pool unless a column in
 * `properties`, `units` or `amenities` says there is one — and if it asserts
 * one anyway, `groundDraft` drops the draft because the fact key was never
 * offered.
 */

import { claimFromRow, type SourceRow } from './facts'
import type { SiteClaim, SiteSectionKind } from './types'

/* ------------------------------------------------------------ properties -- */

/**
 * What a property row can honestly say about itself.
 *
 * The columns are named individually rather than swept from the row, because
 * a sweep would publish `tax_id`, `contact_phone` and `metadata` the day
 * somebody added a column. A public website is a disclosure surface and the
 * list of what it discloses is written down.
 */
export function propertyClaims(property: SourceRow): readonly SiteClaim[] {
  const claims: (SiteClaim | null)[] = [
    claimFromRow({
      key: 'property.name',
      row: property,
      column: 'name',
      source: 'property',
    }),
    claimFromRow({
      key: 'property.description',
      row: property,
      column: 'description',
      source: 'property',
    }),
    claimFromRow({
      key: 'property.city',
      row: property,
      column: 'city',
      source: 'property',
    }),
    claimFromRow({
      key: 'property.region',
      row: property,
      column: 'region',
      source: 'property',
    }),
    claimFromRow({
      key: 'property.address',
      row: property,
      column: 'address_line1',
      source: 'property',
    }),
    claimFromRow({
      key: 'property.check_in_time',
      row: property,
      column: 'default_check_in_time',
      source: 'property',
      format: (raw) => `הגעה מהשעה ${trimSeconds(raw)}`,
    }),
    claimFromRow({
      key: 'property.check_out_time',
      row: property,
      column: 'default_check_out_time',
      source: 'property',
      format: (raw) => `עזיבה עד השעה ${trimSeconds(raw)}`,
    }),
    claimFromRow({
      key: 'property.min_nights',
      row: property,
      column: 'min_nights',
      source: 'property',
      format: (raw) =>
        raw === '1' ? 'ללא מינימום לילות' : `מינימום ${raw} לילות`,
    }),
    claimFromRow({
      key: 'property.house_rules',
      row: property,
      column: 'house_rules',
      source: 'property',
    }),
    // The cancellation paragraph the guest agreed to, not a summary of it.
    // A website that paraphrases a policy has created a second policy.
    claimFromRow({
      key: 'property.cancellation_policy',
      row: property,
      column: 'cancellation_policy_text',
      source: 'property',
    }),
    claimFromRow({
      key: 'property.contact_phone',
      row: property,
      column: 'contact_phone',
      source: 'property',
    }),
    claimFromRow({
      key: 'property.contact_email',
      row: property,
      column: 'contact_email',
      source: 'property',
    }),
  ]

  return claims.filter(isClaim)
}

/* ----------------------------------------------------------------- units -- */

/**
 * What a unit row can honestly say.
 *
 * `base_price_agorot` is deliberately NOT here. A nightly rate on a public
 * page is a price, prices come from the pricing engine for a real request, and
 * a number copied out of a column into a snapshot is a price the business has
 * stopped charging by the time somebody reads it. The booking widget asks
 * `priceStay` live — see `public.ts`.
 */
export function unitClaims(unit: SourceRow): readonly SiteClaim[] {
  const claims: (SiteClaim | null)[] = [
    claimFromRow({
      key: 'unit.name',
      row: unit,
      column: 'name',
      source: 'unit',
    }),
    claimFromRow({
      key: 'unit.description',
      row: unit,
      column: 'description',
      source: 'unit',
    }),
    claimFromRow({
      key: 'unit.max_guests',
      row: unit,
      column: 'max_guests',
      source: 'unit',
      format: (raw) => `עד ${raw} אורחים`,
    }),
    claimFromRow({
      key: 'unit.bedrooms',
      row: unit,
      column: 'bedrooms',
      source: 'unit',
      format: (raw) => (raw === '1' ? 'חדר שינה אחד' : `${raw} חדרי שינה`),
    }),
    claimFromRow({
      key: 'unit.beds',
      row: unit,
      column: 'beds',
      source: 'unit',
      format: (raw) => (raw === '1' ? 'מיטה אחת' : `${raw} מיטות`),
    }),
    claimFromRow({
      key: 'unit.bathrooms',
      row: unit,
      column: 'bathrooms',
      source: 'unit',
      format: (raw) => `${raw} חדרי רחצה`,
    }),
    claimFromRow({
      key: 'unit.size_sqm',
      row: unit,
      column: 'size_sqm',
      source: 'unit',
      format: (raw) => `${raw} מ״ר`,
    }),
  ]

  return claims.filter(isClaim)
}

/* ------------------------------------------------------------- amenities -- */

/**
 * One amenity, as a claim.
 *
 * `name_he` first, because the product is Hebrew and the built-in catalogue
 * carries both — and `name` as the fallback rather than as a second claim, so
 * an amenity never appears twice in one list.
 */
export function amenityClaim(
  amenity: SourceRow,
  index: number,
): SiteClaim | null {
  return (
    claimFromRow({
      key: `amenity.${index}`,
      row: amenity,
      column: 'name_he',
      source: 'amenity',
    }) ??
    claimFromRow({
      key: `amenity.${index}`,
      row: amenity,
      column: 'name',
      source: 'amenity',
    })
  )
}

export function amenityClaims(
  amenities: readonly SourceRow[],
): readonly SiteClaim[] {
  return amenities
    .map((amenity, index) => amenityClaim(amenity, index))
    .filter(isClaim)
}

/* ------------------------------------------------------- the closed world -- */

export type SectionFactInput = {
  kind: SiteSectionKind
  property: SourceRow | null
  units: readonly SourceRow[]
  amenities: readonly SourceRow[]
  organizationName: string | null
  organizationId: string
}

/**
 * Every fact a section of this kind is allowed to rest on.
 *
 * Also the exact set handed to a generator. Two consequences worth naming:
 *
 *   1. A `contact_details` section is not offered the unit rates, so a model
 *      writing a contact block cannot mention a price at all.
 *   2. A section bound to nothing gets an empty set, and both the generator
 *      and the quality pass say the same thing about it — "there is nothing
 *      here to write from" — rather than one of them improvising.
 */
export function factsForSection(input: SectionFactInput): readonly SiteClaim[] {
  const property = input.property ? propertyClaims(input.property) : []
  const units = input.units.flatMap((unit) =>
    unitClaims(unit).map((claim) => ({
      ...claim,
      key: `${claim.key}.${unit.id}`,
    })),
  )
  const amenities = amenityClaims(input.amenities)

  const organization: readonly SiteClaim[] = input.organizationName
    ? [
        {
          key: 'organization.name',
          text: input.organizationName,
          source: 'organization' as const,
          sourceId: input.organizationId,
          sourceField: 'name',
          sourceValue: input.organizationName,
        },
      ]
    : []

  switch (input.kind) {
    case 'hero':
    case 'property_intro':
    case 'rich_text':
    case 'cta':
    case 'faq':
      return [...organization, ...property]

    case 'unit_grid':
    case 'booking_widget':
      return [...organization, ...property, ...units]

    case 'amenity_list':
      return [...organization, ...property, ...amenities]

    case 'location_map':
      return [
        ...organization,
        ...property.filter((claim) =>
          ['property.city', 'property.region', 'property.address'].includes(
            claim.key,
          ),
        ),
      ]

    case 'contact_details':
      return [
        ...organization,
        ...property.filter((claim) =>
          [
            'property.contact_phone',
            'property.contact_email',
            'property.address',
            'property.city',
          ].includes(claim.key),
        ),
      ]

    // A gallery asserts nothing in prose. Its facts are its images, and an
    // image's provenance is its `site_media` row.
    case 'gallery':
      return organization
  }
}

/* ----------------------------------------------------------------- shared -- */

function isClaim(claim: SiteClaim | null): claim is SiteClaim {
  return claim !== null
}

/** `15:00:00` is what Postgres returns for a `time`; `15:00` is what a person reads. */
function trimSeconds(value: string): string {
  return /^\d{2}:\d{2}:\d{2}$/.test(value) ? value.slice(0, 5) : value
}
