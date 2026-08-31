/**
 * Building the actor.
 *
 * Everything downstream trusts this function completely, so the tests are
 * mostly about what it refuses: a suspended member, a role code the catalogue
 * does not recognise, a membership with no scope row, an organization with no
 * subscription. Each of those is a state the database can genuinely be in, and
 * each has exactly one safe answer.
 */

import { describe, expect, it } from 'vitest'
import { authorize, can } from '../authz/can'
import type { MembershipStatus } from '../authz/can'
import { InMemoryActorSource, makeEffectivePlan } from './memory-source'
import {
  grantsForAssignments,
  resolveActor,
  resolveActorOrThrow,
  scopeFromRow,
} from './resolve'
import type {
  ActorSource,
  MembershipRow,
  RoleAssignment,
  ScopeNarrowing,
} from './source'
import { AuthorizationError, NotFoundError } from '../errors'

const ORG = 'org-a'
const OTHER_ORG = 'org-b'
const USER = 'user-1'
const MEMBERSHIP = 'mem-1'

function membership(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    id: MEMBERSHIP,
    userId: USER,
    organizationId: ORG,
    status: 'active',
    ...overrides,
  }
}

function sourceFor(
  options: {
    membership?: MembershipRow | null
    roles?: readonly RoleAssignment[]
    scope?: Parameters<typeof scopeFromRow>[0]
    plan?: ReturnType<typeof makeEffectivePlan> | null
  } = {},
): InMemoryActorSource {
  const row =
    options.membership === undefined ? membership() : options.membership

  return new InMemoryActorSource({
    memberships: row ? [row] : [],
    roles: options.roles ? { [row?.id ?? MEMBERSHIP]: options.roles } : {},
    scopes: options.scope && row ? { [row.id]: options.scope } : {},
    plans:
      options.plan === null
        ? {}
        : { [ORG]: options.plan ?? makeEffectivePlan({ organizationId: ORG }) },
  })
}

// ── Refusals ──────────────────────────────────────────────────────────────

describe('refusing to build an actor', () => {
  it('refuses when the user has no membership in the organization', async () => {
    const source = sourceFor({ membership: null })
    const resolution = await resolveActor(source, USER, ORG)

    expect(resolution.ok).toBe(false)
    expect(resolution.ok === false && resolution.reason).toBe('no_membership')
  })

  const inactive: readonly MembershipStatus[] = [
    'invited',
    'pending',
    'suspended',
    'removed',
  ]

  it.each([...inactive])('refuses a membership that is %s', async (status) => {
    const source = sourceFor({ membership: membership({ status }) })
    const resolution = await resolveActor(source, USER, ORG)

    expect(resolution.ok).toBe(false)
    if (
      resolution.ok === false &&
      resolution.reason === 'membership_not_active'
    ) {
      expect(resolution.status).toBe(status)
    } else {
      throw new Error('expected membership_not_active')
    }
  })

  it('produces no actor at all rather than an actor with no grants', async () => {
    // The distinction matters: an empty-granted actor still satisfies "is
    // someone signed in here?", and one day a call site will ask only that.
    const source = sourceFor({
      membership: membership({ status: 'suspended' }),
    })
    const resolution = await resolveActor(source, USER, ORG)

    expect(resolution.ok).toBe(false)
    expect('actor' in resolution).toBe(false)
  })

  it('reads nothing else once the membership disqualifies the user', async () => {
    const source = sourceFor({ membership: membership({ status: 'removed' }) })
    await resolveActor(source, USER, ORG)

    expect(source.calls.loadMembership).toBe(1)
    expect(source.calls.loadRoles).toBe(0)
    expect(source.calls.loadScope).toBe(0)
    expect(source.calls.loadPlan).toBe(0)
  })

  it('refuses an organization with no subscription rather than guessing', async () => {
    const source = sourceFor({ plan: null })
    const resolution = await resolveActor(source, USER, ORG)

    expect(resolution.ok).toBe(false)
    expect(resolution.ok === false && resolution.reason).toBe('no_subscription')
  })

  it('refuses a membership row that names a different organization', async () => {
    // A source that answers the wrong question: asked about ORG, it returns a
    // row belonging to OTHER_ORG. A real one should never do this, which is
    // exactly why the guard exists — the day a join is written wrongly, the
    // failure must not be a cross-tenant actor.
    const lyingSource: ActorSource = {
      async loadMembership() {
        return membership({ organizationId: OTHER_ORG })
      },
      async loadRoles() {
        return [{ code: 'organization_owner', kind: 'system' }]
      },
      async loadScope() {
        return { kind: 'all_organization' }
      },
      async loadPlan() {
        return makeEffectivePlan({ organizationId: ORG })
      },
    }

    const resolution = await resolveActor(lyingSource, USER, ORG)
    expect(resolution.ok).toBe(false)
    expect(resolution.ok === false && resolution.reason).toBe('no_membership')
  })
})

// ── Roles → grants ────────────────────────────────────────────────────────

describe('flattening roles to grants', () => {
  it('resolves a system role through the catalogue in code', async () => {
    const source = sourceFor({
      roles: [{ code: 'reception', kind: 'system' }],
      scope: { kind: 'all_organization' },
    })
    const resolution = await resolveActor(source, USER, ORG)
    if (!resolution.ok) throw new Error('expected an actor')

    expect(resolution.actor.grants.has('booking.update')).toBe(true)
    // Reception is deliberately denied profitability and export.
    expect(resolution.actor.grants.has('booking.view_profitability')).toBe(
      false,
    )
    expect(resolution.actor.grants.has('booking.export')).toBe(false)
  })

  it('unions the grants of several roles', async () => {
    const grants = grantsForAssignments([
      { code: 'cleaner', kind: 'system' },
      { code: 'accountant', kind: 'system' },
    ])
    expect(grants.has('task.complete')).toBe(true)
    expect(grants.has('report.financial.export')).toBe(true)
  })

  it('gives an unrecognised system role code nothing at all', () => {
    // The database and the catalogue disagree. The safe reading of a
    // disagreement about permissions is the smaller one.
    const grants = grantsForAssignments([
      { code: 'super_manager_v2', kind: 'system' },
    ])
    expect(grants.size).toBe(0)
  })

  it('ignores grants attached to a system role, using the catalogue instead', () => {
    // A row in the database must not be able to widen a system role.
    const grants = grantsForAssignments([
      { code: 'cleaner', kind: 'system', grants: ['payment.refund'] },
    ])
    expect(grants.has('task.complete')).toBe(true)
    expect(grants.has('payment.refund')).toBe(false)
  })

  it('takes a custom role at its word, because only the customer composed it', () => {
    const grants = grantsForAssignments([
      {
        code: 'night_auditor',
        kind: 'custom',
        grants: ['booking.view', 'payment.view'],
      },
    ])
    expect(grants.has('booking.view')).toBe(true)
    expect(grants.has('payment.view')).toBe(true)
    expect(grants.size).toBe(2)
  })

  it('holds no grants for a membership with no roles', async () => {
    const source = sourceFor({ roles: [] })
    const resolution = await resolveActor(source, USER, ORG)
    if (!resolution.ok) throw new Error('expected an actor')

    expect(resolution.actor.grants.size).toBe(0)
    expect(can(resolution.actor, 'booking.view')).toBe(false)
  })

  it('marks platform staff, and only from a platform role', async () => {
    const staff = await resolveActor(
      sourceFor({
        roles: [
          {
            code: 'platform_support',
            kind: 'platform',
            grants: ['platform.organization.view'],
          },
        ],
      }),
      USER,
      ORG,
    )
    const employee = await resolveActor(
      sourceFor({ roles: [{ code: 'general_manager', kind: 'system' }] }),
      USER,
      ORG,
    )

    if (!staff.ok || !employee.ok) throw new Error('expected actors')
    expect(staff.actor.isPlatformStaff).toBe(true)
    expect(employee.actor.isPlatformStaff).toBeUndefined()
  })
})

// ── Scope ─────────────────────────────────────────────────────────────────

describe('scope', () => {
  it('carries each scope variant through unchanged', () => {
    expect(scopeFromRow({ kind: 'all_organization' })).toEqual({
      kind: 'all_organization',
    })
    expect(
      scopeFromRow({ kind: 'properties', propertyIds: ['p-1', 'p-2'] }),
    ).toEqual({
      kind: 'properties',
      propertyIds: ['p-1', 'p-2'],
    })
    expect(scopeFromRow({ kind: 'units', unitIds: ['u-1'] })).toEqual({
      kind: 'units',
      unitIds: ['u-1'],
    })
    expect(scopeFromRow({ kind: 'team', teamIds: ['t-1'] })).toEqual({
      kind: 'team',
      teamIds: ['t-1'],
    })
    expect(scopeFromRow({ kind: 'own_records' })).toEqual({
      kind: 'own_records',
    })
  })

  it('falls back to own_records when no scope row exists', async () => {
    // Not `all_organization`, which would hand the whole business to someone
    // whose scope was never written; and not a refusal, which would lock a
    // real employee out over a missing row.
    const source = sourceFor({
      roles: [{ code: 'general_manager', kind: 'system' }],
      scope: undefined,
    })
    const resolution = await resolveActor(source, USER, ORG)
    if (!resolution.ok) throw new Error('expected an actor')

    expect(resolution.actor.scope).toEqual({ kind: 'own_records' })
    expect(
      can(resolution.actor, 'booking.update', {
        organizationId: ORG,
        propertyId: 'p-1',
      }),
    ).toBe(false)
    expect(
      can(resolution.actor, 'booking.update', {
        organizationId: ORG,
        assignedToUserId: USER,
      }),
    ).toBe(true)
  })

  it('reaches nothing when a property scope names no properties', async () => {
    const source = sourceFor({
      roles: [{ code: 'property_manager', kind: 'system' }],
      scope: { kind: 'properties', propertyIds: [] },
    })
    const resolution = await resolveActor(source, USER, ORG)
    if (!resolution.ok) throw new Error('expected an actor')

    expect(
      can(resolution.actor, 'booking.update', {
        organizationId: ORG,
        propertyId: 'p-1',
      }),
    ).toBe(false)
  })
})

// ── Plan ──────────────────────────────────────────────────────────────────

describe('plan and quotas', () => {
  it('computes entitlements through the plan engine, overrides included', async () => {
    const source = sourceFor({
      roles: [{ code: 'general_manager', kind: 'system' }],
      scope: { kind: 'all_organization' },
      plan: makeEffectivePlan({
        organizationId: ORG,
        entitlements: ['core', 'operations'],
        entitlementGrants: ['website'],
        entitlementRevocations: ['operations'],
      }),
    })
    const resolution = await resolveActor(source, USER, ORG)
    if (!resolution.ok) throw new Error('expected an actor')

    expect(resolution.actor.entitlements.has('website')).toBe(true)
    // A revocation beats a grant, and beats the plan.
    expect(resolution.actor.entitlements.has('operations')).toBe(false)
    expect(resolution.actor.entitlements.has('core')).toBe(true)
  })

  it('refuses a gated action for a plan that does not include it', async () => {
    const source = sourceFor({
      roles: [{ code: 'general_manager', kind: 'system' }],
      scope: { kind: 'all_organization' },
      plan: makeEffectivePlan({ organizationId: ORG, entitlements: ['core'] }),
    })
    const resolution = await resolveActor(source, USER, ORG)
    if (!resolution.ok) throw new Error('expected an actor')

    const decision = authorize(resolution.actor, 'task.create', {
      organizationId: ORG,
    })
    expect(decision).toEqual({
      allowed: false,
      reason: 'plan_does_not_include',
      grant: 'task.create',
      entitlement: 'operations',
    })
  })

  it('returns the effective limits, with per-customer overrides applied', async () => {
    const source = sourceFor({
      plan: makeEffectivePlan({
        organizationId: ORG,
        limits: { units: 15, members: 10 },
        limitOverrides: { units: 25 },
      }),
    })
    const resolution = await resolveActor(source, USER, ORG)
    if (!resolution.ok) throw new Error('expected an actor')

    expect(resolution.limits.units).toBe(25)
    expect(resolution.limits.members).toBe(10)
  })

  it('keeps a cancelled subscription on the core product only', async () => {
    const source = sourceFor({
      roles: [{ code: 'organization_owner', kind: 'system' }],
      scope: { kind: 'all_organization' },
      plan: makeEffectivePlan({ organizationId: ORG, status: 'cancelled' }),
    })
    const resolution = await resolveActor(source, USER, ORG)
    if (!resolution.ok) throw new Error('expected an actor')

    expect([...resolution.actor.entitlements]).toEqual(['core'])
    // The business can still see its own bookings; it cannot use paid modules.
    expect(can(resolution.actor, 'booking.view', { organizationId: ORG })).toBe(
      true,
    )
    expect(can(resolution.actor, 'task.create', { organizationId: ORG })).toBe(
      false,
    )
  })
})

// ── The enforcing form ────────────────────────────────────────────────────

describe('resolveActorOrThrow', () => {
  it('returns the resolution when everything holds', async () => {
    const resolved = await resolveActorOrThrow(
      sourceFor({ roles: [{ code: 'reception', kind: 'system' }] }),
      USER,
      ORG,
    )
    expect(resolved.actor.userId).toBe(USER)
    expect(resolved.membershipId).toBe(MEMBERSHIP)
  })

  it('hides the existence of an organization the user is not a member of', async () => {
    // "You are not a member of Villa Sunrise" confirms that Villa Sunrise is a
    // customer of ours. To a non-member, the workspace does not exist.
    await expect(
      resolveActorOrThrow(sourceFor({ membership: null }), USER, ORG),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('tells a suspended member that they are suspended', async () => {
    await expect(
      resolveActorOrThrow(
        sourceFor({ membership: membership({ status: 'suspended' }) }),
        USER,
        ORG,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})

// ── Per-family narrowing ──────────────────────────────────────────────────

/**
 * The membership scope row is the authority; a narrowing is a request.
 *
 * These are the regression tests for the defect where an agent's configured
 * inventory reach never reached them. The fix was not to project the stored
 * reach onto `Actor.scopeOverrides` — `scopeFor` replaces rather than
 * intersects, so that would have taken every agent from a membership scope
 * granting nothing to whatever a settings screen named. The fix was to give
 * the membership a real scope row and clamp the request against it, and what
 * follows is that clamp, exercised through `resolveActor` rather than against
 * `clampScope` directly.
 */
describe('a source that asks for per-family reach', () => {
  /** A source with a scope row and a narrowing, resolved the way a request does. */
  function agentSource(
    granted: Parameters<typeof scopeFromRow>[0],
    families: ScopeNarrowing['families'],
    scope: ScopeNarrowing['scope'] = { kind: 'own_records' },
  ): ActorSource {
    const inner = sourceFor({
      roles: [{ code: 'sales_agent', kind: 'system' }],
      scope: granted ?? undefined,
    })
    return {
      loadMembership: (u, o) => inner.loadMembership(u, o),
      loadRoles: (m) => inner.loadRoles(m),
      loadScope: (m) => inner.loadScope(m),
      loadPlan: (o) => inner.loadPlan(o),
      async loadScopeNarrowing() {
        return { scope, families }
      },
    }
  }

  const unitIn = {
    organizationId: ORG,
    propertyId: 'prop-1',
    unitId: 'unit-1',
    family: 'inventory' as const,
  }
  const unitOut = { ...unitIn, propertyId: 'prop-9', unitId: 'unit-9' }

  it('grants the inventory reach the membership scope row holds', async () => {
    // The defect, closed. Before the row existed this was `false`, because a
    // property carries no assignee and `own_records` therefore reaches none.
    const resolution = await resolveActor(
      agentSource(
        { kind: 'properties', propertyIds: ['prop-1'] },
        {
          inventory: { kind: 'properties', propertyIds: ['prop-1'] },
        },
      ),
      USER,
      ORG,
    )
    if (!resolution.ok) throw new Error(resolution.reason)

    expect(can(resolution.actor, 'availability.view', unitIn)).toBe(true)
    expect(can(resolution.actor, 'availability.view', unitOut)).toBe(false)
  })

  it('refuses a request wider than the grant, and would fail if it widened', async () => {
    // The settings screen asking for the whole portfolio on a membership
    // granted one property. If the clamp were removed this assertion flips:
    // `all_organization` reaches every unit in the organization.
    const resolution = await resolveActor(
      agentSource(
        { kind: 'properties', propertyIds: ['prop-1'] },
        {
          inventory: { kind: 'all_organization' },
        },
      ),
      USER,
      ORG,
    )
    if (!resolution.ok) throw new Error(resolution.reason)

    expect(resolution.actor.scopeOverrides?.inventory).toEqual({
      kind: 'properties',
      propertyIds: ['prop-1'],
    })
    expect(can(resolution.actor, 'availability.view', unitOut)).toBe(false)
  })

  it('honours a narrowing the terms make inside a wider grant', async () => {
    // An owner narrowing an agent on the settings screen, taking effect on the
    // request already in flight behind the click.
    const resolution = await resolveActor(
      agentSource(
        { kind: 'all_organization' },
        {
          inventory: { kind: 'properties', propertyIds: ['prop-1'] },
        },
      ),
      USER,
      ORG,
    )
    if (!resolution.ok) throw new Error(resolution.reason)

    expect(can(resolution.actor, 'availability.view', unitIn)).toBe(true)
    expect(can(resolution.actor, 'availability.view', unitOut)).toBe(false)
  })

  it('gives a membership with no scope row no inventory reach at all', async () => {
    // Every agent written before `attachExistingUser` wrote the row. They keep
    // the answer they had, which is the direction that makes this fix safe to
    // ship against live data.
    const resolution = await resolveActor(
      agentSource(null, {
        inventory: { kind: 'properties', propertyIds: ['prop-1'] },
      }),
      USER,
      ORG,
    )
    if (!resolution.ok) throw new Error(resolution.reason)

    expect(resolution.actor.scope).toEqual({ kind: 'own_records' })
    expect(can(resolution.actor, 'availability.view', unitIn)).toBe(false)
  })

  it('leaves every family the narrowing does not name on the default', async () => {
    // `own_records` for bookings, leads and commissions — which is what the
    // agent had before any of this, and is why the change is a widening of
    // inventory alone. A colleague's booking inside the granted property must
    // stay invisible.
    const resolution = await resolveActor(
      agentSource(
        { kind: 'properties', propertyIds: ['prop-1'] },
        {
          inventory: { kind: 'properties', propertyIds: ['prop-1'] },
        },
      ),
      USER,
      ORG,
    )
    if (!resolution.ok) throw new Error(resolution.reason)

    const rivalsBooking = {
      organizationId: ORG,
      propertyId: 'prop-1',
      createdByUserId: 'user-2',
      family: 'booking' as const,
    }
    expect(can(resolution.actor, 'booking.view', rivalsBooking)).toBe(false)
    expect(
      can(resolution.actor, 'booking.view', {
        ...rivalsBooking,
        createdByUserId: USER,
      }),
    ).toBe(true)
  })

  it('cannot widen the default scope either', async () => {
    // A source asking for `all_organization` as its default gets the grant
    // back. The narrowing channel is a narrowing channel in both halves.
    const resolution = await resolveActor(
      agentSource(
        { kind: 'properties', propertyIds: ['prop-1'] },
        {},
        { kind: 'all_organization' },
      ),
      USER,
      ORG,
    )
    if (!resolution.ok) throw new Error(resolution.reason)

    expect(resolution.actor.scope).toEqual({
      kind: 'properties',
      propertyIds: ['prop-1'],
    })
  })

  it('resolves a source without the method exactly as it always did', async () => {
    // The port method is optional so that no existing implementation had to
    // change. A membership with no narrowing keeps one scope and no overrides.
    const resolution = await resolveActor(
      sourceFor({
        roles: [{ code: 'reception', kind: 'system' }],
        scope: { kind: 'all_organization' },
      }),
      USER,
      ORG,
    )
    if (!resolution.ok) throw new Error(resolution.reason)

    expect(resolution.actor.scope).toEqual({ kind: 'all_organization' })
    expect(resolution.actor.scopeOverrides).toBeUndefined()
  })
})
