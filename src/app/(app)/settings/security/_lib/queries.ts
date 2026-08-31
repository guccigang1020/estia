/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the security screen.
 *
 * ══ NOTHING IN THIS FILE READS A SECRET ══════════════════════════════════
 *
 * Not masked, not truncated, not "last four". The columns that hold a
 * credential are never named in a `select`, because a value that never leaves
 * the database cannot leak through a log line, a React Server Component
 * payload, a cache or a serialisation nobody thought about. Masking is a
 * decision made in a component, and components get refactored.
 *
 * The three that exist, and what is shown about each instead:
 *
 *   · `invitations.token_hash` — a hash of a single-use invitation token. The
 *     screen reports how many invitations are outstanding and when the newest
 *     was written. Never the hash, which is still a credential-shaped value
 *     even hashed.
 *   · `bookings.guest_token` — 32 bytes from a CSPRNG, unique, and a
 *     *capability*: 0009 explains that a guest arrives holding this and nothing
 *     else, which is exactly why it is not the primary key. Every booking has
 *     one. The screen reports how many and when the newest was minted, and that
 *     the product has no path to rotate one.
 *   · Passwords and MFA factors live in `auth`, not in `public`, and PostgREST
 *     does not expose that schema at all. There is nothing here to read even by
 *     mistake.
 *
 * ── There is no session list, and the screen must not imply one ───────────
 *
 * Supabase owns sessions in `auth.sessions` and `auth.refresh_tokens`. Neither
 * is in the exposed schema, `supabase.auth` has no "list my sessions" call
 * available to an anon/authenticated client, and this product wires no admin
 * client on a page. So "sign this device out" is not an action ESTIA can
 * perform and no such control is offered.
 *
 * What it *can* do is real and is offered: `resetPasswordAction` in
 * `src/app/(auth)/actions.ts` calls `supabase.auth.signOut({ scope: 'others' })`
 * after a successful password change, so changing the password genuinely ends
 * every other session. That is stated as the way to do it, and it links to
 * `/forgot-password`, which exists.
 *
 * ── What is a fact about *this* member versus about the organization ──────
 *
 * The account panel needs no grant beyond being signed in — it is the reader's
 * own record. The team panel needs `user.view`, and the invitations panel needs
 * `user.view` as well: an outstanding invitation carries somebody's email
 * address, which is exactly the kind of value `user.view` gates.
 */

import { holdsGrant, type Actor } from '@/lib/authz/can'
import {
  asString,
  asStringOrNull,
  asTimestampOrNull,
  toRows,
  type Db,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shared -- */

export type SecurityArgs = {
  db: Db
  actor: Actor
  organizationId: string
}

/* -------------------------------------------------------- this account --- */

/**
 * What the product knows about the signed-in person's own account.
 *
 * `mfaEnforcedAt` is `user_profiles.mfa_enforced_at`, and its own column
 * comment is worth honouring exactly: null means the requirement has not been
 * imposed, **not** that MFA is absent. The screen says that in those words
 * rather than rendering "no second factor", which would be a claim about the
 * account rather than about the policy.
 */
export type AccountSecurity = {
  /** `memberships.last_active_at`. The nearest thing to "last seen". */
  lastActiveAt: string | null
  /** `memberships.joined_at`. When this access began. */
  joinedAt: string | null
  /** `memberships.status`. */
  membershipStatus: string
  /** When a second factor was made mandatory, or null: not imposed. */
  mfaEnforcedAt: string | null
  /** `user_profiles.full_name`, the reader's own. */
  fullName: string | null
  /** Whether a recovery telephone number is on the profile. Never the number. */
  hasRecoveryPhone: boolean
}

export async function loadAccountSecurity(
  args: SecurityArgs,
): Promise<AccountSecurity | null> {
  const { db, actor, organizationId } = args

  const [membership, profile] = await Promise.all([
    db
      .from('memberships')
      .select('status, joined_at, last_active_at')
      .eq('organization_id', organizationId)
      .eq('user_id', actor.userId)
      .maybeSingle(),
    db
      .from('user_profiles')
      .select('id, full_name, phone, mfa_enforced_at')
      .eq('id', actor.userId)
      .maybeSingle(),
  ])

  if (membership.error) throw membership.error
  if (profile.error) throw profile.error
  if (!membership.data) return null

  const row = membership.data as Record<string, unknown>
  const person = (profile.data ?? {}) as Record<string, unknown>

  return {
    lastActiveAt: asTimestampOrNull(row, 'last_active_at'),
    joinedAt: asTimestampOrNull(row, 'joined_at'),
    membershipStatus: asString(row, 'status'),
    mfaEnforcedAt:
      profile.data === null
        ? null
        : asTimestampOrNull(person, 'mfa_enforced_at'),
    fullName:
      profile.data === null ? null : asStringOrNull(person, 'full_name'),
    // The presence of a recovery number is a security fact; the number itself
    // is contact data and answers no question this screen asks.
    hasRecoveryPhone:
      profile.data !== null && asStringOrNull(person, 'phone') !== null,
  }
}

/* --------------------------------------------------------------- people -- */

/**
 * Who can act in this organization, and how far each of them reaches.
 *
 * The security question a buyer actually asks is "who could do damage here",
 * and the honest answer is a list of memberships with their roles, their scope
 * and whether a second factor has been imposed on them. It is the same data the
 * team screen shows, read here for a different reason and with the security
 * columns attached.
 *
 * `null` without `user.view`.
 */
export type MemberSecurity = {
  membershipId: string
  userId: string
  /** Null when the profile is not readable. Never a uuid in its place. */
  fullName: string | null
  status: string
  joinedAt: string | null
  lastActiveAt: string | null
  /** Role names, for display. The engine never sees one. */
  roles: readonly string[]
  /** `all_organization`, `properties`, `units`, `team`, `own_records`. */
  scopeKind: string | null
  /** When a second factor became mandatory for them. Null: not imposed. */
  mfaEnforcedAt: string | null
}

export async function listMemberSecurity(
  args: SecurityArgs,
): Promise<readonly MemberSecurity[] | null> {
  const { db, actor, organizationId } = args

  if (!holdsGrant(actor, 'user.view')) return null

  const { data, error } = await db
    .from('memberships')
    .select('id, user_id, status, joined_at, last_active_at')
    .eq('organization_id', organizationId)
    .order('joined_at', { ascending: true })

  if (error) throw error

  const rows = toRows(data)
  if (rows.length === 0) return []

  const membershipIds = rows.map((row) => asString(row, 'id'))
  const userIds = rows.map((row) => asString(row, 'user_id'))

  const [roles, scopes, profiles] = await Promise.all([
    rolesByMembership(db, organizationId, membershipIds),
    scopeByMembership(db, organizationId, membershipIds),
    profileSecurity(db, userIds),
  ])

  return rows.map((row): MemberSecurity => {
    const membershipId = asString(row, 'id')
    const userId = asString(row, 'user_id')
    const profile = profiles.get(userId)

    return {
      membershipId,
      userId,
      fullName: profile?.fullName ?? null,
      status: asString(row, 'status'),
      joinedAt: asTimestampOrNull(row, 'joined_at'),
      lastActiveAt: asTimestampOrNull(row, 'last_active_at'),
      roles: roles.get(membershipId) ?? [],
      scopeKind: scopes.get(membershipId) ?? null,
      mfaEnforcedAt: profile?.mfaEnforcedAt ?? null,
    }
  })
}

/**
 * How many of the people above are required to carry a second factor.
 *
 * Counted rather than inferred, and reported as a pair — `enforced` out of
 * `total` — because "3 of 10" and "3" are different statements and only the
 * first is useful to somebody deciding whether to impose it more widely.
 */
export function mfaCoverage(members: readonly MemberSecurity[]): {
  enforced: number
  active: number
} {
  const active = members.filter((member) => member.status === 'active')
  return {
    enforced: active.filter((member) => member.mfaEnforcedAt !== null).length,
    active: active.length,
  }
}

/* ---------------------------------------------------------- invitations -- */

/**
 * An outstanding invitation — a way into the organization that nobody has used
 * yet.
 *
 * `token_hash` is **not** in the select. It is the credential this row exists
 * to carry, it is unique, and hashing it does not make it a value to render.
 * `expires_at` and the email are what somebody reviewing access needs.
 *
 * `null` without `user.view`, because the email address is the point.
 */
export type OutstandingInvitation = {
  id: string
  /** The address the invitation was sent to. */
  email: string
  expiresAt: string
  /** True once `expires_at` is behind us: it can no longer be redeemed. */
  expired: boolean
  invitedByUserId: string | null
  invitedByName: string | null
  createdAt: string | null
}

export async function listOutstandingInvitations(
  args: SecurityArgs,
  now: Date = new Date(),
): Promise<readonly OutstandingInvitation[] | null> {
  const { db, actor, organizationId } = args

  if (!holdsGrant(actor, 'user.view')) return null

  const { data, error } = await db
    .from('invitations')
    // No `token_hash`, deliberately and permanently.
    .select('id, email, expires_at, invited_by, created_at')
    .eq('organization_id', organizationId)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .order('expires_at', { ascending: true })

  if (error) throw error

  const rows = toRows(data)
  const names = await profileNames(
    db,
    rows
      .map((row) => asStringOrNull(row, 'invited_by'))
      .filter((id): id is string => id !== null),
  )

  return rows.map((row): OutstandingInvitation => {
    const expiresAt = asTimestampOrNull(row, 'expires_at')
    const invitedBy = asStringOrNull(row, 'invited_by')

    return {
      id: asString(row, 'id'),
      email: asString(row, 'email'),
      // `invitations_expires_after_creation` makes this non-null in the schema;
      // the fallback exists so a malformed row degrades to "expired" rather
      // than throwing a security screen off the air.
      expiresAt: expiresAt ?? new Date(0).toISOString(),
      expired: expiresAt === null || Date.parse(expiresAt) <= now.getTime(),
      invitedByUserId: invitedBy,
      invitedByName: invitedBy === null ? null : (names.get(invitedBy) ?? null),
      createdAt: asTimestampOrNull(row, 'created_at'),
    }
  })
}

/* ------------------------------------------------------------- secrets -- */

/**
 * A credential the product holds and this screen will never render.
 *
 * The brief is explicit: if a value cannot be shown safely, say what it is and
 * when it changed. So each entry carries a count of how many exist and the
 * newest timestamp associated with them — read from columns that are not the
 * secret. No entry carries the value, a prefix of it, or a masked form.
 */
export type SecretHolding = {
  key: 'invitation_token' | 'guest_portal_token' | 'auth_credentials'
  /** How many exist, or null when the product cannot count them. */
  count: number | null
  /** The newest moment associated with them, or null. */
  newestAt: string | null
}

/**
 * Count the credential-bearing rows without touching the credential.
 *
 * `bookings.guest_token` has a `default` that generates it at insert and there
 * is no rotation path anywhere in the product, so the booking's `created_at` is
 * genuinely when that token was minted — which is why `created_at` is what is
 * read and reported rather than `updated_at`, whose meaning is "the row
 * changed" and would be a different and misleading claim.
 */
export async function loadSecretHoldings(
  args: SecurityArgs,
): Promise<readonly SecretHolding[]> {
  const { db, organizationId } = args

  const [invitations, bookings] = await Promise.all([
    newestOf(db, 'invitations', organizationId, 'created_at'),
    newestOf(db, 'bookings', organizationId, 'created_at'),
  ])

  return [
    { key: 'invitation_token', ...invitations },
    { key: 'guest_portal_token', ...bookings },
    {
      key: 'auth_credentials',
      // Passwords, recovery tokens and MFA factors are in the `auth` schema,
      // which PostgREST does not expose. There is nothing to count and saying
      // "0" would imply the product looked and found none.
      count: null,
      newestAt: null,
    },
  ]
}

async function newestOf(
  db: Db,
  table: 'invitations' | 'bookings',
  organizationId: string,
  column: 'created_at',
): Promise<{ count: number; newestAt: string | null }> {
  const [total, newest] = await Promise.all([
    db
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId),
    db
      .from(table)
      .select(column)
      .eq('organization_id', organizationId)
      .order(column, { ascending: false })
      .limit(1),
  ])

  if (total.error) throw total.error
  if (newest.error) throw newest.error

  const rows = toRows(newest.data)
  return {
    count: total.count ?? 0,
    newestAt: rows.length === 0 ? null : asTimestampOrNull(rows[0], column),
  }
}

/* ------------------------------------------------------------ internals -- */

async function rolesByMembership(
  db: Db,
  organizationId: string,
  membershipIds: readonly string[],
): Promise<ReadonlyMap<string, string[]>> {
  if (membershipIds.length === 0) return new Map()

  const { data, error } = await db
    .from('membership_roles')
    .select('membership_id, roles!inner(name, sort_order)')
    .eq('organization_id', organizationId)
    .in('membership_id', [...membershipIds])

  if (error) throw error

  const byMembership = new Map<string, { name: string; order: number }[]>()

  for (const row of toRows(data)) {
    const embedded = Array.isArray(row.roles) ? row.roles[0] : row.roles
    if (typeof embedded !== 'object' || embedded === null) continue

    const role = embedded as Record<string, unknown>
    const name = typeof role.name === 'string' ? role.name : null
    if (name === null) continue

    const membershipId = asString(row, 'membership_id')
    const order = typeof role.sort_order === 'number' ? role.sort_order : 0
    byMembership.set(membershipId, [
      ...(byMembership.get(membershipId) ?? []),
      { name, order },
    ])
  }

  const result = new Map<string, string[]>()
  for (const [membershipId, roles] of byMembership) {
    result.set(
      membershipId,
      roles.sort((a, b) => a.order - b.order).map((role) => role.name),
    )
  }
  return result
}

async function scopeByMembership(
  db: Db,
  organizationId: string,
  membershipIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (membershipIds.length === 0) return new Map()

  const { data, error } = await db
    .from('membership_scopes')
    .select('membership_id, kind')
    .eq('organization_id', organizationId)
    .in('membership_id', [...membershipIds])

  if (error) throw error

  const scopes = new Map<string, string>()
  for (const row of toRows(data)) {
    scopes.set(asString(row, 'membership_id'), asString(row, 'kind'))
  }
  return scopes
}

async function profileSecurity(
  db: Db,
  userIds: readonly string[],
): Promise<
  ReadonlyMap<string, { fullName: string | null; mfaEnforcedAt: string | null }>
> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name, mfa_enforced_at')
    .in('id', unique)

  if (error) throw error

  const profiles = new Map<
    string,
    { fullName: string | null; mfaEnforcedAt: string | null }
  >()
  for (const row of toRows(data)) {
    profiles.set(asString(row, 'id'), {
      fullName: asStringOrNull(row, 'full_name'),
      mfaEnforcedAt: asTimestampOrNull(row, 'mfa_enforced_at'),
    })
  }
  return profiles
}

async function profileNames(
  db: Db,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const profiles = await profileSecurity(db, userIds)
  const names = new Map<string, string>()
  for (const [userId, profile] of profiles) {
    if (profile.fullName !== null) names.set(userId, profile.fullName)
  }
  return names
}
