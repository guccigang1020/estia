/**
 * The narrowings, as pure functions.
 *
 * This is the half of the privacy rule that can be tested without a request, a
 * cookie jar or a dataset, and it is the half where a mistake is silent: a
 * scope that produces `{ kind: 'none' }` when it should produce nothing does
 * not throw, does not log, and returns every row in the organization.
 *
 * The case this file exists for is the third `describe` below. `scopeReaches`
 * answers a `team` scope by looking for `resource.teamId`, and
 * `inventory_items` has no `team_id` column at all — so a narrowing that
 * filtered one would name a column that is not there, and a narrowing that
 * skipped it would hand a team-scoped membership the organization's stock.
 * Neither is what `can()` would say. "Nothing" is.
 */

import { describe, expect, it } from 'vitest'

import type { Actor } from '@/lib/authz/can'

import {
  INVENTORY_SCOPE_COLUMNS,
  TASK_SCOPE_COLUMNS,
  narrowingsFor,
  operationsResource,
  reachesNothing,
} from './scope'

const ORGANIZATION = 'org-1'
const USER = 'user-1'

function actorWith(
  scope: Actor['scope'],
  overrides: Partial<Actor> = {},
): Actor {
  return {
    userId: USER,
    organizationId: ORGANIZATION,
    membershipStatus: 'active',
    grants: new Set(),
    scope,
    entitlements: new Set(),
    ...overrides,
  }
}

describe('a task, which carries all five location columns', () => {
  it('does not narrow an organization-wide membership', () => {
    expect(
      narrowingsFor(
        actorWith({ kind: 'all_organization' }),
        TASK_SCOPE_COLUMNS,
      ),
    ).toEqual([{ kind: 'none' }])
  })

  it('narrows a property membership to its properties', () => {
    expect(
      narrowingsFor(
        actorWith({ kind: 'properties', propertyIds: ['p1', 'p2'] }),
        TASK_SCOPE_COLUMNS,
      ),
    ).toEqual([{ kind: 'in', column: 'property_id', values: ['p1', 'p2'] }])
  })

  it('narrows a team membership to its teams', () => {
    expect(
      narrowingsFor(
        actorWith({ kind: 'team', teamIds: ['t1'] }),
        TASK_SCOPE_COLUMNS,
      ),
    ).toEqual([{ kind: 'in', column: 'team_id', values: ['t1'] }])
  })

  it('splits own_records into the two halves the engine admits', () => {
    // `scopeReaches` admits a row assigned to this person *or* created by them.
    // PostgREST spells that with `.or()`, which the demo client and the
    // transaction compiler both refuse on purpose — so it is two queries.
    expect(
      narrowingsFor(actorWith({ kind: 'own_records' }), TASK_SCOPE_COLUMNS),
    ).toEqual([
      { kind: 'eq', column: 'assigned_to_user_id', value: USER },
      { kind: 'eq', column: 'created_by', value: USER },
    ])
  })

  it('lets platform staff through without narrowing', () => {
    expect(
      narrowingsFor(
        actorWith({ kind: 'own_records' }, { isPlatformStaff: true }),
        TASK_SCOPE_COLUMNS,
      ),
    ).toEqual([{ kind: 'none' }])
  })
})

describe('an empty scope list', () => {
  it('reaches nothing rather than everything', () => {
    // A property manager whose last property was sold. Treating the empty list
    // as a wildcard would hand them the whole organization on the day they lost
    // their only claim to any of it.
    const narrowings = narrowingsFor(
      actorWith({ kind: 'properties', propertyIds: [] }),
      TASK_SCOPE_COLUMNS,
    )

    expect(narrowings).toHaveLength(1)
    expect(reachesNothing(narrowings[0])).toBe(true)
  })
})

describe('inventory, which has no team column', () => {
  it('reaches nothing for a team-scoped membership', () => {
    const narrowings = narrowingsFor(
      actorWith({ kind: 'team', teamIds: ['t1'] }),
      INVENTORY_SCOPE_COLUMNS,
    )

    expect(narrowings).toEqual([{ kind: 'nothing' }])
    expect(reachesNothing(narrowings[0])).toBe(true)
  })

  it('still narrows a property-scoped membership normally', () => {
    expect(
      narrowingsFor(
        actorWith({ kind: 'properties', propertyIds: ['p1'] }),
        INVENTORY_SCOPE_COLUMNS,
      ),
    ).toEqual([{ kind: 'in', column: 'property_id', values: ['p1'] }])
  })

  it('falls back to the creator alone for own_records, since there is no assignee', () => {
    expect(
      narrowingsFor(
        actorWith({ kind: 'own_records' }),
        INVENTORY_SCOPE_COLUMNS,
      ),
    ).toEqual([{ kind: 'eq', column: 'created_by', value: USER }])
  })
})

describe('the resource an operations question is asked about', () => {
  it('carries only what the row actually has', () => {
    const actor = actorWith({ kind: 'all_organization' })

    expect(
      operationsResource(actor, {
        propertyId: 'p1',
        unitId: null,
        teamId: 't1',
      }),
    ).toEqual({
      organizationId: ORGANIZATION,
      family: 'operations',
      propertyId: 'p1',
      teamId: 't1',
    })
  })

  it('always declares the operations family', () => {
    // Without it, an external seller's *default* scope — `own_records` — would
    // be applied to a task instead of their operations scope, which is a
    // different answer for the same row.
    expect(
      operationsResource(actorWith({ kind: 'own_records' }), {}).family,
    ).toBe('operations')
  })
})
