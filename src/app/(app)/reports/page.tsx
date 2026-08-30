import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ReportScreen } from '@/components/reports/report-screen'
import { can } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import type { DashboardResponse } from '@/lib/metrics'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import {
  describePeriod,
  parseReportPeriod,
  periodIssue,
  recentMonths,
} from './_lib/period'
import {
  FINANCIAL_REPORT_METRICS,
  loadReport,
  scopePropertyNames,
} from './_lib/queries'
import { metricsWiring } from './_lib/wiring'

export const metadata: Metadata = { title: 'דוח כספי' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The financial report.
 *
 * WHAT IS ON THIS SCREEN. Ten figures from `src/lib/metrics`, computed by
 * `computeDashboard` over `SupabaseMetricSource` reading through the
 * request-scoped Supabase client under row level security. Not one of them is
 * calculated here. Revenue is the sum of stored `booking_price_lines`, net of
 * VAT because the adapter excludes the `tax` kind; ADR is that revenue over
 * the nights `facts.ts` counted as sold; the comparison against last month is
 * `compareValues`. This file chooses the window, the property and the list of
 * metric ids, and formats nothing.
 *
 * NO HISTORICAL DRIFT. A report about last August is built from the price
 * lines that were written when those bookings were priced — the stored record
 * of what the guest was actually charged — and never from today's unit rates.
 * That is the whole reason `BookingFactRow.roomRevenue` comes from
 * `booking_price_lines` rather than from `units.base_price_agorot`: a rate
 * rise in September must not move August's revenue. The one figure that would
 * drift is `outstanding_balance`, and it drifts *correctly* — money collected
 * last week against an August arrival changes what is still owed on it, which
 * is the question the metric asks.
 *
 * GATING, IN THREE INDEPENDENT PLACES. `requireGrant('report.financial.view')`
 * refuses the route. `computeDashboard` then refuses each metric separately
 * against `METRICS[id].requires` — a reader who holds financial reporting but
 * not `finance.view` gets revenue and *no* figure at all for what is still
 * owed, not a zero. And row level security refuses the rows underneath both,
 * regardless of what this component decided.
 *
 * WHY THIS ROUTE IS NOT THE ONLY REPORT. `requireGrant` takes one grant, and
 * there is no single grant held by everybody who may read *some* of these
 * figures: occupancy is gated on `availability.view`, which the accountant
 * does not hold, and revenue on `report.financial.view`, which the general
 * manager does not. Gating one screen on either would refuse somebody a figure
 * the catalogue says is theirs. `/reports/operations` is the other half, and
 * it shows no money to anyone — see `OPERATING_REPORT_METRICS`.
 */
export default async function FinancialReportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('report.financial.view'),
    shellContext(),
    searchParams,
  ])

  // `requireGrant` redirects when the context is not ready, so this is
  // narrowing for the type system rather than a second decision.
  if (!context || context.status !== 'ready') return null

  const period = parseReportPeriod(params)
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let response: DashboardResponse | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const { source } = await metricsWiring()
    response = await loadReport({
      actor,
      source,
      range: period.range,
      comparison: period.comparison,
      metrics: FINANCIAL_REPORT_METRICS,
      propertyId,
    })
  } catch (cause) {
    // A refused scope arrives here too — `MetricScopeError` is an `AppError`
    // carrying its own Hebrew wording, and `toSafeResponse` keeps that wording
    // rather than replacing it with a generic failure. A property-scoped
    // manager who somehow reached an organization-wide request is told what
    // happened instead of shown an empty report.
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <ReportScreen
      title="דוח כספי"
      intro="הכנסות, גבייה ועלויות הערוצים, כפי שהמדדים מחשבים אותן מקווי המחיר השמורים — ולא ממחירון היום."
      action="/reports"
      range={period.range}
      comparison={period.comparison}
      months={recentMonths(new Date())}
      periodLabel={describePeriod(period.range)}
      issue={periodIssue(params)}
      response={response}
      failure={failure?.error ?? null}
      propertyNames={scopePropertyNames(context.properties, response)}
      crossLink={
        can(actor, 'availability.view', {
          organizationId: actor.organizationId,
        })
          ? { href: '/reports/operations', label: 'לדוח התפעולי ←' }
          : null
      }
    />
  )
}
