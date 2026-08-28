/**
 * The route guard, tested on its own.
 *
 * These cases import nothing from `src/components/nav`. That is deliberate and
 * is the claim being made: route access is decided without the menu existing,
 * so hiding an item and refusing a route are two independent mechanisms that
 * happen to agree.
 */

import { describe, expect, it } from 'vitest'

import type { User } from '@supabase/supabase-js'

import type { Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { ENTITLEMENTS } from '@/lib/plans/entitlements'

import { routeAccess } from './access'
import type { ShellContext, Workspace } from './context'

const USER = { id: 'user-1', email: 'daniel@example.com' } as User

const WORKSPACE: Workspace = {
  organizationId: 'org-1',
  name: 'וילות הגליל',
  slug: 'galil',
}

function actor(grants: readonly Grant[]): Actor {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    membershipStatus: 'active',
    grants: new Set(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set(ENTITLEMENTS),
  }
}

type ReadyContext = Extract<ShellContext, { status: 'ready' }>

function ready(grants: readonly Grant[]): ReadyContext {
  return {
    status: 'ready',
    user: USER,
    workspaces: [WORKSPACE],
    workspace: WORKSPACE,
    actor: actor(grants),
    membershipId: 'membership-1',
    roles: [],
    properties: [],
    selectedPropertyId: 'all',
  }
}

describe('routeAccess', () => {
  it('sends a signed-out request to sign in', () => {
    expect(routeAccess(null, 'booking.view')).toEqual({ outcome: 'sign_in' })
  })

  it('allows a grant the actor holds', () => {
    const decision = routeAccess(ready(['booking.view']), 'booking.view')

    expect(decision.outcome).toBe('allow')
  })

  it('denies a grant the actor does not hold', () => {
    const decision = routeAccess(ready(['task.view']), 'booking.view')

    expect(decision).toEqual({
      outcome: 'denied',
      grant: 'booking.view',
      reason: 'missing_permission',
    })
  })

  it('denies by default: an actor with no grants gets nothing', () => {
    for (const grant of [
      'booking.view',
      'payment.view',
      'audit.view',
      'organization.settings.edit',
    ] as const) {
      expect(routeAccess(ready([]), grant).outcome).toBe('denied')
    }
  })

  it('separates a plan refusal from a permission refusal', () => {
    const context = ready(['task.view'])
    const withoutOperations: ReadyContext = {
      ...context,
      actor: { ...context.actor, entitlements: new Set(['core']) },
    }

    expect(routeAccess(withoutOperations, 'task.view')).toEqual({
      outcome: 'denied',
      grant: 'task.view',
      reason: 'plan_does_not_include',
    })
  })

  it('refuses a resource belonging to another organization', () => {
    const decision = routeAccess(ready(['booking.view']), 'booking.view', {
      organizationId: 'org-2',
    })

    expect(decision).toEqual({
      outcome: 'denied',
      grant: 'booking.view',
      reason: 'cross_organization',
    })
  })

  it('refuses a resource outside the actor scope', () => {
    const context = ready(['task.view'])
    const scoped: ReadyContext = {
      ...context,
      actor: {
        ...context.actor,
        scope: { kind: 'properties', propertyIds: ['property-1'] },
      },
    }

    expect(
      routeAccess(scoped, 'task.view', {
        organizationId: 'org-1',
        propertyId: 'property-2',
      }),
    ).toEqual({
      outcome: 'denied',
      grant: 'task.view',
      reason: 'out_of_scope',
    })
  })

  it('sends a person with no usable workspace to the landing state', () => {
    expect(
      routeAccess({ status: 'no_workspace', user: USER }, 'booking.view'),
    ).toEqual({ outcome: 'no_workspace', reason: 'no_workspace' })

    expect(
      routeAccess(
        {
          status: 'membership_not_active',
          user: USER,
          workspace: WORKSPACE,
          membershipStatus: 'suspended',
        },
        'booking.view',
      ),
    ).toEqual({ outcome: 'no_workspace', reason: 'membership_not_active' })

    expect(
      routeAccess(
        { status: 'no_subscription', user: USER, workspace: WORKSPACE },
        'booking.view',
      ),
    ).toEqual({ outcome: 'no_workspace', reason: 'no_subscription' })
  })

  it('allows a membership-only route without consulting any grant', () => {
    const decision = routeAccess(ready([]), null)

    expect(decision.outcome).toBe('allow')
  })

  it('still refuses a membership-only route when there is no membership', () => {
    expect(routeAccess({ status: 'no_workspace', user: USER }, null)).toEqual({
      outcome: 'no_workspace',
      reason: 'no_workspace',
    })
  })
})
