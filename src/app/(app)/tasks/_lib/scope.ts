/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * A membership's scope, expressed as a query narrowing, for the four
 * operations screens.
 *
 * ── Why the scope is pushed into the query at all ─────────────────────────
 *
 * Row level security is the floor and this is not a substitute for it. But a
 * query that reads the whole organization and then filters in JavaScript has
 * already read rows it had no business reading, so the membership's scope goes
 * into the query and every row that comes back is checked again with `can()`.
 * That is the same two-floor rule `preparation/_lib/queries.ts` and
 * `properties/_lib/load.ts` already apply.
 *
 * ── Why this is per *table shape* and not one narrowing ───────────────────
 *
 * `scopeReaches` in `src/lib/authz/can.ts` answers `team` by looking for
 * `resource.teamId` and refuses when there is none. `public.tasks` has a
 * `team_id`; `public.inventory_items` does not. A narrowing that filtered
 * `inventory_items.team_id` would name a column that is not there — the query
 * fails against Postgres and matches nothing in the demo, and neither is the
 * true answer. The true answer is that a team-scoped membership reaches no
 * inventory row at all, exactly as `can()` would say, and it is spelled here
 * as `nothing` so no query is issued for it.
 *
 * So each table declares which of the five location columns it actually has,
 * and a scope that has no column to land on reaches nothing rather than
 * everything. Deny by default, in the shape the table really has.
 *
 * ── `nothing` rather than `in (…)` with an empty list ─────────────────────
 *
 * An empty `in` is a query that has to be issued to come back empty, and
 * PostgREST's handling of `in.()` is not something to rest a privacy rule on.
 * `nothing` short-circuits before a request is made, which is provably empty
 * and costs nothing.
 */

import {
  scopeFor,
  type Actor,
  type Resource,
  type Scope,
} from '@/lib/authz/can'

/**
 * One narrowing, as data rather than as a function over a query builder.
 *
 * `bookings/_lib/queries.ts` made this call first and for the same reason:
 * taking a PostgREST builder as a parameter needs a self-referential generic
 * that blows TypeScript's instantiation depth on these types, and an `any` in
 * the function that applies the tenant filter is not a trade worth making. So
 * the *decision* travels and each query applies it inline.
 */
export type ScopeNarrowing =
  /** No narrowing beyond the tenant filter the caller already applied. */
  | { kind: 'none' }
  | { kind: 'in'; column: string; values: readonly string[] }
  | { kind: 'eq'; column: string; value: string }
  /** This membership reaches no row of this table. Issue no query. */
  | { kind: 'nothing' }

/**
 * Which of the five location columns a table actually carries.
 *
 * Written per table rather than assumed, because the assumption is what
 * produces a filter on a column that is not there.
 */
export type ScopeColumns = {
  property?: string
  unit?: string
  team?: string
  /** The person answerable for the row. */
  assignee?: string
  /** The person who wrote the row. */
  creator?: string
}

/** `public.tasks`, 0011. It carries all five. */
export const TASK_SCOPE_COLUMNS: ScopeColumns = {
  property: 'property_id',
  unit: 'unit_id',
  team: 'team_id',
  assignee: 'assigned_to_user_id',
  creator: 'created_by',
}

/**
 * `public.inventory_items`, 0011. No `team_id` and no assignee.
 *
 * A stock cupboard belongs to a property and sometimes to a unit. It belongs
 * to nobody's team, which is why a team-scoped membership reaches none of it.
 */
export const INVENTORY_SCOPE_COLUMNS: ScopeColumns = {
  property: 'property_id',
  unit: 'unit_id',
  creator: 'created_by',
}

/**
 * The scope that governs an operations row for this actor.
 *
 * `family: 'operations'` and not the bare default: an external seller's
 * default scope is `own_records` while their inventory scope is a property
 * list, so asking without the family applies the wrong one of their two
 * scopes.
 */
export function operationsScope(actor: Actor): Scope {
  return scopeFor(actor, {
    organizationId: actor.organizationId,
    family: 'operations',
  })
}

/** The resource an authorization question about an operations row is asked about. */
export function operationsResource(
  actor: Actor,
  row: {
    propertyId?: string | null
    unitId?: string | null
    teamId?: string | null
    assignedToUserId?: string | null
    createdByUserId?: string | null
  },
): Resource {
  const resource: Resource = {
    organizationId: actor.organizationId,
    family: 'operations',
  }
  if (row.propertyId) resource.propertyId = row.propertyId
  if (row.unitId) resource.unitId = row.unitId
  if (row.teamId) resource.teamId = row.teamId
  if (row.assignedToUserId) resource.assignedToUserId = row.assignedToUserId
  if (row.createdByUserId) resource.createdByUserId = row.createdByUserId
  return resource
}

/**
 * The narrowings to apply when reading `table` as this actor.
 *
 * Almost always one. `own_records` is the exception and is genuinely a
 * disjunction — `scopeReaches` admits a row assigned to this person *or*
 * created by them — and PostgREST expresses that with `.or()`, which the
 * transaction compiler and the demo client both refuse on purpose. So it is
 * two queries whose results are merged by id, exactly as the guest-name search
 * in `bookings/_lib/queries.ts` unions two matches rather than reaching for
 * `or`.
 */
export function narrowingsFor(
  actor: Actor,
  columns: ScopeColumns,
  scope: Scope = operationsScope(actor),
): readonly ScopeNarrowing[] {
  // Platform staff act across an organization once inside it, exactly as
  // `isWithinScope` allows, and every such view is audited by the caller.
  if (actor.isPlatformStaff) return [{ kind: 'none' }]

  switch (scope.kind) {
    case 'all_organization':
      return [{ kind: 'none' }]

    case 'properties':
      return columns.property === undefined
        ? [{ kind: 'nothing' }]
        : [{ kind: 'in', column: columns.property, values: scope.propertyIds }]

    case 'units':
      return columns.unit === undefined
        ? [{ kind: 'nothing' }]
        : [{ kind: 'in', column: columns.unit, values: scope.unitIds }]

    case 'team':
      return columns.team === undefined
        ? [{ kind: 'nothing' }]
        : [{ kind: 'in', column: columns.team, values: scope.teamIds }]

    case 'own_records': {
      const narrowings: ScopeNarrowing[] = []
      if (columns.assignee !== undefined) {
        narrowings.push({
          kind: 'eq',
          column: columns.assignee,
          value: actor.userId,
        })
      }
      if (columns.creator !== undefined) {
        narrowings.push({
          kind: 'eq',
          column: columns.creator,
          value: actor.userId,
        })
      }
      return narrowings.length > 0 ? narrowings : [{ kind: 'nothing' }]
    }

    default:
      // Deny by default. An unrecognised scope reaches nothing rather than
      // everything, which is the failure mode that matters.
      return [{ kind: 'nothing' }]
  }
}

/**
 * An empty scope list is a membership that reaches nothing.
 *
 * `{ kind: 'properties', propertyIds: [] }` is a real row — a property manager
 * whose last property was sold — and treating an empty list as a wildcard
 * would hand them the whole organization. `narrowingsFor` produces
 * `in (…empty)` for it, and this is what turns that into "issue no query".
 */
export function reachesNothing(narrowing: ScopeNarrowing): boolean {
  return (
    narrowing.kind === 'nothing' ||
    (narrowing.kind === 'in' && narrowing.values.length === 0)
  )
}
