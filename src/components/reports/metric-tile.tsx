/**
 * One measured figure, and everything the domain already decided about it.
 *
 * This component formats and nothing else. The number arrives as
 * `MetricResult.formatted`, which `computeDashboard` produced by calling
 * `formatMetricValue` once — so the dashboard, the report and any export can
 * never render the same value differently. The comparison, the direction and
 * the colour all arrive decided too: `evaluateState` knows that a rise in
 * cancellations is bad news and a fall in outstanding balance is good, and a
 * component that painted every rise green would be lying about half the tiles.
 *
 * ── Three states that look alike and are not ──────────────────────────────
 *
 *   · `value === null` — the metric does not apply. There is no fraction to
 *     state, and `NOT_APPLICABLE` is "—" rather than a zero. A property with
 *     no available nights is not 0% occupied.
 *   · `comparison === null` — no comparison was asked for.
 *   · `comparison.empty` — a comparison was asked for and the baseline window
 *     held no rows. A property that did not exist last year did not suffer a
 *     100% collapse, so the arrow is withheld and the sentence says why.
 *
 * ── Colour is never the only signal ───────────────────────────────────────
 *
 * A `warning` or `critical` tile carries a word as well as a hue, because the
 * hue is invisible to a colour-blind reader and meaningless in a screenshot
 * printed in black and white.
 *
 * No `"use client"`: results in, markup out.
 */

import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import {
  formatMetricValue,
  type MetricResult,
  type MetricState,
  type TrendDirection,
} from '@/lib/metrics'

import { describePeriod } from '@/app/(app)/reports/_lib/period'

/**
 * What the state means, said in words.
 *
 * `positive` gets none: a figure that is simply doing well needs no label, and
 * a badge on every tile is a badge nobody reads.
 */
const STATE_LABEL: Readonly<Record<MetricState, string | null>> = {
  positive: null,
  neutral: null,
  warning: 'דורש תשומת לב',
  critical: 'חריג',
}

const STATE_TEXT: Readonly<Record<MetricState, string>> = {
  positive: 'text-success',
  neutral: 'text-muted-foreground',
  warning: 'text-warning',
  critical: 'text-danger',
}

/** `▲` and `▼` are read aloud as symbols, so the word is what carries it. */
const TREND_LABEL: Readonly<Record<TrendDirection, string>> = {
  up: 'עלייה',
  down: 'ירידה',
  flat: 'ללא שינוי',
  unknown: 'אין השוואה',
}

const TREND_MARK: Readonly<Record<TrendDirection, string>> = {
  up: '▲',
  down: '▼',
  flat: '=',
  unknown: '',
}

export function MetricTile({ metric }: { metric: MetricResult }) {
  const stateLabel = STATE_LABEL[metric.state]

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-soft">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-muted-foreground">
          {metric.name}
        </h3>
        {stateLabel && (
          <Badge
            tone="neutral"
            className={cn('shrink-0', STATE_TEXT[metric.state])}
          >
            {stateLabel}
          </Badge>
        )}
      </div>

      <p
        className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
        // The figure reads left-to-right even in a right-to-left sentence:
        // "₪12,400" and "73.3%" are numbers, not Hebrew words.
        dir="ltr"
        style={{ textAlign: 'start' }}
      >
        {metric.formatted}
      </p>

      <Comparison metric={metric} />

      {/* The dictionary's one-line definition, written for an operator rather
          than an accountant. It is on the tile rather than in a tooltip: a
          tooltip is unreachable on the phone this product is used on. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {metric.description}
      </p>
    </div>
  )
}

function Comparison({ metric }: { metric: MetricResult }) {
  const { comparison } = metric

  if (comparison === null) {
    return (
      <p className="text-xs text-muted-foreground">לא נבחרה תקופת השוואה.</p>
    )
  }

  const baseline = describePeriod(comparison.range)

  if (comparison.empty) {
    return (
      <p className="text-xs text-muted-foreground">
        אין נתונים ב{baseline}, ולכן אין ממה להשוות. זה אינו אפס.
      </p>
    )
  }

  const delta =
    comparison.delta === null
      ? null
      : formatMetricValue(metric.unit, comparison.delta)

  const percent =
    comparison.deltaPercent === null
      ? null
      : formatMetricValue('percentage', Math.abs(comparison.deltaPercent))

  return (
    <div className="flex flex-col gap-1">
      <p className={cn('text-xs font-medium', STATE_TEXT[metric.state])}>
        <span aria-hidden="true">{TREND_MARK[metric.trend]} </span>
        <span className="sr-only">{TREND_LABEL[metric.trend]} </span>
        {delta === null ? 'אין שינוי מדיד' : delta}
        {percent !== null && ` (${percent})`}
      </p>

      <p className="text-xs text-muted-foreground">
        {baseline}: {formatMetricValue(metric.unit, comparison.value)}
      </p>

      {/* February is not in trouble for being three nights shorter than
          March. When the two windows differ in length and the figure grows
          with length, the number is still shown and the conclusion is not
          drawn for the reader. */}
      {!comparison.comparable && (
        <p className="text-xs text-warning">
          התקופות אינן באותו אורך ({comparison.nights} מול{' '}
          {comparison.baselineNights} לילות), ולכן ההפרש אינו השוואה מלאה.
        </p>
      )}
    </div>
  )
}

export function MetricGrid({ metrics }: { metrics: readonly MetricResult[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {metrics.map((metric) => (
        <MetricTile key={metric.id} metric={metric} />
      ))}
    </div>
  )
}
