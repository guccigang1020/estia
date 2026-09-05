/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Resolving the platform session: is the signed-in person on ESTIA's roster,
 * and what do they hold?
 *
 * ══ THIS FUNCTION FAILS CLOSED, AND THAT IS ITS ENTIRE DESIGN ═════════════
 *
 * Every path that is not an active roster row returns `null`. Not staff,
 * revoked, the table refused the read, the table does not exist in this
 * deployment, the query threw — all of them are `null`, and `null` is refused
 * by the guard.
 *
 * The "table does not exist" case is not hypothetical: 0041 has to be applied,
 * and until it is, this query fails. A resolver that treated a failed read as
 * anything but "no session" would open the console during exactly the window
 * in which the database cannot enforce anything about it.
 *
 * The failure is logged rather than swallowed, because the two `null`s mean
 * very different things to whoever is on call. "Nobody is on the roster" is a
 * deployment that is working; "the roster could not be read" is one that is
 * not, and it looks identical from the browser.
 *
 * ── Three queries, not one embed ──────────────────────────────────────────
 *
 * The roster row, its grants, and the person's name are read separately
 * instead of as one nested PostgREST embed. Embeds through two levels
 * (`platform_staff → roles → role_permissions`) are the reads that break
 * quietly when a relationship is ambiguous, and this is the read that decides
 * whether the console opens at all.
 */

import type { Db } from '@/lib/persistence'
import { toLogEntry } from '@/lib/errors'

import { isPlatformRole, platformGrants, type PlatformSession } from './staff'

/** What the roster row and its role look like coming off the wire. */
type StaffRow = {
  id: unknown
  user_id: unknown
  role_id: unknown
  roles: { code: unknown; name: unknown } | null
}

/**
 * The signed-in person's platform session, or `null`.
 *
 * `userId` comes from `getCurrentUser()`, which revalidates the JWT against
 * the auth server. This function does not re-authenticate; it answers the
 * second question, and it answers it from rows rather than from a claim in a
 * token — a roster revoked at 09:00 is refused at 09:00, not when a token
 * happens to expire.
 */
export async function resolvePlatformSession(
  db: Db,
  userId: string,
): Promise<PlatformSession | null> {
  try {
    const { data, error } = await db
      .from('platform_staff')
      .select('id, user_id, role_id, roles!inner(code, name)')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (error) {
      // Distinguishable in the log, indistinguishable in the answer. See the
      // header: the refusal is the same either way, on purpose.
      console.error(
        toLogEntry(
          new Error(
            `platform_staff could not be read (${error.code ?? 'no code'}): ` +
              `${error.message}. The console is refusing everybody until this ` +
              `is resolved — check that 0041_platform_admin.sql has been applied.`,
          ),
          crypto.randomUUID(),
        ),
      )
      return null
    }

    if (!data) return null

    const row = data as unknown as StaffRow
    const role = row.roles

    // A roster row whose role did not come back is not a session. `!inner`
    // should make this impossible; it is checked because "impossible" and
    // "unchecked" is how a null role became an empty grant set somewhere else
    // in this codebase, and an empty grant set is refused rather than noticed.
    if (!role || typeof role.code !== 'string' || !isPlatformRole(role.code)) {
      console.error(
        toLogEntry(
          new Error(
            `platform_staff row ${String(row.id)} names a role that is not an ` +
              `ESTIA platform role. tg_platform_staff_role_is_platform should ` +
              `have refused it.`,
          ),
          crypto.randomUUID(),
        ),
      )
      return null
    }

    const [grants, displayName] = await Promise.all([
      loadGrants(db, String(row.role_id)),
      loadDisplayName(db, userId),
    ])

    return {
      staffId: String(row.id),
      userId,
      role: role.code,
      roleName: typeof role.name === 'string' ? role.name : role.code,
      grants,
      displayName,
    }
  } catch (error) {
    // The demo runs on an in-memory database that raises on a table it does
    // not carry, and a deployment where 0041 has not been applied raises too.
    // Both are "no session", both are logged, and neither opens the console.
    console.error(toLogEntry(error, crypto.randomUUID()))
    return null
  }
}

/**
 * The grants on the roster row's role.
 *
 * Narrowed by `platformGrants()`, which drops anything that is not a
 * `platform.*` code. The database already refuses to attach a customer
 * permission to a platform role; this is the third refusal, and the cheapest.
 */
async function loadGrants(db: Db, roleId: string) {
  const { data, error } = await db
    .from('role_permissions')
    .select('permission_code')
    .eq('role_id', roleId)

  if (error || !data) return platformGrants([])

  return platformGrants(
    data
      .map((row) => (row as { permission_code?: unknown }).permission_code)
      .filter((code): code is string => typeof code === 'string'),
  )
}

/**
 * The person's name, for the audit trail.
 *
 * A missing profile is not a failure: it is a colleague who has not filled one
 * in, and the label falls back to the role name. What it never does is invent
 * one — an audit row signed with a guessed name is worse than one signed
 * "ESTIA · מנהל-על ESTIA", because only the first is believed.
 */
async function loadDisplayName(db: Db, userId: string): Promise<string | null> {
  const { data, error } = await db
    .from('user_profiles')
    .select('full_name')
    .eq('id', userId)
    .maybeSingle()

  if (error || !data) return null

  const name = (data as { full_name?: unknown }).full_name
  return typeof name === 'string' && name.trim() !== '' ? name : null
}
