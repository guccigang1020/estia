/**
 * What a listing is worth, as a guest would judge it.
 *
 * ══ THE LAW, INHERITED FROM `website/quality.ts` ════════════════════════════
 *
 *   A CHECK THAT CANNOT BE SOURCED FROM REAL DATA REPORTS `not_assessed`.
 *
 * Not a zero, not a guess, not "7/10". `not_assessed` is a first-class status
 * here for the same reason it is there: a report that scores what it cannot
 * measure is decoration, and decoration is what makes people stop reading
 * reports. Three things this product genuinely cannot assess today, and each
 * says so rather than inventing a number:
 *
 *   · **Guest ratings.** `review.view` and `review.manage` are in the
 *     permission catalogue and there is no reviews table in any migration.
 *     The grants point at nothing, which is the same shape `message.assign`
 *     was in before 0063.
 *   · **How the listing converts.** No analytics source exists. Views,
 *     enquiry rate and booking rate are all unmeasurable here.
 *   · **How it compares to the market.** That is the fourth module and it has
 *     no data source at all yet, so nothing here claims a position.
 *
 * ══ IT SCORES A LISTING, NOT A WEBSITE ══════════════════════════════════════
 *
 * `website/quality.ts` judges site pages and sections — the marketing surface.
 * This judges the LISTING: what a guest evaluating a stay actually needs to
 * know before booking. The two overlap in tone and share the law, and they are
 * deliberately not merged: a business with no website still has listings, and
 * a listing check that only ran for site owners would be silent for exactly
 * the businesses that need it most.
 *
 * ══ NOTHING HERE BLOCKS ANYTHING ════════════════════════════════════════════
 *
 * There is no `blocker` severity in this module. `website/quality.ts` has one
 * and uses it only for claims that cannot be sourced, because publishing a
 * false claim is a different class of act. A listing with a short description
 * is merely a listing that will convert less well, and a tool that refused to
 * let a business rent its own cabin over a missing field is a tool that gets
 * switched off — after which nothing is checked at all.
 */

export const LISTING_CHECK_STATUSES = [
  'pass',
  'warn',
  /** The data needed to judge this does not exist in the product. */
  'not_assessed',
] as const

export type ListingCheckStatus = (typeof LISTING_CHECK_STATUSES)[number]

/**
 * What a finding is about. Grouped the way a person would fix them: a morning
 * spent on photos is a different morning from one spent on pricing.
 */
export const LISTING_CHECK_AREAS = [
  'description',
  'photos',
  'amenities',
  'capacity',
  'pricing',
  'policies',
  'location',
  'reputation',
] as const

export type ListingCheckArea = (typeof LISTING_CHECK_AREAS)[number]

export interface ListingCheck {
  /** Stable across releases. The Hebrew lives in `labels.ts`. */
  readonly code: string
  readonly area: ListingCheckArea
  readonly status: ListingCheckStatus
  /**
   * What this check contributes when it passes, and what it costs when it does
   * not. Zero for `not_assessed`, which is what keeps an unmeasurable check
   * from quietly dragging a score down.
   */
  readonly weight: number
  /** The actual value that produced the verdict, for a person who disagrees. */
  readonly observed: string | null
}

export interface ListingScore {
  /**
   * 0–100, over the checks that could be assessed.
   *
   * `not_assessed` checks are excluded from BOTH the numerator and the
   * denominator. A business is not penalised for a measurement this product
   * cannot take, and is not credited for one either.
   */
  readonly score: number
  readonly assessed: number
  readonly notAssessed: number
}

export interface ListingReport {
  readonly propertyId: string
  readonly unitId: string | null
  readonly name: string
  readonly score: ListingScore
  readonly checks: readonly ListingCheck[]
}

/** The subset of a property this module reads. Nothing is written. */
export interface ListingProperty {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly city: string | null
  readonly region: string | null
  readonly latitude: number | null
  readonly longitude: number | null
  readonly houseRules: string | null
  readonly cancellationPolicyText: string | null
  readonly coverImageUrl: string | null
  readonly amenityCount: number
  readonly photoCount: number

  /**
   * Published reviews, and their mean.
   *
   * `reviewAverage` is null when there are none and also when there are too
   * few to average — `reviews/summary.ts` decides which, and the difference
   * does not matter here because both mean the same thing to a report: this
   * cannot be judged yet, and not judging it is not a mark against anybody.
   *
   * `reviewsHidden` is separate and is never folded into the average. A
   * business that hid its bad reviews must not be able to show the same
   * number as one that did not.
   */
  readonly reviewCount: number
  readonly reviewAverage: number | null
  readonly reviewsHidden: number
}

/** The subset of a unit this module reads. */
export interface ListingUnit {
  readonly id: string
  readonly propertyId: string
  readonly name: string
  readonly description: string | null
  readonly maxGuests: number | null
  readonly bedrooms: number | null
  readonly bathrooms: number | null
  readonly beds: number | null
  readonly sizeSqm: number | null
  readonly basePriceAgorot: number | null
  readonly cleaningFeeAgorot: number | null
  readonly depositAgorot: number | null
  readonly minNights: number | null
  readonly coverImageUrl: string | null
  readonly amenityCount: number
  readonly photoCount: number
}
