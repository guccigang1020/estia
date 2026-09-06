/**
 * EXECUTION CONTEXT — SERVER ONLY. What a CUSTOM role grants.
 *
 * `_lib/queries.ts` beside this file explains at length why it does not read
 * `role_permissions`: every row it returns is a system role, a system role's
 * grants are derived by `grantsForSystemRole()` rather than stored, and a join
 * against that table would render every role as granting nothing.
 *
 * That argument is exactly right for a system role and exactly wrong for a
 * custom one. A customer's role has no entry in the catalogue in code — its
 * grants genuinely are the rows in `role_permissions`, and there is nowhere
 * else to read them from. So this file reads them, and only for roles whose
 * `organization_id` is set.
 *
 * `RoleRecord.grantsKnown` on the other query was the honest marker while
 * nothing could show a custom role's grants. It can now, and the roles screen
 * renders these rows through the same `groupGrants` the system roles go
 * through — so a custom role and a built-in one are presented identically,
 * which is what `can()` already believes about them.
 *
 * ── Unknown codes are dropped, not rendered ───────────────────────────────
 *
 * `permission_code` is a foreign key into `public.permissions`, and that table
 * is seeded to match `permissions.ts` — but they are two artefacts, and a
 * build deployed between two migrations can legitimately see a code it does
 * not know. Such a code is counted and reported rather than shown as a grant
 * this build can explain, for the same reason `knownRoleProfile` checks
 * instead of casting.
 */

import { isGrant } from '@/lib/authz/grantable'
import type { Grant } from '@/lib/authz/permissions'
import type { Db } from '@/lib/persistence'
import { asNumber, asString, asStringOrNull, toRows } from '@/lib/persistence'

export type CustomRoleRecord = {
  id: string
  code: string
  name: string
  description: string | null
  /** Grants this build understands, in catalogue order once grouped. */
  grants: readonly Grant[]
  /** Codes stored on the role that this build has never heard of. */
  unknownGrantCount: number
  /** Memberships in this organization holding it. */
  memberCount: number
  version: number
}

/**
 * The organization's own roles, with their grants and their holders.
 *
 * Filtered to `organization_id = <this organization>` rather than left to row
 * level security alone. `roles_select` also admits the twenty-two global rows,
 * and this list is specifically the ones a customer composed — mixing the two
 * would put `cleaner` in a section headed "roles you can edit", which is the
 * one thing it is not.
 */
export async function listCustomRoles(
  db: Db,
  organizationId: string,
): Promise<readonly CustomRoleRecord[]> {
  const { data, error } = await db
    .from('roles')
    .select('id, code, name, description, version')
    .eq('organization_id', organizationId)
    .order('name', { ascending: true })

  if (error) throw error

  const rows = toRows(data)
  if (rows.length === 0) return []

  const ids = rows.map((row) => asString(row, 'id'))
  const [grants, holders] = await Promise.all([
    grantsByRole(db, ids),
    holdersByRole(db, organizationId, ids),
  ])

  return rows.map((row) => {
    const id = asString(row, 'id')
    const codes = grants.get(id) ?? []

    return {
      id,
      code: asString(row, 'code'),
      name: asString(row, 'name'),
      description: asStringOrNull(row, 'description'),
      grants: codes.filter(isGrant),
      unknownGrantCount: codes.filter((code) => !isGrant(code)).length,
      memberCount: holders.get(id) ?? 0,
      version: asNumber(row, 'version'),
    }
  })
}

async function grantsByRole(
  db: Db,
  roleIds: readonly string[],
): Promise<ReadonlyMap<string, string[]>> {
  const { data, error } = await db
    .from('role_permissions')
    .select('role_id, permission_code')
    .in('role_id', [...roleIds])

  if (error) throw error

  const grants = new Map<string, string[]>()
  for (const row of toRows(data)) {
    const roleId = asString(row, 'role_id')
    const entries = grants.get(roleId) ?? []
    entries.push(asString(row, 'permission_code'))
    grants.set(roleId, entries)
  }
  return grants
}

/**
 * Counted from rows rather than with an aggregate, matching the count the
 * system-role list already shows. Two numbers on one screen derived two
 * different ways is how they start to disagree.
 */
async function holdersByRole(
  db: Db,
  organizationId: string,
  roleIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const { data, error } = await db
    .from('membership_roles')
    .select('role_id')
    .eq('organization_id', organizationId)
    .in('role_id', [...roleIds])

  if (error) throw error

  const counts = new Map<string, number>()
  for (const row of toRows(data)) {
    const roleId = asString(row, 'role_id')
    counts.set(roleId, (counts.get(roleId) ?? 0) + 1)
  }
  return counts
}
