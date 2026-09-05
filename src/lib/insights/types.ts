/**
 * What an insight is, and what it is not allowed to be.
 *
 * A report answers a question somebody asked. An insight notices something and
 * says why it matters. The difference is not the data — it is the same metric
 * dictionary underneath both — it is that an insight makes a claim, and a claim
 * without its working shown is an opinion.
 *
 * ── The rule this whole directory exists to enforce ───────────────────────
 *
 * **No number originates here.** Every figure an insight states comes from
 * `src/lib/metrics`: the value and its formatting from `computeDashboard`, the
 * operands behind it from `aggregateFacts`, the rounding from `rounding.ts`.
 * Nothing in this directory divides revenue by nights, and nothing invents a
 * threshold that the dictionary did not already carry. If an insight needs a
 * figure no canonical source produces, the insight does not ship — it is
 * reported as a gap instead. See `GAPS` in `rules.ts`.
 *
 * ── Absent, never zeroed ──────────────────────────────────────────────────
 *
 * An insight whose inputs the reader may not see, or whose module the
 * organization has not bought, is **absent** — it appears in `absent` with a
 * reason and no figure of any kind. That is the same discipline
 * `computeDashboard` applies to a withheld metric, for the same reason: a
 * disabled module rendering a confident zero is a lie about the business, and
 * it is the easiest lie to tell by accident.
 *
 * There are five reasons an insight is absent and they are genuinely
 * different. `permission` is a conversation with an administrator. `plan` is a
 * conversation with whoever owns the package. `no_data` means the source
 * returned nothing for the window. `no_baseline` means there is nothing to
 * compare against — a business three weeks old has no trend, and drawing a
 * flat line for it would be an invention. `not_measurable` means the formula
 * has no denominator: a property with no available nights is not 0% occupied.
 */

import type { Grant } from '../authz/permissions'
import type { MetricId, MetricRange, MetricState, MetricUnit } from '../metrics'
import type { Entitlement } from '../plans/entitlements'

// ── Evidence ──────────────────────────────────────────────────────────────

/**
 * One term of the arithmetic, named.
 *
 * `value` is in the metric's own storage unit — agorot for currency, whole
 * counts otherwise — and is formatted by `formatMetricValue` at the point of
 * display, never here. Two screens formatting the same operand differently is
 * the failure `src/lib/metrics/types.ts` opens by describing.
 */
export interface EvidenceOperand {
  label: string
  unit: MetricUnit
  value: number
  /** The operator that precedes this term. Absent on the first. */
  join?: '÷' | '+' | '−'
}

/**
 * One metric, with the arithmetic that produced it.
 *
 * `operands` mirror the dictionary's own formula for that metric id — see
 * `FORMULA` in `evidence.ts`, which is a transcription of `METRICS[id].compute`
 * and is asserted against the dictionary by `evidence.test.ts`.
 */
export interface MetricEvidence {
  id: MetricId
  name: string
  unit: MetricUnit
  /** Formatted by `computeDashboard`. Carried, never recomputed. */
  formatted: string
  operands: readonly EvidenceOperand[]
  /** The line a reader can check: `775 ÷ 1,240 = 62.5%`. */
  arithmetic: string
  /** Anything the formula's own labels cannot say in a word. */
  note?: string
}

/** The evidence for one window. Two blocks make a comparison checkable. */
export interface EvidenceBlock {
  periodLabel: string
  metrics: readonly MetricEvidence[]
  /** Figures that are not metrics: counted facts the claim leans on. */
  operands?: readonly EvidenceOperand[]
}

// ── An insight ────────────────────────────────────────────────────────────

/** Where the rows behind the claim live, and the grant that route requires. */
export interface InsightDestination {
  href: string
  label: string
  /** The argument to the `requireGrant` call at the top of that route. */
  requires: Grant
}

export interface Insight {
  id: InsightId
  title: string
  /** What was noticed. One sentence, in the reader's terms. */
  headline: string
  /** Why it matters. Never a restatement of the headline. */
  because: string
  tone: MetricState
  evidence: readonly EvidenceBlock[]
  /**
   * What this claim cannot support.
   *
   * A cancellation rate is measurable and where it concentrates is not, and an
   * insight that implied otherwise would send somebody looking for a
   * breakdown that does not exist.
   */
  caveat?: string
  /** Null when the reader would not be admitted to the route. */
  destination: InsightDestination | null
}

export type AbsenceReason =
  'permission' | 'plan' | 'no_data' | 'no_baseline' | 'not_measurable'

export interface InsightAbsence {
  id: InsightId
  title: string
  reason: AbsenceReason
  /** Hebrew, one or two sentences. Says what is missing and who can fix it. */
  explanation: string
  /** The package feature that would supply it. Only ever set for `plan`. */
  entitlement: Entitlement | null
  /** The metrics this insight would have read. Named, never their grants. */
  metricNames: readonly string[]
}

/**
 * A figure the product cannot produce today.
 *
 * Not a bug and not a permission: no canonical source computes it, so no
 * insight may claim it. Stated on screen so that a reader who came looking for
 * it learns why it is not there instead of assuming the screen is broken.
 */
export interface InsightGap {
  title: string
  explanation: string
}

export interface InsightReport {
  range: MetricRange
  periodLabel: string
  insights: readonly Insight[]
  absent: readonly InsightAbsence[]
  gaps: readonly InsightGap[]
  /** True when the source returned no rows at all for the window. */
  empty: boolean
}

// ── Ids ───────────────────────────────────────────────────────────────────

export const INSIGHT_IDS = [
  'occupancy_direction',
  'unsold_occupied_nights',
  'out_of_service_load',
  'inventory_anomaly',
  'revenue_per_available_night',
  'commission_load',
  'collection_gap',
  'channel_contribution',
  'cancellation_pressure',
  'lead_time_shift',
  'conversion_pressure',
  'booking_pace_direction',
] as const

export type InsightId = (typeof INSIGHT_IDS)[number]
