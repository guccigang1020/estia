/**
 * Scope resolution, on its own.
 *
 * The dashboard tests exercise this through a whole request; these exercise the
 * narrowing rules directly, including the ones a full request rarely reaches —
 * a unit-scoped membership, and a request that names both a property and a unit.
 */

import { describe, expect, it } from 'vitest'
import {
  describeScope,
  filterToScope,
  isRowInScope,
  MetricScopeError,
  resolveMetricScope,
  type ResolvedScope,
} from './scope'
import type { Actor, Scope } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

function actor(scope: Scope, overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'user-1',
    organizationId: 'org-a',
    membershipStatus: 'active',
    grants: new Set<Grant>(['booking.view']),
    scope,
    entitlements: EVERY_ENTITLEMENT,
    ...overrides,
  }
}

const ORG = { organizationId: 'org-a' }

describe('a unit-scoped membership', () => {
  const housekeeper = actor({ kind: 'units', unitIds: ['unit-1', 'unit-2'] })

  it('is never widened to the organization', () => {
    expect(resolveMetricScope(housekeeper, ORG)).toEqual({
      organizationId: 'org-a',
      propertyIds: null,
      unitIds: ['unit-1', 'unit-2'],
    })
  })

  it('narrows to a single unit when one is requested', () => {
    expect(
      resolveMetricScope(housekeeper, { ...ORG, unitId: 'unit-2' }),
    ).toEqual({
      organizationId: 'org-a',
      propertyIds: null,
      unitIds: ['unit-2'],
    })
  })

  it('refuses a unit it does not hold', () => {
    expect(() =>
      resolveMetricScope(housekeeper, { ...ORG, unitId: 'unit-9' }),
    ).toThrow(MetricScopeError)
  })

  it('keeps both filters when a property is requested as well', () => {
    // The unit ceiling stays. The rows that survive are the intersection, so a
    // unit outside the requested property simply contributes nothing — which is
    // an empty answer, not a wide one.
    expect(
      resolveMetricScope(housekeeper, { ...ORG, propertyId: 'prop-1' }),
    ).toEqual({
      organizationId: 'org-a',
      propertyIds: ['prop-1'],
      unitIds: ['unit-1', 'unit-2'],
    })
  })

  it('treats an empty unit list as reaching nothing', () => {
    expect(() =>
      resolveMetricScope(actor({ kind: 'units', unitIds: [] }), ORG),
    ).toThrow(MetricScopeError)
  })
})

describe('a property-scoped membership asking about one unit', () => {
  it('keeps the property ceiling alongside the requested unit', () => {
    const manager = actor({ kind: 'properties', propertyIds: ['prop-1'] })
    expect(resolveMetricScope(manager, { ...ORG, unitId: 'unit-7' })).toEqual({
      organizationId: 'org-a',
      propertyIds: ['prop-1'],
      unitIds: ['unit-7'],
    })
  })
})

describe('resolution copies rather than aliases', () => {
  it('does not hand back the membership’s own array to be mutated', () => {
    const ids = ['prop-1']
    const manager = actor({ kind: 'properties', propertyIds: ids })
    const resolved = resolveMetricScope(manager, ORG)
    expect(resolved.propertyIds).not.toBe(ids)
    expect(resolved.propertyIds).toEqual(ids)
  })
})

describe('filtering rows', () => {
  const scope: ResolvedScope = {
    organizationId: 'org-a',
    propertyIds: ['prop-1'],
    unitIds: ['unit-1'],
  }

  it('keeps only rows inside both filters', () => {
    const rows = [
      { propertyId: 'prop-1', unitId: 'unit-1' },
      { propertyId: 'prop-1', unitId: 'unit-2' },
      { propertyId: 'prop-2', unitId: 'unit-1' },
    ]
    expect(filterToScope(scope, rows)).toEqual([rows[0]])
  })

  it('rejects a row that cannot say which unit it belongs to', () => {
    // Deny by default: an unlocatable row is not assumed to be in scope.
    expect(isRowInScope(scope, { propertyId: 'prop-1' })).toBe(false)
  })

  it('accepts anything when there is no restriction', () => {
    const wide: ResolvedScope = {
      organizationId: 'org-a',
      propertyIds: null,
      unitIds: null,
    }
    expect(isRowInScope(wide, { propertyId: 'anything' })).toBe(true)
  })
})

describe('describing a scope', () => {
  it('renders the unrestricted case as a wildcard', () => {
    expect(
      describeScope({
        organizationId: 'org-a',
        propertyIds: null,
        unitIds: null,
      }),
    ).toBe('p=*;u=*')
  })

  it('sorts, so the same scope always describes the same way', () => {
    const a = describeScope({
      organizationId: 'org-a',
      propertyIds: ['b', 'a'],
      unitIds: null,
    })
    const b = describeScope({
      organizationId: 'org-a',
      propertyIds: ['a', 'b'],
      unitIds: null,
    })
    expect(a).toBe(b)
  })

  it('escapes an identifier that would otherwise spell a different scope', () => {
    const forged = describeScope({
      organizationId: 'org-a',
      propertyIds: ['a,b'],
      unitIds: null,
    })
    const genuine = describeScope({
      organizationId: 'org-a',
      propertyIds: ['a', 'b'],
      unitIds: null,
    })
    expect(forged).not.toBe(genuine)
  })
})
