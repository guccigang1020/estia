/**
 * Cache keys, which are a security boundary.
 *
 * A dashboard is expensive and obviously cacheable, and the obvious key —
 * "the date range and the metrics asked for" — serves one customer's revenue to
 * another. That is not a subtle bug: it is the worst failure the product can
 * have, introduced by an optimisation nobody reviews.
 *
 * So the key derivation is here, next to the code that resolves scope, and it
 * includes everything that can change the answer:
 *
 *   1. **The organization.** The tenant boundary, first and unconditionally.
 *   2. **The resolved scope**, not the requested one — the properties and units
 *      actually aggregated after the membership narrowed the request.
 *   3. **The permission-relevant identity.** Not the user id: the set of grants
 *      that this request's metrics actually depend on, restricted to the ones
 *      the actor holds. Two colleagues with the same organization, the same
 *      scope and the same relevant grants receive a byte-identical response, so
 *      sharing an entry between them is correct and keying on the user id would
 *      multiply the cache by the size of the staff list for no safety at all.
 *      An actor missing `commission.view` derives a different key, because they
 *      receive a different response.
 *   4. The window, the comparison mode and the metrics requested.
 *
 * ── Why this is not hashed ────────────────────────────────────────────────
 *
 * A short hash makes a tidy key and introduces the possibility of two tenants
 * colliding. The consequence of that collision is one customer being served
 * another's financials — so the key is a long, canonical, unambiguous string
 * instead. Every segment is escaped, which means no combination of identifiers
 * can be arranged to spell a different key: a property literally named `a|b` is
 * distinguishable from the pair `a` and `b`. Storage is cheap; the alternative
 * is not.
 */

import { holdsGrant, type Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { METRICS, type MetricId } from './dictionary'
import type { ComparisonMode } from './periods'
import { describeScope, type ResolvedScope } from './scope'
import type { MetricRange } from './types'

const VERSION = 'metrics.v1'
const SEPARATOR = '|'

/**
 * Make a segment unable to impersonate a boundary.
 *
 * Without this, an organization called `a` with property `b|c` and an
 * organization called `a|b` with property `c` produce the same joined string.
 */
function escapeSegment(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\p')
}

/**
 * The grants that decide what this request returns, filtered to the ones the
 * actor actually holds.
 *
 * Both the viewing grant and the drill-down grant are included: `detailAvailable`
 * is part of the response, so an actor who may open the payments behind a total
 * must not be served a cached response that says they may not.
 */
export function accessFingerprint(
  actor: Actor,
  metrics: readonly MetricId[],
): readonly string[] {
  const relevant = new Set<Grant>()
  for (const id of metrics) {
    const definition = METRICS[id]
    if (!definition) continue
    relevant.add(definition.requires)
    if (definition.detailRequires) relevant.add(definition.detailRequires)
  }

  const held = [...relevant].filter((grant) => holdsGrant(actor, grant)).sort()
  // Platform staff bypass scope inside an organization, so they can see a wider
  // aggregate than a member holding the identical grants.
  return actor.isPlatformStaff ? ['@platform_staff', ...held] : held
}

export interface CacheKeyInput {
  actor: Actor
  scope: ResolvedScope
  range: MetricRange
  comparison: ComparisonMode
  metrics: readonly MetricId[]
}

export function metricCacheKey(input: CacheKeyInput): string {
  const metrics = [...new Set(input.metrics)].sort()

  const segments = [
    VERSION,
    `org=${input.actor.organizationId}`,
    `scope=${describeScope(input.scope)}`,
    `range=${input.range.start}..${input.range.end}`,
    `cmp=${input.comparison}`,
    `metrics=${metrics.join(',')}`,
    `access=${accessFingerprint(input.actor, metrics).join(',')}`,
  ]

  return segments.map(escapeSegment).join(SEPARATOR)
}
