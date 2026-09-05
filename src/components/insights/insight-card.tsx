/**
 * One insight, with its working shown.
 *
 * The card is three things in a fixed order and the order is the argument:
 * what was noticed, why it matters, and the arithmetic that produced it. The
 * evidence is not behind a disclosure triangle and not in a tooltip — a
 * tooltip is unreachable on the phone this product is used on, and an insight
 * nobody can check is an opinion.
 *
 * ── This component decides nothing ────────────────────────────────────────
 *
 * Every figure arrives formatted, every colour arrives decided, and the link
 * arrives already checked against the destination route's own gate grant. A
 * card that re-asked would be a third opinion for the two real ones to drift
 * from — see the same note on `components/reports/metric-tile.tsx`.
 *
 * The one thing it formats is an operand, through `formatMetricValue`, which
 * is the same function that produced the figure above it. That is deliberate:
 * `775` and `1,240` under `62.5%` have to be rendered by the module that
 * rounded them, or the line stops adding up in front of the reader.
 *
 * No `"use client"`: values in, markup out.
 */

import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import type { EvidenceBlock, Insight } from '@/lib/insights'
import { formatMetricValue, type MetricState } from '@/lib/metrics'

/** A figure that is simply doing well needs no badge. */
const TONE_LABEL: Readonly<Record<MetricState, string | null>> = {
  positive: null,
  neutral: null,
  warning: 'דורש תשומת לב',
  critical: 'חריג',
}

const TONE_TEXT: Readonly<Record<MetricState, string>> = {
  positive: 'text-success',
  neutral: 'text-muted-foreground',
  warning: 'text-warning',
  critical: 'text-danger',
}

const TONE_EDGE: Readonly<Record<MetricState, string>> = {
  positive: 'border-border',
  neutral: 'border-border',
  warning: 'border-warning/50',
  critical: 'border-danger/50',
}

export function InsightCard({ insight }: { insight: Insight }) {
  const badge = TONE_LABEL[insight.tone]

  return (
    <article
      className={cn(
        'flex flex-col gap-4 rounded-xl border bg-surface p-5 shadow-soft',
        TONE_EDGE[insight.tone],
      )}
      aria-labelledby={`insight-${insight.id}`}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {insight.title}
          </p>
          {/* Colour is never the only signal: it is invisible to a
              colour-blind reader and meaningless in a printed screenshot. */}
          {badge && (
            <Badge
              tone="neutral"
              className={cn('shrink-0', TONE_TEXT[insight.tone])}
            >
              {badge}
            </Badge>
          )}
        </div>

        <h3
          id={`insight-${insight.id}`}
          className="font-display text-lg font-bold leading-snug tracking-tight text-foreground sm:text-xl"
        >
          {insight.headline}
        </h3>

        <p className="text-sm leading-relaxed text-muted-foreground">
          {insight.because}
        </p>
      </div>

      <Evidence blocks={insight.evidence} />

      {insight.caveat && (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {insight.caveat}
        </p>
      )}

      {insight.destination && (
        <p className="text-sm">
          <Link
            href={insight.destination.href}
            className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {insight.destination.label} ←
          </Link>
        </p>
      )}
    </article>
  )
}

/**
 * The arithmetic, for both windows when there are two.
 *
 * A trend shows the fraction from each period rather than a delta alone,
 * because a delta is the one number a reader cannot check without being handed
 * the two it came from.
 */
function Evidence({ blocks }: { blocks: readonly EvidenceBlock[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3">
      <p className="text-xs font-semibold text-foreground">החישוב</p>

      {blocks.map((block) => (
        <div key={block.periodLabel} className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">{block.periodLabel}</p>

          {block.metrics.map((metric) => (
            <div key={metric.id} className="flex flex-col gap-0.5">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="text-muted-foreground">{metric.name}:</span>
                {/* The expression reads left to right inside a right-to-left
                    sentence. "₪12,400" and "775 ÷ 1,240" are not Hebrew. */}
                <span
                  dir="ltr"
                  className="font-medium text-foreground"
                  style={{ textAlign: 'start' }}
                >
                  {metric.arithmetic}
                </span>
              </p>

              {metric.note && (
                <p className="text-xs text-muted-foreground">{metric.note}</p>
              )}
            </div>
          ))}

          {block.operands && block.operands.length > 0 && (
            <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              {block.operands.map((operand) => (
                <div
                  key={operand.label}
                  className="flex items-baseline justify-between gap-2 text-xs"
                >
                  <dt className="text-muted-foreground">{operand.label}</dt>
                  <dd
                    dir="ltr"
                    className="font-medium text-foreground"
                    style={{ textAlign: 'start' }}
                  >
                    {formatMetricValue(operand.unit, operand.value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ))}
    </div>
  )
}
