/**
 * EXECUTION CONTEXT — SERVER ONLY. What the roles screen reads from rows.
 *
 * Almost nothing, and that is the design. What each role *grants* comes from
 * `_lib/catalogue.ts`, which derives it from the permission catalogue in code
 * — because that is what `can()` will actually answer with. Two things are
 * genuinely rows and are read here:
 *
 *   · the Hebrew name and description of each role, from `public.roles`,
 *     seeded by `0002_authz.sql` and `0012_permission_catalogue.sql`. They are
 *     what the shell already prints beside a person's name, and a screen that
 *     retyped them would eventually print a different word for the same role
 *     than the badge two centimetres above it.
 *   · how many memberships in this organization currently hold each role,
 *     from `membership_roles`. "מנהל כללי · אדם אחד" is the number that turns
 *     a catalogue into an inventory of who can do what today.
 *
 * ── Why `role_permissions` is not read ────────────────────────────────────
 *
 * Every row seeded into `public.roles` is `is_system = true`, and
 * `SupabaseActorSource.loadRoles` is explicit that a system role's grants come
 * from the catalogue in code rather than from that table — the `grants` field
 * is left `undefined` rather than `[]` precisely so nothing misreads an empty
 * join as "this role grants nothing". The demo dataset seeds
 * `role_permissions` as an empty array for the same reason. Reading it here
 * would produce a screen that says every role grants nothing, which is both
 * wrong and confidently so.
 *
 * ── Custom roles ──────────────────────────────────────────────────────────
 *
 * A customer may compose one, and `roles_select` admits it — this query does
 * not filter to `is_system`, so a custom role appears in the list with its own
 * name and its own member count. What it cannot yet show is what a custom role
 * grants, because that genuinely does live in `role_permissions` and the
 * screen has no reader for it. It is marked on screen rather than omitted; see
 * `RoleRecord.grantsKnown`.
 */

import type { Db } from '@/lib/persistence'
import {
  asBoolean,
  asNumber,
  asString,
  asStringOrNull,
  toRows,
} from '@/lib/persistence'

export type RoleRecord = {
  id: string
  code: string
  /** Hebrew, from the migration's own seed. */
  name: string
  description: string | null
  isSystem: boolean
  /** ESTIA's own staff. Never assignable inside a customer organization. */
  isPlatform: boolean
  sortOrder: number
  /**
   * Whether this screen can say what the role grants.
   *
   * True for a system role, whose grants are the catalogue's answer in code.
   * False for a customer's own role, whose grants live in `role_permissions`
   * and are not read here. A screen that rendered an unknown as an empty list
   * would tell an owner their custom role does nothing.
   */
  grantsKnown: boolean
  /** Memberships in this organization currently holding it. */
  memberCount: number
}

/**
 * The role catalogue, with the member count for this organization.
 *
 * `roles_select` admits a row whose `organization_id is null` — the global
 * catalogue — or one belonging to an organization the caller is a member of.
 * So the query deliberately carries no `organization_id` filter: adding one
 * would drop the twenty-two system roles, which are exactly what this screen
 * is about. The tenant narrowing that does apply is on the *count*, which is
 * read from `membership_roles` for one organization only.
 */
export async function listRoles(
  db: Db,
  organizationId: string,
): Promise<readonly RoleRecord[]> {
  const { data, error } = await db
    .from('roles')
    .select(
      'id, code, name, description, is_system, is_platform, sort_order, organization_id',
    )
    .order('sort_order', { ascending: true })

  if (error) throw error

  const counts = await countByRole(db, organizationId)

  return toRows(data).map((row) => {
    const id = asString(row, 'id')
    return {
      id,
      code: asString(row, 'code'),
      name: asString(row, 'name'),
      description: asStringOrNull(row, 'description'),
      isSystem: asBoolean(row, 'is_system'),
      isPlatform: asBoolean(row, 'is_platform'),
      sortOrder: asNumber(row, 'sort_order'),
      grantsKnown: asBoolean(row, 'is_system'),
      memberCount: counts.get(id) ?? 0,
    }
  })
}

/**
 * How many memberships hold each role, counted from the rows themselves.
 *
 * Not a stored counter and not a database aggregate: `membership_roles_select`
 * narrows to the caller's organizations, so counting the rows that came back
 * is the only count that matches the roster the team screen will show them. A
 * number that disagreed with the list under it is worse than no number.
 *
 * It selects the foreign key and nothing else — a count should not be an
 * excuse to read a table.
 */
async function countByRole(
  db: Db,
  organizationId: string,
): Promise<ReadonlyMap<string, number>> {
  const { data, error } = await db
    .from('membership_roles')
    .select('role_id')
    .eq('organization_id', organizationId)

  if (error) throw error

  const counts = new Map<string, number>()
  for (const row of toRows(data)) {
    const roleId = asString(row, 'role_id')
    counts.set(roleId, (counts.get(roleId) ?? 0) + 1)
  }
  return counts
}
