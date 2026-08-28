/**
 * The aggregation contract.
 *
 * One request, one response, one round trip. A dashboard with fifteen tiles
 * must not be fifteen queries fired from a browser — not for performance,
 * though that too, but because fifteen independent calls are fifteen
 * independent authorization decisions, and the fourteenth is the one somebody
 * forgets to scope.
 *
 * So the browser names a scope, a window, a comparison mode and the metrics it
 * wants, and receives typed results. Everything else — which metrics this actor
 * may see, how wide the aggregate is allowed to be, how the number rounds, what
 * colour it deserves — is decided on the server, here.
 *
 * ── Refusal, and what it looks like ───────────────────────────────────────
 *
 * A metric the actor may not see is **absent**. Not zero, not `null`, not a
 * greyed-out tile with a lock on it holding the real value in its props: absent
 * from the array. The id appears in `withheld` so the interface can explain the
 * gap, and no figure of any kind is computed for it.
 *
 * A scope that cannot be resolved refuses the whole request — see `scope.ts`.
 * There is no honest partial answer to "show me the organization" from someone
 * who may only see one property.
 */

import { holdsGrant, type Actor } from '../authz/can'
import { ValidationError } from '../errors/app-error'
import { metricCacheKey } from './cache-key'
import {
  formatMetricValue,
  isMetricId,
  METRICS,
  type MetricDefinition,
  type MetricId,
} from './dictionary'
import { aggregateFacts, type MetricFacts } from './facts'
import {
  comparisonRange,
  compareValues,
  type ComparisonMode,
  type MetricComparison,
} from './periods'
import {
  resolveMetricScope,
  type ResolvedScope,
  type ScopeRequest,
} from './scope'
import type { MetricSource } from './source'
import {
  assertValidRange,
  type MetricRange,
  type MetricState,
  type MetricUnit,
  type MetricValue,
  type TrendDirection,
} from './types'

// ── Request ───────────────────────────────────────────────────────────────

export interface DashboardRequest {
  /** Organization, and optionally one property or unit inside it. */
  scope: ScopeRequest
  range: MetricRange
  comparison: ComparisonMode
  /** Only these are computed. Asking for less does less work. */
  metrics: readonly MetricId[]
}

// ── Response ──────────────────────────────────────────────────────────────

export interface MetricResult {
  id: MetricId
  /** Carried with the value so a tile needs no second lookup to label itself. */
  name: string
  description: string
  unit: MetricUnit
  value: MetricValue
  /** Formatted once, here, so two screens cannot render the same value differently. */
  formatted: string
  comparison: MetricComparison | null
  trend: TrendDirection
  state: MetricState
  /** May this actor open the records behind the figure? */
  detailAvailable: boolean
}

export interface DashboardResponse {
  organizationId: string
  /** What was actually aggregated, after the membership narrowed the request. */
  scope: ResolvedScope
  range: MetricRange
  comparison: ComparisonMode
  comparisonRange: MetricRange | null
  metrics: readonly MetricResult[]
  /** Requested, and refused. No values, no comparisons, nothing. */
  withheld: readonly MetricId[]
  cacheKey: string
  generatedAt: string
}

// ── Colour, decided by meaning ────────────────────────────────────────────

/**
 * Below this, a change is noise.
 *
 * Percent of the baseline, not percent points. Occupancy moving from 70.0 to
 * 70.9 is a rounding artefact of a single booking, and painting it green
 * teaches people to ignore the colours.
 */
export const MATERIAL_CHANGE_PERCENT = 2

/** Above this, an adverse move is not a warning but a fire. */
export const SEVERE_CHANGE_PERCENT = 25

/**
 * What the interface should say about this figure.
 *
 * Never "it went up, so green". A rise in cancellations, in commission cost or
 * in outstanding balance is bad news, and the dictionary says so through
 * `sentiment`. Absolute thresholds beat the trend, because 8% occupancy is
 * critical whether or not it doubled.
 */
export function evaluateState(
  definition: MetricDefinition,
  value: MetricValue,
  comparison: MetricComparison | null,
): MetricState {
  // Nothing measured, nothing to say. A missing figure is not a bad one.
  if (value === null) return 'neutral'

  const thresholds = definition.thresholds
  if (thresholds) {
    const { criticalAbove, criticalBelow, warningAbove, warningBelow } =
      thresholds
    if (criticalAbove !== undefined && value > criticalAbove) return 'critical'
    if (criticalBelow !== undefined && value < criticalBelow) return 'critical'
    if (warningAbove !== undefined && value > warningAbove) return 'warning'
    if (warningBelow !== undefined && value < warningBelow) return 'warning'
  }

  // A metric with no direction of goodness gets no opinion from a trend.
  if (definition.sentiment === 'neutral') return 'neutral'

  // Nothing to compare against, or two windows of different lengths for a
  // figure that grows with length: February is not in trouble for being short.
  if (!comparison || !comparison.comparable) return 'neutral'

  const { delta, deltaPercent } = comparison
  if (delta === null || deltaPercent === null) return 'neutral'
  if (Math.abs(deltaPercent) < MATERIAL_CHANGE_PERCENT) return 'neutral'

  const adverse =
    definition.sentiment === 'higher_is_better' ? delta < 0 : delta > 0
  if (!adverse) return 'positive'
  return Math.abs(deltaPercent) >= SEVERE_CHANGE_PERCENT
    ? 'critical'
    : 'warning'
}

// ── The operation ─────────────────────────────────────────────────────────

export interface DashboardArgs {
  actor: Actor
  request: DashboardRequest
  source: MetricSource
  /** Injected, so a response is deterministic and a test needs no clock. */
  now?: Date
}

export async function computeDashboard(
  args: DashboardArgs,
): Promise<DashboardResponse> {
  const { actor, request, source } = args
  const now = args.now ?? new Date()

  assertValidRange(request.range)
  assertKnownMetrics(request.metrics)

  // Scope first. A request that cannot be narrowed to something this actor may
  // see is refused before a single row is read.
  const scope = resolveMetricScope(actor, request.scope)

  const requested = [...new Set(request.metrics)]
  const visible: MetricId[] = []
  const withheld: MetricId[] = []
  for (const id of requested) {
    if (holdsGrant(actor, METRICS[id].requires)) visible.push(id)
    else withheld.push(id)
  }

  const cacheKey = metricCacheKey({
    actor,
    scope,
    range: request.range,
    comparison: request.comparison,
    metrics: requested,
  })

  const baselineRange = comparisonRange(request.range, request.comparison)

  const skeleton = {
    organizationId: scope.organizationId,
    scope,
    range: request.range,
    comparison: request.comparison,
    comparisonRange: baselineRange,
    withheld,
    cacheKey,
    generatedAt: now.toISOString(),
  }

  // Nothing this actor may see means nothing to fetch. Reading rows in order to
  // throw the answer away would be a privacy cost with no product benefit.
  if (visible.length === 0) {
    return { ...skeleton, metrics: [] }
  }

  const facts = await loadFacts(source, scope, request.range)
  const baselineFacts =
    baselineRange === null
      ? null
      : await loadFacts(source, scope, baselineRange)

  const metrics = visible.map((id) =>
    buildResult(actor, METRICS[id], facts, baselineFacts, request),
  )

  return { ...skeleton, metrics }
}

// ── Helpers ───────────────────────────────────────────────────────────────

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

function buildResult(
  actor: Actor,
  definition: MetricDefinition,
  facts: MetricFacts,
  baselineFacts: MetricFacts | null,
  request: DashboardRequest,
): MetricResult {
  const value = definition.compute(facts)

  const comparison =
    baselineFacts === null || request.comparison === 'none'
      ? null
      : compareValues({
          basis: request.comparison,
          range: request.range,
          baselineRange: baselineFacts.range,
          unit: definition.unit,
          extensive: definition.extensive,
          current: value,
          baseline: definition.compute(baselineFacts),
          baselineHasData: baselineFacts.hasData,
        })

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    unit: definition.unit,
    value,
    formatted: formatMetricValue(definition.unit, value),
    comparison,
    trend: comparison?.direction ?? 'unknown',
    state: evaluateState(definition, value, comparison),
    detailAvailable:
      definition.detailRequires !== undefined &&
      holdsGrant(actor, definition.detailRequires),
  }
}

/**
 * An unknown metric id is a client bug, reported as one.
 *
 * Silently ignoring it would leave a tile permanently blank with nothing in any
 * log to say why.
 */
function assertKnownMetrics(metrics: readonly string[]): void {
  const unknown = metrics.filter((id) => !isMetricId(id))
  if (unknown.length === 0) return

  throw new ValidationError(
    unknown.map((id) => ({
      field: 'metrics',
      code: 'unknown_metric',
      message: `המדד המבוקש אינו קיים: ${id}`,
      label: 'מדדים',
    })),
  )
}
