/**
 * EXECUTION CONTEXT — SERVER ONLY. What a person may open a task *against*.
 *
 * ── The gap this file exists to close ─────────────────────────────────────
 *
 * `isWithinScope` cannot answer "may this team-scoped person act on this
 * property". `scopeReaches` handles a `team` scope by looking for
 * `resource.teamId` and refusing when there is none — which is correct for
 * reading a task, because a task carries a team. A *property* does not carry
 * one, so `can(cleaner, 'incident.create', { propertyId })` is false for every
 * cleaner in the product, and the cleaner reporting a fault is the entire point
 * of the incidents screen.
 *
 * The honest way round it is not to widen the engine and not to skip the check.
 * It is to derive, from the very same scope, the set of places this person
 * demonstrably reaches — and then to require that the property and unit they
 * named be in it. For an organization-wide or property-scoped membership that
 * set is the properties in their scope. For a team-scoped or `own_records`
 * membership it is the properties and units on the *tasks they already hold*,
 * which is data they legitimately have in their hands and nothing more.
 *
 * The same function feeds the form's `<select>` and the action's refusal, so
 * the control and the enforcement cannot drift: what is not offered is also not
 * accepted.
 */

import { scopeFor, type Actor } from '@/lib/authz/can'
import {
  asString,
  asStringOrNull,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

import { TASK_SCOPE_COLUMNS, narrowingsFor, reachesNothing } from './scope'

export type TargetProperty = { id: string; name: string | null }
export type TargetUnit = { id: string; name: string; propertyId: string }
export type TargetTeam = { id: string; name: string }

export type TaskTargets = {
  properties: readonly TargetProperty[]
  units: readonly TargetUnit[]
  /** Empty when this person may not route work to a team. */
  teams: readonly TargetTeam[]
}

/** Nothing reachable. A person in this state cannot open a task at all. */
export const NO_TARGETS: TaskTargets = {
  properties: [],
  units: [],
  teams: [],
}

/**
 * Where this person may open work.
 *
 * Two shapes, chosen by the scope kind rather than by the grant, because the
 * question is "where does this membership reach" and that is what a scope is.
 */
export async function listTaskTargets(
  db: Db,
  actor: Actor,
): Promise<TaskTargets> {
  const scope = scopeFor(actor, {
    organizationId: actor.organizationId,
    family: 'operations',
  })

  const anchors =
    scope.kind === 'team' || scope.kind === 'own_records'
      ? await anchorsFromOwnTasks(db, actor)
      : await anchorsFromScope(db, actor, scope)

  if (anchors.propertyIds.length === 0) return NO_TARGETS

  const [properties, units, teams] = await Promise.all([
    loadProperties(db, actor, anchors.propertyIds),
    loadUnits(db, actor, anchors),
    loadTeams(db, actor, scope),
  ])

  return { properties, units, teams }
}

/**
 * Is this a place the person may open work against?
 *
 * Both halves are checked. A unit that belongs to a different property from the
 * one named is refused even when both are individually reachable — 0011's
 * `tasks_unit_fkey` is a three-column key over (unit, organization, property)
 * and would refuse it at the database, and a form that let somebody get that
 * far would produce a constraint error instead of a sentence.
 */
export function isReachableTarget(
  targets: TaskTargets,
  input: { propertyId: string; unitId: string | null; teamId: string | null },
): boolean {
  if (
    !targets.properties.some((property) => property.id === input.propertyId)
  ) {
    return false
  }

  if (input.unitId !== null) {
    const unit = targets.units.find((entry) => entry.id === input.unitId)
    if (!unit || unit.propertyId !== input.propertyId) return false
  }

  if (input.teamId !== null) {
    if (!targets.teams.some((team) => team.id === input.teamId)) return false
  }

  return true
}

/* ------------------------------------------------------------ internals -- */

type Anchors = {
  propertyIds: readonly string[]
  /** Set only when the unit list is itself constrained, not merely derived. */
  unitIds: readonly string[] | null
}

/**
 * The places a location scope names.
 *
 * `units` resolves up to the properties holding those units, because a task
 * needs a `property_id` and 0011 makes it NOT NULL — a unit-scoped person who
 * could name no property could open no task at all.
 */
async function anchorsFromScope(
  db: Db,
  actor: Actor,
  scope: ReturnType<typeof scopeFor>,
): Promise<Anchors> {
  if (scope.kind === 'all_organization') {
    const { data, error } = await db
      .from('properties')
      .select('id')
      .eq('organization_id', actor.organizationId)
      .is('deleted_at', null)
    if (error) throw error
    return {
      propertyIds: toRows(data).map((row) => asString(row, 'id')),
      unitIds: null,
    }
  }

  if (scope.kind === 'properties') {
    return { propertyIds: scope.propertyIds, unitIds: null }
  }

  if (scope.kind === 'units') {
    if (scope.unitIds.length === 0) return { propertyIds: [], unitIds: [] }
    const { data, error } = await db
      .from('units')
      .select('id, property_id')
      .eq('organization_id', actor.organizationId)
      .in('id', [...scope.unitIds])
    if (error) throw error
    const rows = toRows(data)
    return {
      propertyIds: [
        ...new Set(rows.map((row) => asString(row, 'property_id'))),
      ],
      unitIds: rows.map((row) => asString(row, 'id')),
    }
  }

  // Platform staff and anything unrecognised. Deny by default.
  return actor.isPlatformStaff
    ? anchorsFromScope(db, actor, { kind: 'all_organization' })
    : { propertyIds: [], unitIds: [] }
}

/**
 * The places this person's own work already puts them.
 *
 * For a team-scoped cleaner and for an `own_records` membership. Nothing is
 * read that they could not already read on `/tasks`: the same table, the same
 * narrowing, the same tenant filter.
 */
async function anchorsFromOwnTasks(db: Db, actor: Actor): Promise<Anchors> {
  const results = await Promise.all(
    narrowingsFor(actor, TASK_SCOPE_COLUMNS).map(async (narrowing) => {
      if (reachesNothing(narrowing)) return [] as Row[]

      let query = db
        .from('tasks')
        .select('property_id, unit_id')
        .eq('organization_id', actor.organizationId)
        .is('deleted_at', null)

      if (narrowing.kind === 'in') {
        query = query.in(narrowing.column, [...narrowing.values])
      } else if (narrowing.kind === 'eq') {
        query = query.eq(narrowing.column, narrowing.value)
      }

      const { data, error } = await query
      if (error) throw error
      return toRows(data)
    }),
  )

  const rows = results.flat()
  return {
    propertyIds: [...new Set(rows.map((row) => asString(row, 'property_id')))],
    unitIds: [
      ...new Set(
        rows
          .map((row) => asStringOrNull(row, 'unit_id'))
          .filter((id): id is string => id !== null),
      ),
    ],
  }
}

async function loadProperties(
  db: Db,
  actor: Actor,
  ids: readonly string[],
): Promise<readonly TargetProperty[]> {
  const { data, error } = await db
    .from('properties')
    .select('id, name')
    .eq('organization_id', actor.organizationId)
    .in('id', [...ids])
    .is('deleted_at', null)

  if (error) throw error

  // A property whose name row is refused keeps its id and a null name, exactly
  // as the shell's own property chooser does. A truncated uuid is unhelpful; a
  // confident wrong name is worse.
  return toRows(data)
    .map((row) => ({
      id: asString(row, 'id'),
      name: asStringOrNull(row, 'name'),
    }))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'he'))
}

async function loadUnits(
  db: Db,
  actor: Actor,
  anchors: Anchors,
): Promise<readonly TargetUnit[]> {
  if (anchors.unitIds !== null && anchors.unitIds.length === 0) return []

  let query = db
    .from('units')
    .select('id, name, property_id')
    .eq('organization_id', actor.organizationId)
    .in('property_id', [...anchors.propertyIds])
    .is('deleted_at', null)

  if (anchors.unitIds !== null) {
    query = query.in('id', [...anchors.unitIds])
  }

  const { data, error } = await query
  if (error) throw error

  return toRows(data)
    .map((row) => ({
      id: asString(row, 'id'),
      name: asString(row, 'name'),
      propertyId: asString(row, 'property_id'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'))
}

/**
 * The teams work may be routed to.
 *
 * Offered only to somebody whose scope reaches beyond one team. A team-scoped
 * member gets their own team and no other, because handing work to a team they
 * cannot see would be handing it somewhere they cannot follow it.
 */
async function loadTeams(
  db: Db,
  actor: Actor,
  scope: ReturnType<typeof scopeFor>,
): Promise<readonly TargetTeam[]> {
  let query = db
    .from('teams')
    .select('id, name')
    .eq('organization_id', actor.organizationId)

  if (scope.kind === 'team') {
    if (scope.teamIds.length === 0) return []
    query = query.in('id', [...scope.teamIds])
  } else if (scope.kind === 'own_records') {
    return []
  }

  const { data, error } = await query
  if (error) throw error

  return toRows(data)
    .map((row) => ({ id: asString(row, 'id'), name: asString(row, 'name') }))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'))
}
