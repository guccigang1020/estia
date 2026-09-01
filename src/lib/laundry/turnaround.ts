/**
 * Can the linen physically be back in time.
 *
 * ── The failure this exists to catch ──────────────────────────────────────
 *
 * A guest arrives Friday at 16:00. The provider's turnaround is 48 hours. The
 * van comes Thursday morning. Every one of those three facts is ordinary, none
 * of them is a mistake, and the beds are unmade when the guest walks in.
 *
 * Nobody notices, because there is no screen on which the three facts appear
 * together. The order looks sent, the provider looks reliable and the arrival
 * looks covered. It surfaces as a phone call from a guest.
 *
 * So availability is never silently assumed. Every laundry requirement is
 * assessed against the collection instant and the turnaround that applies to
 * it, and one that cannot make the arrival raises `laundry.deadline_risk` —
 * with BOTH times in the payload, because a warning that says "at risk" and
 * makes somebody go and look up the two numbers is a warning people learn to
 * dismiss.
 *
 * ── Why the collection instant is an input ────────────────────────────────
 *
 * It would be possible to infer it: the provider collects on Sundays and
 * Wednesdays, so the next collection before Friday is Wednesday. That
 * inference is wrong on the days it matters — a public holiday, a van that did
 * not come, a Thursday collection arranged by telephone — and a confident
 * wrong "you are fine" is worse than no assessment at all. The caller supplies
 * the instant the van is actually expected, and where nobody knows, the caller
 * supplies now.
 */

import { addHours, hoursBetween, isAfter } from './dates'
import type { LaundryRequirement, TurnaroundAssessment } from './types'

export interface TurnaroundInput {
  requirements: readonly LaundryRequirement[]
  /** ISO instant the linen is collected, or is expected to be. */
  pickupAt: string
}

/**
 * Assess every requirement, at risk or not.
 *
 * Everything is returned, not only the failures. A screen that lists only
 * risks cannot show that the other eleven items are fine, and "no warnings"
 * is indistinguishable from "not checked".
 */
export function assessTurnaround(
  input: TurnaroundInput,
): readonly TurnaroundAssessment[] {
  return input.requirements.map((requirement) =>
    assessOne(requirement, input.pickupAt),
  )
}

export function assessOne(
  requirement: LaundryRequirement,
  pickupAt: string,
): TurnaroundAssessment {
  const expectedReturnAt = addHours(pickupAt, requirement.turnaroundHours)
  const atRisk = isAfter(expectedReturnAt, requirement.requiredBy)
  const shortfallHours = atRisk
    ? hoursBetween(requirement.requiredBy, expectedReturnAt)
    : 0

  return {
    itemId: requirement.itemId,
    label: requirement.label,
    propertyId: requirement.propertyId,
    pickupAt,
    turnaroundHours: requirement.turnaroundHours,
    expectedReturnAt,
    requiredBy: requirement.requiredBy,
    atRisk,
    shortfallHours,
    explanation: sentence(requirement, {
      pickupAt,
      expectedReturnAt,
      atRisk,
      shortfallHours,
    }),
  }
}

/** Only the ones that cannot make it. */
export function atRisk(
  assessments: readonly TurnaroundAssessment[],
): readonly TurnaroundAssessment[] {
  return assessments.filter((assessment) => assessment.atRisk)
}

/**
 * The payload of `laundry.deadline_risk`.
 *
 * Both instants, named, plus the shortfall already computed. A subscriber that
 * had to re-derive "how late" from two timestamps would eventually derive it
 * differently from the screen, and the notification and the dashboard would
 * disagree about the same risk.
 */
export interface DeadlineRiskPayload {
  itemId: string
  label: string
  propertyId: string
  /** ISO instant. When the linen leaves. */
  pickupAt: string
  /** ISO instant. When it comes back. */
  expectedReturnAt: string
  /** ISO instant. When it is needed. */
  requiredBy: string
  turnaroundHours: number
  shortfallHours: number
}

export function deadlineRiskPayload(
  assessment: TurnaroundAssessment,
): DeadlineRiskPayload {
  return {
    itemId: assessment.itemId,
    label: assessment.label,
    propertyId: assessment.propertyId,
    pickupAt: assessment.pickupAt,
    expectedReturnAt: assessment.expectedReturnAt,
    requiredBy: assessment.requiredBy,
    turnaroundHours: assessment.turnaroundHours,
    shortfallHours: assessment.shortfallHours,
  }
}

/**
 * The latest the van can collect and still make the deadline.
 *
 * The actionable half of a risk warning. "At risk" tells somebody there is a
 * problem; "collect by Wednesday 08:00" tells them what to do about it, and it
 * is one subtraction away.
 */
export function latestPickupFor(requirement: LaundryRequirement): string {
  return addHours(requirement.requiredBy, -requirement.turnaroundHours)
}

function sentence(
  requirement: LaundryRequirement,
  facts: {
    pickupAt: string
    expectedReturnAt: string
    atRisk: boolean
    shortfallHours: number
  },
): string {
  const when = `נאסף ב-${clock(facts.pickupAt)}, חוזר ב-${clock(facts.expectedReturnAt)}, נדרש ב-${clock(requirement.requiredBy)}`

  return facts.atRisk
    ? `${requirement.label}: ${when} — באיחור של ${facts.shortfallHours} שעות. זמן הטיפול הוא ${requirement.turnaroundHours} שעות.`
    : `${requirement.label}: ${when} — בזמן.`
}

/**
 * A readable instant for a Hebrew sentence.
 *
 * Deliberately not `Intl.DateTimeFormat` with a timezone: this string is
 * embedded in an explanation that is stored and compared in tests, and a
 * formatter whose output depends on the machine's locale data makes the
 * assertion machine-dependent. The screens format for display; this is the
 * record.
 */
function clock(instant: string): string {
  const at = new Date(instant)
  if (Number.isNaN(at.getTime())) return instant
  const [date, time] = at.toISOString().split('T')
  return `${date ?? instant} ${(time ?? '').split('.')[0] ?? ''}`.trim()
}
