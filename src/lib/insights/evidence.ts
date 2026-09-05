/**
 * The arithmetic behind a figure, transcribed from the dictionary.
 *
 * `METRICS[id].compute` is a one-liner over `MetricFacts` — that is the whole
 * design of `src/lib/metrics/dictionary.ts`, and it is what makes this file
 * possible without a second definition of anything. Each entry below names the
 * same fact fields that metric's formula reads, in the same order, joined by
 * the same operator. Nothing here computes the metric: the value and its
 * formatting arrive on `MetricResult`, produced once by `computeDashboard`.
 *
 * `evidence.test.ts` holds the transcription honest in the only way that
 * matters mechanically — it recomputes each metric from the operands this file
 * declares and asserts the result equals `METRICS[id].compute(facts)`. A
 * formula that changes in the dictionary and not here fails there.
 *
 * ── Evidence is gated exactly as the figure is ────────────────────────────
 *
 * Two rules, and the second was found by a test rather than by reasoning.
 *
 * First: `buildInsightReport` asks for evidence only for metrics
 * `computeDashboard` did not withhold. A withheld metric produces no operands
 * at all, which is why ADR's `roomRevenue` operand is safe — nobody reaches
 * ADR without `report.financial.view`, and the division is invertible anyway,
 * so a screen showing ADR beside sold nights has disclosed revenue whether or
 * not it printed it.
 *
 * Second, and less obvious: **a metric may be allowed while its operands are
 * not.** `direct_booking_share` is a percentage gated on
 * `booking.view_source`, and its formula is revenue over revenue. A general
 * manager legitimately holds the share and legitimately does not hold revenue
 * — and the first version of this file handed them "₪0 ÷ ₪2,400" under the
 * percentage. So a formula may declare `operandsRequire`: the metric whose own
 * grant covers its operands. When the reader did not receive that metric, the
 * line is redacted and says so, rather than being shown, being zeroed, or
 * taking the perfectly permitted percentage above it down with it.
 *
 * The first attempt at that test was "does this reader hold *any* currency
 * metric", and it was wrong for the exact person it was written for: a general
 * manager holds `commission.view`, so they do receive one currency figure —
 * what the agent network cost, which is theirs — while holding no revenue at
 * all. A coarse money flag passed, and revenue leaked underneath it. The
 * question has to name the metric.
 */

import {
  formatMetricValue,
  type MetricFacts,
  type MetricId,
  type MetricResult,
} from '../metrics'

import type { EvidenceOperand, MetricEvidence } from './types'

// ── The transcription ─────────────────────────────────────────────────────

type Formula = {
  operands: (facts: MetricFacts) => readonly EvidenceOperand[]
  /** What the labels alone cannot say. */
  note?: (facts: MetricFacts) => string
  /**
   * The metric whose grant covers these operands, when it is not this one.
   *
   * Set only where a formula's terms are more sensitive than the figure they
   * produce. Absent means the metric's own grant is sufficient, which is the
   * ordinary case: ADR is money, is gated on money, and its operands are the
   * money it divides.
   */
  operandsRequire?: MetricId
}

const count = (label: string, value: number): EvidenceOperand => ({
  label,
  unit: 'count',
  value,
})

const money = (label: string, value: number): EvidenceOperand => ({
  label,
  unit: 'currency',
  value,
})

const over = (operand: EvidenceOperand): EvidenceOperand => ({
  ...operand,
  join: '÷',
})

const plus = (operand: EvidenceOperand): EvidenceOperand => ({
  ...operand,
  join: '+',
})

const minus = (operand: EvidenceOperand): EvidenceOperand => ({
  ...operand,
  join: '−',
})

/**
 * One entry per metric id, and the type demands it.
 *
 * A metric added to the dictionary without a formula here fails to compile,
 * which is the point: an insight that cited a figure with no visible
 * arithmetic would be exactly the opinion this screen exists not to publish.
 */
export const FORMULA: Readonly<Record<MetricId, Formula>> = {
  occupancy: {
    operands: (facts) => [
      count('לילות תפוסים', facts.occupiedUnitNights),
      over(count('לילות זמינים למכירה', facts.availableUnitNights)),
    ],
  },

  adr: {
    operands: (facts) => [
      money('הכנסה מלינה', facts.roomRevenue),
      over(count('לילות שנמכרו', facts.soldUnitNights)),
    ],
    note: (facts) =>
      facts.occupiedUnitNights === facts.soldUnitNights
        ? ''
        : `המכנה אינו התפוסה: ${facts.occupiedUnitNights - facts.soldUnitNights} לילות תפוסים לא נמכרו ואינם נספרים כאן.`,
  },

  revpar: {
    operands: (facts) => [
      money('הכנסה מלינה', facts.roomRevenue),
      over(count('לילות זמינים למכירה', facts.availableUnitNights)),
    ],
  },

  revenue: {
    operands: (facts) => [
      money('לינה', facts.roomRevenue),
      plus(money('תוספות ושירותים', facts.ancillaryRevenue)),
    ],
  },

  net_operating_revenue: {
    operands: (facts) => [
      money('לינה', facts.roomRevenue),
      plus(money('תוספות ושירותים', facts.ancillaryRevenue)),
      minus(money('עמלות ערוצים וסוכנים', facts.commission)),
    ],
    note: () => 'זה אינו רווח — הוצאות התפעול אינן נכללות.',
  },

  direct_booking_share: {
    // A percentage gated on `booking.view_source`, divided out of two figures
    // gated on `report.financial.view`. The only entry in the dictionary where
    // the terms are more sensitive than the answer.
    operandsRequire: 'revenue',
    operands: (facts) => [
      money('הכנסה ממקורות ישירים', facts.directRevenue),
      over(money('סך ההכנסות', facts.roomRevenue + facts.ancillaryRevenue)),
    ],
  },

  commission_cost: {
    operands: (facts) => [money('עמלות ערוצים וסוכנים', facts.commission)],
  },

  outstanding_balance: {
    operands: (facts) => [
      money('חויב על ההגעות בתקופה', facts.billed),
      minus(money('נגבה בפועל', facts.collected)),
    ],
  },

  collected: {
    operands: (facts) => [money('נגבה בפועל', facts.collected)],
  },

  average_booking_value: {
    operands: (facts) => [
      money('חויב על ההגעות בתקופה', facts.billed),
      over(count('הזמנות שהגיעו', facts.soldBookingCount)),
    ],
  },

  booking_pace: {
    operands: (facts) => [
      count('הזמנות שנסגרו בתקופה', facts.committedInRangeCount),
    ],
  },

  lead_time: {
    operands: (facts) => [
      { label: 'סך הימים מראש', unit: 'days', value: facts.leadTimeDayTotal },
      over(count('הזמנות שנספרו', facts.leadTimeSample)),
    ],
  },

  length_of_stay: {
    operands: (facts) => [
      { label: 'סך הלילות', unit: 'nights', value: facts.stayNightTotal },
      over(count('שהיות שהתחילו בתקופה', facts.stayCount)),
    ],
  },

  conversion_rate: {
    operands: (facts) => [
      count('נסגרו מתוכן', facts.createdCommittedCount),
      over(count('פניות והצעות שנפתחו בתקופה', facts.createdBookingCount)),
    ],
  },

  cancellation_rate: {
    operands: (facts) => [
      count('הגעות שבוטלו', facts.cancelledArrivalCount),
      over(
        count(
          'הגעות שהיו אמורות להתחיל',
          facts.cancelledArrivalCount + facts.realisedArrivalCount,
        ),
      ),
    ],
    note: (facts) =>
      `המכנה הוא ${facts.realisedArrivalCount} הגעות שהתממשו בתוספת ${facts.cancelledArrivalCount} שבוטלו.`,
  },
}

// ── Rendering the line ────────────────────────────────────────────────────

/** `775 ÷ 1,240 = 62.5%`, or just the figure when there is one term. */
export function arithmeticLine(
  operands: readonly EvidenceOperand[],
  formatted: string,
): string {
  const expression = operands
    .map((operand, index) => {
      const value = formatMetricValue(operand.unit, operand.value)
      return index === 0 ? value : `${operand.join} ${value}`
    })
    .join(' ')

  // A single term is its own answer. `₪4,200 = ₪4,200` is noise that teaches
  // a reader to stop reading the line that is the whole point of the card.
  return operands.length > 1 ? `${expression} = ${formatted}` : expression
}

/**
 * The sentence that replaces terms nobody may see.
 *
 * A redaction, said out loud. The alternative — printing the percentage with
 * no line under it — reads as an insight somebody forgot to finish, and the
 * alternative to that is a zero, which is a claim about the business.
 */
const REDACTED_NOTE =
  'הפירוט מתחת לשיעור הזה מורכב מסכומי כסף שאינם בהרשאות שלך, ולכן אינו מוצג. השיעור עצמו כן — הוא אינו חושף סכום.'

/**
 * Which metrics this reader actually received.
 *
 * A predicate over the response rather than over the actor's grants, so it
 * cannot disagree with what `computeDashboard` decided. `() => true` is the
 * default because a caller with no response to check is a test of the
 * formatting, not of the gate.
 */
export type MetricVisibility = (id: MetricId) => boolean

const EVERYTHING: MetricVisibility = () => true

function build(
  result: MetricResult,
  facts: MetricFacts,
  formatted: string,
  canSee: MetricVisibility,
): MetricEvidence {
  const formula = FORMULA[result.id]
  const declared = formula.operands(facts)
  const note = formula.note?.(facts)

  const guard = formula.operandsRequire
  if (guard !== undefined && !canSee(guard)) {
    return {
      id: result.id,
      name: result.name,
      unit: result.unit,
      formatted,
      operands: [],
      arithmetic: formatted,
      note: REDACTED_NOTE,
    }
  }

  return {
    id: result.id,
    name: result.name,
    unit: result.unit,
    formatted,
    operands: declared,
    arithmetic: arithmeticLine(declared, formatted),
    ...(note !== undefined && note.length > 0 ? { note } : {}),
  }
}

/**
 * One metric's evidence for the measured window.
 *
 * Takes the `MetricResult` rather than a value, because the result is what
 * carries the formatting `computeDashboard` already did — and because a result
 * only exists for a metric the actor was actually allowed to receive.
 *
 * `canSee` answers whether the reader received a given metric, and is used
 * only for a formula that declares `operandsRequire`. It is derived from the
 * response rather than from a grant, so it cannot disagree with what the
 * domain decided.
 */
export function metricEvidence(
  result: MetricResult,
  facts: MetricFacts,
  canSee: MetricVisibility = EVERYTHING,
): MetricEvidence {
  return build(result, facts, result.formatted, canSee)
}

/**
 * The same metric's evidence for the comparison window.
 *
 * The baseline value is read off `result.comparison`, which `compareValues`
 * produced from `METRICS[id].compute(baselineFacts)` — so the figure and the
 * operands under it come from the same window, and a comparison a reader
 * cannot check is not published. A baseline that held no rows formats as `—`,
 * because `formatMetricValue` renders `null` that way and a zero here would be
 * the exact lie `periods.ts` refuses to tell.
 */
export function baselineEvidence(
  result: MetricResult,
  baselineFacts: MetricFacts,
  canSee: MetricVisibility = EVERYTHING,
): MetricEvidence {
  const value = result.comparison?.value ?? null
  return build(
    result,
    baselineFacts,
    formatMetricValue(result.unit, value),
    canSee,
  )
}
