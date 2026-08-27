/**
 * Packages, subscriptions and the price a customer actually pays.
 *
 * The guarantee that matters commercially is grandfathering: raising a price in
 * the back office must not reach anybody who already signed. That is proved
 * here by raising a plan's price after signup and showing the customer still
 * pays the old figure.
 */

import { describe, expect, it } from 'vitest'
import {
  agreedPrice,
  effectiveEntitlements,
  effectiveLimits,
  formatAgorot,
  isGrandfathered,
  type EffectivePlan,
  type Plan,
  type Subscription,
  type SubscriptionStatus,
} from './plan'
import type { Entitlement, PlanLimits } from './entitlements'
import { checkQuota } from './quota'

// ── Fixtures ──────────────────────────────────────────────────────────────

const PRO_LIMITS: PlanLimits = {
  properties: 5,
  units: 15,
  members: 10,
  storageGb: 50,
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-pro',
    code: 'pro',
    name: 'Pro',
    description: 'For complexes.',
    monthlyPrice: 64_900,
    yearlyPrice: 649_000,
    limits: PRO_LIMITS,
    entitlements: [
      'core',
      'payments',
      'invoicing',
      'website',
      'team',
      'operations',
    ],
    isPublic: true,
    sortOrder: 3,
    ...overrides,
  }
}

function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-1',
    organizationId: 'org-a',
    planId: 'plan-pro',
    status: 'active',
    interval: 'monthly',
    agreedMonthlyPrice: 64_900,
    agreedYearlyPrice: 649_000,
    trialEndsAt: null,
    currentPeriodEnd: null,
    limitOverrides: {},
    entitlementGrants: [],
    entitlementRevocations: [],
    ...overrides,
  }
}

function makeEffective(
  plan: Partial<Plan> = {},
  subscription: Partial<Subscription> = {},
): EffectivePlan {
  return { plan: makePlan(plan), subscription: makeSubscription(subscription) }
}

// ── Entitlements ──────────────────────────────────────────────────────────

describe('effectiveEntitlements()', () => {
  it("returns the plan's own features when nothing is overridden", () => {
    const result = effectiveEntitlements(makeEffective())

    expect([...result].sort()).toEqual(
      ['core', 'payments', 'invoicing', 'website', 'team', 'operations'].sort(),
    )
  })

  it('adds a feature granted to this customer specifically', () => {
    const result = effectiveEntitlements(
      makeEffective({}, { entitlementGrants: ['owner_portal'] }),
    )

    expect(result.has('owner_portal')).toBe(true)
    expect(result.has('website')).toBe(true)
  })

  it('removes a feature withdrawn from this customer specifically', () => {
    const result = effectiveEntitlements(
      makeEffective({}, { entitlementRevocations: ['website'] }),
    )

    expect(result.has('website')).toBe(false)
    expect(result.has('payments')).toBe(true)
  })

  it('lets a revocation beat a grant when the two disagree, which is deny by default applied to money', () => {
    const result = effectiveEntitlements(
      makeEffective(
        {},
        {
          entitlementGrants: ['owner_portal', 'channels'],
          entitlementRevocations: ['owner_portal'],
        },
      ),
    )

    expect(result.has('owner_portal')).toBe(false)
    expect(result.has('channels')).toBe(true)
  })

  it('applies grants before revocations, so ordering cannot be exploited by listing a feature twice', () => {
    const result = effectiveEntitlements(
      makeEffective(
        {},
        {
          entitlementGrants: ['ai_content'],
          entitlementRevocations: ['ai_content', 'website'],
        },
      ),
    )

    expect(result.has('ai_content')).toBe(false)
    expect(result.has('website')).toBe(false)
  })

  it('collapses a cancelled subscription to the core product only', () => {
    const result = effectiveEntitlements(
      makeEffective({}, { status: 'cancelled' }),
    )

    expect([...result]).toEqual(['core'])
  })

  it('ignores customer-specific grants on a cancelled subscription', () => {
    const result = effectiveEntitlements(
      makeEffective(
        {},
        {
          status: 'cancelled',
          entitlementGrants: ['owner_portal', 'multi_brand'],
        },
      ),
    )

    expect([...result]).toEqual(['core'])
  })

  it('leaves a cancelled customer their core product, so a failed card does not lock them out of their own bookings', () => {
    expect(
      effectiveEntitlements(makeEffective({}, { status: 'cancelled' })).has(
        'core',
      ),
    ).toBe(true)
  })

  const stillPaying: readonly SubscriptionStatus[] = [
    'trialing',
    'active',
    'past_due',
    'paused',
  ]

  it.each(stillPaying)(
    'keeps the paid features of a subscription in status "%s", because only cancellation collapses the plan',
    (status) => {
      const result = effectiveEntitlements(makeEffective({}, { status }))

      expect(result.has('website')).toBe(true)
      expect(result.has('operations')).toBe(true)
    },
  )

  it('always includes the core product, even on a plan that does not list it', () => {
    const result = effectiveEntitlements(
      makeEffective({ entitlements: ['payments'] }),
    )

    expect(result.has('core')).toBe(true)
  })

  it('always includes the core product, even when a revocation tries to remove it', () => {
    const result = effectiveEntitlements(
      makeEffective({}, { entitlementRevocations: ['core'] }),
    )

    expect(result.has('core')).toBe(true)
  })

  it('does not include a feature nobody granted', () => {
    const result = effectiveEntitlements(makeEffective())

    expect(result.has('multi_brand')).toBe(false)
    expect(result.has('api_access')).toBe(false)
  })

  it("does not mutate the plan's own entitlement list", () => {
    const plan = makePlan()
    const before = [...plan.entitlements]

    effectiveEntitlements({
      plan,
      subscription: makeSubscription({
        entitlementGrants: ['multi_brand'],
        entitlementRevocations: ['website'],
      }),
    })

    expect([...plan.entitlements]).toEqual(before)
  })
})

// ── Limits ────────────────────────────────────────────────────────────────

describe('effectiveLimits()', () => {
  it("returns the plan's limits when the customer has no special deal", () => {
    expect(effectiveLimits(makeEffective())).toEqual(PRO_LIMITS)
  })

  it('lets a per-customer override win over the plan limit', () => {
    const result = effectiveLimits(
      makeEffective({}, { limitOverrides: { units: 25 } }),
    )

    expect(result.units).toBe(25)
  })

  it('leaves the limits the override does not mention untouched', () => {
    const result = effectiveLimits(
      makeEffective({}, { limitOverrides: { units: 25 } }),
    )

    expect(result.properties).toBe(5)
    expect(result.members).toBe(10)
    expect(result.storageGb).toBe(50)
  })

  it('lets an override make a limit unlimited', () => {
    const result = effectiveLimits(
      makeEffective({}, { limitOverrides: { members: null } }),
    )

    expect(result.members).toBeNull()
  })

  it('lets an override lower a limit as well as raise it', () => {
    const result = effectiveLimits(
      makeEffective({}, { limitOverrides: { units: 2 } }),
    )

    expect(result.units).toBe(2)
  })

  it('applies several overrides at once', () => {
    const result = effectiveLimits(
      makeEffective({}, { limitOverrides: { units: 25, storageGb: 200 } }),
    )

    expect(result).toEqual({
      properties: 5,
      units: 25,
      members: 10,
      storageGb: 200,
    })
  })

  it("does not mutate the plan's own limits", () => {
    const plan = makePlan()

    effectiveLimits({
      plan,
      subscription: makeSubscription({ limitOverrides: { units: 99 } }),
    })

    expect(plan.limits.units).toBe(15)
  })

  /**
   * Regression. A plain spread copied an `undefined` override over the plan's
   * figure, leaving a limit that was neither the plan value nor unlimited.
   * `checkQuota` then read `current <= undefined` as false and reported a
   * permanent overage, which for members and storage blocks the action — a
   * customer locked out of inviting staff by a key that said nothing.
   *
   * `Partial<PlanLimits>` permits `{ units: undefined }`, so any caller that
   * builds overrides by assignment rather than by omitting the key reaches it.
   */
  it('falls through to the plan limit when an override key is present but undefined', () => {
    const result = effectiveLimits(
      makeEffective({}, { limitOverrides: { units: undefined } }),
    )

    expect(result.units).toBe(15)
  })

  it('does not report an overage for a limit whose override was undefined', () => {
    const limits = effectiveLimits(
      makeEffective({}, { limitOverrides: { members: undefined } }),
    )

    expect(checkQuota('members', 1, limits).inOverage).toBe(false)
  })
})

// ── Price ─────────────────────────────────────────────────────────────────

describe('agreedPrice()', () => {
  it('returns the agreed monthly price for a monthly subscription', () => {
    expect(agreedPrice(makeEffective({}, { interval: 'monthly' }))).toBe(64_900)
  })

  it('returns the agreed yearly price for a yearly subscription', () => {
    expect(agreedPrice(makeEffective({}, { interval: 'yearly' }))).toBe(649_000)
  })

  it("keeps an early customer on their original price after the plan's list price is raised", () => {
    // Signed at ₪499/month. The back office later raises Pro to ₪649/month.
    const signedAt = 49_900
    const effective = makeEffective(
      { monthlyPrice: 64_900, yearlyPrice: 649_000 },
      { agreedMonthlyPrice: signedAt, agreedYearlyPrice: 499_000 },
    )

    expect(agreedPrice(effective)).toBe(signedAt)
    expect(agreedPrice(effective)).not.toBe(effective.plan.monthlyPrice)
  })

  it('keeps an early yearly customer on their original yearly price after a rise', () => {
    const effective = makeEffective(
      { yearlyPrice: 649_000 },
      { interval: 'yearly', agreedYearlyPrice: 499_000 },
    )

    expect(agreedPrice(effective)).toBe(499_000)
  })

  it('does not follow the plan downwards either — the snapshot is the price, in both directions', () => {
    const effective = makeEffective(
      { monthlyPrice: 29_900 },
      { agreedMonthlyPrice: 64_900 },
    )

    expect(agreedPrice(effective)).toBe(64_900)
  })
})

describe('isGrandfathered()', () => {
  it('detects a customer paying less than the current list price', () => {
    const effective = makeEffective(
      { monthlyPrice: 64_900, yearlyPrice: 649_000 },
      { agreedMonthlyPrice: 49_900, agreedYearlyPrice: 499_000 },
    )

    expect(isGrandfathered(effective)).toBe(true)
  })

  it('reports a customer paying exactly the list price as not grandfathered', () => {
    expect(isGrandfathered(makeEffective())).toBe(false)
  })

  it('reports a customer paying more than the list price as not grandfathered', () => {
    const effective = makeEffective(
      { monthlyPrice: 29_900, yearlyPrice: 299_000 },
      { agreedMonthlyPrice: 64_900, agreedYearlyPrice: 649_000 },
    )

    expect(isGrandfathered(effective)).toBe(false)
  })

  it('detects grandfathering from either interval, since a customer may switch', () => {
    const monthlyOnly = makeEffective(
      { monthlyPrice: 64_900, yearlyPrice: 649_000 },
      { agreedMonthlyPrice: 49_900, agreedYearlyPrice: 649_000 },
    )
    const yearlyOnly = makeEffective(
      { monthlyPrice: 64_900, yearlyPrice: 649_000 },
      { agreedMonthlyPrice: 64_900, agreedYearlyPrice: 499_000 },
    )

    expect(isGrandfathered(monthlyOnly)).toBe(true)
    expect(isGrandfathered(yearlyOnly)).toBe(true)
  })
})

// ── Display ───────────────────────────────────────────────────────────────

describe('formatAgorot()', () => {
  it('renders a whole number of shekels without decimals', () => {
    expect(formatAgorot(14_900)).toBe('₪149')
    expect(formatAgorot(64_900)).toBe('₪649')
    expect(formatAgorot(0)).toBe('₪0')
  })

  it('renders a part-shekel amount with exactly two decimals', () => {
    expect(formatAgorot(14_950)).toBe('₪149.50')
    expect(formatAgorot(12_345)).toBe('₪123.45')
    expect(formatAgorot(1)).toBe('₪0.01')
    expect(formatAgorot(10)).toBe('₪0.10')
  })

  it('never shows a decimal point on a whole number of shekels', () => {
    for (const amount of [100, 14_900, 149_000, 1_490_000]) {
      expect(formatAgorot(amount), `formatting ${amount}`).not.toContain('.')
    }
  })

  it('groups thousands so a large figure stays readable', () => {
    expect(formatAgorot(149_000)).toBe('₪1,490')
    expect(formatAgorot(100_000_000)).toBe('₪1,000,000')
  })

  it("renders the agreed price of a grandfathered customer, not the plan's", () => {
    const effective = makeEffective(
      { monthlyPrice: 64_900 },
      { agreedMonthlyPrice: 49_900 },
    )

    expect(formatAgorot(agreedPrice(effective))).toBe('₪499')
  })
})

// ── The entitlement set feeds the authorization engine ────────────────────

describe('the plan feeds the authorization engine', () => {
  it('produces a set the engine can consult directly', () => {
    const result: ReadonlySet<Entitlement> =
      effectiveEntitlements(makeEffective())

    expect(result.has('website')).toBe(true)
    expect(result.has('owner_portal')).toBe(false)
  })

  it('produces exactly the core set for a cancelled customer, so every paid grant is refused downstream', () => {
    const result = effectiveEntitlements(
      makeEffective({}, { status: 'cancelled' }),
    )

    expect(result.size).toBe(1)
    expect(result.has('core')).toBe(true)
  })
})
