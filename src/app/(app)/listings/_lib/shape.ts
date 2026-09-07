/**
 * EXECUTION CONTEXT — PURE. No I/O.
 *
 * The listing reports, counted for the row of instruments above them.
 *
 * ── WHAT AN AVERAGE OF SCORES IS, AND WHAT IT IS NOT ──────────────────────
 *
 * A plain mean over the listings this product could judge at all. Not a
 * weighted one: `ListingScore` keeps `score`, `assessed` and `notAssessed`, and
 * not the earned/possible weights it was built from, so a genuinely pooled
 * score is not derivable here and is not faked. Every listing therefore counts
 * once regardless of how many checks applied to it, which is the definition
 * the screen states in words underneath.
 *
 * ── LISTINGS THAT CANNOT BE JUDGED ARE OUTSIDE THE AVERAGE ────────────────
 *
 * `weakestFirst` already argues this for the ordering: a listing with nothing
 * assessable scores 0 and is not the worst listing — it is the one the product
 * knows least about. Feeding that 0 into an average would drag the business's
 * headline number down for a listing nobody has failed at yet, and would do it
 * silently. They are counted separately and named on screen instead.
 *
 * With no judgeable listing at all, the average is `null`. Never 0: a business
 * whose properties have no units yet would otherwise read "0 מתוך 100" and
 * conclude the product graded them, rather than that it could not.
 */

import type { ListingCheck, ListingScore } from '@/lib/listing-quality'

/** The part of a report this module reads. Deliberately not the whole report. */
export interface ScoredListing {
  readonly score: ListingScore
  readonly checks: readonly ListingCheck[]
}

export interface ListingsShape {
  /** Reports in view, judgeable or not. */
  readonly listings: number
  /** Reports with at least one check the product could apply. */
  readonly judgeable: number
  /** Reports with nothing assessable — outside the average, by name. */
  readonly blind: number
  /** Findings across every report: checks that came back `warn`. */
  readonly findings: number
  /** Judgeable reports carrying at least one finding. */
  readonly withFindings: number
  /**
   * Mean score over judgeable reports, 0..100, rounded. Null when none.
   *
   * `Dial` wants a fraction, so the caller divides — this module keeps the
   * number in the unit the rest of the listing-quality module speaks.
   */
  readonly averageScore: number | null
}

export function listingsShape(
  reports: readonly ScoredListing[],
): ListingsShape {
  let judgeable = 0
  let total = 0
  let findings = 0
  let withFindings = 0

  for (const report of reports) {
    const warnings = report.checks.filter(
      (check) => check.status === 'warn',
    ).length
    findings += warnings

    if (report.score.assessed === 0) continue

    judgeable += 1
    total += report.score.score
    if (warnings > 0) withFindings += 1
  }

  return {
    listings: reports.length,
    judgeable,
    blind: reports.length - judgeable,
    findings,
    withFindings,
    averageScore: judgeable > 0 ? Math.round(total / judgeable) : null,
  }
}
