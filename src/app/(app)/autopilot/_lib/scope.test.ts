/**
 * The narrowing, and the doctrine it follows.
 *
 * The one that would be tempting to get wrong: an organization-wide row is
 * reachable only by an organization-wide scope. `can.ts` says so — "a resource
 * that carries no location is organization-wide and is therefore only
 * reachable by an organization-wide scope" — and Autopilot follows it rather
 * than inventing a softer rule for itself, even though RLS would allow more.
 * Narrower is the failure direction that matters.
 */

import { describe, expect, it } from 'vitest'

import { can } from '@/lib/authz/can'

import { makeActor, ORGANIZATION, PROPERTY_A, PROPERTY_B } from './fixtures'
import { autopilotNarrowing, autopilotResource } from './scope'

describe('autopilotNarrowing', () => {
  it('does not narrow an organization-wide scope', () => {
    expect(autopilotNarrowing(makeActor())).toEqual({ kind: 'none' })
  })

  it('narrows to the property list', () => {
    const actor = makeActor({
      scope: { kind: 'properties', propertyIds: [PROPERTY_A, PROPERTY_B] },
    })
    expect(autopilotNarrowing(actor)).toEqual({
      kind: 'property_in',
      values: [PROPERTY_A, PROPERTY_B],
    })
  })

  it('reaches nothing for an empty property list', () => {
    const actor = makeActor({ scope: { kind: 'properties', propertyIds: [] } })
    expect(autopilotNarrowing(actor)).toEqual({ kind: 'nothing' })
  })

  it('reaches nothing for a scope no Autopilot table can express', () => {
    // `units`, `team` and `own_records` name columns no autopilot table
    // carries. The honest answer is that there is no narrowing to push, and
    // `can()` would drop every row anyway.
    for (const scope of [
      { kind: 'units', unitIds: ['u'] },
      { kind: 'team', teamIds: ['t'] },
      { kind: 'own_records' },
    ] as const) {
      expect(autopilotNarrowing(makeActor({ scope }))).toEqual({
        kind: 'nothing',
      })
    }
  })

  it('does not narrow for platform staff', () => {
    const actor = makeActor({
      isPlatformStaff: true,
      scope: { kind: 'properties', propertyIds: [PROPERTY_A] },
    })
    expect(autopilotNarrowing(actor)).toEqual({ kind: 'none' })
  })

  it('honours a per-family override, because operations is the family', () => {
    const actor = makeActor({
      scope: { kind: 'all_organization' },
      scopeOverrides: {
        operations: { kind: 'properties', propertyIds: [PROPERTY_B] },
      },
    })
    expect(autopilotNarrowing(actor)).toEqual({
      kind: 'property_in',
      values: [PROPERTY_B],
    })
  })
})

describe('autopilotResource', () => {
  it('omits propertyId for an organization-wide row', () => {
    const resource = autopilotResource(ORGANIZATION, null)
    expect(resource.propertyId).toBeUndefined()
    expect(resource.family).toBe('operations')
  })

  it('makes an organization-wide row unreachable by a property scope', () => {
    const actor = makeActor({
      scope: { kind: 'properties', propertyIds: [PROPERTY_A] },
    })
    expect(
      can(actor, 'autopilot.view', autopilotResource(ORGANIZATION, null)),
    ).toBe(false)
    expect(
      can(actor, 'autopilot.view', autopilotResource(ORGANIZATION, PROPERTY_A)),
    ).toBe(true)
    expect(
      can(actor, 'autopilot.view', autopilotResource(ORGANIZATION, PROPERTY_B)),
    ).toBe(false)
  })

  it('refuses on the entitlement, not only on the grant', () => {
    // `autopilot` is add-on only and on no plan. An actor with every grant and
    // no entitlement must still be refused, which is what makes the plan lock
    // the default experience rather than an edge case.
    const actor = makeActor({ entitlements: new Set() })
    expect(
      can(actor, 'autopilot.view', autopilotResource(ORGANIZATION, PROPERTY_A)),
    ).toBe(false)
  })
})
