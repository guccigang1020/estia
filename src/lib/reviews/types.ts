/**
 * A guest review, reduced to what a summary needs.
 *
 * `status` is here rather than filtered away by the caller on purpose: the
 * count of HIDDEN reviews is part of the answer, not noise to be dropped
 * before the calculation. See `summary.ts`.
 */

export type ReviewStatus = 'published' | 'hidden'

export type ReviewSource = 'guest_portal' | 'entered_by_host' | 'channel_import'

export type ReviewDimension =
  'cleanliness' | 'accuracy' | 'communication' | 'location' | 'value_for_money'

export const REVIEW_DIMENSIONS: readonly ReviewDimension[] = Object.freeze([
  'cleanliness',
  'accuracy',
  'communication',
  'location',
  'value_for_money',
])

export type Review = {
  readonly id: string
  readonly propertyId: string
  readonly unitId: string | null
  readonly bookingId: string
  readonly status: ReviewStatus
  readonly source: ReviewSource
  readonly overall: number
  readonly dimensions: Readonly<Partial<Record<ReviewDimension, number>>>
  readonly comment: string | null
  readonly hostReply: string | null
  readonly stayedAt: string
}

export type ReviewSummary = {
  /** Published reviews only. */
  readonly counted: number
  /** Hidden reviews. Reported, never silently dropped. */
  readonly hidden: number
  /** Mean of `overall` across counted reviews, one decimal. Null under three. */
  readonly average: number | null
  /** How many of each star, 1..5, published only. */
  readonly distribution: Readonly<Record<1 | 2 | 3 | 4 | 5, number>>
  readonly dimensionAverages: Readonly<Partial<Record<ReviewDimension, number>>>
  /** Published reviews with no reply from the business. */
  readonly awaitingReply: number
}

/**
 * Three.
 *
 * Below three reviews an average is a coin toss — one unhappy guest takes a
 * listing from 5.0 to 3.0 and it says nothing about the place. The threshold
 * is low because guesthouses are small, and it exists so that "4.5" and "one
 * person liked it" are not shown as the same kind of fact.
 */
export const MIN_REVIEWS_TO_AVERAGE = 3
