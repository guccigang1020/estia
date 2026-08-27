/**
 * The authorization engine.
 *
 * One question, asked the same way everywhere in the product:
 *
 *     can this user perform this action on this resource,
 *     inside this organization, right now?
 *
 * Nothing else is allowed to decide access. Not a role comparison, not a
 * hidden menu item, not a filtered query. Callers that need a boolean use
 * `can()`; callers that need to explain a refusal to a human use `authorize()`
 * and read the reason.
 *
 * This runs on the server. It is the second of two floors: the database
 * enforces tenant isolation through row level security regardless of what
 * happens here, so a bug in this file cannot leak one customer's data to
 * another. This floor decides what a member of an organization may do inside
 * their own organization.
 */

import type { Grant } from './permissions'
import type { Entitlement } from '../plans/entitlements'
import { ENTITLEMENT_FOR_GRANT } from '../plans/entitlements'

// ── Inputs ────────────────────────────────────────────────────────────────

export type MembershipStatus =
  | 'invited'
  | 'pending'
  | 'active'
  | 'suspended'
  | 'removed'

/**
 * Where a membership's permissions apply.
 *
 * A role says what someone may do; a scope says where. Both are required —
 * "property manager" is meaningless until it names which properties.
 */
export type Scope =
  | { kind: 'all_organization' }
  | { kind: 'properties'; propertyIds: readonly string[] }
  | { kind: 'units'; unitIds: readonly string[] }
  | { kind: 'team'; teamIds: readonly string[] }
  | { kind: 'own_records' }

/**
 * The resolved actor for the active workspace.
 *
 * Built once per request from the session, the membership and the plan. Note
 * there is no `role` field: roles have already been flattened into grants, so
 * a custom role and a built-in one behave identically from here on.
 */
export interface Actor {
  userId: string
  /** The workspace being acted in. A user with several memberships has one active. */
  organizationId: string
  membershipStatus: MembershipStatus
  grants: ReadonlySet<Grant>
  scope: Scope
  /** Features the organization's plan includes. */
  entitlements: ReadonlySet<Entitlement>
  /** ESTIA staff. Bypasses scope, never bypasses tenant isolation or audit. */
  isPlatformStaff?: boolean
}

/**
 * The thing being acted upon.
 *
 * `organizationId` is mandatory — an authorization question about a resource
 * that does not know which tenant it belongs to cannot be answered safely.
 */
export interface Resource {
  organizationId: string
  propertyId?: string
  unitId?: string
  teamId?: string
  /** Set for records owned by a person, e.g. the assignee of a task. */
  assignedToUserId?: string
  createdByUserId?: string
}

// ── Outputs ───────────────────────────────────────────────────────────────

export type DenialReason =
  | 'membership_not_active'
  | 'cross_organization'
  | 'missing_permission'
  | 'plan_does_not_include'
  | 'out_of_scope'

export type Decision =
  | { allowed: true }
  | {
      allowed: false
      reason: DenialReason
      /** The grant that was missing, when the refusal was about one. */
      grant?: Grant
      /** The plan feature required, when the refusal was about the plan. */
      entitlement?: Entitlement
    }

const ALLOW: Decision = { allowed: true }

// ── Holding a grant ───────────────────────────────────────────────────────

/**
 * The plan feature this grant needs and the actor lacks, or `null`.
 *
 * Kept as one function because two places ask the question — the decision
 * ladder below, and field redaction further down — and two implementations of
 * the same rule drift apart. When they did, `authorize()` refused a finance
 * manager the commission figure while `redact()` handed it over.
 */
function missingEntitlementFor(actor: Actor, grant: Grant): Entitlement | null {
  const required = ENTITLEMENT_FOR_GRANT[grant]
  if (!required) return null
  return actor.entitlements.has(required) ? null : required
}

/**
 * Does the actor hold this grant outright — permission and plan together?
 *
 * The authoritative answer to "may they", without the scope question, which
 * needs a resource. Anything deciding visibility uses this rather than reading
 * `actor.grants` directly.
 */
export function holdsGrant(actor: Actor, grant: Grant): boolean {
  return actor.grants.has(grant) && missingEntitlementFor(actor, grant) === null
}

// ── The engine ────────────────────────────────────────────────────────────

/**
 * Decide, with a reason.
 *
 * Order matters, and it is not arbitrary:
 *
 *   1. Membership — a suspended or removed person is not an actor at all.
 *   2. Tenant     — the most serious failure possible, checked before anything
 *                   that could accidentally answer for the wrong organization.
 *   3. Permission — does this person hold the right?
 *   4. Plan       — they hold the right, but the organization has not bought
 *                   the feature. Distinguished from (3) so the interface can
 *                   offer an upgrade instead of saying "not allowed".
 *   5. Scope      — they hold the right and the plan, but not here.
 */
export function authorize(
  actor: Actor,
  grant: Grant,
  resource?: Resource,
): Decision {
  if (actor.membershipStatus !== 'active') {
    return { allowed: false, reason: 'membership_not_active' }
  }

  if (resource && resource.organizationId !== actor.organizationId) {
    return { allowed: false, reason: 'cross_organization' }
  }

  if (!actor.grants.has(grant)) {
    return { allowed: false, reason: 'missing_permission', grant }
  }

  const entitlement = missingEntitlementFor(actor, grant)
  if (entitlement) {
    return { allowed: false, reason: 'plan_does_not_include', grant, entitlement }
  }

  if (resource && !isWithinScope(actor, resource)) {
    return { allowed: false, reason: 'out_of_scope', grant }
  }

  return ALLOW
}

/** The boolean form, for call sites that do not need to explain themselves. */
export function can(actor: Actor, grant: Grant, resource?: Resource): boolean {
  return authorize(actor, grant, resource).allowed
}

/**
 * The enforcing form. Services call this so that forgetting to check the
 * result is not a silent security hole.
 */
export function assertCan(
  actor: Actor,
  grant: Grant,
  resource?: Resource,
): void {
  const decision = authorize(actor, grant, resource)
  if (!decision.allowed) throw new AuthorizationError(decision, grant)
}

export class AuthorizationError extends Error {
  readonly decision: Extract<Decision, { allowed: false }>
  readonly grant: Grant

  constructor(decision: Decision, grant: Grant) {
    super(`Not authorized: ${grant}`)
    this.name = 'AuthorizationError'
    this.grant = grant
    this.decision = decision as Extract<Decision, { allowed: false }>
  }
}

// ── Scope ─────────────────────────────────────────────────────────────────

/**
 * Does the actor's scope reach this resource?
 *
 * Deny by default: an unrecognised or unresolvable combination refuses rather
 * than falls through. A resource that carries no location is organization-wide
 * and is therefore only reachable by an organization-wide scope.
 */
export function isWithinScope(actor: Actor, resource: Resource): boolean {
  // Platform staff act across an organization once they are inside it. The
  // tenant check above still applies, and every action is audited.
  if (actor.isPlatformStaff) return true

  switch (actor.scope.kind) {
    case 'all_organization':
      return true

    case 'properties':
      if (resource.propertyId === undefined) return false
      return actor.scope.propertyIds.includes(resource.propertyId)

    case 'units':
      if (resource.unitId === undefined) return false
      return actor.scope.unitIds.includes(resource.unitId)

    case 'team':
      if (resource.teamId === undefined) return false
      return actor.scope.teamIds.includes(resource.teamId)

    case 'own_records':
      return (
        resource.assignedToUserId === actor.userId ||
        resource.createdByUserId === actor.userId
      )

    default:
      return false
  }
}

// ── Field-level access ────────────────────────────────────────────────────

/**
 * Strip fields the actor may not see.
 *
 * Called where a record is shaped for a response, so that privacy holds on
 * every path out of the system — screen, API, export, realtime payload — and
 * not only where someone remembered to hide a column.
 *
 * Uses `holdsGrant`, so a field belonging to a feature the organization has
 * not bought is withheld for the same reason the action behind it is refused.
 * One rule, asked once.
 */
export function redact<T extends object>(
  actor: Actor,
  record: T,
  fields: ReadonlyArray<{ key: keyof T; requires: Grant }>,
): T {
  const output = { ...record }
  for (const field of fields) {
    if (!holdsGrant(actor, field.requires)) {
      delete output[field.key]
    }
  }
  return output
}
