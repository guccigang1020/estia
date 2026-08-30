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

/**
 * The five, declared once, beside the type they inhabit.
 *
 * The array is the runtime half and the type is derived from it, so the two
 * cannot disagree. It lives here rather than in the persistence layer because
 * every reader of a status needs the same five: the engine, the actor
 * resolver, and the agent domain. A copy in an adapter made
 * `persistence/actor.ts` the source of truth for a decision that belongs to
 * authorization — and made `persistence/agents.ts` import from the adapter
 * beside it, which is the import cycle `persistence/actor.ts` would otherwise
 * close when it reads an agent's stored ladders.
 */
export const MEMBERSHIP_STATUSES = [
  'invited',
  'pending',
  'active',
  'suspended',
  'removed',
] as const

export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number]

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
 * The kind of thing being reached for.
 *
 * Scope is not one answer per person. An external sales agent needs *these
 * properties* to see what is free to sell, and *only their own records* for
 * bookings, commissions and leads. One value cannot say both: give them
 * `properties` and they read every agent's commissions; give them
 * `own_records` and they cannot see availability at all, because a property
 * belongs to nobody in particular.
 *
 * So a membership carries a default scope and may narrow it per family.
 */
export const RESOURCE_FAMILIES = [
  'inventory', // properties, units, availability — what may be sold
  'booking', // bookings, holds, quotes, leads
  'guest',
  'finance', // payments, invoices, commissions, statements
  'operations', // tasks, incidents, inventory items
  'team',
  'website',
  'settings',
] as const

export type ResourceFamily = (typeof RESOURCE_FAMILIES)[number]

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
  /** Applies wherever no family below narrows it. */
  scope: Scope
  /**
   * Per-family narrowing, for memberships whose reach genuinely differs by
   * what they are reaching for. Absent for almost everyone — an employee has
   * one scope and this stays undefined.
   *
   * An unlisted family falls back to `scope`, and so does a resource that
   * declares no family at all — which is what makes this safe to add to the
   * model: a call site that has not opted in cannot have its answer changed.
   *
   * A listed family, though, is **replaced** rather than intersected — see
   * `scopeFor` below. An override is a narrowing only when what is written
   * into it is already a subset of the default; write something wider and it
   * widens. Whoever populates this field owns that comparison, because the
   * engine does not make it.
   */
  scopeOverrides?: Partial<Record<ResourceFamily, Scope>>
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
  /**
   * Which family this belongs to, so a per-family scope can apply. Omitted
   * resources use the actor's default scope, which is the behaviour every
   * existing call site already relies on.
   */
  family?: ResourceFamily
}

// ── Outputs ───────────────────────────────────────────────────────────────

export type DenialReason =
  | 'membership_not_active'
  | 'cross_organization'
  | 'missing_permission'
  | 'plan_does_not_include'
  | 'out_of_scope'
  /**
   * Held the right, but the value attempted exceeds a limit somebody else must
   * sign off — an agent asking for 12% when their cap is 5%.
   *
   * `authorize()` never returns this on its own: it cannot see the value being
   * attempted, and teaching it to would turn an authorization engine into a
   * business-rule engine. The domain evaluates the limit and returns a
   * `Decision` carrying this reason, which the service layer composes.
   *
   * It is a denial, not a third outcome, so `can()` stays false and every
   * boolean call site fails closed. Only callers that read the reason can
   * offer the approval path — and offering it matters: an agent who is simply
   * refused takes the negotiation to WhatsApp, and the sale leaves the system.
   */
  | 'requires_approval'

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
    return {
      allowed: false,
      reason: 'plan_does_not_include',
      grant,
      entitlement,
    }
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

  return scopeReaches(scopeFor(actor, resource), actor.userId, resource)
}

/**
 * Which scope governs this resource.
 *
 * A per-family override wins where one is set; otherwise the membership's
 * default applies. A resource that does not declare a family always uses the
 * default, which is why adding families to the model cannot change the answer
 * for any call site that has not opted in.
 *
 * "Wins" is literal: the override is returned instead of the default, not
 * intersected with it. That is deliberate — the two scopes an agent needs
 * ("which records are mine" and "which inventory may I sell") have no common
 * subset, so an intersection would always be empty and the model would answer
 * nothing. The cost is that this function cannot tell a narrowing from a
 * widening, so whatever fills `scopeOverrides` must.
 */
export function scopeFor(actor: Actor, resource: Resource): Scope {
  if (resource.family === undefined) return actor.scope
  return actor.scopeOverrides?.[resource.family] ?? actor.scope
}

function scopeReaches(
  scope: Scope,
  userId: string,
  resource: Resource,
): boolean {
  switch (scope.kind) {
    case 'all_organization':
      return true

    case 'properties':
      if (resource.propertyId === undefined) return false
      return scope.propertyIds.includes(resource.propertyId)

    case 'units':
      if (resource.unitId === undefined) return false
      return scope.unitIds.includes(resource.unitId)

    case 'team':
      if (resource.teamId === undefined) return false
      return scope.teamIds.includes(resource.teamId)

    case 'own_records':
      return (
        resource.assignedToUserId === userId ||
        resource.createdByUserId === userId
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
  /**
   * The record being shaped, when a field's visibility depends on whose it is.
   *
   * An agent may see the guest they entered themselves and not the one another
   * agent brought — the same grant, a different answer per row. Omit it and
   * only the grant decides, which is what every existing call site does.
   */
  resource?: Resource,
): T {
  const output = { ...record }
  for (const field of fields) {
    const allowed =
      holdsGrant(actor, field.requires) &&
      (resource === undefined || isWithinScope(actor, resource))
    if (!allowed) {
      delete output[field.key]
    }
  }
  return output
}
