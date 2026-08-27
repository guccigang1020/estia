/**
 * The authorization engine.
 *
 * These tests prove the shape of a refusal as much as the refusal itself. The
 * product owner cannot read `can.ts`; what they can read is a list of sentences
 * saying who is stopped, and why the system says they were stopped.
 */

import { describe, expect, it } from 'vitest'
import {
  AuthorizationError,
  assertCan,
  authorize,
  can,
  isWithinScope,
  redact,
  type Actor,
  type MembershipStatus,
  type Resource,
} from './can'
import type { Grant } from './permissions'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'

// ── Helpers ───────────────────────────────────────────────────────────────

const ORG = 'org-a'
const USER = 'user-1'

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

/**
 * Build an actor. Defaults are the permissive case — active, organization-wide,
 * fully entitled — so each test only states the one thing it is about.
 */
function makeActor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: USER,
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
    ...overrides,
  }
}

/** An actor holding exactly the listed grants. */
function actorWith(
  grants: readonly Grant[],
  overrides: Partial<Actor> = {},
): Actor {
  return makeActor({ grants: new Set<Grant>(grants), ...overrides })
}

function resource(overrides: Partial<Resource> = {}): Resource {
  return { organizationId: ORG, ...overrides }
}

// ── Membership status ─────────────────────────────────────────────────────

describe('membership status', () => {
  const inactiveStatuses: readonly MembershipStatus[] = [
    'invited',
    'pending',
    'suspended',
    'removed',
  ]

  it.each(inactiveStatuses)(
    'denies a member whose membership is "%s", however complete their permissions are',
    (membershipStatus) => {
      const actor = actorWith(['booking.view'], { membershipStatus })

      const decision = authorize(actor, 'booking.view', resource())

      expect(decision).toEqual({
        allowed: false,
        reason: 'membership_not_active',
      })
    },
  )

  it.each(inactiveStatuses)(
    'denies a member whose membership is "%s" even when no resource is named',
    (membershipStatus) => {
      const actor = actorWith(['booking.view'], { membershipStatus })

      expect(can(actor, 'booking.view')).toBe(false)
    },
  )

  it('allows an active member holding the grant, so the inactive cases are not passing vacuously', () => {
    const actor = actorWith(['booking.view'], { membershipStatus: 'active' })

    expect(authorize(actor, 'booking.view', resource())).toEqual({
      allowed: true,
    })
  })

  it('reports membership_not_active without naming a grant, because the person is not an actor at all', () => {
    const decision = authorize(
      actorWith(['booking.view'], { membershipStatus: 'removed' }),
      'booking.view',
      resource(),
    )

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.grant).toBeUndefined()
  })
})

// ── Permissions ───────────────────────────────────────────────────────────

describe('holding the permission', () => {
  it('denies an actor who does not hold the grant, and names the grant that was missing', () => {
    const decision = authorize(
      actorWith(['booking.view']),
      'booking.cancel',
      resource(),
    )

    expect(decision).toEqual({
      allowed: false,
      reason: 'missing_permission',
      grant: 'booking.cancel',
    })
  })

  it('allows an actor who holds the grant', () => {
    expect(
      can(actorWith(['booking.cancel']), 'booking.cancel', resource()),
    ).toBe(true)
  })

  it('denies a grant that merely shares a prefix with one the actor holds', () => {
    // `booking.view` must not imply `booking.view_price`. Grants are compared
    // whole, never by prefix.
    const decision = authorize(
      actorWith(['booking.view']),
      'booking.view_price',
      resource(),
    )

    expect(decision).toMatchObject({ reason: 'missing_permission' })
  })

  it('denies an actor holding no grants at all', () => {
    expect(can(makeActor(), 'booking.view', resource())).toBe(false)
  })
})

// ── Scope ─────────────────────────────────────────────────────────────────

describe('scope: properties', () => {
  const actor = actorWith(['booking.view'], {
    scope: { kind: 'properties', propertyIds: ['prop-1', 'prop-2'] },
  })

  it('allows a resource belonging to a listed property', () => {
    expect(
      authorize(actor, 'booking.view', resource({ propertyId: 'prop-2' })),
    ).toEqual({
      allowed: true,
    })
  })

  it('denies a resource belonging to an unlisted property, out of scope', () => {
    const decision = authorize(
      actor,
      'booking.view',
      resource({ propertyId: 'prop-9' }),
    )

    expect(decision).toEqual({
      allowed: false,
      reason: 'out_of_scope',
      grant: 'booking.view',
    })
  })

  it('denies a resource that carries no propertyId, because an unlocated record is organization-wide', () => {
    const decision = authorize(actor, 'booking.view', resource())

    expect(decision).toMatchObject({ reason: 'out_of_scope' })
  })

  it('denies a resource located only by unit, ignoring the unit as a substitute for the property', () => {
    const decision = authorize(
      actor,
      'booking.view',
      resource({ unitId: 'unit-1' }),
    )

    expect(decision).toMatchObject({ reason: 'out_of_scope' })
  })

  it('denies every resource for an actor scoped to an empty property list', () => {
    const empty = actorWith(['booking.view'], {
      scope: { kind: 'properties', propertyIds: [] },
    })

    expect(can(empty, 'booking.view', resource({ propertyId: 'prop-1' }))).toBe(
      false,
    )
  })
})

describe('scope: units', () => {
  const actor = actorWith(['task.view'], {
    scope: { kind: 'units', unitIds: ['unit-1', 'unit-2'] },
  })

  it('allows a resource belonging to a listed unit', () => {
    expect(can(actor, 'task.view', resource({ unitId: 'unit-1' }))).toBe(true)
  })

  it('denies a resource belonging to an unlisted unit, out of scope', () => {
    expect(
      authorize(actor, 'task.view', resource({ unitId: 'unit-9' })),
    ).toMatchObject({
      reason: 'out_of_scope',
    })
  })

  it('denies a resource that carries no unitId', () => {
    expect(authorize(actor, 'task.view', resource())).toMatchObject({
      reason: 'out_of_scope',
    })
  })

  it('denies a resource located only by property, ignoring the property as a substitute for the unit', () => {
    expect(
      authorize(actor, 'task.view', resource({ propertyId: 'prop-1' })),
    ).toMatchObject({ reason: 'out_of_scope' })
  })
})

describe('scope: team', () => {
  const actor = actorWith(['task.view'], {
    scope: { kind: 'team', teamIds: ['team-1'] },
  })

  it('allows a resource belonging to a listed team', () => {
    expect(can(actor, 'task.view', resource({ teamId: 'team-1' }))).toBe(true)
  })

  it('denies a resource belonging to another team', () => {
    expect(can(actor, 'task.view', resource({ teamId: 'team-2' }))).toBe(false)
  })

  it('denies a resource that carries no teamId', () => {
    expect(can(actor, 'task.view', resource())).toBe(false)
  })
})

describe('scope: own_records', () => {
  const actor = actorWith(['task.view'], { scope: { kind: 'own_records' } })

  it('allows a record assigned to the actor', () => {
    expect(can(actor, 'task.view', resource({ assignedToUserId: USER }))).toBe(
      true,
    )
  })

  it('allows a record created by the actor', () => {
    expect(can(actor, 'task.view', resource({ createdByUserId: USER }))).toBe(
      true,
    )
  })

  it('denies a record assigned to and created by somebody else', () => {
    const decision = authorize(
      actor,
      'task.view',
      resource({ assignedToUserId: 'user-2', createdByUserId: 'user-2' }),
    )

    expect(decision).toMatchObject({ reason: 'out_of_scope' })
  })

  it('denies a record that names no assignee and no creator', () => {
    expect(authorize(actor, 'task.view', resource())).toMatchObject({
      reason: 'out_of_scope',
    })
  })

  it("denies a record located in the actor's property but owned by another person", () => {
    expect(
      can(
        actor,
        'task.view',
        resource({ propertyId: 'prop-1', assignedToUserId: 'user-2' }),
      ),
    ).toBe(false)
  })
})

describe('scope: all_organization', () => {
  const actor = actorWith(['booking.view'], {
    scope: { kind: 'all_organization' },
  })

  const anywhere: ReadonlyArray<{ label: string; res: Resource }> = [
    {
      label: 'a resource with no location at all',
      res: { organizationId: ORG },
    },
    {
      label: 'a resource in an arbitrary property',
      res: { organizationId: ORG, propertyId: 'prop-anything' },
    },
    {
      label: 'a resource in an arbitrary unit',
      res: { organizationId: ORG, unitId: 'unit-anything' },
    },
    {
      label: 'a resource belonging to another person',
      res: { organizationId: ORG, assignedToUserId: 'user-2' },
    },
  ]

  it.each(anywhere)('allows $label inside the organization', ({ res }) => {
    expect(authorize(actor, 'booking.view', res)).toEqual({ allowed: true })
  })
})

describe('a resource with no location is reachable only by an organization-wide scope', () => {
  const unlocated: Resource = { organizationId: ORG }

  const narrowScopes: ReadonlyArray<{ label: string; actor: Actor }> = [
    {
      label: 'properties',
      actor: actorWith(['booking.view'], {
        scope: { kind: 'properties', propertyIds: ['prop-1'] },
      }),
    },
    {
      label: 'units',
      actor: actorWith(['booking.view'], {
        scope: { kind: 'units', unitIds: ['unit-1'] },
      }),
    },
    {
      label: 'team',
      actor: actorWith(['booking.view'], {
        scope: { kind: 'team', teamIds: ['team-1'] },
      }),
    },
    {
      label: 'own_records',
      actor: actorWith(['booking.view'], { scope: { kind: 'own_records' } }),
    },
  ]

  it.each(narrowScopes)(
    'denies an unlocated resource to an actor scoped to $label',
    ({ actor }) => {
      expect(isWithinScope(actor, unlocated)).toBe(false)
      expect(authorize(actor, 'booking.view', unlocated)).toMatchObject({
        reason: 'out_of_scope',
      })
    },
  )

  it('allows an unlocated resource to an actor scoped to the whole organization', () => {
    const wide = actorWith(['booking.view'], {
      scope: { kind: 'all_organization' },
    })

    expect(isWithinScope(wide, unlocated)).toBe(true)
  })
})

describe('scope is not consulted when no resource is named', () => {
  it('allows a narrowly scoped actor to be asked about a capability in the abstract', () => {
    // `can(actor, grant)` answers "may this person ever do this?", which is what
    // a navigation menu needs. The record-level question always passes a resource.
    const cleaner = actorWith(['task.view'], { scope: { kind: 'own_records' } })

    expect(can(cleaner, 'task.view')).toBe(true)
    expect(can(cleaner, 'task.view', resource())).toBe(false)
  })
})

// ── Plan entitlements ─────────────────────────────────────────────────────

describe('plan entitlements', () => {
  /** Holds the rights, but the organization bought only the core package. */
  const coreOnly = actorWith(['site.publish', 'booking.view', 'task.view'], {
    entitlements: new Set<Entitlement>(['core']),
  })

  it('denies site.publish to an actor whose plan does not include the website module', () => {
    const decision = authorize(coreOnly, 'site.publish', resource())

    expect(decision).toEqual({
      allowed: false,
      reason: 'plan_does_not_include',
      grant: 'site.publish',
      entitlement: 'website',
    })
  })

  it('populates the entitlement field so the interface can offer an upgrade instead of a refusal', () => {
    const decision = authorize(coreOnly, 'site.publish', resource())

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.entitlement).toBe('website')
  })

  it('allows the same actor a core action such as booking.view', () => {
    expect(authorize(coreOnly, 'booking.view', resource())).toEqual({
      allowed: true,
    })
  })

  it('denies task.view to an actor whose plan does not include the operations module', () => {
    expect(authorize(coreOnly, 'task.view', resource())).toMatchObject({
      reason: 'plan_does_not_include',
      entitlement: 'operations',
    })
  })

  it('allows a gated grant once the plan includes its entitlement', () => {
    const withWebsite = actorWith(['site.publish'], {
      entitlements: new Set<Entitlement>(['core', 'website']),
    })

    expect(authorize(withWebsite, 'site.publish', resource())).toEqual({
      allowed: true,
    })
  })

  it('gates a field permission by the plan as well, denying owner.view_commission without the owner portal', () => {
    const actor = actorWith(['owner.view_commission'], {
      entitlements: new Set<Entitlement>(['core']),
    })

    expect(authorize(actor, 'owner.view_commission', resource())).toMatchObject(
      {
        reason: 'plan_does_not_include',
        entitlement: 'owner_portal',
      },
    )
  })

  it('denies a plan-gated action to platform staff too, since staff bypass scope only', () => {
    const staff = actorWith(['site.publish'], {
      entitlements: new Set<Entitlement>(['core']),
      isPlatformStaff: true,
    })

    expect(authorize(staff, 'site.publish', resource())).toMatchObject({
      reason: 'plan_does_not_include',
    })
  })
})

// ── Reason precedence ─────────────────────────────────────────────────────

describe('reason precedence when several checks fail at once', () => {
  it('reports membership_not_active ahead of every other failure', () => {
    const actor = makeActor({
      membershipStatus: 'suspended',
      grants: new Set<Grant>(),
      entitlements: new Set<Entitlement>(['core']),
      scope: { kind: 'properties', propertyIds: ['prop-1'] },
    })

    expect(
      authorize(actor, 'site.publish', { organizationId: 'org-b' }),
    ).toEqual({
      allowed: false,
      reason: 'membership_not_active',
    })
  })

  it('reports missing_permission ahead of plan_does_not_include', () => {
    // The actor lacks the grant AND the plan. The permission failure is the
    // honest one: offering an upgrade to somebody who still would not be
    // allowed is a lie the interface must not tell.
    const actor = makeActor({ entitlements: new Set<Entitlement>(['core']) })

    expect(authorize(actor, 'site.publish', resource())).toEqual({
      allowed: false,
      reason: 'missing_permission',
      grant: 'site.publish',
    })
  })

  it('reports missing_permission ahead of out_of_scope', () => {
    const actor = makeActor({
      scope: { kind: 'properties', propertyIds: ['prop-1'] },
    })

    expect(
      authorize(actor, 'booking.view', resource({ propertyId: 'prop-9' })),
    ).toEqual({
      allowed: false,
      reason: 'missing_permission',
      grant: 'booking.view',
    })
  })

  it('reports plan_does_not_include ahead of out_of_scope', () => {
    const actor = actorWith(['task.view'], {
      entitlements: new Set<Entitlement>(['core']),
      scope: { kind: 'properties', propertyIds: ['prop-1'] },
    })

    expect(
      authorize(actor, 'task.view', resource({ propertyId: 'prop-9' })),
    ).toEqual({
      allowed: false,
      reason: 'plan_does_not_include',
      grant: 'task.view',
      entitlement: 'operations',
    })
  })

  it('reports out_of_scope only when membership, tenancy, permission and plan all pass', () => {
    const actor = actorWith(['task.view'], {
      scope: { kind: 'properties', propertyIds: ['prop-1'] },
    })

    expect(
      authorize(actor, 'task.view', resource({ propertyId: 'prop-9' })),
    ).toEqual({
      allowed: false,
      reason: 'out_of_scope',
      grant: 'task.view',
    })
  })
})

// ── can / assertCan ───────────────────────────────────────────────────────

describe('can()', () => {
  it('returns true only when authorize() allows', () => {
    const actor = actorWith(['booking.view'])

    expect(can(actor, 'booking.view', resource())).toBe(true)
    expect(can(actor, 'booking.cancel', resource())).toBe(false)
  })
})

describe('assertCan()', () => {
  it('returns without throwing when the action is allowed', () => {
    expect(() =>
      assertCan(actorWith(['booking.view']), 'booking.view', resource()),
    ).not.toThrow()
  })

  it('throws AuthorizationError when the action is refused', () => {
    expect(() => assertCan(makeActor(), 'booking.view', resource())).toThrow(
      AuthorizationError,
    )
  })

  it('names the grant in the error message so a log line is readable', () => {
    expect(() => assertCan(makeActor(), 'payment.refund', resource())).toThrow(
      'Not authorized: payment.refund',
    )
  })

  it('carries the full decision on the error so a caller can explain the refusal', () => {
    try {
      assertCan(
        actorWith(['site.publish'], {
          entitlements: new Set<Entitlement>(['core']),
        }),
        'site.publish',
        resource(),
      )
      expect.unreachable(
        'assertCan must throw when the plan does not include the feature',
      )
    } catch (error) {
      const authError = error as AuthorizationError
      expect(authError.name).toBe('AuthorizationError')
      expect(authError.grant).toBe('site.publish')
      expect(authError.decision.reason).toBe('plan_does_not_include')
      expect(authError.decision.entitlement).toBe('website')
    }
  })
})

// ── redact() ──────────────────────────────────────────────────────────────

describe('redact()', () => {
  interface BookingRow {
    id: string
    unitName: string
    guestPhone?: string
    price?: number
    profitability?: number
  }

  const row: BookingRow = {
    id: 'bk-1',
    unitName: 'Suite 2',
    guestPhone: '050-0000000',
    price: 145000,
    profitability: 0.42,
  }

  const sensitive = [
    { key: 'guestPhone', requires: 'guest.view_contact' },
    { key: 'price', requires: 'booking.view_price' },
    { key: 'profitability', requires: 'booking.view_profitability' },
  ] as const

  it('removes every field whose required grant the actor does not hold', () => {
    const cleaner = actorWith(['task.view'])

    const result = redact(cleaner, row, sensitive)

    expect('guestPhone' in result).toBe(false)
    expect('price' in result).toBe(false)
    expect('profitability' in result).toBe(false)
  })

  it('keeps fields whose required grant the actor holds', () => {
    const reception = actorWith(['guest.view_contact', 'booking.view_price'])

    const result = redact(reception, row, sensitive)

    expect(result.guestPhone).toBe('050-0000000')
    expect(result.price).toBe(145000)
    expect('profitability' in result).toBe(false)
  })

  it('keeps every field for an actor holding all of the required grants', () => {
    const manager = actorWith([
      'guest.view_contact',
      'booking.view_price',
      'booking.view_profitability',
    ])

    expect(redact(manager, row, sensitive)).toEqual(row)
  })

  it('never touches fields that were not declared sensitive', () => {
    const result = redact(actorWith([]), row, sensitive)

    expect(result.id).toBe('bk-1')
    expect(result.unitName).toBe('Suite 2')
  })

  it('does not mutate the record it was given', () => {
    const original: BookingRow = { ...row }

    redact(actorWith([]), original, sensitive)

    expect(original).toEqual(row)
    expect(original.guestPhone).toBe('050-0000000')
  })

  it('returns a new object rather than the record itself', () => {
    const result = redact(actorWith(['guest.view_contact']), row, [])

    expect(result).not.toBe(row)
    expect(result).toEqual(row)
  })

  it('redacts a field that is already absent without introducing it', () => {
    const partial: BookingRow = { id: 'bk-2', unitName: 'Suite 3' }

    const result = redact(actorWith([]), partial, sensitive)

    expect(result).toEqual({ id: 'bk-2', unitName: 'Suite 3' })
  })

  /**
   * Regression. `redact()` once read `actor.grants` directly while
   * `authorize()` also consulted the plan, so an organization without the
   * owner-portal feature was refused the commission action and handed the
   * commission figure anyway. Both now ask `holdsGrant`, so the field and the
   * action behind it can never disagree.
   */
  it('withholds a field whose feature the organization has not bought, matching authorize()', () => {
    const actor = actorWith(['owner.view_commission'], {
      entitlements: new Set<Entitlement>(['core']),
    })

    const ownerRow = { id: 'o-1', commission: 1500 }
    const result = redact(actor, ownerRow, [
      { key: 'commission', requires: 'owner.view_commission' },
    ])

    expect(can(actor, 'owner.view_commission', resource())).toBe(false)
    expect(result).not.toHaveProperty('commission')
  })

  it('returns the field once the plan includes the feature', () => {
    const actor = actorWith(['owner.view_commission'], {
      entitlements: new Set<Entitlement>(['core', 'owner_portal']),
    })

    const result = redact(actor, { id: 'o-1', commission: 1500 }, [
      { key: 'commission', requires: 'owner.view_commission' },
    ])

    expect(result.commission).toBe(1500)
  })
})
