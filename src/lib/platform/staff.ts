/**
 * Who ESTIA's own staff are, and what they may do.
 *
 * This module is pure. It knows the shape of a platform session and the rules
 * that follow from it, and it never reads a row — `session.ts` does that, and
 * `access.ts` decides with what this file returns.
 *
 * ── The one property everything else rests on ─────────────────────────────
 *
 * A platform session holds `platform.*` grants and nothing else. That is not a
 * convention maintained here; it is enforced three times over and this file is
 * the third:
 *
 *   1. `tg_role_permission_grantable()` (0002) refuses a customer permission
 *      on a role flagged `is_platform`.
 *   2. `has_platform_permission()` (0041) reads only roles named by
 *      `platform_staff`, and `tg_platform_staff_role_is_platform()` refuses a
 *      role that is not `is_platform`.
 *   3. `platformGrants()` below narrows whatever came back to the five codes
 *      the catalogue calls platform permissions, so a row that somehow carried
 *      `booking.delete` produces a session that cannot use it.
 *
 * The consequence is worth stating plainly, because it is the answer to the
 * question a customer asks about a support console: ESTIA staff cannot write
 * a customer's business data. Not a booking, not a payment, not a guest. There
 * is no grant in this session that any customer policy consults.
 */

import { PERMISSIONS, type Permission } from '@/lib/authz/permissions'
import { PLATFORM_ROLES, type PlatformRole } from '@/lib/authz/roles'

/* ---------------------------------------------------------------- grants -- */

/**
 * The platform half of the catalogue.
 *
 * Derived from `PERMISSIONS` by the same `platform.` prefix rule the database
 * generates `permissions.is_platform` from, rather than listed again. A sixth
 * platform permission added to the catalogue is therefore a platform grant
 * here on the same commit, which is the property a hand-written copy loses.
 */
export const PLATFORM_GRANTS = PERMISSIONS.filter((code) =>
  code.startsWith('platform.'),
) as readonly PlatformGrant[]

export type PlatformGrant = Extract<Permission, `platform.${string}`>

const PLATFORM_GRANT_SET: ReadonlySet<string> = new Set(PLATFORM_GRANTS)

export function isPlatformGrant(value: string): value is PlatformGrant {
  return PLATFORM_GRANT_SET.has(value)
}

/**
 * The grants a session actually holds, from whatever the roster row carried.
 *
 * Narrowing rather than trusting. The database has two triggers keeping a
 * customer permission off a platform role, and this is the third refusal: a
 * code that is not a platform grant is dropped, not passed through with a
 * shrug. Deny by default applies to the platform's own staff first.
 */
export function platformGrants(
  codes: readonly string[],
): ReadonlySet<PlatformGrant> {
  return new Set(codes.filter(isPlatformGrant))
}

/* --------------------------------------------------------------- session -- */

export const PLATFORM_STAFF_STATUSES = ['active', 'revoked'] as const

export type PlatformStaffStatus = (typeof PLATFORM_STAFF_STATUSES)[number]

export function isPlatformRole(value: string): value is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(value)
}

/**
 * A signed-in member of ESTIA's staff, resolved for one request.
 *
 * Deliberately NOT an `Actor`. An `Actor` answers "what may this person do
 * inside their organization", and a platform staff member has no organization:
 * `organizationId` would have to be filled with something, and whatever were
 * chosen would be a claim of membership that is not true. The console asks a
 * different question and carries a different object, so the two can never be
 * passed to each other by accident.
 */
export interface PlatformSession {
  staffId: string
  userId: string
  role: PlatformRole
  /** The role's Hebrew name, for display only. Never decides anything. */
  roleName: string
  grants: ReadonlySet<PlatformGrant>
  /** From `user_profiles`, when there is one. The audit trail needs a name. */
  displayName: string | null
}

/** Does this session hold the grant outright? No plan and no scope to consult. */
export function holdsPlatformGrant(
  session: PlatformSession,
  grant: PlatformGrant,
): boolean {
  return session.grants.has(grant)
}

/**
 * How the trail names this person.
 *
 * Prefixed with the product's name on purpose. An `audit_events` row written
 * by ESTIA lands in a customer's own trail beside their employees' rows, and
 * "דנה כהן" sitting between two of their own people reads as a colleague they
 * have forgotten hiring. `actor_type` already says `platform_staff`, and the
 * label says it again in the one place a human actually looks.
 */
export function platformActorLabel(session: PlatformSession): string {
  return `ESTIA · ${session.displayName ?? session.roleName}`
}
