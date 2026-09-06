/**
 * Guest reviews.
 *
 * PURE. Nothing here queries and nothing here writes.
 *
 * The rule the module exists to protect, enforced in `0066_guest_reviews.sql`
 * and respected here: a business cannot edit a guest's words or score, cannot
 * delete a review, and every hidden review is counted where the average is
 * shown. `listing-quality` reads these numbers and tells somebody their
 * listing is good, so a rating that could be quietly curated would be a lie
 * told with real data.
 */

export { needsReplyFirst, summarise } from './summary'
export { DIMENSION_LABEL, REVIEW_NOTE, SOURCE_LABEL } from './labels'
export {
  MIN_REVIEWS_TO_AVERAGE,
  REVIEW_DIMENSIONS,
  type Review,
  type ReviewDimension,
  type ReviewSource,
  type ReviewStatus,
  type ReviewSummary,
} from './types'
