/**
 * The escalation rule, stated as sentences.
 *
 * These are the tests a reviewer reads instead of `grantable.ts`. Every one of
 * them is a claim about what a person composing a role cannot do, and the
 * headline claim is the last block: holding the right to edit role grants is
 * not holding the grants themselves.
 */

import { describe, expect, it } from 'vitest'

import { BusinessRuleError } from '../errors'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import {
  assertGrantable,
  describeGrantRefusal,
  grantsBeyondReach,
  isGrant,
  reviewGrants,
} from './grantable'
import type { Actor } from './can'
import type { Grant } from './permissions'

const ORG = 'org-a'

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

function actorWith(
  grants: readonly Grant[],
  overrides: Partial<Actor> = {},
): Actor {
  return {
    userId: 'user-1',
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
    ...overrides,
  }
}

describe('what counts as a grant', () => {
  it('accepts an action permission and a field permission alike', () => {
    expect(isGrant('booking.update')).toBe(true)
    expect(isGrant('booking.view_price')).toBe(true)
  })

  it('refuses a string that merely looks like one', () => {
    expect(isGrant('booking.update_everything')).toBe(false)
    expect(isGrant('')).toBe(false)
  })

  it('refuses an unknown code before it asks who holds what', () => {
    const actor = actorWith(['permission.edit'])
    const refusal = reviewGrants(actor, ['booking.update_everything'])

    expect(refusal).toEqual({
      kind: 'unknown_grant',
      codes: ['booking.update_everything'],
    })
  })
})

describe('platform grants', () => {
  /**
   * The database says the same thing in `tg_role_permission_grantable` (0002).
   * It is repeated here because the message a person reads should name what
   * they reached for rather than arriving as a constraint violation.
   */
  it('are refused even to somebody who somehow holds one', () => {
    const actor = actorWith([
      'permission.edit',
      'platform.impersonate' as Grant,
    ])

    expect(reviewGrants(actor, ['platform.impersonate'])).toEqual({
      kind: 'platform_grant',
      codes: ['platform.impersonate'],
    })
  })
})

describe('a role may not carry more than its author holds', () => {
  it('refuses the grant the author lacks and names it', () => {
    // The attack in one line: somebody who may edit role grants, and who does
    // not hold the right they are trying to put into the role.
    const editor = actorWith(['permission.edit', 'role.create', 'user.view'])

    const refusal = reviewGrants(editor, [
      'user.view',
      'organization.settings.edit',
    ])

    expect(refusal).toEqual({
      kind: 'beyond_author',
      codes: ['organization.settings.edit'],
    })
  })

  it('reports every grant beyond reach at once, not the first one', () => {
    const editor = actorWith(['permission.edit', 'booking.view'])

    expect(
      grantsBeyondReach(editor, [
        'booking.view',
        'payment.refund',
        'organization.close',
        'guest.export',
      ]),
    ).toEqual(['payment.refund', 'organization.close', 'guest.export'])
  })

  it('admits a role that is a subset of what the author holds', () => {
    const manager = actorWith([
      'permission.edit',
      'task.view',
      'task.assign',
      'incident.view',
    ])

    expect(reviewGrants(manager, ['task.view', 'incident.view'])).toBeNull()
  })

  it('admits an author handing on exactly what they hold', () => {
    const manager = actorWith(['permission.edit', 'task.view'])
    expect(reviewGrants(manager, ['task.view'])).toBeNull()
  })

  /**
   * A grant the organization has not bought is not held in any usable sense,
   * and a role minted with it would come alive on the day they upgrade — a
   * right nobody ever decided to hand out, appearing because of a billing
   * change. `holdsGrant` is permission AND plan, and this is why.
   */
  it('refuses a grant whose plan feature the organization has not bought', () => {
    const owner = actorWith(['permission.edit', 'agent.scope.manage'], {
      entitlements: new Set<Entitlement>(['custom_roles']),
    })

    expect(reviewGrants(owner, ['agent.scope.manage'])).toEqual({
      kind: 'beyond_author',
      codes: ['agent.scope.manage'],
    })
  })

  it('refuses an empty-handed author every grant there is', () => {
    const nobody = actorWith([])
    expect(reviewGrants(nobody, ['booking.view'])).toEqual({
      kind: 'beyond_author',
      codes: ['booking.view'],
    })
  })

  it('admits an empty list, which grants nothing', () => {
    expect(reviewGrants(actorWith([]), [])).toBeNull()
  })
})

describe('how the refusal reaches the person', () => {
  /**
   * A `BusinessRuleError` and not an `AuthorizationError`, deliberately: the
   * person DOES hold `permission.edit`. Rendering this as a permission failure
   * would send them to an administrator to ask for a right they already have.
   */
  it('is a business rule failure, not an authorization one', () => {
    const editor = actorWith(['permission.edit'])

    expect(() => assertGrantable(editor, ['payment.refund'])).toThrow(
      BusinessRuleError,
    )
  })

  it('names the grants in the Hebrew the person reads', () => {
    const editor = actorWith(['permission.edit'])

    try {
      assertGrantable(editor, ['payment.refund'])
      throw new Error('the escalation was allowed')
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessRuleError)
      expect((error as BusinessRuleError).userMessage).toContain(
        'payment.refund',
      )
      expect((error as BusinessRuleError).code).toBe('beyond_author')
    }
  })

  it('returns the list typed when nothing is refused', () => {
    const editor = actorWith(['permission.edit', 'task.view'])
    expect(assertGrantable(editor, ['task.view'])).toEqual(['task.view'])
  })

  it('has a sentence for each of the three refusals', () => {
    expect(
      describeGrantRefusal({ kind: 'unknown_grant', codes: ['nope'] }),
    ).toContain('nope')
    expect(
      describeGrantRefusal({
        kind: 'platform_grant',
        codes: ['platform.impersonate'],
      }),
    ).toContain('ESTIA')
    expect(
      describeGrantRefusal({
        kind: 'beyond_author',
        codes: ['payment.refund'],
      }),
    ).toContain('payment.refund')
  })
})
