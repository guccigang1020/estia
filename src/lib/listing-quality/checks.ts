/**
 * The checks, and what each one reads.
 *
 * Pure. Every function takes rows and returns findings; nothing here queries,
 * and nothing here writes. That is what lets the whole module be tested
 * against handmade values rather than a seeded database.
 *
 * ══ EVERY THRESHOLD IS AN OPINION, SO EVERY THRESHOLD IS NAMED ══════════════
 *
 * A number buried in an `if` is an opinion nobody can argue with. Each one
 * below is a named constant with the reason beside it, so a business that
 * disagrees can see exactly what it is disagreeing with — and so the next
 * person can change one without hunting for the others.
 */

import type { ListingCheck, ListingProperty, ListingUnit } from './types'

/**
 * A description shorter than this reads as a placeholder.
 *
 * Not a marketing rule — a practical one. Below roughly forty words a guest
 * cannot tell what the place is, and every channel that syndicates a listing
 * treats a two-line description as an incomplete one.
 */
export const MIN_DESCRIPTION_CHARS = 220

/** Long enough to answer the obvious questions without becoming a brochure. */
export const GOOD_DESCRIPTION_CHARS = 600

/**
 * Five photos.
 *
 * One photo is a listing nobody books. The number is low on purpose: it is the
 * point below which a guest cannot picture the place at all, not an aspiration.
 */
export const MIN_PHOTOS = 5

/**
 * Eight amenities.
 *
 * `amenities` is a catalogue with categories, and a listing naming fewer than
 * eight has almost certainly not been filled in rather than genuinely offering
 * little — every cabin has a kettle.
 */
export const MIN_AMENITIES = 8

/** Rounded up: two guests to a bed is the ordinary assumption. */
export const GUESTS_PER_BED = 2

/**
 * 4.3 out of 5.
 *
 * Not an aspiration and not a school grade. On the channels a guest actually
 * filters with, a listing below roughly this line drops out of the default
 * sort — so the threshold marks where a rating starts costing bookings rather
 * than where it stops being flattering.
 *
 * Ratings below `MIN_REVIEWS_TO_AVERAGE` never reach this comparison at all:
 * `summarise` returns a null average and the check reports `not_assessed`.
 * A new business is not a bad one.
 */
export const GOOD_RATING = 4.3

function check(
  code: string,
  area: ListingCheck['area'],
  status: ListingCheck['status'],
  weight: number,
  observed: string | null,
): ListingCheck {
  return { code, area, status, weight, observed }
}

const length = (value: string | null): number =>
  value === null ? 0 : value.trim().length

/* ---------------------------------------------------------- the property -- */

export function checkProperty(
  property: ListingProperty,
): readonly ListingCheck[] {
  const checks: ListingCheck[] = []

  const descriptionChars = length(property.description)
  checks.push(
    check(
      'property.description_present',
      'description',
      descriptionChars >= MIN_DESCRIPTION_CHARS ? 'pass' : 'warn',
      3,
      `${descriptionChars} תווים`,
    ),
  )
  checks.push(
    check(
      'property.description_full',
      'description',
      descriptionChars >= GOOD_DESCRIPTION_CHARS ? 'pass' : 'warn',
      1,
      `${descriptionChars} תווים`,
    ),
  )

  checks.push(
    check(
      'property.cover_image',
      'photos',
      property.coverImageUrl !== null ? 'pass' : 'warn',
      3,
      property.coverImageUrl === null ? 'אין' : 'יש',
    ),
  )
  checks.push(
    check(
      'property.photo_count',
      'photos',
      property.photoCount >= MIN_PHOTOS ? 'pass' : 'warn',
      2,
      `${property.photoCount} תמונות`,
    ),
  )

  checks.push(
    check(
      'property.amenities',
      'amenities',
      property.amenityCount >= MIN_AMENITIES ? 'pass' : 'warn',
      2,
      `${property.amenityCount} שירותים`,
    ),
  )

  // Coordinates, not an address. An address a guest cannot put in a map is an
  // address they will ask about by phone, and "איפה זה בדיוק" is the most
  // common question a guesthouse answers twice a day.
  const located = property.latitude !== null && property.longitude !== null
  checks.push(
    check(
      'property.coordinates',
      'location',
      located ? 'pass' : 'warn',
      2,
      located ? 'יש' : 'אין',
    ),
  )
  checks.push(
    check(
      'property.locality',
      'location',
      property.city !== null || property.region !== null ? 'pass' : 'warn',
      1,
      property.city ?? property.region ?? 'אין',
    ),
  )

  checks.push(
    check(
      'property.cancellation_policy',
      'policies',
      length(property.cancellationPolicyText) > 0 ? 'pass' : 'warn',
      3,
      length(property.cancellationPolicyText) > 0 ? 'יש' : 'אין',
    ),
  )
  checks.push(
    check(
      'property.house_rules',
      'policies',
      length(property.houseRules) > 0 ? 'pass' : 'warn',
      1,
      length(property.houseRules) > 0 ? 'יש' : 'אין',
    ),
  )

  // Guest rating stopped being unsourceable when `0066_guest_reviews.sql`
  // landed — this check is the reason that migration exists, and the reason
  // the migration makes a review impossible to delete or edit. A rating a
  // business could curate would make this number a lie told with real data.
  //
  // It still reports `not_assessed` twice over: with no reviews at all, and
  // with too few to average. Neither is a quality failure and both weigh
  // nothing, so a business that opened last month is not marked down for
  // having opened last month.
  if (property.reviewAverage === null) {
    checks.push(
      check('property.guest_rating', 'reputation', 'not_assessed', 0, null),
    )
  } else {
    checks.push(
      check(
        'property.guest_rating',
        'reputation',
        property.reviewAverage >= GOOD_RATING ? 'pass' : 'warn',
        2,
        `${property.reviewAverage} מתוך 5 · ${property.reviewCount} ביקורות`,
      ),
    )
  }

  // Hidden reviews are their own finding rather than a footnote on the rating.
  // The average above already excludes them, so without this line a business
  // could hide its way to a good score and the report would agree.
  if (property.reviewsHidden > 0) {
    checks.push(
      check(
        'property.reviews_hidden',
        'reputation',
        'warn',
        1,
        `${property.reviewsHidden} מוסתרות`,
      ),
    )
  }

  return checks
}

/* -------------------------------------------------------------- the unit -- */

export function checkUnit(unit: ListingUnit): readonly ListingCheck[] {
  const checks: ListingCheck[] = []

  const descriptionChars = length(unit.description)
  checks.push(
    check(
      'unit.description_present',
      'description',
      descriptionChars >= MIN_DESCRIPTION_CHARS ? 'pass' : 'warn',
      3,
      `${descriptionChars} תווים`,
    ),
  )

  checks.push(
    check(
      'unit.cover_image',
      'photos',
      unit.coverImageUrl !== null ? 'pass' : 'warn',
      3,
      unit.coverImageUrl === null ? 'אין' : 'יש',
    ),
  )
  checks.push(
    check(
      'unit.photo_count',
      'photos',
      unit.photoCount >= MIN_PHOTOS ? 'pass' : 'warn',
      2,
      `${unit.photoCount} תמונות`,
    ),
  )

  checks.push(
    check(
      'unit.amenities',
      'amenities',
      unit.amenityCount >= MIN_AMENITIES ? 'pass' : 'warn',
      2,
      `${unit.amenityCount} שירותים`,
    ),
  )

  const capacityStated =
    unit.maxGuests !== null && unit.bedrooms !== null && unit.bathrooms !== null
  checks.push(
    check(
      'unit.capacity_stated',
      'capacity',
      capacityStated ? 'pass' : 'warn',
      3,
      capacityStated
        ? `${unit.maxGuests} אורחים · ${unit.bedrooms} חדרים · ${unit.bathrooms} מקלחות`
        : 'חסר',
    ),
  )

  // Coherence, not just presence. "Sleeps eight" with two beds is the single
  // most common cause of a guest arriving to find the place is not what they
  // booked — and of the argument that follows.
  if (unit.maxGuests !== null && unit.beds !== null && unit.beds > 0) {
    const plausible = unit.maxGuests <= unit.beds * GUESTS_PER_BED
    checks.push(
      check(
        'unit.capacity_plausible',
        'capacity',
        plausible ? 'pass' : 'warn',
        2,
        `${unit.maxGuests} אורחים על ${unit.beds} מיטות`,
      ),
    )
  } else {
    // Not a failure: the beds count is simply absent, and guessing whether the
    // capacity is plausible without it would be inventing the answer.
    checks.push(
      check('unit.capacity_plausible', 'capacity', 'not_assessed', 0, null),
    )
  }

  checks.push(
    check(
      'unit.base_price',
      'pricing',
      unit.basePriceAgorot !== null && unit.basePriceAgorot > 0
        ? 'pass'
        : 'warn',
      3,
      unit.basePriceAgorot === null ? 'אין' : `${unit.basePriceAgorot} אגורות`,
    ),
  )

  // Present OR explicitly zero both pass. A business that charges no cleaning
  // fee has answered the question; only `null` means nobody has decided, and a
  // guest discovering an unstated fee at checkout is the complaint that
  // follows.
  checks.push(
    check(
      'unit.fees_decided',
      'pricing',
      unit.cleaningFeeAgorot !== null && unit.depositAgorot !== null
        ? 'pass'
        : 'warn',
      2,
      `ניקיון ${unit.cleaningFeeAgorot ?? 'לא הוגדר'} · פיקדון ${unit.depositAgorot ?? 'לא הוגדר'}`,
    ),
  )

  checks.push(
    check(
      'unit.size_stated',
      'capacity',
      unit.sizeSqm !== null ? 'pass' : 'warn',
      1,
      unit.sizeSqm === null ? 'אין' : `${unit.sizeSqm} מ״ר`,
    ),
  )

  checks.push(
    check('unit.conversion_rate', 'reputation', 'not_assessed', 0, null),
  )
  checks.push(check('unit.market_position', 'pricing', 'not_assessed', 0, null))

  return checks
}
