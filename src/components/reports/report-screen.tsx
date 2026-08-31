/**
 * The shape both report screens share.
 *
 * The two routes differ in exactly three things — the grant that admits you,
 * the metrics that are asked for, and the words at the top — and everything
 * below the heading is the same page. Writing it twice would mean the day
 * somebody fixes the "no data" wording on one screen and not the other, so it
 * is written once and the differences arrive as props.
 *
 * What it deliberately does *not* take is an actor, a client or a grant. This
 * component cannot decide access and must not look as though it could: the
 * route decided that with `requireGrant` before any of this rendered, and
 * `computeDashboard` decided the per-metric half. A component that re-asked
 * would be a third opinion for the two real ones to drift from.
 *
 * No `"use client"`: the only interactive part is `PeriodBar`, which carries
 * its own directive.
 */

import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import type {
  ComparisonMode,
  DashboardResponse,
  MetricRange,
} from '@/lib/metrics'

import { MetricGrid } from './metric-tile'
import { PeriodBar } from './period-bar'
import { NoFiguresNote, ScopeNote, WithheldNote } from './report-notes'
import { withheldNames } from '@/app/(app)/reports/_lib/queries'

export type ReportScreenProps = {
  title: string
  /** One line saying what this report is, and what it is not. */
  intro: string
  /** Where the period form submits. */
  action: string
  range: MetricRange
  comparison: ComparisonMode
  months: readonly { range: MetricRange; label: string }[]
  periodLabel: string
  /** Set when the URL asked for a window that could not be used. */
  issue: string | null
  /** The report, or null when the query failed. Never both. */
  response: DashboardResponse | null
  failure: SafeErrorBody | null
  propertyNames: readonly string[]
  /** The other report, when this reader holds the grant for it. */
  crossLink: { href: string; label: string } | null
}

export function ReportScreen({
  title,
  intro,
  action,
  range,
  comparison,
  months,
  periodLabel,
  issue,
  response,
  failure,
  propertyNames,
  crossLink,
}: ReportScreenProps) {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        <p className="text-muted-foreground">
          {intro} התקופה המוצגת: {periodLabel}.
        </p>

        {response && (
          <ScopeNote scope={response.scope} propertyNames={propertyNames} />
        )}

        {crossLink && (
          <p className="text-sm">
            <Link
              href={crossLink.href}
              className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {crossLink.label}
            </Link>
          </p>
        )}
      </header>

      <PeriodBar
        action={action}
        range={range}
        comparison={comparison}
        months={months}
        issue={issue}
      />

      {/* A failed query and a quiet month are never rendered the same way.
          The first is an error with a correlation id; the second is a true
          sentence about a business with nothing in the window. */}
      {failure ? (
        <ActionError error={failure} />
      ) : response === null ? null : response.metrics.length === 0 ? (
        <NoFiguresNote period={periodLabel} />
      ) : (
        <MetricGrid metrics={response.metrics} />
      )}

      {response && <WithheldNote names={withheldNames(response)} />}
    </div>
  )
}
