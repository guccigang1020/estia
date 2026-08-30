/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the report screens.
 *
 * There is exactly one function that produces a figure in this whole module,
 * and it is `computeDashboard` in `src/lib/metrics`. Nothing here divides,
 * sums, rounds or formats: this file chooses *which* metrics to ask for, hands
 * the request to the domain with the actor attached, and returns what comes
 * back. A screen that did its own arithmetic would be a second definition of
 * ADR, and `src/lib/metrics/types.ts` opens by explaining what that costs.
 *
 * ── Two metric sets, and why they are not one screen ──────────────────────
 *
 * `computeDashboard` already withholds any metric the actor may not see, so a
 * single screen asking for all fifteen would be *safe*. It would not be
 * *honest*: a general manager holds `availability.view` and `booking.view` and
 * neither `report.financial.view` nor `finance.view`, so nine of the fifteen
 * tiles would come back withheld and the screen would be mostly an explanation
 * of what they cannot see. Worse, `requireGrant` takes one grant, and no
 * single grant in the catalogue is held by everybody who may legitimately read
 * *some* of these figures — occupancy is gated on `availability.view`, which
 * the accountant does not hold, while revenue is gated on
 * `report.financial.view`, which the general manager does not.
 *
 * So there are two routes with two honest gates. `/reports` is the financial
 * report and is refused without `report.financial.view`. `/reports/operations`
 * is the operating report, is refused without `availability.view`, and asks
 * for **no currency metric at all** — which is a property the tests assert
 * rather than a promise this comment makes.
 */

import {
  METRICS,
  computeDashboard,
  type DashboardResponse,
  type MetricId,
  type MetricSource,
  type ComparisonMode,
  type MetricRange,
} from '@/lib/metrics'
import type { Actor } from '@/lib/authz/can'

/**
 * The money report.
 *
 * Ordered as a person reads a statement: what came in, what it cost, what it
 * says per night, and what is still owed. Occupancy is last and is here on
 * purpose — ADR and RevPAR are meaningless without it, and a revenue figure
 * beside an empty house is a different story from the same figure beside a
 * full one.
 */
export const FINANCIAL_REPORT_METRICS: readonly MetricId[] = [
  'revenue',
  'net_operating_revenue',
  'collected',
  'outstanding_balance',
  'commission_cost',
  'adr',
  'revpar',
  'average_booking_value',
  'direct_booking_share',
  'occupancy',
]

/**
 * The operating report. Every one of these is free/busy or counting.
 *
 * `direct_booking_share` is deliberately absent even though it is a
 * percentage: it is a share *of revenue*, it is gated on
 * `booking.view_source`, and the point of this list is that a reader of this
 * screen learns nothing about money — not the amount, and not its shape.
 * `assertNoCurrency` below is the enforcement; the test beside it is the
 * proof.
 */
export const OPERATING_REPORT_METRICS: readonly MetricId[] = [
  'occupancy',
  'booking_pace',
  'conversion_rate',
  'cancellation_rate',
  'lead_time',
  'length_of_stay',
]

/**
 * Refuse a metric set that carries money onto a screen that must not show it.
 *
 * Called at module load for `OPERATING_REPORT_METRICS`, so adding
 * `revenue` to that list fails the build rather than shipping a shekel figure
 * to somebody whose whole gate was `availability.view`.
 */
export function assertNoCurrency(metrics: readonly MetricId[]): void {
  const money = metrics.filter((id) => METRICS[id].unit === 'currency')
  if (money.length > 0) {
    throw new Error(
      `The operating report must contain no currency metric, and it has: ` +
        `${money.join(', ')}. Currency figures belong on /reports, which is ` +
        `gated on report.financial.view.`,
    )
  }
}

assertNoCurrency(OPERATING_REPORT_METRICS)

export type ReportRequest = {
  actor: Actor
  source: MetricSource
  range: MetricRange
  comparison: ComparisonMode
  metrics: readonly MetricId[]
  /** One property, or null for every property this membership reaches. */
  propertyId: string | null
  /** Injected so a test needs no clock. */
  now?: Date
}

/**
 * One report, one round trip's worth of decisions.
 *
 * The scope is *asked for*, never asserted: `resolveMetricScope` intersects
 * the request with the membership and refuses the whole report rather than
 * quietly widening it — see `scope.ts`. So passing `propertyId: null` for a
 * property-scoped manager does not produce an organization-wide number; it
 * produces their properties, which is the only honest answer.
 */
export async function loadReport(
  request: ReportRequest,
): Promise<DashboardResponse> {
  return computeDashboard({
    actor: request.actor,
    source: request.source,
    now: request.now,
    request: {
      scope: {
        organizationId: request.actor.organizationId,
        ...(request.propertyId === null
          ? {}
          : { propertyId: request.propertyId }),
      },
      range: request.range,
      comparison: request.comparison,
      metrics: request.metrics,
    },
  })
}

/** The Hebrew names of the metrics that were refused, for the note on screen. */
export function withheldNames(response: DashboardResponse): readonly string[] {
  return response.withheld.map((id) => METRICS[id].name)
}

/**
 * The names of the properties the report actually covered.
 *
 * `ResolvedScope` carries ids; the shell already resolved names for the
 * properties this person may select. An id with no name stays an id —
 * inventing "נכס 1" on the very line that says what the figures cover would be
 * inventing the scope itself. `null` property ids mean the whole organization
 * and produce no list, because there is nothing to enumerate.
 */
export function scopePropertyNames(
  properties: readonly { id: string; name: string | null }[],
  response: DashboardResponse | null,
): readonly string[] {
  if (response === null || response.scope.propertyIds === null) return []

  return response.scope.propertyIds.map(
    (id) => properties.find((property) => property.id === id)?.name ?? id,
  )
}
