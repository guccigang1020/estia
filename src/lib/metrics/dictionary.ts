/**
 * The metric dictionary.
 *
 * Every business measure ESTIA reports is defined here exactly once: a stable
 * machine id, the Hebrew name a hotelier reads, a one-line Hebrew definition
 * plain enough for somebody who is not an accountant, the unit, which direction
 * is good news, the grant required to see it, and the formula as an actual
 * function.
 *
 * The formulas are deliberately one-liners. Everything difficult has already
 * happened in `facts.ts`, where the arguable decisions are made and commented.
 * If a formula here needs a paragraph of explanation, the explanation belongs
 * over there.
 *
 * Adding a measure to the product means adding it here first. A metric with no
 * definition, no unit, no Hebrew wording or no required grant fails
 * `dictionary.test.ts` — the dictionary staying complete is the entire point of
 * having one.
 */

import type { Grant } from '../authz/permissions'
import type { BookingSource, Agorot } from '../booking/types'
import { formatAgorot } from '../plans/plan'
import type { MetricFacts } from './facts'
import { agorotPer, allocateShares, averagePer, percentOf } from './rounding'
import type {
  MetricSentiment,
  MetricThresholds,
  MetricUnit,
  MetricValue,
} from './types'

// ── The catalogue ─────────────────────────────────────────────────────────

export const METRIC_IDS = [
  'occupancy',
  'adr',
  'revpar',
  'revenue',
  'net_operating_revenue',
  'direct_booking_share',
  'commission_cost',
  'outstanding_balance',
  'collected',
  'average_booking_value',
  'booking_pace',
  'lead_time',
  'length_of_stay',
  'conversion_rate',
  'cancellation_rate',
] as const

export type MetricId = (typeof METRIC_IDS)[number]

const METRIC_ID_SET: ReadonlySet<string> = new Set(METRIC_IDS)

export function isMetricId(value: string): value is MetricId {
  return METRIC_ID_SET.has(value)
}

// ── The definition ────────────────────────────────────────────────────────

export interface MetricDefinition {
  id: MetricId
  /** Hebrew, as it appears on the tile. */
  name: string
  /** Hebrew, one line, shown in the tooltip. Written for an operator. */
  description: string
  unit: MetricUnit
  /** Which direction is good news. Decides colour, never the sign of a delta. */
  sentiment: MetricSentiment
  /**
   * Does the figure grow simply because the window is longer?
   *
   * Revenue does; occupancy does not. It is the difference between a
   * comparison that survives February being three nights shorter than March and
   * one that does not, and it is why the comparison carries `comparable`.
   */
  extensive: boolean
  /** The grant required to receive the number at all. */
  requires: Grant
  /**
   * The grant required to open the records behind the number.
   *
   * Seeing "יתרה לגבייה ₪12,000" and seeing the list of payments that produced
   * it are different rights, and a business genuinely grants one without the
   * other — a shift manager chases the total without being handed the ledger.
   * Absent means the aggregate carries no drill-down.
   */
  detailRequires?: Grant
  /** Absolute lines that mean something regardless of last month. */
  thresholds?: MetricThresholds
  compute: (facts: MetricFacts) => MetricValue
}

/**
 * The dictionary.
 *
 * `occupancy`, `adr` and `revpar` implement the specification's formulas
 * literally: occupied ÷ available, room revenue ÷ sold, room revenue ÷
 * available. What "occupied", "available" and "sold" mean is settled in
 * `facts.ts` and nowhere else.
 */
export const METRICS: Readonly<Record<MetricId, MetricDefinition>> = {
  occupancy: {
    id: 'occupancy',
    name: 'תפוסה',
    description:
      'אחוז הלילות שהיו תפוסים מתוך הלילות שהיו זמינים למכירה בתקופה.',
    unit: 'percentage',
    sentiment: 'higher_is_better',
    extensive: false,
    // Occupancy is free/busy arithmetic and nothing more. It exposes no price,
    // no guest and no channel, so it is gated by the availability right rather
    // than by a financial one — an external seller may be told how full the
    // property is without being shown a shekel.
    requires: 'availability.view',
    detailRequires: 'booking.view',
    thresholds: { warningBelow: 50, criticalBelow: 30 },
    compute: (facts) =>
      percentOf(facts.occupiedUnitNights, facts.availableUnitNights),
  },

  adr: {
    id: 'adr',
    name: 'מחיר ממוצע ללילה',
    description:
      'ההכנסה מלינה חלקי מספר הלילות שנמכרו בפועל. לילות חינם ואופציות אינם נספרים.',
    unit: 'currency',
    sentiment: 'higher_is_better',
    extensive: false,
    requires: 'report.financial.view',
    detailRequires: 'booking.view_price',
    compute: (facts) => agorotPer(facts.roomRevenue, facts.soldUnitNights),
  },

  revpar: {
    id: 'revpar',
    name: 'הכנסה ללילה זמין',
    description:
      'ההכנסה מלינה חלקי כל הלילות שהיו זמינים למכירה — כולל אלה שנשארו ריקים.',
    unit: 'currency',
    sentiment: 'higher_is_better',
    extensive: false,
    requires: 'report.financial.view',
    detailRequires: 'booking.view_price',
    compute: (facts) => agorotPer(facts.roomRevenue, facts.availableUnitNights),
  },

  revenue: {
    id: 'revenue',
    name: 'הכנסות',
    description:
      'סך ההכנסות בתקופה: לינה לפי לילות בתוספת שירותים ותוספות, ללא מע״מ.',
    unit: 'currency',
    sentiment: 'higher_is_better',
    extensive: true,
    requires: 'report.financial.view',
    detailRequires: 'report.financial.export',
    compute: (facts) => facts.roomRevenue + facts.ancillaryRevenue,
  },

  net_operating_revenue: {
    id: 'net_operating_revenue',
    name: 'הכנסה תפעולית נטו',
    description:
      'ההכנסות בניכוי עמלות ערוצים וסוכנים. זה אינו רווח — הוצאות התפעול אינן כלולות.',
    unit: 'currency',
    sentiment: 'higher_is_better',
    extensive: true,
    requires: 'report.financial.view',
    detailRequires: 'report.financial.export',
    compute: (facts) =>
      facts.roomRevenue + facts.ancillaryRevenue - facts.commission,
  },

  direct_booking_share: {
    id: 'direct_booking_share',
    name: 'שיעור הזמנות ישירות',
    description:
      'חלק ההכנסות שהגיע מהאתר ומהזמנות ישירות, מתוך כלל ההכנסות בתקופה.',
    unit: 'percentage',
    sentiment: 'higher_is_better',
    extensive: false,
    // Attribution is the booking's source field, so this is the same right.
    requires: 'booking.view_source',
    detailRequires: 'booking.view',
    thresholds: { warningBelow: 30 },
    compute: (facts) =>
      percentOf(
        facts.directRevenue,
        facts.roomRevenue + facts.ancillaryRevenue,
      ),
  },

  commission_cost: {
    id: 'commission_cost',
    name: 'עלות עמלות',
    description: 'הסכום שהעסק משלם לערוצים ולסוכנים על הלילות שנמכרו בתקופה.',
    unit: 'currency',
    // Lower is better as a cost — but it rises with revenue, so it is only
    // meaningful read beside it. The dashboard places the two together.
    sentiment: 'lower_is_better',
    extensive: true,
    requires: 'commission.view',
    detailRequires: 'agent_statement.view',
    compute: (facts) => facts.commission,
  },

  outstanding_balance: {
    id: 'outstanding_balance',
    name: 'יתרה לגבייה',
    description: 'כמה כסף עדיין לא שולם על ההזמנות שמועד ההגעה שלהן חל בתקופה.',
    unit: 'currency',
    sentiment: 'lower_is_better',
    extensive: true,
    // The total is a finance figure; the payments behind it are the ledger.
    requires: 'finance.view',
    detailRequires: 'payment.view',
    compute: (facts) => facts.billed - facts.collected,
  },

  collected: {
    id: 'collected',
    name: 'נגבה בפועל',
    description: 'כמה כסף כבר התקבל על ההזמנות שמועד ההגעה שלהן חל בתקופה.',
    unit: 'currency',
    sentiment: 'higher_is_better',
    extensive: true,
    requires: 'finance.view',
    detailRequires: 'payment.view',
    compute: (facts) => facts.collected,
  },

  average_booking_value: {
    id: 'average_booking_value',
    name: 'ערך הזמנה ממוצע',
    description:
      'השווי הממוצע של הזמנה שמגיעה בתקופה, כולל לינה ותוספות, לפני גבייה.',
    unit: 'currency',
    sentiment: 'higher_is_better',
    extensive: false,
    requires: 'report.financial.view',
    detailRequires: 'booking.view_price',
    compute: (facts) => agorotPer(facts.billed, facts.soldBookingCount),
  },

  booking_pace: {
    id: 'booking_pace',
    name: 'קצב סגירת הזמנות',
    description:
      'כמה הזמנות נסגרו במהלך התקופה — הקצב שבו הפנקס מתמלא, ללא קשר למועד השהייה.',
    unit: 'count',
    sentiment: 'higher_is_better',
    extensive: true,
    requires: 'booking.view',
    compute: (facts) => facts.committedInRangeCount,
  },

  lead_time: {
    id: 'lead_time',
    name: 'טווח הזמנה מראש',
    description:
      'כמה ימים מראש, בממוצע, הזמינו האורחים שמועד ההגעה שלהם חל בתקופה.',
    unit: 'days',
    // Genuinely ambiguous: a long lead time is runway, a short one is demand.
    // The product declines to have an opinion rather than colouring it wrong.
    sentiment: 'neutral',
    extensive: false,
    requires: 'booking.view',
    compute: (facts) =>
      averagePer(facts.leadTimeDayTotal, facts.leadTimeSample),
  },

  length_of_stay: {
    id: 'length_of_stay',
    name: 'אורך שהייה ממוצע',
    description:
      'כמה לילות נמשכת בממוצע שהייה שמתחילה בתקופה, גם אם היא נמשכת אל מעבר לה.',
    unit: 'nights',
    sentiment: 'higher_is_better',
    extensive: false,
    requires: 'booking.view',
    compute: (facts) => averagePer(facts.stayNightTotal, facts.stayCount),
  },

  conversion_rate: {
    id: 'conversion_rate',
    name: 'שיעור המרה',
    description:
      'מתוך הפניות וההצעות שנפתחו בתקופה, כמה הפכו להזמנה סגורה — גם אם נסגרו מאוחר יותר.',
    unit: 'percentage',
    sentiment: 'higher_is_better',
    extensive: false,
    requires: 'booking.view',
    detailRequires: 'lead.view',
    thresholds: { warningBelow: 20, criticalBelow: 10 },
    compute: (facts) =>
      percentOf(facts.createdCommittedCount, facts.createdBookingCount),
  },

  cancellation_rate: {
    id: 'cancellation_rate',
    name: 'שיעור ביטולים',
    description:
      'מתוך השהיות שהיו אמורות להתחיל בתקופה, כמה מהן בוטלו בסופו של דבר.',
    unit: 'percentage',
    sentiment: 'lower_is_better',
    extensive: false,
    requires: 'booking.view',
    detailRequires: 'booking.view',
    thresholds: { warningAbove: 10, criticalAbove: 20 },
    compute: (facts) =>
      percentOf(
        facts.cancelledArrivalCount,
        facts.cancelledArrivalCount + facts.realisedArrivalCount,
      ),
  },
}

export const ALL_METRICS: readonly MetricDefinition[] = METRIC_IDS.map(
  (id) => METRICS[id],
)

// ── The source mix ────────────────────────────────────────────────────────

export interface SourceShare {
  source: BookingSource
  revenue: Agorot
  /** Percent points. Every share in the list adds to exactly 100.0. */
  share: number
}

/**
 * Where the revenue came from, as parts of a whole that actually add up.
 *
 * `direct_booking_share` is one slice of this same pie, computed the same way,
 * so the headline figure and the breakdown beneath it can never disagree.
 * Returns `null` when there is no revenue to divide — an empty month has no
 * mix, and an even split across sources that sold nothing would be an
 * invention.
 */
export function sourceMix(facts: MetricFacts): readonly SourceShare[] | null {
  const entries = Object.entries(facts.revenueBySource)
    .map(([source, revenue]) => ({
      source: source as BookingSource,
      revenue: revenue ?? 0,
    }))
    .sort((a, b) =>
      b.revenue === a.revenue
        ? a.source.localeCompare(b.source)
        : b.revenue - a.revenue,
    )

  const shares = allocateShares(entries.map((entry) => entry.revenue))
  if (shares === null) return null

  return entries.map((entry, index) => ({ ...entry, share: shares[index] }))
}

// ── Formatting ────────────────────────────────────────────────────────────

/** What a dashboard shows when a metric does not apply. Not a zero. */
export const NOT_APPLICABLE = '—'

/**
 * Render a value for a human.
 *
 * The only conversion in the whole module: agorot become shekels here and
 * nowhere else. Formatting is done once, next to the value, so two screens
 * cannot format the same number differently.
 */
export function formatMetricValue(
  unit: MetricUnit,
  value: MetricValue,
): string {
  if (value === null) return NOT_APPLICABLE

  switch (unit) {
    case 'currency':
      return formatAgorot(value)
    case 'percentage':
      return `${decimals(value)}%`
    case 'count':
      return decimals(value)
    case 'nights':
      return value === 1 ? 'לילה אחד' : `${decimals(value)} לילות`
    case 'days':
      return value === 1 ? 'יום אחד' : `${decimals(value)} ימים`
    default:
      return decimals(value)
  }
}

/** One decimal when there is one, none when there is not. `73` and `73.4`. */
function decimals(value: number): string {
  return value.toLocaleString('he-IL', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })
}
