/**
 * What a pile of reviews adds up to.
 *
 * ══ HIDDEN REVIEWS ARE EXCLUDED FROM THE AVERAGE AND COUNTED SEPARATELY ═════
 *
 * This is the whole reason the module is careful. `0066_guest_reviews.sql`
 * makes it impossible to delete a review and requires a written reason to hide
 * one — but none of that matters if the summary quietly drops hidden rows and
 * shows a clean 4.9. The count comes back with the average, every time, so a
 * business that has hidden four of its nine reviews cannot show the same
 * number as one that has hidden none.
 *
 * A hidden review is still excluded from the average, because there are good
 * reasons to hide one — a review naming a guest's medical details, a review
 * about the wrong property. The point is not to punish hiding. The point is
 * that it is visible.
 *
 * ══ AN AVERAGE OF ONE REVIEW IS NOT AN AVERAGE ══════════════════════════════
 *
 * Under `MIN_REVIEWS_TO_AVERAGE` the average is `null` rather than a number.
 * `listing-quality` reads that as "cannot judge yet" instead of scoring a new
 * business badly for being new, which is the same rule `not_assessed` follows
 * everywhere else in this product.
 */

import {
  MIN_REVIEWS_TO_AVERAGE,
  REVIEW_DIMENSIONS,
  type Review,
  type ReviewDimension,
  type ReviewSummary,
} from './types'

const oneDecimal = (value: number): number => Math.round(value * 10) / 10

export function summarise(reviews: readonly Review[]): ReviewSummary {
  const published = reviews.filter((r) => r.status === 'published')
  const hidden = reviews.length - published.length

  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  }

  for (const review of published) {
    const star = Math.min(5, Math.max(1, Math.round(review.overall))) as
      1 | 2 | 3 | 4 | 5
    distribution[star] += 1
  }

  const average =
    published.length >= MIN_REVIEWS_TO_AVERAGE
      ? oneDecimal(
          published.reduce((sum, r) => sum + r.overall, 0) / published.length,
        )
      : null

  const dimensionAverages: Partial<Record<ReviewDimension, number>> = {}
  for (const dimension of REVIEW_DIMENSIONS) {
    // Each dimension averages over the reviews that ANSWERED it. A guest who
    // rated cleanliness and skipped location must not drag location down by
    // counting as a zero, and must not be excluded from cleanliness either.
    const scores = published
      .map((r) => r.dimensions[dimension])
      .filter((value): value is number => typeof value === 'number')

    if (scores.length >= MIN_REVIEWS_TO_AVERAGE) {
      dimensionAverages[dimension] = oneDecimal(
        scores.reduce((sum, v) => sum + v, 0) / scores.length,
      )
    }
  }

  return {
    counted: published.length,
    hidden,
    average,
    distribution,
    dimensionAverages,
    awaitingReply: published.filter((r) => r.hostReply === null).length,
  }
}

/**
 * The reviews worth answering first: unanswered, worst, oldest.
 *
 * Worst before oldest, and both before anything else. An unanswered one-star
 * from last week is the one costing bookings today; an unanswered five-star
 * from March is a courtesy. Sorting by date alone buries the first behind the
 * second.
 */
export function needsReplyFirst(reviews: readonly Review[]): readonly Review[] {
  return reviews
    .filter((r) => r.status === 'published' && r.hostReply === null)
    .slice()
    .sort(
      (a, b) => a.overall - b.overall || a.stayedAt.localeCompare(b.stayedAt),
    )
}
