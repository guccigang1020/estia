/**
 * Building the actor.
 *
 * One user, one organization, one request → the `Actor` the authorization
 * engine consumes. Everything downstream — `can()`, `assertCan()`, `redact()`,
 * every service operation — trusts this function completely, so it is written
 * to be boring and to fail closed.
 *
 * Three properties it holds:
 *
 *   1. **It is pure.** All I/O arrives through `ActorSource`. No clock, no
 *      environment, no client.
 *   2. **It refuses rather than degrades.** A membership that is not `active`
 *      produces no `Actor` at all — not an `Actor` with no grants. The
 *      difference matters: an empty-granted actor still passes "is there a
 *      logged-in actor here?" checks written elsewhere, and one day one of
 *      them will be written badly.
 *   3. **An unrecognised role grants nothing.** Deny by default reaches the
 *      resolution step too.
 */

import type { Actor, Scope } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { SYSTEM_ROLES, grantsForRoles, type SystemRole } from '../authz/roles'
import type { Entitlement, PlanLimits } from '../plans/entitlements'
import { effectiveEntitlements, effectiveLimits } from '../plans/plan'
import { AuthorizationError, NotFoundError } from '../errors'
import type { ActorSource, MembershipScopeRow, RoleAssignment } from './source'

// ── Result ────────────────────────────────────────────────────────────────

/**
 * Why no actor could be built.
 *
 * Separated from `DenialReason` in `can.ts` because these are not refusals of
 * an action — there is no action yet. A page reading `no_membership` sends the
 * person to the workspace picker; one reading `membership_not_active` shows
 * them who to contact.
 */
export type ActorResolutionFailure =
  | { reason: 'no_membership' }
  | { reason: 'membership_not_active'; status: Actor['membershipStatus'] }
  | { reason: 'no_subscription' }

export type ActorResolution =
  | {
      ok: true
      actor: Actor
      /** The membership row id, for writing `created_by` style columns. */
      membershipId: string
      /** The organization's effective quotas, after per-customer overrides. */
      limits: PlanLimits
      /** The organization's effective features. Same set as `actor.entitlements`. */
      entitlements: ReadonlySet<Entitlement>
    }
  | ({ ok: false } & ActorResolutionFailure)

// ── Roles → grants ────────────────────────────────────────────────────────

const SYSTEM_ROLE_CODES: ReadonlySet<string> = new Set(SYSTEM_ROLES)

function isSystemRole(code: string): code is SystemRole {
  return SYSTEM_ROLE_CODES.has(code)
}

/**
 * Flatten every role on the membership into one set of grants.
 *
 * System roles resolve through `grantsForRoles()` — the catalogue in code, not
 * a copy in the database — so owner and administrator automatically hold a
 * permission the day it is added. Custom and platform roles carry their own
 * grants, because a customer composed them and no code knows what they contain.
 *
 * A `system` role whose code is not in `SYSTEM_ROLES` contributes nothing. It
 * means the database and the catalogue disagree, and the safe reading of a
 * disagreement about permissions is the smaller one.
 */
export function grantsForAssignments(
  assignments: readonly RoleAssignment[],
): Set<Grant> {
  const systemRoles: SystemRole[] = []
  const explicit = new Set<Grant>()

  for (const assignment of assignments) {
    if (assignment.kind === 'system') {
      if (isSystemRole(assignment.code)) systemRoles.push(assignment.code)
      continue
    }
    for (const grant of assignment.grants ?? []) explicit.add(grant)
  }

  const grants = grantsForRoles(systemRoles)
  for (const grant of explicit) grants.add(grant)
  return grants
}

// ── Scope row → scope ─────────────────────────────────────────────────────

/**
 * The most restrictive scope that still lets a person work.
 *
 * Used when no scope row exists. Not `all_organization`, which would hand the
 * whole business to someone whose scope was never written; and not a refusal,
 * which would lock a real employee out over a missing row. `own_records`
 * leaves them able to see what they are assigned and nothing else.
 */
const FALLBACK_SCOPE: Scope = { kind: 'own_records' }

export function scopeFromRow(row: MembershipScopeRow | null): Scope {
  if (!row) return FALLBACK_SCOPE

  switch (row.kind) {
    case 'all_organization':
      return { kind: 'all_organization' }
    case 'properties':
      return { kind: 'properties', propertyIds: [...(row.propertyIds ?? [])] }
    case 'units':
      return { kind: 'units', unitIds: [...(row.unitIds ?? [])] }
    case 'team':
      return { kind: 'team', teamIds: [...(row.teamIds ?? [])] }
    case 'own_records':
      return { kind: 'own_records' }
    default:
      // Unreachable while the union holds. Kept because an enum value added to
      // the database before it is added here must not fall through to "allow".
      return FALLBACK_SCOPE
  }
}

// ── Resolution ────────────────────────────────────────────────────────────

/**
 * Build the actor for `userId` acting inside `organizationId`.
 *
 * Order is chosen so the cheapest and most disqualifying check runs first: a
 * suspended member's roles, scope and plan are never read at all.
 */
export async function resolveActor(
  source: ActorSource,
  userId: string,
  organizationId: string,
): Promise<ActorResolution> {
  const membership = await source.loadMembership(userId, organizationId)
  if (!membership) return { ok: false, reason: 'no_membership' }

  if (membership.status !== 'active') {
    return {
      ok: false,
      reason: 'membership_not_active',
      status: membership.status,
    }
  }

  // A membership row that names a different organization than the one asked
  // about is a bug in the source, and the one bug class that must never be
  // absorbed quietly.
  if (membership.organizationId !== organizationId) {
    return { ok: false, reason: 'no_membership' }
  }

  const plan = await source.loadPlan(organizationId)
  if (!plan) return { ok: false, reason: 'no_subscription' }

  const [assignments, scopeRow] = await Promise.all([
    source.loadRoles(membership.id),
    source.loadScope(membership.id),
  ])

  const grants = grantsForAssignments(assignments)
  const entitlements = effectiveEntitlements(plan)
  const isPlatformStaff = assignments.some((a) => a.kind === 'platform')

  const actor: Actor = {
    userId: membership.userId,
    organizationId: membership.organizationId,
    membershipStatus: membership.status,
    grants,
    scope: scopeFromRow(scopeRow),
    entitlements,
    ...(isPlatformStaff ? { isPlatformStaff: true } : {}),
  }

  return {
    ok: true,
    actor,
    membershipId: membership.id,
    limits: effectiveLimits(plan),
    entitlements,
  }
}

/**
 * The enforcing form, for a service call site that has nowhere useful to send
 * a person who has no actor.
 *
 * `no_membership` becomes a `NotFoundError` on the organization rather than a
 * refusal: to someone who is not a member, a workspace they were never invited
 * to does not exist, and saying "you are not a member of Villa Sunrise"
 * confirms that Villa Sunrise is a customer of ours.
 */
export async function resolveActorOrThrow(
  source: ActorSource,
  userId: string,
  organizationId: string,
): Promise<Extract<ActorResolution, { ok: true }>> {
  const resolution = await resolveActor(source, userId, organizationId)
  if (resolution.ok) return resolution

  switch (resolution.reason) {
    case 'no_membership':
      throw new NotFoundError('organization', organizationId)
    case 'membership_not_active':
      throw new AuthorizationError(
        { allowed: false, reason: 'membership_not_active' },
        'organization.view',
      )
    case 'no_subscription':
      throw new NotFoundError('organization_subscription', organizationId)
  }
}
