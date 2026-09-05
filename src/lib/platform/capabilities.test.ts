import { describe, expect, it } from 'vitest'

import { effectiveEntitlements, effectiveLimits } from '@/lib/plans/plan'
import type { Entitlement } from '@/lib/plans/entitlements'

import {
  capabilityStates,
  isOverridden,
  limitStates,
  mergedLimits,
} from './capabilities'
import type { ConsoleSubscription, OrganizationUsage } from './organizations'

/**
 * The console must agree with the product about what a customer has.
 *
 * These tests do not check the console against a fixture of what somebody
 * believed the answer was. They check it against `effectiveEntitlements()` and
 * `effectiveLimits()` — the functions the running application resolves a
 * customer's package with. A console that disagrees with those is a console
 * showing a feature list nobody experiences.
 */

function subscription(
  overrides: Partial<ConsoleSubscription> = {},
): ConsoleSubscription {
  return {
    id: 'sub-1',
    planCode: 'pro',
    planName: 'Pro',
    status: 'active',
    interval: 'monthly',
    agreedMonthlyAgorot: 64900,
    agreedYearlyAgorot: 649000,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelledAt: null,
    planEntitlements: ['core', 'payments', 'invoicing', 'website'],
    entitlementGrants: [],
    entitlementRevocations: [],
    planLimits: { properties: 5, units: 15, members: 10, storageGb: 50 },
    limitOverrides: {},
    ...overrides,
  }
}

/** The same subscription, in the shape `src/lib/plans` expects. */
function asEffectivePlan(source: ConsoleSubscription) {
  return {
    plan: {
      id: 'plan-1',
      code: source.planCode,
      name: source.planName,
      description: '',
      monthlyPrice: source.agreedMonthlyAgorot,
      yearlyPrice: source.agreedYearlyAgorot,
      limits: mergedPlanLimits(source),
      entitlements: source.planEntitlements,
      isPublic: true,
      sortOrder: 1,
    },
    subscription: {
      id: source.id,
      organizationId: 'org-1',
      planId: 'plan-1',
      status: source.status,
      interval: source.interval,
      agreedMonthlyPrice: source.agreedMonthlyAgorot,
      agreedYearlyPrice: source.agreedYearlyAgorot,
      trialEndsAt: null,
      currentPeriodEnd: null,
      limitOverrides: source.limitOverrides as Record<string, number | null>,
      entitlementGrants: source.entitlementGrants,
      entitlementRevocations: source.entitlementRevocations,
    },
  }
}

function mergedPlanLimits(source: ConsoleSubscription) {
  return {
    properties: (source.planLimits.properties ?? null) as number | null,
    units: (source.planLimits.units ?? null) as number | null,
    members: (source.planLimits.members ?? null) as number | null,
    storageGb: (source.planLimits.storageGb ?? null) as number | null,
  }
}

function activeSet(source: ConsoleSubscription): Set<Entitlement> {
  return new Set(
    capabilityStates(source)
      .filter((state) => state.active)
      .map((state) => state.entitlement),
  )
}

describe('capabilityStates', () => {
  it('matches effectiveEntitlements for a plain subscription', () => {
    const source = subscription()
    expect(activeSet(source)).toEqual(
      new Set(effectiveEntitlements(asEffectivePlan(source))),
    )
  })

  it('matches when a feature is granted for this customer only', () => {
    const source = subscription({ entitlementGrants: ['api_access'] })

    expect(activeSet(source)).toEqual(
      new Set(effectiveEntitlements(asEffectivePlan(source))),
    )
    expect(
      capabilityStates(source).find((s) => s.entitlement === 'api_access'),
    ).toEqual({ entitlement: 'api_access', active: true, origin: 'granted' })
  })

  it('matches when a feature is revoked, and says a revocation beats a grant', () => {
    const source = subscription({
      entitlementGrants: ['website'],
      entitlementRevocations: ['website'],
    })

    expect(activeSet(source)).toEqual(
      new Set(effectiveEntitlements(asEffectivePlan(source))),
    )
    expect(
      capabilityStates(source).find((s) => s.entitlement === 'website'),
    ).toEqual({ entitlement: 'website', active: false, origin: 'revoked' })
  })

  it('shows a cancelled subscription as cancelled, not as revoked', () => {
    const source = subscription({ status: 'cancelled' })

    // Same set as the product resolves — core only.
    expect(activeSet(source)).toEqual(
      new Set(effectiveEntitlements(asEffectivePlan(source))),
    )
    expect(activeSet(source)).toEqual(new Set(['core']))

    // And the reason is distinguishable, because "you revoked this" and "they
    // stopped paying" are different conversations with the customer.
    const website = capabilityStates(source).find(
      (s) => s.entitlement === 'website',
    )
    expect(website?.origin).toBe('cancelled')
  })

  it('lists every entitlement the product has, not only the active ones', () => {
    // A screen that lists only what is on cannot be used to turn anything on.
    const states = capabilityStates(subscription())
    expect(states.length).toBeGreaterThan(activeSet(subscription()).size)
    expect(states.some((s) => !s.active)).toBe(true)
  })
})

describe('mergedLimits', () => {
  it('matches effectiveLimits when there are no overrides', () => {
    const source = subscription()
    expect(mergedLimits(source)).toEqual(
      effectiveLimits(asEffectivePlan(source)),
    )
  })

  it('lets a present override win', () => {
    const source = subscription({ limitOverrides: { units: 25 } })
    expect(mergedLimits(source).units).toBe(25)
    expect(mergedLimits(source)).toEqual(
      effectiveLimits(asEffectivePlan(source)),
    )
  })

  it('treats an explicit null as unlimited rather than as absent', () => {
    const source = subscription({ limitOverrides: { members: null } })
    expect(mergedLimits(source).members).toBeNull()
  })

  it('does not let an undefined override erase the plan figure', () => {
    // The exact defect `effectiveLimits()` documents: an override carrying
    // `undefined` copied over a real figure, checkQuota then compared against
    // nothing, and the customer was locked out of inviting staff.
    const source = subscription({
      limitOverrides: { members: undefined } as Record<string, unknown>,
    })
    expect(mergedLimits(source).members).toBe(10)
  })
})

describe('limitStates', () => {
  const usage: OrganizationUsage = { properties: 4, units: 12, members: 3 }

  it('reports a quota only where the usage was measured', () => {
    const states = limitStates(subscription(), usage)
    const byKey = new Map(states.map((state) => [state.key, state]))

    expect(byKey.get('properties')?.quota?.current).toBe(4)
    expect(byKey.get('properties')?.quota?.withinLimit).toBe(true)
    expect(byKey.get('units')?.quota?.approaching).toBe(true)
  })

  it('never turns unmeasured storage into a zero', () => {
    const storage = limitStates(subscription(), usage).find(
      (state) => state.key === 'storageGb',
    )

    expect(storage?.usage).toBeNull()
    expect(storage?.quota).toBeNull()
    expect(storage?.limit).toBe(50)
    expect(storage?.unmeasuredReason).toContain('אינה נמדדת')
  })

  it('never turns a failed count into a zero either', () => {
    // `usage: null` is "the count could not be read". An account rendered as
    // 0 / 5 properties when it has four is a number somebody downgrades on.
    for (const state of limitStates(subscription(), null)) {
      expect(state.usage).toBeNull()
      expect(state.quota).toBeNull()
      expect(state.unmeasuredReason).not.toBeNull()
    }
  })

  it('reports an overage without calling it a violation', () => {
    const source = subscription({ limitOverrides: { properties: 2 } })
    const properties = limitStates(source, usage).find(
      (state) => state.key === 'properties',
    )

    expect(properties?.quota?.inOverage).toBe(true)
    // The product's rule: properties and units warn, they do not block. A
    // business must never be unable to check a guest in.
    expect(properties?.limit).toBe(2)
  })
})

describe('isOverridden', () => {
  it('is true only for a key the customer actually carries', () => {
    const source = subscription({ limitOverrides: { units: 25 } })
    expect(isOverridden(source, 'units')).toBe(true)
    expect(isOverridden(source, 'properties')).toBe(false)
  })
})
