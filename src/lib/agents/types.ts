/**
 * The agent domain contract.
 *
 * ── The shape, and why it is this shape ───────────────────────────────────
 *
 * There is no `users.is_agent` and there is no `agent.type`. An agent is a
 * **member of an organization** — the same `User → Membership → Organization →
 * Roles → Scope` chain as everybody else — with a deliberately narrow role and
 * a deliberately narrow reach. What is genuinely new is not an identity system;
 * it is the commercial relationship sitting above one.
 *
 * A flag on the user would end the module before it started. The same person
 * sells for five competing businesses on the same day, on five different sets
 * of terms, and an attribute of the person cannot hold five answers. The whole
 * point is that the permission belongs to the *relationship*.
 *
 * Which is why the records split the way they do:
 *
 *   `AgentProfile`              global — the phone, and whether it is verified
 *   `AgentOrganizationSettings` per organization — everything else
 *
 * One global user. A separate agent membership per organization, with
 * independent permissions, independent inventory and an independent commission.
 * A booking made in one organization is never visible in another, not even to
 * the same agent — which is not a new rule, it is tenant isolation applied to
 * somebody standing in two tenants at once, and it is enforced at the database
 * floor rather than by a filter somebody has to remember to write.
 *
 * ── Two scopes, one engine ────────────────────────────────────────────────
 *
 * An agent needs two different answers about "where":
 *
 *   · **which records are theirs** — their bookings, their leads, their
 *     commissions;
 *   · **which inventory they may sell** — which properties exist for them at
 *     all.
 *
 * One `Scope` value cannot say both, and getting it wrong is not subtle. Give
 * an agent `properties` and they read every *other* agent's bookings and
 * commissions inside those properties; give them `own_records` and they cannot
 * see availability at all, because a property belongs to nobody in particular.
 *
 * `can.ts` answers this directly with `Actor.scopeOverrides` and the
 * `ResourceFamily` a resource declares, so an agent resolves as:
 *
 *     scope:          { kind: 'own_records' }                  // the default
 *     scopeOverrides: { inventory: { kind: 'properties', … } }
 *
 * and every family that is not `inventory` — `booking`, `finance`, `guest` —
 * falls through to `own_records`. **There is no agent-specific enforcement
 * code.** `AgentInventoryScope` below is only how the reach is *stored*;
 * `inventoryScopeToScope` converts it for the actor, and the deciding is the
 * one engine's. That is the whole reason for not building a second one.
 */

import {
  isWithinScope,
  type Actor,
  type MembershipStatus,
  type Resource,
  type Scope,
} from '../authz/can'
import { NotFoundError } from '../errors'
import type { AgentAccess } from './access'
import type { AgentDiscountCap } from './discounts'
import type { AgentHoldLimits } from './holds'

// ── Identity ──────────────────────────────────────────────────────────────

/**
 * The agent as a person, once, globally.
 *
 * The phone number is the identity key and is stored normalised — see
 * `phone.ts`. `phoneVerifiedAt` is what a change of number has to re-earn:
 * swapping the key without proving the new one is account takeover in one
 * click, because the login code follows the key.
 */
export interface AgentProfile {
  userId: string
  /** E.164. `+972501234567`. The only format ever stored. */
  phoneE164: string
  phoneVerifiedAt: string | null
  displayName: string | null
  email: string | null
}

// ── Reach ─────────────────────────────────────────────────────────────────

/**
 * Which inventory exists for this agent, inside this organization.
 *
 * Deny by default runs through every branch: an empty list matches nothing, and
 * an unrecognised kind matches nothing. The permissive reading of a scope
 * nobody configured is how an outsider ends up with the whole portfolio.
 */
export type AgentInventoryScope =
  | { kind: 'all_properties' }
  | { kind: 'properties'; propertyIds: readonly string[] }
  | { kind: 'units'; unitIds: readonly string[] }

/**
 * The stored reach, converted into the scope the engine understands.
 *
 * This is the *only* thing this module does with inventory reach. Everything
 * downstream asks `can(actor, grant, { …, family: 'inventory' })` and gets its
 * answer from `isWithinScope`, so there is one implementation of "does this
 * scope reach this resource" in the product and this is not a second one.
 *
 * `all_properties` becomes `all_organization` rather than a list of every
 * property id: a list would be a snapshot, and an agent given "everything"
 * would silently not reach the property bought next month.
 */
export function inventoryScopeToScope(scope: AgentInventoryScope): Scope {
  switch (scope.kind) {
    case 'all_properties':
      return { kind: 'all_organization' }
    case 'properties':
      return { kind: 'properties', propertyIds: [...scope.propertyIds] }
    case 'units':
      return { kind: 'units', unitIds: [...scope.unitIds] }
    default:
      // Deny by default. An unrecognised stored kind reaches their own records
      // and no inventory at all, rather than the whole portfolio.
      return { kind: 'own_records' }
  }
}

/** The unit an agent is asking about, as a resource the engine can judge. */
export interface AgentInventoryTarget {
  organizationId: string
  propertyId: string | null
  unitId: string
}

/**
 * The `Resource` for a piece of inventory.
 *
 * `family: 'inventory'` is what makes the per-family override apply. Without
 * it the resource falls back to the agent's default scope — `own_records` —
 * and a unit belongs to nobody, so the answer would be a refusal. That
 * fallback direction is deliberate and is the safe one: forgetting the family
 * denies, it does not widen.
 */
export function inventoryResource(target: AgentInventoryTarget): Resource {
  const resource: Resource = {
    organizationId: target.organizationId,
    unitId: target.unitId,
    family: 'inventory',
  }
  if (target.propertyId !== null) resource.propertyId = target.propertyId
  return resource
}

/**
 * Refuse a unit outside this agent's reach.
 *
 * `NotFoundError`, not an authorization refusal. To an agent who was never
 * given a property, that property does not exist — and answering "you are not
 * allowed to see Villa Sunrise" confirms that Villa Sunrise is on this
 * business's books, which is competitive information handed to somebody who
 * also sells for four rivals.
 */
export function assertAgentReach(
  actor: Actor,
  target: AgentInventoryTarget,
): void {
  const resource = inventoryResource(target)
  if (
    resource.organizationId === actor.organizationId &&
    isWithinScope(actor, resource)
  ) {
    return
  }
  throw new NotFoundError('unit', target.unitId)
}

// ── The relationship ──────────────────────────────────────────────────────

/**
 * What this agent is, inside this organization.
 *
 * Note what is not here: no `type`, no `preset`, no `model`. The four presets
 * are seed values for `access` and stop existing the moment one is chosen. A
 * stored type would be an invitation to write `if (agent.type === 'senior')`
 * somewhere, and that line silently breaks every manual edit an owner makes —
 * which is the one thing the specification demands must keep working.
 */
export interface AgentOrganizationSettings {
  organizationId: string
  agentUserId: string
  /** The membership this agent acts through. There is no second identity. */
  membershipId: string
  status: MembershipStatus
  /** The three ladders, in a shape that cannot hold an incoherent combination. */
  access: AgentAccess
  inventory: AgentInventoryScope
  discountCap: AgentDiscountCap
  holdLimits: AgentHoldLimits
  /** 0–100. Widens the hold limits as the agent performs. See `holds.ts`. */
  reputationScore: number
  /** Set when the agent sells under an agency's agreement. */
  agencyId: string | null
  internalNote: string | null
  createdAt: string
  updatedAt: string
  version: number
}

/**
 * A compile-time guard against the field the architecture forbids.
 *
 * If somebody adds `type` — or `preset`, or `model` — to the record above, this
 * line stops compiling. A comment saying "do not add a type column" is advice;
 * this is a gate, and it fails in `tsc` rather than in review.
 */
type Forbidden = 'type' | 'preset' | 'model' | 'agentType'
type AssertNoForbiddenField<T> =
  Extract<keyof T, Forbidden> extends never ? true : never

export const NO_AGENT_TYPE_COLUMN: AssertNoForbiddenField<AgentOrganizationSettings> = true

// ── Invitations ───────────────────────────────────────────────────────────

/**
 * An agent invited by telephone number who has not yet accepted.
 *
 * Separate from the membership because there is nobody to attach a membership
 * to yet: the number belongs to a person ESTIA has never met. When they accept,
 * a user and a membership are created together and the invitation is consumed.
 */
export interface AgentInvitation {
  id: string
  organizationId: string
  phoneE164: string
  displayName: string | null
  email: string | null
  invitedByUserId: string
  /** The ladders the agent will start with. Chosen before they accept. */
  access: AgentAccess
  inventory: AgentInventoryScope
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
  createdAt: string
  expiresAt: string
  acceptedAt: string | null
}

/** The channels an invitation is delivered on. The identity is the phone. */
export const INVITATION_CHANNELS = ['sms', 'whatsapp'] as const

export type InvitationChannel = (typeof INVITATION_CHANNELS)[number]
