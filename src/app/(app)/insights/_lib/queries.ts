/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the insights screen.
 *
 * There are exactly two functions in this module that produce anything, and
 * neither of them is arithmetic. `computeDashboard` produces the figures — it
 * is the only thing in the product allowed to — and `aggregateFacts` produces
 * the operands under them. This file chooses the window, asks for the metrics
 * the rule catalogue declares, and hands both to `buildInsightReport`.
 *
 * ── The metric list is derived, never written twice ───────────────────────
 *
 * `INSIGHT_METRICS` is the union of what the rules declare. Adding a rule
 * therefore adds its metrics to the request with no second edit, and — more
 * importantly — a rule can never quietly read a metric that was never asked
 * for, because `read()` in `rules.ts` throws on a metric that is not in the
 * response.
 *
 * ── Why the facts are loaded here and not taken from the dashboard ────────
 *
 * `computeDashboard` keeps its facts private, and rightly: they hold every
 * figure in the dictionary regardless of who is asking, and handing that
 * object to a caller would put the gate one careless line away from being
 * bypassed. So the facts are loaded again through the same `MetricSource`,
 * with the scope the response resolved — and the evidence layer reads them
 * only for metrics `computeDashboard` was willing to return. The reads
 * themselves are free: `CachedMetricSource` in `wiring.ts` already answered
 * them.
 */

import {
  METRICS,
  aggregateFacts,
  computeDashboard,
  type ComparisonMode,
  type DashboardResponse,
  type MetricFacts,
  type MetricId,
  type MetricRange,
  type MetricSource,
  type ResolvedScope,
} from '@/lib/metrics'
import {
  INSIGHT_RULES,
  buildInsightReport,
  type InsightReport,
} from '@/lib/insights'
import type { Actor } from '@/lib/authz/can'

import { describePeriod } from './period'
import { sourceLabel } from './labels'

/**
 * Every metric any rule reads, once.
 *
 * Sorted by the dictionary's own order so the request is stable across
 * deployments — a request whose metric list reorders itself produces a
 * different `cacheKey` for the same question.
 */
export const INSIGHT_METRICS: readonly MetricId[] = [
  ...new Set(INSIGHT_RULES.flatMap((rule) => rule.metrics)),
].sort((a, b) => a.localeCompare(b))

/**
 * The screen asks for money and is not gated on it.
 *
 * Stated here so the property is visible where the list is: this route admits
 * a general manager who holds no financial grant at all, and every currency
 * metric in the list above is refused for them by `computeDashboard` against
 * `METRICS[id].requires` — absent from `response.metrics`, no value computed.
 * That is what makes one screen honest for both audiences where `/reports` had
 * to become two.
 */
export const CURRENCY_INSIGHT_METRICS: readonly MetricId[] =
  INSIGHT_METRICS.filter((id) => METRICS[id].unit === 'currency')

export type InsightRequest = {
  actor: Actor
  source: MetricSource
  range: MetricRange
  comparison: ComparisonMode
  /** One property, or null for every property this membership reaches. */
  propertyId: string | null
  /** Injected so a test needs no clock. */
  now?: Date
}

export type LoadedInsights = {
  response: DashboardResponse
  report: InsightReport
}

/**
 * One screen's worth of reads and one screen's worth of decisions.
 *
 * The scope is *asked for*, never asserted: `resolveMetricScope` inside
 * `computeDashboard` intersects the request with the membership and refuses
 * the whole thing rather than quietly widening it. So a property-scoped
 * manager passing `propertyId: null` receives their properties, not the
 * organization.
 */
export async function loadInsights(
  request: InsightRequest,
): Promise<LoadedInsights> {
  const response = await computeDashboard({
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
      metrics: INSIGHT_METRICS,
    },
  })

  const facts = await loadFacts(request.source, response.scope, response.range)
  const baselineFacts =
    response.comparisonRange === null
      ? null
      : await loadFacts(
          request.source,
          response.scope,
          response.comparisonRange,
        )

  const report = buildInsightReport({
    actor: request.actor,
    response,
    facts,
    baselineFacts,
    periodLabel: describePeriod(response.range),
    baselineLabel:
      response.comparisonRange === null
        ? null
        : describePeriod(response.comparisonRange),
    sourceLabel,
  })

  return { response, report }
}

/**
 * The facts for one window.
 *
 * The same three reads and the same aggregation `computeDashboard` performs
 * internally, called against the same source instance so the cache answers
 * them. It is not a second definition of anything: `aggregateFacts` is the
 * definition, and this is a call to it.
 */
async function loadFacts(
  source: MetricSource,
  scope: ResolvedScope,
  range: MetricRange,
): Promise<MetricFacts> {
  const [units, outOfService, bookings] = await Promise.all([
    source.loadUnits(scope, range),
    source.loadOutOfService(scope, range),
    source.loadBookings(scope, range),
  ])
  return aggregateFacts({ range, scope, units, outOfService, bookings })
}

/** The Hebrew names of the metrics that were refused, for the note on screen. */
export function withheldNames(response: DashboardResponse): readonly string[] {
  return response.withheld.map((id) => METRICS[id].name)
}

/**
 * The names of the properties the insights actually covered.
 *
 * An id with no name stays an id. Inventing "נכס 1" on the very line that says
 * what the figures cover would be inventing the scope itself.
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
