/**
 * The insights screen, assembled.
 *
 * What it deliberately does not take is an actor, a client or a grant. This
 * component cannot decide access and must not look as though it could: the
 * route decided that with `requireAnyInsightGrant`, `computeDashboard` decided
 * the per-metric half, and `buildInsightReport` decided which insights survive
 * both. A component that re-asked would be a fourth opinion for the three real
 * ones to drift from.
 *
 * ── The order on the page is the argument ─────────────────────────────────
 *
 * Findings first, then what is missing, then what the product cannot measure
 * at all. A screen that opened with its own limitations would be apologising
 * before it said anything; a screen that never got to them would be pretending
 * the list is complete. Both notes sit below the cards and above nothing else.
 *
 * No `"use client"`: the only interactive part is the period bar, which
 * carries its own directive.
 */

import { ActionError } from '@/components/booking/action-error'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import type { InsightReport } from '@/lib/insights'
import type { ComparisonMode, MetricRange, ResolvedScope } from '@/lib/metrics'

import { InsightCard } from './insight-card'
import { AbsenceList, EmptyWindow, GapList, ScopeNote } from './notes'
import { InsightPeriodBar } from './period-bar'

export type InsightScreenProps = {
  title: string
  intro: string
  /** Where the period form submits. */
  action: string
  range: MetricRange
  comparison: ComparisonMode
  months: readonly { range: MetricRange; label: string }[]
  periodLabel: string
  /** Set when the URL asked for a window that could not be used. */
  issue: string | null
  /** The report, or null when the read failed. Never both. */
  report: InsightReport | null
  failure: SafeErrorBody | null
  scope: ResolvedScope | null
  propertyNames: readonly string[]
  /** Metrics refused outright, named for the note. */
  withheld: readonly string[]
  /** Screens the same figures live on, when this reader may open them. */
  crossLinks: readonly { href: string; label: string }[]
}

export function InsightScreen({
  title,
  intro,
  action,
  range,
  comparison,
  months,
  periodLabel,
  issue,
  report,
  failure,
  scope,
  propertyNames,
  withheld,
  crossLinks,
}: InsightScreenProps) {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        <p className="text-muted-foreground">
          {intro} התקופה הנבדקת: {periodLabel}.
        </p>

        {scope && <ScopeNote scope={scope} propertyNames={propertyNames} />}

        {crossLinks.length > 0 && (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {crossLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {link.label} ←
              </a>
            ))}
          </p>
        )}
      </header>

      <InsightPeriodBar
        action={action}
        range={range}
        comparison={comparison}
        months={months}
        issue={issue}
      />

      {/* A failed read and a quiet month are never rendered the same way. The
          first is an error carrying a correlation id; the second is a true
          sentence about a business with nothing in the window. */}
      {failure ? (
        <ActionError error={failure} />
      ) : report === null ? null : report.empty ? (
        <>
          <EmptyWindow period={periodLabel} />
          <GapList gaps={report.gaps} />
        </>
      ) : (
        <>
          {report.insights.length > 0 && (
            <section aria-label="תובנות" className="grid gap-4 lg:grid-cols-2">
              {report.insights.map((insight) => (
                <InsightCard key={insight.id} insight={insight} />
              ))}
            </section>
          )}

          {report.insights.length === 0 && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-6 text-center text-sm text-muted-foreground"
            >
              אף תובנה לא נמצאה ב{periodLabel}. הנתונים נקראו — הרשימה למטה
              אומרת בדיוק מה נחסם, מה לא היה ניתן לחשב, ומה המוצר עדיין אינו
              מודד.
            </p>
          )}

          <AbsenceList absences={report.absent} />

          {withheld.length > 0 && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              {withheld.length === 1
                ? 'מדד אחד אינו כלול בהרשאות שלך ולכן לא חושב כלל: '
                : `${withheld.length} מדדים אינם כלולים בהרשאות שלך ולכן לא חושבו כלל: `}
              <span className="font-medium text-foreground">
                {withheld.join(' · ')}
              </span>
              .
            </p>
          )}

          <GapList gaps={report.gaps} />
        </>
      )}
    </div>
  )
}
