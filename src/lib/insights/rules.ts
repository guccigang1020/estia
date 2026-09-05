/**
 * The insights, declared as rules.
 *
 * Each rule names the metrics it reads, where the rows behind it live, and a
 * pure function that turns a window's facts into a sentence — or into nothing,
 * or into a stated absence. There is no `if (role === …)` and no query: a rule
 * receives what `computeDashboard` was willing to give this reader and nothing
 * else, so a rule physically cannot see a figure the actor was refused.
 *
 * ── Three outcomes, and they are not the same ─────────────────────────────
 *
 *   `insight`  — something was noticed, with its arithmetic attached.
 *   `absent`   — the rule applies and cannot speak: no baseline to compare
 *                against, or a formula with no denominator. Rendered as a
 *                sentence saying which, never as a zero and never as a flat
 *                line.
 *   `nothing`  — the rule applies, ran, and found nothing worth saying. No
 *                anomalous nights is not an insight and not an absence; it is
 *                a quiet month, and a card announcing it would train people to
 *                skim past the cards that matter.
 *
 * The two refusals a rule never produces are `permission` and `plan`. Those
 * are decided before a rule runs — see `report.ts` — because the input a
 * refused rule would need does not exist by then.
 *
 * ── Nothing here invents a threshold ──────────────────────────────────────
 *
 * `MATERIAL_CHANGE_PERCENT` and `METRICS[id].thresholds` are the dictionary's
 * own lines and are read from it. A rule that decided 15% cancellations was
 * "high" would be a second opinion for the tile beside it to disagree with.
 */

import type { BookingSource } from '../booking/types'
import {
  MATERIAL_CHANGE_PERCENT,
  METRICS,
  formatMetricValue,
  percentOf,
  sourceMix,
  type MetricFacts,
  type MetricId,
  type MetricRange,
  type MetricResult,
  type MetricState,
} from '../metrics'

import { baselineEvidence, metricEvidence } from './evidence'
import type {
  EvidenceBlock,
  EvidenceOperand,
  InsightDestination,
  InsightGap,
  InsightId,
} from './types'

// ── What a rule receives ──────────────────────────────────────────────────

export interface RuleInput {
  /** The window, in words. Formatted by the screen; this layer has no Intl. */
  periodLabel: string
  /** The comparison window in words, or null when none was asked for. */
  baselineLabel: string | null
  /** Only the metrics this reader was actually given. */
  results: ReadonlyMap<MetricId, MetricResult>
  facts: MetricFacts
  baselineFacts: MetricFacts | null
  /**
   * Did this reader receive a given metric?
   *
   * Membership of `results`, expressed as a predicate, so it cannot disagree
   * with what `computeDashboard` decided. Rules use it for the one thing the
   * results map cannot answer on its own: whether an operand more sensitive
   * than the figure above it may be shown. See `evidence.ts`.
   *
   * It is deliberately not "does this reader see money". A general manager
   * holds `commission.view` and no revenue at all, so a coarse money flag
   * answers yes for them and leaks the revenue underneath the channel mix.
   */
  canSee: (id: MetricId) => boolean
  /** Hebrew for a booking source. Supplied by the screen — see `_lib/labels`. */
  sourceLabel: (source: BookingSource) => string
}

export type RuleOutcome =
  | {
      kind: 'insight'
      headline: string
      because: string
      tone: MetricState
      evidence: readonly EvidenceBlock[]
      caveat?: string
    }
  | {
      kind: 'absent'
      reason: 'no_baseline' | 'not_measurable'
      explanation: string
    }
  | { kind: 'nothing' }

export interface InsightRule {
  id: InsightId
  title: string
  /** Every metric whose value this rule reads. All must survive the gate. */
  metrics: readonly [MetricId, ...MetricId[]]
  /**
   * Where the underlying rows live.
   *
   * A function of the window, because a link that opens an unfiltered list
   * makes the reader redo the filtering and they will do it differently. Null
   * for a claim with nowhere honest to send anybody.
   */
  destination: ((range: MetricRange) => InsightDestination) | null
  evaluate: (input: RuleInput) => RuleOutcome
}

// ── Small helpers ─────────────────────────────────────────────────────────

/**
 * The result for a metric the caller already established is available.
 *
 * Throws rather than returning undefined: `buildInsightReport` runs a rule
 * only when every id in `metrics` is present, so a miss here is a wiring bug
 * and a silently empty card would hide it.
 */
function read(input: RuleInput, id: MetricId): MetricResult {
  const result = input.results.get(id)
  if (!result) {
    throw new Error(
      `Rule asked for the metric '${id}', which is not in the response. ` +
        `A rule may only read metrics it declares in 'metrics'.`,
    )
  }
  return result
}

const nothing: RuleOutcome = { kind: 'nothing' }

function absent(
  reason: 'no_baseline' | 'not_measurable',
  explanation: string,
): RuleOutcome {
  return { kind: 'absent', reason, explanation }
}

const whole = (value: number): string => formatMetricValue('count', value)
const percent = (value: number | null): string =>
  formatMetricValue('percentage', value)

/**
 * The evidence for the measured window.
 *
 * The visibility predicate is threaded here rather than checked per rule, so
 * a rule cannot forget it. See the header of `evidence.ts`: a percentage may
 * be permitted while the figures it divides are not.
 */
function block(input: RuleInput, ids: readonly MetricId[]): EvidenceBlock {
  return {
    periodLabel: input.periodLabel,
    metrics: ids.map((id) =>
      metricEvidence(read(input, id), input.facts, input.canSee),
    ),
  }
}

/**
 * The measured window, and the comparison window when there is one.
 *
 * The baseline block carries the *same* operands from the baseline facts, so a
 * reader checking a trend can see both fractions rather than being asked to
 * trust a delta. It is dropped entirely when no comparison was asked for —
 * an empty block under a heading would read as a period that measured zero.
 */
function withBaseline(
  input: RuleInput,
  ids: readonly MetricId[],
): readonly EvidenceBlock[] {
  const { baselineFacts, baselineLabel } = input
  const current = block(input, ids)
  if (baselineFacts === null || baselineLabel === null) return [current]

  return [
    current,
    {
      periodLabel: baselineLabel,
      metrics: ids.map((id) =>
        baselineEvidence(read(input, id), baselineFacts, input.canSee),
      ),
    },
  ]
}

/** The last night of a half-open window, for a link that ends on a date. */
function lastNight(range: MetricRange): string {
  const end = new Date(`${range.end}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() - 1)
  return end.toISOString().slice(0, 10)
}

function bookingsHref(range: MetricRange, status?: string): string {
  const params = new URLSearchParams({
    from: range.start,
    to: lastNight(range),
  })
  if (status) params.set('status', status)
  return `/bookings?${params.toString()}`
}

/** The dictionary's own lines, said out loud. Never a number written here. */
function thresholdSentence(id: MetricId): string {
  const thresholds = METRICS[id].thresholds
  if (!thresholds) return ''

  const parts: string[] = []
  if (thresholds.warningAbove !== undefined) {
    parts.push(`מעל ${percent(thresholds.warningAbove)} דורש תשומת לב`)
  }
  if (thresholds.criticalAbove !== undefined) {
    parts.push(`מעל ${percent(thresholds.criticalAbove)} חריג`)
  }
  if (thresholds.warningBelow !== undefined) {
    parts.push(`מתחת ל־${percent(thresholds.warningBelow)} דורש תשומת לב`)
  }
  if (thresholds.criticalBelow !== undefined) {
    parts.push(`מתחת ל־${percent(thresholds.criticalBelow)} חריג`)
  }

  return parts.length === 0 ? '' : `הסף במוצר: ${parts.join(', ')}.`
}

// ── The rules ─────────────────────────────────────────────────────────────

export const INSIGHT_RULES: readonly InsightRule[] = [
  // ── Occupancy, and what is hiding inside it ─────────────────────────────
  {
    id: 'occupancy_direction',
    title: 'כיוון התפוסה',
    metrics: ['occupancy'],
    destination: () => ({
      href: '/reports/operations',
      label: 'לדוח התפעולי',
      requires: 'availability.view',
    }),
    evaluate: (input) => {
      const occupancy = read(input, 'occupancy')

      if (occupancy.value === null) {
        return absent(
          'not_measurable',
          'לא היו לילות זמינים למכירה בתקופה, ולכן אין שבר לחשב. זה אינו 0% — חדרים שלא היו במלאי אינם חדרים שעמדו ריקים.',
        )
      }

      const comparison = occupancy.comparison
      if (comparison === null) {
        return absent(
          'no_baseline',
          'לא נבחרה תקופת השוואה, ולכן אין כיוון. מגמה דורשת שתי תקופות, ומספר יחיד אינו מגמה.',
        )
      }

      if (
        comparison.empty ||
        comparison.value === null ||
        comparison.delta === null ||
        input.baselineFacts === null
      ) {
        return absent(
          'no_baseline',
          `בתקופת ההשוואה לא נמצאו נתונים כלל, ולכן אין ממה להשוות. עסק שהתחיל לפני שלושה שבועות עדיין אין לו מגמה, וקו שטוח היה המצאה ולא מדידה.`,
        )
      }

      const nightsDelta =
        input.facts.occupiedUnitNights - input.baselineFacts.occupiedUnitNights

      const material =
        comparison.deltaPercent !== null &&
        Math.abs(comparison.deltaPercent) >= MATERIAL_CHANGE_PERCENT

      const direction =
        comparison.delta > 0 ? 'עלתה' : comparison.delta < 0 ? 'ירדה' : null

      const headline =
        direction === null
          ? `התפוסה לא זזה: ${occupancy.formatted} בשתי התקופות`
          : `התפוסה ${direction} מ־${formatMetricValue('percentage', comparison.value)} ל־${occupancy.formatted}`

      const size =
        nightsDelta === 0
          ? 'מספר הלילות התפוסים זהה בשתי התקופות.'
          : `ההפרש הוא ${whole(Math.abs(nightsDelta))} לילות תפוסים: ${whole(input.facts.occupiedUnitNights)} מול ${whole(input.baselineFacts.occupiedUnitNights)}.`

      const weight = material
        ? ''
        : ` השינוי קטן מסף המהותיות של המוצר (${percent(MATERIAL_CHANGE_PERCENT)} מהבסיס), ולכן הוא אינו נחשב מגמה.`

      return {
        kind: 'insight',
        headline,
        because: `${size}${weight}`,
        tone: occupancy.state,
        evidence: withBaseline(input, ['occupancy']),
      }
    },
  },

  {
    id: 'unsold_occupied_nights',
    title: 'לילות תפוסים שלא נמכרו',
    metrics: ['occupancy'],
    destination: () => ({
      href: '/reports/operations',
      label: 'לדוח התפעולי',
      requires: 'availability.view',
    }),
    evaluate: (input) => {
      const { facts } = input
      const unsold = facts.occupiedUnitNights - facts.soldUnitNights
      if (unsold <= 0) return nothing

      return {
        kind: 'insight',
        headline: `${whole(unsold)} מתוך ${whole(facts.occupiedUnitNights)} הלילות התפוסים לא נמכרו`,
        because:
          'התפוסה סופרת אותם, כי החדר באמת תפוס ואי אפשר למכור אותו לאיש אחר. מחיר ממוצע ללילה אינו סופר אותם, כי הם לא הכניסו דבר. כשהשניים מסופרים יחד נדמה שהמחיר נפל, והוא לא.',
        tone: 'neutral',
        evidence: [
          {
            ...block(input, ['occupancy']),
            operands: [
              {
                label: 'לילות שנמכרו',
                unit: 'count',
                value: facts.soldUnitNights,
              },
              {
                label: 'לילות מתנה',
                unit: 'count',
                value: facts.complimentaryUnitNights,
              },
              {
                label: 'לילות באופציה',
                unit: 'count',
                value: facts.heldOptionUnitNights,
              },
            ],
          },
        ],
      }
    },
  },

  {
    id: 'out_of_service_load',
    title: 'מלאי שנסגר למכירה',
    metrics: ['occupancy'],
    destination: () => ({
      href: '/units',
      label: 'לרשימת היחידות',
      requires: 'property.view',
    }),
    evaluate: (input) => {
      const { facts } = input
      const closed = facts.outOfServiceUnitNights
      if (closed <= 0) return nothing

      const inService = facts.availableUnitNights + closed
      const share = percentOf(closed, inService)

      return {
        kind: 'insight',
        headline: `${whole(closed)} לילות מלאי נסגרו למכירה בתקופה`,
        because: `המכנה של התפוסה הוא ${whole(facts.availableUnitNights)} לילות זמינים ולא ${whole(inService)} לילות המלאי המלא — ${percent(share)} מהמלאי הוצאו במכוון, ולילה סגור אינו נספר כלילה שעמד ריק.`,
        tone: 'neutral',
        evidence: [
          {
            ...block(input, ['occupancy']),
            operands: [
              { label: 'לילות שנסגרו', unit: 'count', value: closed },
              { label: 'לילות מלאי בסך הכול', unit: 'count', value: inService },
            ],
          },
        ],
      }
    },
  },

  {
    id: 'inventory_anomaly',
    title: 'שהיות על מלאי שלא היה זמין',
    metrics: ['occupancy'],
    destination: (range) => ({
      href: bookingsHref(range),
      label: 'להזמנות שחופפות לתקופה',
      requires: 'booking.view',
    }),
    evaluate: (input) => {
      const anomalous = input.facts.anomalousUnitNights
      if (anomalous <= 0) return nothing

      return {
        kind: 'insight',
        headline: `${whole(anomalous)} לילות שהייה יושבים על מלאי שלא היה זמין למכירה`,
        because:
          'זו תקלת נתונים ולא תפוסה: הזמנה תופסת יחידה שלא הייתה במלאי באותו לילה, או שנסגרה לתחזוקה. הלילות האלה לא נספרו בתפוסה — אחרת היא הייתה עוברת 100% — וגם לא נמחקו, כדי שהזמנה אמיתית לא תיעלם מהמסך.',
        tone: 'critical',
        evidence: [
          {
            ...block(input, ['occupancy']),
            operands: [
              { label: 'לילות חריגים', unit: 'count', value: anomalous },
            ],
          },
        ],
      }
    },
  },

  // ── Money ───────────────────────────────────────────────────────────────
  {
    id: 'revenue_per_available_night',
    title: 'הכנסה ללילה זמין מול לילה שנמכר',
    metrics: ['revpar', 'adr'],
    destination: () => ({
      href: '/reports',
      label: 'לדוח הכספי',
      requires: 'report.financial.view',
    }),
    evaluate: (input) => {
      const revpar = read(input, 'revpar')
      const adr = read(input, 'adr')

      if (revpar.value === null || adr.value === null) {
        return absent(
          'not_measurable',
          'אין לילות זמינים או אין לילות שנמכרו בתקופה, ולכן לאחד השברים אין מכנה. זה אינו ₪0.',
        )
      }

      const { facts } = input
      const empty = facts.availableUnitNights - facts.soldUnitNights

      return {
        kind: 'insight',
        headline: `כל לילה זמין הניב ${revpar.formatted}, וכל לילה שנמכר הניב ${adr.formatted}`,
        because: `הפער בין השניים הוא ${whole(empty)} מתוך ${whole(facts.availableUnitNights)} הלילות הזמינים שלא נמכרו. אותה הכנסה מחולקת פעמיים: פעם בכל המלאי ופעם רק במה שנמכר.`,
        tone: revpar.state,
        evidence: [block(input, ['revpar', 'adr'])],
      }
    },
  },

  {
    id: 'commission_load',
    title: 'מה עלו הערוצים והסוכנים',
    metrics: ['commission_cost', 'revenue'],
    destination: () => ({
      href: '/finance/commissions',
      label: 'לעמלות',
      requires: 'commission.view',
    }),
    evaluate: (input) => {
      const commission = read(input, 'commission_cost')
      const revenue = read(input, 'revenue')
      if (input.facts.commission <= 0) return nothing

      const total = input.facts.roomRevenue + input.facts.ancillaryRevenue
      const share = percentOf(input.facts.commission, total)

      return {
        kind: 'insight',
        headline: `${commission.formatted} מההכנסות שולמו כעמלה לערוצים ולסוכנים`,
        because:
          share === null
            ? `לא נרשמה הכנסה שאפשר לחלק בה את העמלה, ולכן העלות מוצגת כסכום ולא כשיעור.`
            : `זהו ${percent(share)} מתוך ${revenue.formatted} — הכנסה שנמכרה ולא נשארה בעסק. העמלה מוכרת לילה־לילה לצד הלינה, ולכן היא מתיישבת עם ההכנסה באותה תקופה.`,
        tone: commission.state,
        evidence: [block(input, ['commission_cost', 'revenue'])],
      }
    },
  },

  {
    id: 'collection_gap',
    title: 'מה נגבה ומה נותר',
    metrics: ['outstanding_balance', 'collected'],
    destination: () => ({
      href: '/finance/payments',
      label: 'לתשלומים',
      requires: 'payment.view',
    }),
    evaluate: (input) => {
      const { facts } = input
      if (facts.billed <= 0) return nothing

      const outstanding = read(input, 'outstanding_balance')
      const collected = read(input, 'collected')
      const gap = facts.billed - facts.collected
      const share = percentOf(gap, facts.billed)

      return {
        kind: 'insight',
        headline:
          gap <= 0
            ? 'כל ההגעות בתקופה שולמו במלואן'
            : `נותרו ${outstanding.formatted} לגבייה על ההגעות בתקופה`,
        because: `${collected.formatted} נגבו מתוך ${formatMetricValue('currency', facts.billed)} שחויבו — ${percent(share)} עדיין פתוחים. היתרה נמדדת לפי מועד ההגעה של ההזמנה כולה, ולכן היא בכוונה אינה מתיישבת עם ההכנסה שמוכרת לילה־לילה.`,
        tone: gap <= 0 ? 'positive' : outstanding.state,
        evidence: [block(input, ['outstanding_balance', 'collected'])],
      }
    },
  },

  {
    id: 'channel_contribution',
    title: 'מאיפה הגיעה ההכנסה',
    metrics: ['direct_booking_share'],
    destination: () => ({
      href: '/reports',
      label: 'לדוח הכספי',
      requires: 'report.financial.view',
    }),
    evaluate: (input) => {
      const direct = read(input, 'direct_booking_share')
      const mix = sourceMix(input.facts)

      if (mix === null || mix.length === 0) {
        return absent(
          'not_measurable',
          'לא נרשמה הכנסה בתקופה, ולכן אין תמהיל לחלק. פיצול שווה בין ערוצים שלא מכרו דבר היה המצאה.',
        )
      }

      const top = mix[0]
      const total = input.facts.roomRevenue + input.facts.ancillaryRevenue

      const operands: EvidenceOperand[] = mix.map((entry) => ({
        label: input.sourceLabel(entry.source),
        unit: 'percentage',
        value: entry.share,
      }))

      return {
        kind: 'insight',
        headline: `${percent(top.share)} מההכנסה בתקופה הגיעה מ${input.sourceLabel(top.source)}`,
        because: `הזמנות ישירות היו ${direct.formatted} מההכנסה, והן אלה שאינן משלמות עמלה. החלקים למטה מחולקים כך שהם מסתכמים בדיוק ל־100%.`,
        tone: direct.state,
        evidence: [
          {
            ...block(input, ['direct_booking_share']),
            operands,
          },
        ],
        // The total is `revenue`, and it is stated only for a reader who
        // received `revenue`. Naming the metric rather than asking "does this
        // person see money" is the whole correction: a general manager holds
        // `commission.view` and no revenue at all.
        ...(input.canSee('revenue')
          ? {
              caveat: `סך ההכנסה שחולקה: ${formatMetricValue('currency', total)}.`,
            }
          : {}),
      }
    },
  },

  // ── The booking book ────────────────────────────────────────────────────
  {
    id: 'cancellation_pressure',
    title: 'ביטולים',
    metrics: ['cancellation_rate'],
    destination: (range) => ({
      href: bookingsHref(range, 'cancelled'),
      label: 'להזמנות שבוטלו וחופפות לתקופה',
      requires: 'booking.view',
    }),
    evaluate: (input) => {
      const rate = read(input, 'cancellation_rate')
      const { facts } = input

      if (rate.value === null) {
        return absent(
          'not_measurable',
          'לא היו הגעות שתוכננו לתקופה, ולכן אין קבוצה שממנה לחשב שיעור ביטולים. זה אינו 0%.',
        )
      }

      const threshold = thresholdSentence('cancellation_rate')

      return {
        kind: 'insight',
        headline:
          rate.value === 0
            ? 'אף הגעה שתוכננה לתקופה לא בוטלה'
            : `${rate.formatted} מההגעות שתוכננו לתקופה בוטלו`,
        because:
          `ביטולים: ${whole(facts.cancelledArrivalCount)}. הגעות שהתממשו: ${whole(facts.realisedArrivalCount)}. הביטול נספר לפי המועד שבו השהייה הייתה אמורה להתחיל, ולא לפי מועד הביטול. ${threshold}`.trim(),
        tone: rate.state,
        caveat:
          'שום מקור קנוני אינו מפלח ביטולים לפי ערוץ, סוכן או יחידה, ולכן אי אפשר לומר מכאן היכן הם מתרכזים.',
        evidence: withBaseline(input, ['cancellation_rate']),
      }
    },
  },

  {
    id: 'lead_time_shift',
    title: 'טווח ההזמנה מראש',
    metrics: ['lead_time'],
    destination: (range) => ({
      href: bookingsHref(range),
      label: 'להזמנות שחופפות לתקופה',
      requires: 'booking.view',
    }),
    evaluate: (input) => {
      const lead = read(input, 'lead_time')
      const { facts } = input

      if (lead.value === null) {
        return absent(
          'not_measurable',
          'לא הגיעו הזמנות בתקופה, ולכן אין מדגם שממנו לחשב טווח הזמנה. זה אינו אפס ימים.',
        )
      }

      const comparison = lead.comparison
      const movement =
        comparison === null
          ? 'לא נבחרה תקופת השוואה, ולכן אין כיוון.'
          : comparison.empty || comparison.delta === null
            ? 'בתקופת ההשוואה לא נמצאו נתונים, ולכן אין כיוון.'
            : comparison.delta === 0
              ? 'הטווח זהה לתקופת ההשוואה.'
              : `${comparison.delta > 0 ? 'התארך' : 'התקצר'} ב־${formatMetricValue('days', Math.abs(comparison.delta))} מול ${formatMetricValue('days', comparison.value)} בתקופת ההשוואה.`

      return {
        kind: 'insight',
        headline: `אורחים שהגיעו בתקופה הזמינו ${lead.formatted} מראש, בממוצע`,
        because: `${movement} המדגם הוא ${whole(facts.leadTimeSample)} הזמנות. הזמנה שנרשמה אחרי מועד ההגעה נספרת כאפס ימים ולא כמספר שלילי.`,
        tone: lead.state,
        caveat:
          'זהו ממוצע בלבד. שכבת המדדים אינה מחזירה התפלגות, ולכן אי אפשר לדעת מכאן אם הממוצע נמשך על ידי הזמנות של הרגע האחרון או על ידי מעטות מוקדמות מאוד.',
        evidence: withBaseline(input, ['lead_time']),
      }
    },
  },

  {
    id: 'conversion_pressure',
    title: 'המרה של פניות להזמנות',
    metrics: ['conversion_rate'],
    destination: () => ({
      href: '/leads',
      label: 'לפניות',
      requires: 'lead.view',
    }),
    evaluate: (input) => {
      const rate = read(input, 'conversion_rate')
      const { facts } = input

      if (rate.value === null) {
        return absent(
          'not_measurable',
          'לא נפתחו פניות או הצעות בתקופה, ולכן אין ממה לחשב המרה. זה אינו 0%.',
        )
      }

      return {
        kind: 'insight',
        headline: `${rate.formatted} מהפניות שנפתחו בתקופה הפכו להזמנה סגורה`,
        because:
          `${whole(facts.createdCommittedCount)} מתוך ${whole(facts.createdBookingCount)}. הקבוצה נמדדת לפי מועד הפתיחה, ולכן פנייה שנפתחה בתקופה ונסגרה אחריה עדיין נספרת כאן — וזו הסיבה שהמספר יכול לעלות אחרי שהחודש נגמר. ${thresholdSentence('conversion_rate')}`.trim(),
        tone: rate.state,
        evidence: [block(input, ['conversion_rate'])],
      }
    },
  },

  {
    id: 'booking_pace_direction',
    title: 'קצב סגירת ההזמנות',
    metrics: ['booking_pace'],
    destination: (range) => ({
      href: bookingsHref(range),
      label: 'להזמנות שחופפות לתקופה',
      requires: 'booking.view',
    }),
    evaluate: (input) => {
      const pace = read(input, 'booking_pace')
      const comparison = pace.comparison

      const movement =
        comparison === null
          ? 'לא נבחרה תקופת השוואה, ולכן אין כיוון.'
          : comparison.empty || comparison.delta === null
            ? 'בתקופת ההשוואה לא נמצאו נתונים, ולכן אין כיוון.'
            : !comparison.comparable
              ? `התקופות אינן באותו אורך (${whole(comparison.nights)} מול ${whole(comparison.baselineNights)} לילות), ולכן ההפרש אינו השוואה מלאה.`
              : comparison.delta === 0
                ? 'אותו מספר כמו בתקופת ההשוואה.'
                : `${comparison.delta > 0 ? 'יותר' : 'פחות'} ב־${whole(Math.abs(comparison.delta))} מול ${whole(comparison.value ?? 0)} בתקופת ההשוואה.`

      return {
        kind: 'insight',
        headline: `${pace.formatted} הזמנות נסגרו במהלך התקופה`,
        because: `${movement} הקצב נמדד לפי מועד הסגירה ולא לפי מועד השהייה, ולכן הוא אומר כמה הפנקס התמלא ולא כמה אורחים היו בבית.`,
        tone: pace.state,
        evidence: withBaseline(input, ['booking_pace']),
      }
    },
  },
]

// ── What this screen deliberately does not claim ──────────────────────────

/**
 * Figures no canonical source produces.
 *
 * Every one of these was wanted on this screen and none of them shipped, for
 * the same reason: there is no function in `src/lib/metrics` that returns
 * them, and a screen whose whole promise is "every number traces to a
 * canonical source" cannot make an exception for the interesting ones. They
 * are printed rather than left silent, so that a reader who came looking finds
 * out why instead of assuming the page is broken.
 */
export const GAPS: readonly InsightGap[] = [
  {
    title: 'היכן הביטולים מתרכזים',
    explanation:
      'שיעור הביטולים נמדד, אבל `aggregateFacts` מחזיר ספירה אחת ולא פילוח. אין מספר לצטט לפי ערוץ, סוכן או יחידה, ולכן אין תובנה.',
  },
  {
    title: 'התפלגות טווח ההזמנה מראש',
    explanation:
      'המילון מחזיר ממוצע: סך הימים חלקי גודל המדגם. התפלגות דורשת את ההזמנה הבודדת, ושכבת המדדים מסכמת אותה לפני שהיא יוצאת.',
  },
  {
    title: 'תרומת הסוכן הבודד',
    explanation:
      'תמהיל המקורות מגיע עד «סוכן» ו«סוכנות» כערוץ. מי הסוכן וכמה כל אחד הביא אינו נמדד בשכבת המדדים, ודוח הסוכנים הוא מסך אחר עם הרשאה משלו.',
  },
  {
    title: 'עומס ההכנה והכביסה מול ההגעות',
    explanation:
      'עומס ההכנה והכביסה מחושב במודולים של אותם מסכים ולא בשכבת המדדים, ואין מדד קנוני שמעמיד אותם מול מספר ההגעות. המסך הזה אינו טוען עליהם דבר — גם לא אפס.',
  },
  {
    title: 'שיעור צירוף מהחנות',
    explanation:
      'הזמנות החנות אינן נכנסות לעובדות המדידה. «תוספות ושירותים» הוא סכום קווי מחיר של ההזמנה ואינו מבחין בין דמי ניקיון לבין מוצר שנמכר, ולכן אין ממה לחשב שיעור צירוף.',
  },
]
