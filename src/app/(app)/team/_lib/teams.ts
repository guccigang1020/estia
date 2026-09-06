/**
 * EXECUTION CONTEXT — SERVER ONLY. The crews, for the panel on `/team`.
 *
 * `public.teams` has existed since 0008 with policies, indexes and two foreign
 * keys pointing at it, and until now nothing in the product read it except to
 * turn a `team_id` into a name on the roster. It could not do more than that,
 * because no team could be created.
 *
 * Two counts travel with each team and both are load-bearing:
 *
 *   · `memberCount` — how many people are in the crew. It is the number a
 *     supervisor is actually looking for, and it is also what `team.archive`
 *     refuses on.
 *   · `scopedCount` — how many memberships have their *reach* defined by this
 *     team, from `membership_scopes` of kind `team`. It is a different and
 *     sharper fact: those people can see what the team can see, and archiving
 *     the team under them would leave a live scope pointing at a dead row.
 *
 * Both are counted from rows this reader was admitted to rather than with a
 * database aggregate, for the reason `roles/_lib/queries.ts` already gives: an
 * aggregate counts rows row level security would not have shown, and a number
 * that disagrees with the list under it is worse than no number.
 */

import type { Db } from '@/lib/persistence'
import {
  asNumber,
  asString,
  asStringOrNull,
  asStringArray,
  asTimestampOrNull,
  toRows,
} from '@/lib/persistence'
import { toTeamKind, type TeamKind } from '@/lib/authz/team-kind'

export type TeamListItem = {
  id: string
  name: string
  description: string | null
  kind: TeamKind
  color: string | null
  propertyId: string | null
  /** Resolved from `properties`, or null when the row was not readable. */
  propertyName: string | null
  memberCount: number
  scopedCount: number
  /** ISO 8601, or null. Archiving is a soft delete — see `teams_deleted_pair`. */
  archivedAt: string | null
  /** Sent back with a rename, so two open tabs refuse rather than overwrite. */
  version: number
}

const TEAM_COLUMNS =
  'id, name, description, kind, color, property_id, deleted_at, version'

/**
 * Every team in this organization, archived ones included.
 *
 * Archived teams are returned rather than filtered out. `teams_select` admits
 * them, the roster can still name one against an old membership, and a panel
 * that silently dropped them would present "the crew disappeared" as the
 * product's answer to archiving. The panel shows them apart and greyed.
 */
export async function listTeams(
  db: Db,
  organizationId: string,
): Promise<readonly TeamListItem[]> {
  const { data, error } = await db
    .from('teams')
    .select(TEAM_COLUMNS)
    .eq('organization_id', organizationId)
    .order('name', { ascending: true })

  if (error) throw error

  const rows = toRows(data)
  if (rows.length === 0) return []

  const [members, scopes, properties] = await Promise.all([
    countMembersByTeam(db, organizationId),
    countScopesByTeam(db, organizationId),
    propertyNames(db, organizationId),
  ])

  return rows.map((row) => {
    const id = asString(row, 'id')
    const propertyId = asStringOrNull(row, 'property_id')

    return {
      id,
      name: asString(row, 'name'),
      description: asStringOrNull(row, 'description'),
      kind: toTeamKind(asStringOrNull(row, 'kind')),
      color: asStringOrNull(row, 'color'),
      propertyId,
      propertyName:
        propertyId === null ? null : (properties.get(propertyId) ?? null),
      memberCount: members.get(id) ?? 0,
      scopedCount: scopes.get(id) ?? 0,
      archivedAt: asTimestampOrNull(row, 'deleted_at'),
      version: asNumber(row, 'version'),
    }
  })
}

async function countMembersByTeam(
  db: Db,
  organizationId: string,
): Promise<ReadonlyMap<string, number>> {
  const { data, error } = await db
    .from('memberships')
    .select('team_id')
    .eq('organization_id', organizationId)
    .not('team_id', 'is', null)

  if (error) throw error

  const counts = new Map<string, number>()
  for (const row of toRows(data)) {
    const teamId = asStringOrNull(row, 'team_id')
    if (teamId === null) continue
    counts.set(teamId, (counts.get(teamId) ?? 0) + 1)
  }
  return counts
}

/**
 * Memberships whose scope is a team, counted per team named.
 *
 * `membership_scopes.team_ids` is a `uuid[]` — PostgreSQL has no foreign key
 * from an array element, which is why 0008 closes both directions with
 * triggers instead. Reading the array and counting here is the same shape the
 * roster already uses to name a scope.
 */
async function countScopesByTeam(
  db: Db,
  organizationId: string,
): Promise<ReadonlyMap<string, number>> {
  const { data, error } = await db
    .from('membership_scopes')
    .select('team_ids')
    .eq('organization_id', organizationId)
    .eq('kind', 'team')

  if (error) throw error

  const counts = new Map<string, number>()
  for (const row of toRows(data)) {
    for (const teamId of asStringArray(row, 'team_ids')) {
      counts.set(teamId, (counts.get(teamId) ?? 0) + 1)
    }
  }
  return counts
}

async function propertyNames(
  db: Db,
  organizationId: string,
): Promise<ReadonlyMap<string, string>> {
  const { data, error } = await db
    .from('properties')
    .select('id, name')
    .eq('organization_id', organizationId)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    names.set(asString(row, 'id'), asString(row, 'name'))
  }
  return names
}
