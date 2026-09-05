/**
 * One read per window, however many times it is asked for.
 *
 * The insights screen needs two things from the same rows: the *values*, which
 * only `computeDashboard` may produce because only it applies the actor's
 * grants, and the *operands* behind them, which come from `aggregateFacts`.
 * Asking the database twice for the same window would be six queries where
 * three will do, and — worse than the cost — it would open a window in which
 * the figures and the arithmetic under them could disagree because a booking
 * was written between the two reads.
 *
 * So the source is wrapped once and both readers see the same rows. It is a
 * decorator rather than a change to `SupabaseMetricSource`, which belongs to
 * the persistence layer and is used by screens that read each window once and
 * would pay for a cache they never hit.
 *
 * ── The lifetime is one request, and that is not an optimisation ──────────
 *
 * An instance is built inside the request that uses it and thrown away with
 * it, exactly as `metricsWiring` builds its client per call. A cache at module
 * scope would be one cache shared by every signed-in person on the server, and
 * the key below deliberately does not contain an actor — because the *scope*
 * is what the rows were filtered by. Two actors with the same resolved scope
 * may legitimately share rows; two actors with different scopes produce
 * different keys. That is safe only while the instance cannot outlive the
 * request, so it must not be hoisted.
 */

import type {
  MetricRange,
  MetricSource,
  OutOfServiceRow,
  ResolvedScope,
  UnitInventoryRow,
} from '../metrics'
import type { BookingFactRow } from '../metrics'

function key(scope: ResolvedScope, range: MetricRange): string {
  const properties = scope.propertyIds === null ? '*' : scope.propertyIds.join()
  const units = scope.unitIds === null ? '*' : scope.unitIds.join()
  return `${scope.organizationId}|${properties}|${units}|${range.start}|${range.end}`
}

export class CachedMetricSource implements MetricSource {
  // Promises rather than values, so two callers racing for the same window
  // share one query instead of starting a second before the first resolves.
  private readonly units = new Map<
    string,
    Promise<readonly UnitInventoryRow[]>
  >()
  private readonly blocks = new Map<
    string,
    Promise<readonly OutOfServiceRow[]>
  >()
  private readonly bookings = new Map<
    string,
    Promise<readonly BookingFactRow[]>
  >()

  constructor(private readonly inner: MetricSource) {}

  loadUnits(
    scope: ResolvedScope,
    range: MetricRange,
  ): Promise<readonly UnitInventoryRow[]> {
    return memoize(this.units, key(scope, range), () =>
      this.inner.loadUnits(scope, range),
    )
  }

  loadOutOfService(
    scope: ResolvedScope,
    range: MetricRange,
  ): Promise<readonly OutOfServiceRow[]> {
    return memoize(this.blocks, key(scope, range), () =>
      this.inner.loadOutOfService(scope, range),
    )
  }

  loadBookings(
    scope: ResolvedScope,
    range: MetricRange,
  ): Promise<readonly BookingFactRow[]> {
    return memoize(this.bookings, key(scope, range), () =>
      this.inner.loadBookings(scope, range),
    )
  }
}

/**
 * Remember the promise, and forget it if it rejects.
 *
 * A cached rejection would turn one failed query into a screen that can never
 * recover inside the request, and — because the page catches and renders an
 * error — into a correlation id that names the wrong read.
 */
function memoize<T>(
  store: Map<string, Promise<T>>,
  cacheKey: string,
  load: () => Promise<T>,
): Promise<T> {
  const existing = store.get(cacheKey)
  if (existing) return existing

  const pending = load().catch((cause) => {
    store.delete(cacheKey)
    throw cause
  })

  store.set(cacheKey, pending)
  return pending
}
