/**
 * Turning findings into a number, and refusing to when it would be a lie.
 *
 * ══ `not_assessed` IS EXCLUDED FROM BOTH SIDES OF THE FRACTION ══════════════
 *
 * This is the whole arithmetic and it is worth being exact about, because the
 * two obvious alternatives are both wrong:
 *
 *   · Counting it as a FAILURE punishes a business for a measurement this
 *     product cannot take. A guesthouse with no reviews table in the schema
 *     would score lower than one with — and there is no such thing as one with.
 *   · Counting it as a PASS inflates every score by the same amount and makes
 *     the number meaningless in exactly the way that stops people reading it.
 *
 * So it is excluded, `weight` is zero for those checks, and the report says
 * how many were skipped. A score of 80 over eight checks and a score of 80
 * over twelve are different facts, and the reader is told which one they have.
 *
 * ══ THERE IS NO GRADE, AND NO ✓ ═════════════════════════════════════════════
 *
 * No letter, no "excellent", no green tick at 90. A band name is a judgement
 * this module has not earned: nothing here has been calibrated against a
 * single real booking outcome, so "excellent" would mean "passed the checks I
 * happened to write". The number and the list of what failed are honest; a
 * verdict on top of them would not be.
 */

import type { ListingCheck, ListingScore } from './types'

export function scoreOf(checks: readonly ListingCheck[]): ListingScore {
  let earned = 0
  let possible = 0
  let assessed = 0
  let notAssessed = 0

  for (const check of checks) {
    if (check.status === 'not_assessed') {
      notAssessed += 1
      continue
    }
    assessed += 1
    possible += check.weight
    if (check.status === 'pass') earned += check.weight
  }

  // Nothing measurable at all. Zero would read as "this listing is terrible"
  // when the truth is "nothing could be judged", and those must not look the
  // same on a screen.
  if (possible === 0) {
    return { score: 0, assessed: 0, notAssessed }
  }

  return {
    score: Math.round((earned / possible) * 100),
    assessed,
    notAssessed,
  }
}

/**
 * What to fix first.
 *
 * Failed checks, heaviest first. Not grouped by area, deliberately: a person
 * with twenty minutes wants the one change that moves the number most, and
 * area grouping buries a weight-3 failure under three weight-1 ones from the
 * same category.
 *
 * `not_assessed` never appears here. It is not something anybody can fix.
 */
export function whatToFixFirst(
  checks: readonly ListingCheck[],
  limit = 5,
): readonly ListingCheck[] {
  return checks
    .filter((check) => check.status === 'warn')
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
}

/**
 * The weakest listings first.
 *
 * A listing with nothing assessable sorts LAST rather than first, even though
 * its score is zero: it is not the worst listing, it is the one this product
 * knows least about, and putting it at the top of a "fix these" list would
 * send somebody to work on a listing the report cannot judge.
 */
export function weakestFirst<T extends { score: ListingScore }>(
  reports: readonly T[],
): readonly T[] {
  return [...reports].sort((a, b) => {
    const aBlind = a.score.assessed === 0
    const bBlind = b.score.assessed === 0
    if (aBlind !== bBlind) return aBlind ? 1 : -1
    return a.score.score - b.score.score
  })
}
