/**
 * Scope, which is where a metrics layer leaks data.
 *
 * Row-level rules protect rows. An aggregate is not a row: it is a number
 * computed from rows the caller may never see, and handing it over defeats
 * every rule underneath it. "Total revenue ₪412,000" tells a property manager
 * scoped to one cabin exactly what the other eleven earned, and no row was
 * exposed to do it.
 *
 * So a dashboard request never chooses its own scope. It *asks*, and the answer
 * is the intersection of what it asked for with what the actor's membership
 * permits. Two properties of that resolution matter more than anything else in
 * this file:
 *
 *   1. An actor whose membership is scoped to properties can never resolve to
 *      "the whole organization". Not by omitting the filter, not by passing an
 *      empty one, not by naming a property they do not hold.
 *   2. The resolved scope is *also* applied to the rows the source returns.
 *      The source is told the scope and is expected to filter, and then the
 *      rows are filtered again here. A query built wrong is a bug; a query
 *      built wrong that silently widens an aggregate is a breach.
 */

import { AppError } from '../errors/app-error'
import type { Actor } from '../authz/can'

// ── The resolved answer ───────────────────────────────────────────────────

/**
 * What this dashboard is allowed to cover.
 *
 * `null` means "no restriction at this level" — every property in the
 * organization, or every unit inside the properties above. It never means
 * "unknown": reaching `propertyIds: null` requires an organization-wide
 * membership, and `resolveMetricScope` is the only thing that can produce it.
 */
export interface ResolvedScope {
  organizationId: string
  propertyIds: readonly string[] | null
  unitIds: readonly string[] | null
}

/** What a caller may ask for. Every field beyond the organization is a narrowing. */
export interface ScopeRequest {
  organizationId: string
  propertyId?: string
  unitId?: string
}

// ── Refusals ──────────────────────────────────────────────────────────────

export type ScopeRefusal =
  | 'cross_organization'
  | 'membership_not_active'
  | 'out_of_scope'
  | 'scope_not_aggregatable'

const REFUSAL_MESSAGE: Record<ScopeRefusal, string> = {
  cross_organization: 'הנתונים המבוקשים שייכים לעסק אחר.',
  membership_not_active: 'החשבון שלך אינו פעיל בעסק הזה.',
  out_of_scope: 'אין לך גישה לנכס או ליחידה שביקשת.',
  scope_not_aggregatable:
    'ההרשאה שלך מוגדרת לרשומות אישיות בלבד, ולכן אין לך לוח בקרה מסכם.',
}

/**
 * The dashboard is refused as a whole.
 *
 * Deliberately not a partial answer. A missing *metric* is a normal state — the
 * actor may see occupancy and not revenue — but a scope that cannot be resolved
 * has no honest reduced form. Returning the numbers for one property under a
 * heading that says "all properties" would be worse than an error.
 */
export class MetricScopeError extends AppError {
  readonly refusal: ScopeRefusal

  constructor(refusal: ScopeRefusal, detail: string) {
    super({
      code: `metric_scope_${refusal}`,
      status: refusal === 'membership_not_active' ? 401 : 403,
      message: `Metric scope refused (${refusal}): ${detail}`,
      userMessage: REFUSAL_MESSAGE[refusal],
      retryable: false,
      dataOutcome: 'not_saved',
    })
    this.refusal = refusal
  }
}

// ── Resolution ────────────────────────────────────────────────────────────

/**
 * Narrow a request to what the actor may actually be told.
 *
 * The order is the same as the authorization engine's, and for the same
 * reasons: membership, then tenant, then scope. Tenant is checked before
 * anything reads a scope array, so a request aimed at another customer is
 * refused without any of this customer's identifiers being consulted.
 */
export function resolveMetricScope(
  actor: Actor,
  request: ScopeRequest,
): ResolvedScope {
  if (actor.membershipStatus !== 'active') {
    throw new MetricScopeError(
      'membership_not_active',
      `membership is ${actor.membershipStatus}`,
    )
  }

  if (request.organizationId !== actor.organizationId) {
    throw new MetricScopeError(
      'cross_organization',
      `actor is in ${actor.organizationId}, request names ${request.organizationId}`,
    )
  }

  // The ceiling: the widest set of rows this membership may ever aggregate.
  let propertyIds: readonly string[] | null
  let unitIds: readonly string[] | null

  // Platform staff act across an organization once inside it, exactly as
  // `isWithinScope` allows — and never across the tenant boundary checked
  // above. Every such view is audited by the caller.
  if (actor.isPlatformStaff) {
    propertyIds = null
    unitIds = null
  } else {
    switch (actor.scope.kind) {
      case 'all_organization':
        propertyIds = null
        unitIds = null
        break

      case 'properties':
        // The whole point of this file. Even with no filter in the request,
        // this actor's ceiling is their own properties and never `null`.
        propertyIds = actor.scope.propertyIds
        unitIds = null
        break

      case 'units':
        propertyIds = null
        unitIds = actor.scope.unitIds
        break

      // A team scope and an own-records scope describe rows belonging to
      // people, not inventory. "Occupancy of my own records" is not a
      // question with an answer, and inventing one — by widening to the
      // organization — is the leak this whole module exists to prevent.
      case 'team':
      case 'own_records':
      default:
        throw new MetricScopeError(
          'scope_not_aggregatable',
          `membership scope '${actor.scope.kind}' has no aggregate form`,
        )
    }
  }

  // An empty scope array is a membership that reaches nothing. It is not a
  // wildcard, and must not be allowed to behave like one.
  if (propertyIds !== null && propertyIds.length === 0) {
    throw new MetricScopeError('out_of_scope', 'membership reaches no property')
  }
  if (unitIds !== null && unitIds.length === 0) {
    throw new MetricScopeError('out_of_scope', 'membership reaches no unit')
  }

  // Now the request's own narrowing, which may only ever shrink the ceiling.
  if (request.propertyId !== undefined) {
    if (propertyIds !== null && !propertyIds.includes(request.propertyId)) {
      throw new MetricScopeError(
        'out_of_scope',
        `property ${request.propertyId} is outside the membership scope`,
      )
    }
    propertyIds = [request.propertyId]
  }

  if (request.unitId !== undefined) {
    if (unitIds !== null && !unitIds.includes(request.unitId)) {
      throw new MetricScopeError(
        'out_of_scope',
        `unit ${request.unitId} is outside the membership scope`,
      )
    }
    unitIds = [request.unitId]
  }

  // A unit-scoped actor asking about a property keeps both filters, and the
  // rows that survive are the intersection. If the unit is not in that
  // property the answer is empty — which is correct, and is not a leak.
  return {
    organizationId: actor.organizationId,
    propertyIds: propertyIds === null ? null : [...propertyIds],
    unitIds: unitIds === null ? null : [...unitIds],
  }
}

// ── Enforcement on the rows themselves ────────────────────────────────────

/** Anything a metric aggregates carries where it happened. */
export interface ScopedRow {
  propertyId: string
  unitId?: string
}

export function isRowInScope(scope: ResolvedScope, row: ScopedRow): boolean {
  if (scope.propertyIds !== null && !scope.propertyIds.includes(row.propertyId))
    return false
  if (scope.unitIds !== null) {
    if (row.unitId === undefined) return false
    if (!scope.unitIds.includes(row.unitId)) return false
  }
  return true
}

/**
 * The second floor.
 *
 * The source is given the scope and is expected to filter in the database,
 * where it is cheap. This runs anyway. A source that over-returns — a join
 * written wrong, a stale cache, a test double — must produce a narrow number,
 * not a wide one.
 */
export function filterToScope<T extends ScopedRow>(
  scope: ResolvedScope,
  rows: readonly T[],
): readonly T[] {
  return rows.filter((row) => isRowInScope(scope, row))
}

/**
 * A stable, unambiguous rendering of a scope. Used by the cache key.
 *
 * Identifiers are escaped, so a property whose id contains the separator cannot
 * be arranged to spell a different scope. Ids are database keys today and this
 * would be paranoid — right up until an integration introduces an external
 * identifier and the paranoia turns out to have been the only thing standing
 * between two customers' dashboards.
 */
export function describeScope(scope: ResolvedScope): string {
  const list = (ids: readonly string[] | null): string =>
    ids === null ? '*' : [...ids].map(escapeId).sort().join(',')
  return `p=${list(scope.propertyIds)};u=${list(scope.unitIds)}`
}

function escapeId(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\c')
    .replace(/;/g, '\\s')
    .replace(/\*/g, '\\a')
}
