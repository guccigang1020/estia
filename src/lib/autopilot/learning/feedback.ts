/**
 * Helpful · Not helpful · Wrong — and the one thing feedback may change.
 *
 * ── Feedback changes FREQUENCY, never a rule ──────────────────────────────
 *
 * Pressing "not helpful" on a recommendation means "stop showing me this so
 * often". It must never mean "change how the business works". A system that
 * quietly retunes a business rule because somebody dismissed a card three
 * times has made a decision nobody made, and the business will discover it
 * months later as behaviour it cannot account for.
 *
 * That constraint is visible in the return type and not only in this comment:
 * every function here returns a `Damping` — a cadence and an explanation — and
 * nothing in this file returns a rule, a parameter, a threshold or a policy.
 * There is no shape for feedback to leak through.
 *
 * ── A safety alert is never damped. Ever. ─────────────────────────────────
 *
 * This is the exception the module exists to encode. False-positive damping is
 * a good idea for an optimization tip and a catastrophic one for "the guest
 * has no way into the property at 22:40". Somebody who dismissed six of those
 * because the first five resolved themselves has not told the system the sixth
 * does not matter; they have told it the first five were fixed.
 *
 * So `dampingFor` short-circuits on the `safety` domain and on any target the
 * caller has marked as a critical alert, BEFORE it counts anything. The
 * dismissals are still counted and still reported — a manager should be able
 * to see that they keep dismissing these — but the cadence stays at every
 * time, and no number of dismissals moves it.
 */

import type { AutopilotDomain } from '../../contracts/states'

/* ------------------------------------------------------------- verdicts -- */

export const FEEDBACK_VERDICTS = ['helpful', 'not_helpful', 'wrong'] as const

export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number]

/** Hebrew, for the three buttons. */
export const VERDICT_LABELS: Readonly<Record<FeedbackVerdict, string>> = {
  helpful: 'עזר',
  not_helpful: 'לא עזר',
  wrong: 'שגוי',
}

/**
 * What each verdict is worth when counting dismissals.
 *
 * Exported and named so the weighting is arguable rather than buried. `wrong`
 * is worth two because it says the suggestion was mistaken and not merely
 * unwanted, and `helpful` is worth minus one because a suggestion that landed
 * once should not stay quiet on the strength of an old dismissal.
 */
export const VERDICT_WEIGHT: Readonly<Record<FeedbackVerdict, number>> = {
  helpful: -1,
  not_helpful: 1,
  wrong: 2,
}

export interface FeedbackRecord {
  /**
   * What the feedback was about — a `patternCode` for a candidate, a signal
   * `code` for a recommendation. Opaque here on purpose: this module counts,
   * and does not need to know which screen the card was on.
   */
  targetKey: string
  verdict: FeedbackVerdict
  /** Who pressed it. Feedback with no author is not feedback. */
  givenBy: string
  givenAt: string
}

/* ------------------------------------------------------------ exemption -- */

/**
 * Domains that are never damped, whatever the feedback says.
 *
 * `safety` is the required member and the reason this list exists. It is a
 * list rather than an equality test so that adding a second domain is a
 * deliberate, reviewable edit — and so a reader can see that exactly one
 * domain is currently exempt.
 */
export const DAMPING_EXEMPT_DOMAINS: readonly AutopilotDomain[] = ['safety']

export interface DampingTarget {
  key: string
  domain: AutopilotDomain
  /**
   * A critical alert outside the `safety` domain — a guest with no access at
   * night, a payment deadline that ends the booking.
   *
   * Set by the caller from the signal it already holds, never inferred here:
   * this module has no signal and guessing at criticality from a domain name
   * is exactly the kind of second opinion Autopilot does not form.
   */
  criticalAlert?: boolean
}

/* -------------------------------------------------------------- damping -- */

export interface Damping {
  /** Raise it once every N detections. `1` means every time. */
  raiseEvery: number
  /**
   * True when it is no longer raised on its own. It is still listed for
   * somebody who goes looking — quiet is not deleted, and a suggestion that
   * vanished entirely is one nobody can reconsider.
   */
  quiet: boolean
  /** The weighted count behind the decision. Always reported. */
  dismissals: number
  /** True when damping was refused because this is a safety alert. */
  exempt: boolean
  /** Hebrew, one sentence, for the screen. */
  explanation: string
}

/**
 * The ladder, in one place.
 *
 * HEURISTIC, and openly so: there is no measurement saying that the second
 * dismissal should halve the cadence rather than the third. What is not a
 * heuristic is the count it reads, which is a plain weighted sum of verdicts.
 */
export const DAMPING_LADDER: readonly {
  atDismissals: number
  every: number
}[] = [
  { atDismissals: 0, every: 1 },
  { atDismissals: 1, every: 2 },
  { atDismissals: 2, every: 4 },
]

/** Dismissals at or above this go quiet. */
export const QUIET_AT_DISMISSALS = 3

/** The weighted dismissal count, floored at zero. Arithmetic, not judgment. */
export function countDismissals(
  feedback: readonly FeedbackRecord[],
  targetKey: string,
): number {
  const total = feedback
    .filter((one) => one.targetKey === targetKey)
    .reduce((sum, one) => sum + VERDICT_WEIGHT[one.verdict], 0)

  return Math.max(0, total)
}

/**
 * How often this may be raised, given what people have said about it.
 *
 * The exemption is checked first and returns before any ladder is consulted,
 * which is what makes "a safety alert is never damped" a property of the
 * control flow rather than of a threshold somebody could tune to zero.
 */
export function dampingFor(
  target: DampingTarget,
  feedback: readonly FeedbackRecord[],
): Damping {
  const dismissals = countDismissals(feedback, target.key)

  if (
    DAMPING_EXEMPT_DOMAINS.includes(target.domain) ||
    target.criticalAlert === true
  ) {
    return {
      raiseEvery: 1,
      quiet: false,
      dismissals,
      exempt: true,
      explanation:
        'התראת בטיחות מוצגת בכל פעם שהיא מזוהה. משוב עליה נשמר ונספר, ' +
        'אך אינו מפחית את תדירות ההצגה.',
    }
  }

  if (dismissals >= QUIET_AT_DISMISSALS) {
    return {
      raiseEvery: DAMPING_LADDER[DAMPING_LADDER.length - 1].every,
      quiet: true,
      dismissals,
      exempt: false,
      explanation:
        `ההצעה נדחתה ${dismissals} פעמים ולכן אינה מוצגת מיוזמתה. היא ` +
        'נשארת ברשימת ההצעות המושתקות וניתן להחזיר אותה.',
    }
  }

  const rung =
    [...DAMPING_LADDER]
      .reverse()
      .find((step) => dismissals >= step.atDismissals) ?? DAMPING_LADDER[0]

  return {
    raiseEvery: rung.every,
    quiet: false,
    dismissals,
    exempt: false,
    explanation:
      rung.every === 1
        ? 'ההצעה מוצגת בכל פעם שהדפוס מזוהה.'
        : `לאחר ${dismissals} דחיות, ההצעה מוצגת אחת ל-${rung.every} זיהויים.`,
  }
}

/**
 * Whether this detection is one of the ones that gets shown.
 *
 * `detectionCount` is how many times the pattern has been detected including
 * this one, supplied by the caller from the stored candidate's occurrence
 * history. A modulus over a counter rather than a random draw, so two runs
 * over the same state agree — a suggestion that appears and disappears
 * depending on the roll of a die is a suggestion nobody trusts.
 */
export function shouldRaise(damping: Damping, detectionCount: number): boolean {
  if (damping.quiet) return false
  if (damping.raiseEvery <= 1) return true
  return detectionCount % damping.raiseEvery === 0
}
