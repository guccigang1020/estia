/**
 * Listing quality, in one import.
 *
 * Entirely pure — checks, arithmetic, labels — so a Client Component can
 * import it. There is no repository in this barrel because there is barely a
 * repository at all: the module reads rows somebody else already owns and
 * writes nothing, so its only adapter is a set of reads that live beside the
 * screen.
 *
 * ══ THIS MODULE HAS NO MIGRATION, AND THAT IS THE DESIGN ════════════════════
 *
 * A listing score is DERIVED. Storing it would create a number that can drift
 * from the rows it describes — a listing improved this morning would still
 * show yesterday's score until something recomputed it, and the report would
 * be confidently wrong in the one direction that matters. Computed on read, it
 * cannot be stale.
 *
 * The cost is that no history is kept, so "are we improving" cannot be
 * answered. That is a real limitation and the honest fix is a snapshot table
 * written deliberately on a schedule — not a cache pretending to be a record.
 */

export {
  LISTING_CHECK_AREAS,
  LISTING_CHECK_STATUSES,
  type ListingCheck,
  type ListingCheckArea,
  type ListingCheckStatus,
  type ListingProperty,
  type ListingReport,
  type ListingScore,
  type ListingUnit,
} from './types'

export {
  GOOD_DESCRIPTION_CHARS,
  GUESTS_PER_BED,
  MIN_AMENITIES,
  MIN_DESCRIPTION_CHARS,
  MIN_PHOTOS,
  checkProperty,
  checkUnit,
} from './checks'

export { scoreOf, weakestFirst, whatToFixFirst } from './score'

export { LISTING_AREA_LABEL, LISTING_CHECK_LABEL, labelFor } from './labels'

export { reportForProperty, reportForUnit } from './report'
