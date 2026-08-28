/**
 * Cache keys, proved not to collide.
 *
 * The failure this file exists to prevent is one customer being served
 * another's revenue out of a cache. It is not hypothetical: it is what happens
 * the first time somebody keys a dashboard on the date range, which is the
 * obvious thing to do and looks correct in every test written by the person who
 * did it.
 */

import { describe, expect, it } from 'vitest'
import { accessFingerprint, metricCacheKey } from './cache-key'
import { METRIC_IDS, type MetricId } from './dictionary'
import type { ResolvedScope } from './scope'
import type { Actor, Scope } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import type { MetricRange } from './types'

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

const OWNER_GRANTS: readonly Grant[] = [
  'availability.view',
  'booking.view',
  'booking.view_price',
  'booking.view_source',
  'commission.view',
  'agent_statement.view',
  'finance.view',
  'payment.view',
  'lead.view',
  'report.financial.view',
  'report.financial.export',
]

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'user-1',
    organizationId: 'org-a',
    membershipStatus: 'active',
    grants: new Set<Grant>(OWNER_GRANTS),
    scope: { kind: 'all_organization' } as Scope,
    entitlements: EVERY_ENTITLEMENT,
    ...overrides,
  }
}

const MARCH: MetricRange = { start: '2026-03-01', end: '2026-04-01' }

const ORG_WIDE: ResolvedScope = {
  organizationId: 'org-a',
  propertyIds: null,
  unitIds: null,
}

const ALL: readonly MetricId[] = METRIC_IDS

function key(
  overrides: {
    actor?: Actor
    scope?: ResolvedScope
    range?: MetricRange
    comparison?: 'none' | 'previous_period' | 'previous_year'
    metrics?: readonly MetricId[]
  } = {},
): string {
  return metricCacheKey({
    actor: overrides.actor ?? actor(),
    scope: overrides.scope ?? ORG_WIDE,
    range: overrides.range ?? MARCH,
    comparison: overrides.comparison ?? 'previous_period',
    metrics: overrides.metrics ?? ALL,
  })
}

describe('the organization is always in the key', () => {
  it('separates two customers asking the identical question', () => {
    const a = key()
    const b = key({
      actor: actor({ organizationId: 'org-b' }),
      scope: { ...ORG_WIDE, organizationId: 'org-b' },
    })
    expect(a).not.toBe(b)
    expect(a).toContain('org=org-a')
    expect(b).toContain('org=org-b')
  })
})

describe('the scope is always in the key', () => {
  it('separates an organization-wide view from a single property', () => {
    expect(key()).not.toBe(
      key({ scope: { ...ORG_WIDE, propertyIds: ['prop-1'] } }),
    )
  })

  it('separates two managers of different properties', () => {
    expect(key({ scope: { ...ORG_WIDE, propertyIds: ['prop-1'] } })).not.toBe(
      key({ scope: { ...ORG_WIDE, propertyIds: ['prop-2'] } }),
    )
  })

  it('separates a property view from a unit view', () => {
    expect(key({ scope: { ...ORG_WIDE, propertyIds: ['x'] } })).not.toBe(
      key({ scope: { ...ORG_WIDE, unitIds: ['x'] } }),
    )
  })

  it('is stable when the same scope arrives in a different order', () => {
    expect(key({ scope: { ...ORG_WIDE, propertyIds: ['a', 'b'] } })).toBe(
      key({ scope: { ...ORG_WIDE, propertyIds: ['b', 'a'] } }),
    )
  })

  it('cannot be forged by an identifier containing a separator', () => {
    // `a|b` as one property must not spell the same key as `a` and `b` as two.
    expect(key({ scope: { ...ORG_WIDE, propertyIds: ['a|b'] } })).not.toBe(
      key({ scope: { ...ORG_WIDE, propertyIds: ['a', 'b'] } }),
    )
    expect(key({ scope: { ...ORG_WIDE, propertyIds: ['a,b'] } })).not.toBe(
      key({ scope: { ...ORG_WIDE, propertyIds: ['a', 'b'] } }),
    )
    // Nor by an identifier that spells the wildcard.
    expect(key({ scope: { ...ORG_WIDE, propertyIds: ['*'] } })).not.toBe(
      key({ scope: { ...ORG_WIDE, propertyIds: null } }),
    )
  })
})

describe('the permission-relevant identity is always in the key', () => {
  it('separates an actor who may see commission from one who may not', () => {
    const withoutCommission = actor({
      grants: new Set<Grant>(
        OWNER_GRANTS.filter((grant) => grant !== 'commission.view'),
      ),
    })
    expect(key()).not.toBe(key({ actor: withoutCommission }))
  })

  it('separates an actor who may open the detail from one who may not', () => {
    // Same aggregate, different `detailAvailable` in the response.
    const withoutLedger = actor({
      grants: new Set<Grant>(
        OWNER_GRANTS.filter((grant) => grant !== 'payment.view'),
      ),
    })
    expect(key()).not.toBe(key({ actor: withoutLedger }))
  })

  it('separates an actor whose plan withdrew a feature', () => {
    // `commission.view` is gated on the agent network entitlement, so losing
    // the plan feature changes what the response contains.
    const downgraded = actor({
      entitlements: new Set<Entitlement>(
        ENTITLEMENTS.filter((entitlement) => entitlement !== 'agent_network'),
      ),
    })
    expect(key()).not.toBe(key({ actor: downgraded }))
  })

  it('separates platform staff, who see past scope', () => {
    expect(key()).not.toBe(key({ actor: actor({ isPlatformStaff: true }) }))
  })

  it('shares an entry between two people with identical access', () => {
    // Deliberate. Two colleagues in the same organization, with the same scope
    // and the same relevant grants, receive a byte-identical response. Keying
    // on the user id would multiply the cache by the size of the staff list and
    // buy nothing — the isolation comes from the organization, the scope and
    // the grants, all of which are already here.
    expect(key()).toBe(key({ actor: actor({ userId: 'user-2' }) }))
  })
})

describe('the question is always in the key', () => {
  it('separates two windows', () => {
    expect(key()).not.toBe(
      key({ range: { start: '2026-04-01', end: '2026-05-01' } }),
    )
  })

  it('separates two comparison modes', () => {
    expect(key({ comparison: 'previous_period' })).not.toBe(
      key({ comparison: 'previous_year' }),
    )
  })

  it('separates two sets of metrics', () => {
    expect(key({ metrics: ['occupancy'] })).not.toBe(
      key({ metrics: ['occupancy', 'revenue'] }),
    )
  })

  it('is stable across order and duplication of the same request', () => {
    expect(key({ metrics: ['revenue', 'occupancy'] })).toBe(
      key({ metrics: ['occupancy', 'revenue', 'occupancy'] }),
    )
  })
})

describe('a sweep across every dimension at once', () => {
  it('produces a distinct key for every distinct request', () => {
    const variants: string[] = [
      key(),
      key({ actor: actor({ organizationId: 'org-b' }) }),
      key({ scope: { ...ORG_WIDE, propertyIds: ['prop-1'] } }),
      key({ scope: { ...ORG_WIDE, propertyIds: ['prop-2'] } }),
      key({ scope: { ...ORG_WIDE, unitIds: ['unit-1'] } }),
      key({ range: { start: '2026-02-01', end: '2026-03-01' } }),
      key({ comparison: 'none' }),
      key({ comparison: 'previous_year' }),
      key({ metrics: ['occupancy'] }),
      key({ actor: actor({ grants: new Set<Grant>(['booking.view']) }) }),
      key({ actor: actor({ isPlatformStaff: true }) }),
    ]
    expect(new Set(variants).size).toBe(variants.length)
  })
})

describe('the access fingerprint', () => {
  it('lists only the grants the actor actually holds', () => {
    const limited = actor({ grants: new Set<Grant>(['availability.view']) })
    expect(accessFingerprint(limited, ['occupancy', 'revenue'])).toEqual([
      'availability.view',
    ])
  })

  it('includes the drill-down grant, because the response mentions it', () => {
    const fingerprint = accessFingerprint(actor(), ['outstanding_balance'])
    expect(fingerprint).toContain('finance.view')
    expect(fingerprint).toContain('payment.view')
  })

  it('is sorted, so the same access always fingerprints the same way', () => {
    const fingerprint = accessFingerprint(actor(), ALL)
    expect(fingerprint).toEqual([...fingerprint].sort())
  })
})
