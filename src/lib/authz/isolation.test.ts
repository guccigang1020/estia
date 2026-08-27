/**
 * Tenant isolation proofs.
 *
 * This is the highest-severity guarantee in the product: one customer's data
 * must never be reachable from another customer's session, whatever role,
 * scope, seniority or staff flag the actor carries.
 *
 * The rule proved here is deliberately absolute. There is no permission, no
 * role, no scope and no platform privilege that crosses an organization
 * boundary in this engine.
 */

import { describe, expect, it } from 'vitest'
import {
  AuthorizationError,
  assertCan,
  authorize,
  can,
  isWithinScope,
  type Actor,
  type Resource,
} from './can'
import { FIELD_PERMISSIONS, PERMISSIONS, type Grant } from './permissions'
import { grantsForRoles } from './roles'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'

// ── Fixtures ──────────────────────────────────────────────────────────────

const ORG_A = 'org-a'
const ORG_B = 'org-b'

/** Every grant the engine understands, permissions and field permissions alike. */
const ALL_GRANTS: readonly Grant[] = [...PERMISSIONS, ...FIELD_PERMISSIONS]

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

/** An actor holding literally every grant, so a denial can only be structural. */
function omnipotentActor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'user-a',
    organizationId: ORG_A,
    membershipStatus: 'active',
    grants: new Set<Grant>(ALL_GRANTS),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
    ...overrides,
  }
}

/** A resource belonging to a different customer, richly located. */
function foreignResource(overrides: Partial<Resource> = {}): Resource {
  return {
    organizationId: ORG_B,
    propertyId: 'prop-1',
    unitId: 'unit-1',
    teamId: 'team-1',
    assignedToUserId: 'user-a',
    createdByUserId: 'user-a',
    ...overrides,
  }
}

// ── The catalogue sweep ───────────────────────────────────────────────────

describe('tenant isolation across the entire permission catalogue', () => {
  it.each(ALL_GRANTS)(
    'denies "%s" on a resource belonging to another organization',
    (grant) => {
      const decision = authorize(omnipotentActor(), grant, foreignResource())

      expect(decision.allowed).toBe(false)
      expect(decision).toMatchObject({ reason: 'cross_organization' })
    },
  )

  it('denies every grant in the catalogue to an organization_owner acting across the tenant boundary', () => {
    const owner = omnipotentActor({
      grants: grantsForRoles(['organization_owner']),
      scope: { kind: 'all_organization' },
    })

    const leaked = ALL_GRANTS.filter((grant) => {
      const decision = authorize(owner, grant, foreignResource())
      return decision.allowed || decision.reason !== 'cross_organization'
    })

    expect(leaked, 'grants an organization_owner could reach cross-tenant').toEqual([])
  })

  it('denies every grant in the catalogue to platform staff acting across the tenant boundary', () => {
    const staff = omnipotentActor({ isPlatformStaff: true })

    const leaked = ALL_GRANTS.filter((grant) => {
      const decision = authorize(staff, grant, foreignResource())
      return decision.allowed || decision.reason !== 'cross_organization'
    })

    expect(leaked, 'grants platform staff could reach cross-tenant').toEqual([])
  })

  it('denies every grant in the catalogue even when the foreign resource sits inside the actor\'s named scope', () => {
    // The scope lists the same property id the foreign resource carries. Scope
    // agreement must never be mistaken for tenancy agreement.
    const actor = omnipotentActor({
      scope: { kind: 'properties', propertyIds: ['prop-1'] },
    })

    const leaked = ALL_GRANTS.filter(
      (grant) => authorize(actor, grant, foreignResource()).allowed,
    )

    expect(leaked, 'grants reachable through a colliding property id').toEqual([])
  })
})

// ── The rule holds regardless of who is asking ────────────────────────────

describe('tenant isolation is not defeated by seniority, staff status or ownership', () => {
  it('denies an organization_owner with all_organization scope any action on another organization', () => {
    const owner = omnipotentActor({
      grants: grantsForRoles(['organization_owner']),
      scope: { kind: 'all_organization' },
    })

    const decision = authorize(owner, 'booking.view', foreignResource())

    expect(decision).toEqual({ allowed: false, reason: 'cross_organization' })
  })

  it('denies platform staff, who bypass scope but never tenancy', () => {
    const staff = omnipotentActor({ isPlatformStaff: true })

    const decision = authorize(staff, 'platform.organization.view', foreignResource())

    expect(decision).toEqual({ allowed: false, reason: 'cross_organization' })
  })

  it('allows platform staff inside their active organization despite a narrow scope, proving the scope bypass is real', () => {
    const staff = omnipotentActor({
      isPlatformStaff: true,
      scope: { kind: 'properties', propertyIds: ['prop-elsewhere'] },
    })

    const decision = authorize(staff, 'booking.view', {
      organizationId: ORG_A,
      propertyId: 'prop-1',
    })

    expect(decision).toEqual({ allowed: true })
  })

  it('denies an own_records actor a record in another organization that they themselves created', () => {
    const actor = omnipotentActor({ scope: { kind: 'own_records' } })

    const decision = authorize(actor, 'task.view', {
      organizationId: ORG_B,
      assignedToUserId: 'user-a',
      createdByUserId: 'user-a',
    })

    expect(decision).toEqual({ allowed: false, reason: 'cross_organization' })
  })

  it('reports cross_organization without naming a grant, because the refusal is not about a missing right', () => {
    const decision = authorize(omnipotentActor(), 'booking.view', foreignResource())

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.grant).toBeUndefined()
    expect(decision.entitlement).toBeUndefined()
  })
})

// ── Comparison is exact ───────────────────────────────────────────────────

describe('organization identity is compared exactly', () => {
  const nearMisses = [
    { label: 'a trailing space', id: `${ORG_A} ` },
    { label: 'different letter casing', id: ORG_A.toUpperCase() },
    { label: 'a prefix of the real id', id: 'org' },
    { label: 'the real id with a suffix', id: `${ORG_A}-2` },
    { label: 'an empty string', id: '' },
  ]

  it.each(nearMisses)(
    'denies a resource whose organization id differs only by $label',
    ({ id }) => {
      const decision = authorize(omnipotentActor(), 'booking.view', {
        organizationId: id,
      })

      expect(decision).toEqual({ allowed: false, reason: 'cross_organization' })
    },
  )

  it('allows the identical organization id, so the near-miss cases are not passing vacuously', () => {
    const decision = authorize(omnipotentActor(), 'booking.view', {
      organizationId: ORG_A,
    })

    expect(decision).toEqual({ allowed: true })
  })
})

// ── Every entry point enforces it ─────────────────────────────────────────

describe('every entry point into the engine enforces tenant isolation', () => {
  it('returns false from can() for a cross-organization resource', () => {
    expect(can(omnipotentActor(), 'booking.view', foreignResource())).toBe(false)
  })

  it('throws AuthorizationError from assertCan() for a cross-organization resource', () => {
    expect(() =>
      assertCan(omnipotentActor(), 'booking.view', foreignResource()),
    ).toThrow(AuthorizationError)
  })

  it('carries the cross_organization reason on the thrown AuthorizationError', () => {
    try {
      assertCan(omnipotentActor(), 'guest.export', foreignResource())
      expect.unreachable('assertCan must throw for a cross-organization resource')
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError)
      const authError = error as AuthorizationError
      expect(authError.decision.reason).toBe('cross_organization')
      expect(authError.grant).toBe('guest.export')
    }
  })
})

// ── Ordering ──────────────────────────────────────────────────────────────

describe('the tenant check sits above everything except membership', () => {
  it('reports membership_not_active before cross_organization for a suspended member of another organization', () => {
    const suspended = omnipotentActor({ membershipStatus: 'suspended' })

    const decision = authorize(suspended, 'booking.view', foreignResource())

    expect(decision).toEqual({ allowed: false, reason: 'membership_not_active' })
  })

  it('reports cross_organization before missing_permission when the actor also lacks the grant', () => {
    const actor = omnipotentActor({ grants: new Set<Grant>() })

    const decision = authorize(actor, 'booking.view', foreignResource())

    expect(decision).toEqual({ allowed: false, reason: 'cross_organization' })
  })

  it('reports cross_organization before plan_does_not_include when the plan also lacks the feature', () => {
    const actor = omnipotentActor({ entitlements: new Set<Entitlement>(['core']) })

    const decision = authorize(actor, 'site.publish', foreignResource())

    expect(decision).toEqual({ allowed: false, reason: 'cross_organization' })
  })

  it('reports cross_organization before out_of_scope when the resource is also outside the scope', () => {
    const actor = omnipotentActor({
      scope: { kind: 'properties', propertyIds: ['prop-mine'] },
    })

    const decision = authorize(actor, 'booking.view', {
      organizationId: ORG_B,
      propertyId: 'prop-theirs',
    })

    expect(decision).toEqual({ allowed: false, reason: 'cross_organization' })
  })
})

// ── The shape of the question ─────────────────────────────────────────────

describe('scope evaluation never stands in for the tenant check', () => {
  it('reports a foreign resource as within scope for an all_organization actor, which is exactly why authorize() must check tenancy first', () => {
    // isWithinScope() answers "where", not "whose". It is documented as such,
    // and this test pins the division of responsibility so nobody is tempted to
    // call isWithinScope() alone as an access check.
    const actor = omnipotentActor()

    expect(isWithinScope(actor, foreignResource())).toBe(true)
    expect(can(actor, 'booking.view', foreignResource())).toBe(false)
  })

  it('reports a foreign resource as within scope for platform staff, for the same reason', () => {
    const staff = omnipotentActor({
      isPlatformStaff: true,
      scope: { kind: 'own_records' },
    })

    expect(isWithinScope(staff, foreignResource())).toBe(true)
    expect(can(staff, 'booking.view', foreignResource())).toBe(false)
  })
})
