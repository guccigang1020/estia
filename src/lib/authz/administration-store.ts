/**
 * EXECUTION CONTEXT — SERVER ONLY. The two implementations of
 * `AdministrationStore`.
 *
 * Nothing here decides anything. Every refusal lives in `administration.ts`
 * and every floor lives in `0004_rls.sql`, `0008_accommodation.sql` and
 * `0069_teams_and_custom_roles.sql`; this is mapping, and mapping is where the
 * interesting mistakes are.
 *
 * ── Two things worth reading before editing ───────────────────────────────
 *
 * **The team assignment goes through an RPC, not an UPDATE.**
 * `memberships_update` admits `user.edit`, and the people who manage teams
 * hold `team.manage` and not `user.edit`. `assign_membership_to_team` (0069)
 * is a SECURITY DEFINER function that can change exactly one column and checks
 * `team.manage` inside itself. Replacing the call with
 * `db.from('memberships').update({ team_id })` would work for an owner, fail
 * silently-ish for everybody the feature exists for, and tempt the next reader
 * into widening the policy.
 *
 * **Grants are replaced, not diffed.** `replaceRoleGrants` deletes every row
 * for the role and inserts the requested set. A diff would be fewer
 * statements and would have to be right about which side is authoritative
 * when the two disagree; a replace cannot be wrong about that. Both statements
 * run inside the operation's transaction, so a failure between them leaves the
 * role as it was.
 */

import {
  asBoolean,
  asNumber,
  asString,
  asStringOrNull,
  asTimestampOrNull,
  clientFor,
  toRow,
  toRows,
  type Db,
} from '../persistence'
import type {
  AdministrationStore,
  MembershipRecord,
  RoleRecord,
  TeamRecord,
  TeamUsage,
} from './administration'
import { isGrant } from './grantable'
import type { Grant } from './permissions'
import { toTeamKind, type TeamKind } from './team-kind'

const TEAM_COLUMNS =
  'id, organization_id, property_id, name, description, kind, color, ' +
  'deleted_at, version'

const ROLE_COLUMNS =
  'id, organization_id, code, name, description, is_system, is_platform, version'

/* ------------------------------------------------------------- supabase -- */

export class SupabaseAdministrationStore implements AdministrationStore {
  constructor(private readonly db: Db) {}

  async loadTeam(
    organizationId: string,
    teamId: string,
  ): Promise<TeamRecord | null> {
    const { data, error } = await this.db
      .from('teams')
      .select(TEAM_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', teamId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = toRow(data)
    return {
      id: asString(row, 'id'),
      organizationId: asString(row, 'organization_id'),
      propertyId: asStringOrNull(row, 'property_id'),
      name: asString(row, 'name'),
      description: asStringOrNull(row, 'description'),
      kind: toTeamKind(asStringOrNull(row, 'kind')),
      color: asStringOrNull(row, 'color'),
      archivedAt: asTimestampOrNull(row, 'deleted_at'),
      version: asNumber(row, 'version'),
    }
  }

  /**
   * Counted from the rows rather than with an aggregate, for the reason the
   * roles screen already gives: row level security narrows what comes back,
   * and a number that disagrees with the list under it is worse than no
   * number. Both selects read one column.
   */
  async teamUsage(organizationId: string, teamId: string): Promise<TeamUsage> {
    const [members, scopes] = await Promise.all([
      this.db
        .from('memberships')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('team_id', teamId),
      this.db
        .from('membership_scopes')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('kind', 'team')
        .contains('team_ids', [teamId]),
    ])

    if (members.error) throw members.error
    if (scopes.error) throw scopes.error

    return {
      memberCount: toRows(members.data).length,
      scopeCount: toRows(scopes.data).length,
    }
  }

  async createTeam(
    input: {
      organizationId: string
      name: string
      kind: TeamKind
      propertyId: string | null
      description: string | null
      color: string | null
      createdBy: string
    },
    tx: unknown,
  ): Promise<{ id: string }> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('teams')
      .insert({
        organization_id: input.organizationId,
        name: input.name,
        kind: input.kind,
        property_id: input.propertyId,
        description: input.description,
        color: input.color,
        created_by: input.createdBy,
        updated_by: input.createdBy,
      })
      .select('id')
      .single()

    if (error) throw error
    return { id: asString(toRow(data), 'id') }
  }

  async renameTeam(
    input: {
      organizationId: string
      teamId: string
      name: string
      description: string | null
      color: string | null
      updatedBy: string
    },
    tx: unknown,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    const { error } = await db
      .from('teams')
      .update({
        name: input.name,
        description: input.description,
        color: input.color,
        updated_by: input.updatedBy,
      })
      .eq('organization_id', input.organizationId)
      .eq('id', input.teamId)

    if (error) throw error
  }

  async archiveTeam(
    input: {
      organizationId: string
      teamId: string
      archivedAt: Date
      archivedBy: string
    },
    tx: unknown,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    const { error } = await db
      .from('teams')
      .update({
        deleted_at: input.archivedAt.toISOString(),
        deleted_by: input.archivedBy,
        updated_by: input.archivedBy,
      })
      .eq('organization_id', input.organizationId)
      .eq('id', input.teamId)

    if (error) throw error
  }

  async loadMembership(
    organizationId: string,
    membershipId: string,
  ): Promise<MembershipRecord | null> {
    const { data, error } = await this.db
      .from('memberships')
      .select('id, organization_id, user_id, status, team_id')
      .eq('organization_id', organizationId)
      .eq('id', membershipId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = toRow(data)
    return {
      id: asString(row, 'id'),
      organizationId: asString(row, 'organization_id'),
      userId: asString(row, 'user_id'),
      status: asString(row, 'status'),
      teamId: asStringOrNull(row, 'team_id'),
    }
  }

  async assignMembershipToTeam(
    membershipId: string,
    teamId: string | null,
    tx: unknown,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    // Named arguments, so the order here cannot silently disagree with the
    // function's signature in 0069.
    const { error } = await db.rpc('assign_membership_to_team', {
      p_membership_id: membershipId,
      p_team_id: teamId,
    })

    if (error) throw error
  }

  async loadRole(
    organizationId: string,
    roleId: string,
  ): Promise<RoleRecord | null> {
    const { data, error } = await this.db
      .from('roles')
      .select(ROLE_COLUMNS)
      .eq('id', roleId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = toRow(data)
    const roleOrganizationId = asStringOrNull(row, 'organization_id')

    // `roles_select` admits the global catalogue as well as this
    // organization's own rows, so a system role is readable here and is
    // returned as what it is. `assertEditableRole` refuses it by name — which
    // is a better sentence than "not found" for somebody who clicked a role
    // that plainly exists on the screen in front of them.
    if (roleOrganizationId !== null && roleOrganizationId !== organizationId) {
      return null
    }

    const [grants, holders] = await Promise.all([
      this.db
        .from('role_permissions')
        .select('permission_code')
        .eq('role_id', roleId),
      this.db
        .from('membership_roles')
        .select('membership_id')
        .eq('organization_id', organizationId)
        .eq('role_id', roleId),
    ])

    if (grants.error) throw grants.error
    if (holders.error) throw holders.error

    return {
      id: asString(row, 'id'),
      organizationId: roleOrganizationId,
      code: asString(row, 'code'),
      name: asString(row, 'name'),
      description: asStringOrNull(row, 'description'),
      isSystem: asBoolean(row, 'is_system'),
      isPlatform: asBoolean(row, 'is_platform'),
      // A code the catalogue in this build has never heard of is dropped
      // rather than cast. It cannot be rendered, cannot be compared against
      // the author's grants, and pretending it is a `Grant` would make the
      // escalation check reason about a string it does not understand.
      grants: toRows(grants.data)
        .map((entry) => asString(entry, 'permission_code'))
        .filter(isGrant),
      holderCount: toRows(holders.data).length,
      version: asNumber(row, 'version'),
    }
  }

  async roleCodeTaken(organizationId: string, code: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('roles')
      .select('id, organization_id')
      .eq('code', code)

    if (error) throw error

    // A collision with a system role counts. `roles_custom_organization_key`
    // would admit a customer role coded `administrator`, and a roster showing
    // two different roles under one code is a screen nobody can read.
    return toRows(data).some((row) => {
      const owner = asStringOrNull(row, 'organization_id')
      return owner === null || owner === organizationId
    })
  }

  async createRole(
    input: {
      organizationId: string
      code: string
      name: string
      description: string | null
      grants: readonly Grant[]
      createdBy: string
    },
    tx: unknown,
  ): Promise<{ id: string }> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('roles')
      .insert({
        organization_id: input.organizationId,
        code: input.code,
        name: input.name,
        description: input.description,
        // Stated rather than defaulted. `roles_insert` checks both, and a
        // row that relied on the column default to be a customer role would
        // be one schema change away from being something else.
        is_system: false,
        is_platform: false,
        created_by: input.createdBy,
        updated_by: input.createdBy,
      })
      .select('id')
      .single()

    if (error) throw error
    const id = asString(toRow(data), 'id')

    if (input.grants.length > 0) {
      const { error: grantError } = await db.from('role_permissions').insert(
        input.grants.map((grant) => ({
          role_id: id,
          permission_code: grant,
          created_by: input.createdBy,
        })),
      )
      if (grantError) throw grantError
    }

    return { id }
  }

  async replaceRoleGrants(
    input: { roleId: string; grants: readonly Grant[]; updatedBy: string },
    tx: unknown,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    const { error: clearError } = await db
      .from('role_permissions')
      .delete()
      .eq('role_id', input.roleId)

    if (clearError) throw clearError
    if (input.grants.length === 0) return

    const { error } = await db.from('role_permissions').insert(
      input.grants.map((grant) => ({
        role_id: input.roleId,
        permission_code: grant,
        created_by: input.updatedBy,
      })),
    )

    if (error) throw error
  }

  async deleteRole(
    input: { organizationId: string; roleId: string },
    tx: unknown,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    // `role_permissions.role_id` cascades, so the grants go with the row.
    const { error } = await db
      .from('roles')
      .delete()
      .eq('organization_id', input.organizationId)
      .eq('id', input.roleId)

    if (error) throw error
  }

  async openInvitationCount(
    organizationId: string,
    roleId: string,
  ): Promise<number> {
    const { data, error } = await this.db
      .from('invitations')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('role_id', roleId)
      .is('accepted_at', null)
      .is('revoked_at', null)

    if (error) throw error
    return toRows(data).length
  }
}

/* ------------------------------------------------------------ in memory -- */

/**
 * The double the operation tests run against.
 *
 * It stores what the tables store and enforces nothing: every rule the tests
 * assert has to come from `administration.ts` or from the pipeline, or the
 * test is proving something about this file instead.
 */
export class InMemoryAdministrationStore implements AdministrationStore {
  readonly teams = new Map<string, TeamRecord>()
  readonly memberships = new Map<string, MembershipRecord>()
  readonly roles = new Map<string, RoleRecord>()
  /** Live invitations, keyed by role id. */
  readonly invitations = new Map<string, number>()
  /** Memberships whose scope is defined by a team, keyed by team id. */
  readonly teamScopes = new Map<string, number>()

  private sequence = 0

  seedTeam(team: Partial<TeamRecord> & { id: string; organizationId: string }) {
    this.teams.set(team.id, {
      propertyId: null,
      name: 'צוות',
      description: null,
      kind: 'other',
      color: null,
      archivedAt: null,
      version: 1,
      ...team,
    })
  }

  seedMembership(membership: MembershipRecord) {
    this.memberships.set(membership.id, membership)
  }

  seedRole(role: Partial<RoleRecord> & { id: string; code: string }) {
    this.roles.set(role.id, {
      organizationId: null,
      name: role.code,
      description: null,
      isSystem: false,
      isPlatform: false,
      grants: [],
      holderCount: 0,
      version: 1,
      ...role,
    })
  }

  private nextId(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }

  async loadTeam(organizationId: string, teamId: string) {
    const team = this.teams.get(teamId)
    return team && team.organizationId === organizationId ? team : null
  }

  async teamUsage(organizationId: string, teamId: string): Promise<TeamUsage> {
    const memberCount = [...this.memberships.values()].filter(
      (member) =>
        member.organizationId === organizationId && member.teamId === teamId,
    ).length

    return { memberCount, scopeCount: this.teamScopes.get(teamId) ?? 0 }
  }

  async createTeam(input: {
    organizationId: string
    name: string
    kind: TeamKind
    propertyId: string | null
    description: string | null
    color: string | null
  }) {
    const id = this.nextId('team')
    this.teams.set(id, {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      name: input.name,
      description: input.description,
      kind: input.kind,
      color: input.color,
      archivedAt: null,
      version: 1,
    })
    return { id }
  }

  async renameTeam(input: {
    teamId: string
    name: string
    description: string | null
    color: string | null
  }) {
    const team = this.teams.get(input.teamId)
    if (!team) return
    this.teams.set(team.id, {
      ...team,
      name: input.name,
      description: input.description,
      color: input.color,
      version: team.version + 1,
    })
  }

  async archiveTeam(input: { teamId: string; archivedAt: Date }) {
    const team = this.teams.get(input.teamId)
    if (!team) return
    this.teams.set(team.id, {
      ...team,
      archivedAt: input.archivedAt.toISOString(),
      version: team.version + 1,
    })
  }

  async loadMembership(organizationId: string, membershipId: string) {
    const membership = this.memberships.get(membershipId)
    return membership && membership.organizationId === organizationId
      ? membership
      : null
  }

  async assignMembershipToTeam(membershipId: string, teamId: string | null) {
    const membership = this.memberships.get(membershipId)
    if (!membership) return
    this.memberships.set(membershipId, { ...membership, teamId })
  }

  async loadRole(organizationId: string, roleId: string) {
    const role = this.roles.get(roleId)
    if (!role) return null
    if (
      role.organizationId !== null &&
      role.organizationId !== organizationId
    ) {
      return null
    }
    return role
  }

  async roleCodeTaken(organizationId: string, code: string) {
    return [...this.roles.values()].some(
      (role) =>
        role.code === code &&
        (role.organizationId === null ||
          role.organizationId === organizationId),
    )
  }

  async createRole(input: {
    organizationId: string
    code: string
    name: string
    description: string | null
    grants: readonly Grant[]
  }) {
    const id = this.nextId('role')
    this.roles.set(id, {
      id,
      organizationId: input.organizationId,
      code: input.code,
      name: input.name,
      description: input.description,
      isSystem: false,
      isPlatform: false,
      grants: [...input.grants],
      holderCount: 0,
      version: 1,
    })
    return { id }
  }

  async replaceRoleGrants(input: { roleId: string; grants: readonly Grant[] }) {
    const role = this.roles.get(input.roleId)
    if (!role) return
    this.roles.set(role.id, { ...role, grants: [...input.grants] })
  }

  async deleteRole(input: { roleId: string }) {
    this.roles.delete(input.roleId)
  }

  async openInvitationCount(_organizationId: string, roleId: string) {
    return this.invitations.get(roleId) ?? 0
  }
}
