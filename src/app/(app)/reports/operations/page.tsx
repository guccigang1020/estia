import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ReportScreen } from '@/components/reports/report-screen'
import { can } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import type { DashboardResponse } from '@/lib/metrics'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  describePeriod,
  parseReportPeriod,
  periodIssue,
  recentMonths,
} from '../_lib/period'
import {
  OPERATING_REPORT_METRICS,
  loadReport,
  scopePropertyNames,
} from '../_lib/queries'
import { metricsWiring } from '../_lib/wiring'

export const metadata: Metadata = { title: 'דוח תפעולי' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The operating report.
 *
 * WHAT IS ON THIS SCREEN, AND WHAT CAN NEVER BE. Six figures, all of them
 * free/busy or counting: how full the house was, how fast the book filled, how
 * many enquiries closed, how many stays fell over, how far ahead people book
 * and how long they stay. `OPERATING_REPORT_METRICS` contains no currency
 * metric, and `assertNoCurrency` runs at module load so that adding one fails
 * the build rather than shipping a shekel figure to a reader whose entire gate
 * was `availability.view`. An owner opening this screen sees no money either —
 * that is the point: the screen is defined by what it measures, not by who is
 * looking.
 *
 * WHY `availability.view` IS THE RIGHT GATE. It is the grant occupancy itself
 * requires, and the metric dictionary is explicit about why: occupancy is
 * free/busy arithmetic that exposes no price, no guest and no channel, so an
 * external seller may be told how full a property is without being shown a
 * shekel. The five counting metrics beside it need `booking.view`, and
 * `computeDashboard` withholds them independently from anybody who lacks it —
 * so a reader with availability and nothing else gets occupancy and an honest
 * note naming the five they did not get.
 *
 * WHAT THIS SCREEN WITHHOLDS FROM A CLEANER: everything, and before it renders.
 * A cleaner holds `task.view` and not `availability.view`, so `requireGrant`
 * redirects. Their screen is `/preparation`.
 *
 * NO HISTORICAL DRIFT. Occupancy for last March counts the nights those stays
 * actually held, from the stored check-in and check-out dates, against the
 * units that were in service then — see the `inServiceFrom` note in
 * `persistence/metrics.ts`. Nothing here re-derives a past month from today's
 * inventory.
 */
export default async function OperatingReportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('availability.view'),
    shellContext(),
    searchParams,
  ])

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
      metrics: OPERATING_REPORT_METRICS,
      propertyId,
    })
  } catch (cause) {
    // `MetricScopeError` lands here for a membership whose scope has no
    // aggregate form — a cleaner's team scope, an agent's own-records scope.
    // "Occupancy of my own records" is not a question with an answer, and the
    // domain refuses the whole report rather than widening it to one that is.
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <ReportScreen
      title="דוח תפעולי"
      intro="תפוסה, קצב סגירה ואורך שהייה. אין בדוח הזה שום סכום כסף, לאף משתמש."
      action="/reports/operations"
      range={period.range}
      comparison={period.comparison}
      months={recentMonths(new Date())}
      periodLabel={describePeriod(period.range)}
      issue={periodIssue(params)}
      response={response}
      failure={failure?.error ?? null}
      propertyNames={scopePropertyNames(context.properties, response)}
      crossLink={
        can(actor, 'report.financial.view', {
          organizationId: actor.organizationId,
        })
          ? { href: '/reports', label: 'לדוח הכספי ←' }
          : null
      }
    />
  )
}
