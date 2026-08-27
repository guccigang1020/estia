/**
 * Packages and subscriptions.
 *
 * Prices are data, not code. The platform administrator edits them in the
 * ESTIA back office, which means the model has to answer a question that a
 * hardcoded price list never faces: what happens to the customers who already
 * signed up when the price changes?
 *
 * The answer here is that it does not reach them. A subscription stores the
 * price that was agreed at the time. Editing a plan changes what new customers
 * are offered; existing subscriptions keep their own figure until someone
 * deliberately moves them. That makes "early customers keep their price
 * forever" a property of the schema rather than a promise someone has to
 * remember to honour.
 */

import type { Entitlement, PlanLimits } from './entitlements'

/**
 * Money is stored in agorot as an integer, everywhere, always.
 *
 * Floating point cannot represent ₪0.10 exactly, and money that is almost
 * right is money that is wrong. Formatting for display happens at the edge.
 */
export type Agorot = number

export type BillingInterval = 'monthly' | 'yearly'

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'cancelled'

/**
 * A package in the catalogue. Editable by ESTIA staff holding
 * `platform.plan.manage`; every edit is audited like any other sensitive
 * change.
 */
export interface Plan {
  id: string
  /** Stable machine name. Never changes, even when the display name does. */
  code: string
  name: string
  description: string
  monthlyPrice: Agorot
  /** Usually ten months' worth — two months free — but the admin sets it. */
  yearlyPrice: Agorot
  limits: PlanLimits
  entitlements: readonly Entitlement[]
  /** Hidden plans still work for whoever is on them; they are just not offered. */
  isPublic: boolean
  sortOrder: number
}

/**
 * One organization's subscription.
 *
 * `agreedMonthlyPrice` and `agreedYearlyPrice` are the snapshot. They are
 * copied from the plan at signup and are not refreshed when the catalogue
 * changes.
 */
export interface Subscription {
  id: string
  organizationId: string
  planId: string
  status: SubscriptionStatus
  interval: BillingInterval
  agreedMonthlyPrice: Agorot
  agreedYearlyPrice: Agorot
  trialEndsAt: Date | null
  currentPeriodEnd: Date | null
  /**
   * Per-customer deviations, for the deal that does not fit a package —
   * "Pro, but with 25 units". Absent keys fall through to the plan.
   */
  limitOverrides: Partial<PlanLimits>
  /** Features granted or withdrawn for this customer specifically. */
  entitlementGrants: readonly Entitlement[]
  entitlementRevocations: readonly Entitlement[]
}

/** A plan together with the subscription that points at it. */
export interface EffectivePlan {
  plan: Plan
  subscription: Subscription
}

/**
 * The features an organization actually has, after overrides.
 *
 * A revocation beats a grant. When the two disagree the safer reading wins,
 * which is the same instinct as deny-by-default.
 */
export function effectiveEntitlements(
  effective: EffectivePlan,
): ReadonlySet<Entitlement> {
  const { plan, subscription } = effective

  // A subscription that is not paying does not unlock paid features. It keeps
  // the core product, so the business can still see its own bookings and is
  // not locked out of its data by a failed card.
  if (subscription.status === 'cancelled') {
    return new Set<Entitlement>(['core'])
  }

  const result = new Set<Entitlement>(plan.entitlements)
  for (const granted of subscription.entitlementGrants) result.add(granted)
  for (const revoked of subscription.entitlementRevocations) result.delete(revoked)
  result.add('core')
  return result
}

/**
 * The limits an organization actually has, after overrides.
 *
 * An override key carrying `undefined` must fall through to the plan rather
 * than replace it. A plain spread does not do that — it copies the `undefined`
 * over a real figure, and `checkQuota` then compares against nothing and
 * reports a permanent overage, which for members and storage blocks the action
 * outright. A customer would be locked out of inviting staff by a key that was
 * never meant to say anything.
 */
export function effectiveLimits(effective: EffectivePlan): PlanLimits {
  const limits: PlanLimits = { ...effective.plan.limits }
  for (const [key, value] of Object.entries(effective.subscription.limitOverrides)) {
    if (value !== undefined) {
      limits[key as keyof PlanLimits] = value
    }
  }
  return limits
}

/** The price this customer pays, which is not necessarily the list price. */
export function agreedPrice(effective: EffectivePlan): Agorot {
  const { subscription } = effective
  return subscription.interval === 'yearly'
    ? subscription.agreedYearlyPrice
    : subscription.agreedMonthlyPrice
}

/**
 * Is this customer paying less than the current list price?
 *
 * Shown in the back office so an administrator editing prices can see who is
 * grandfathered and by how much, instead of discovering it in a support call.
 */
export function isGrandfathered(effective: EffectivePlan): boolean {
  const { plan, subscription } = effective
  return (
    subscription.agreedMonthlyPrice < plan.monthlyPrice ||
    subscription.agreedYearlyPrice < plan.yearlyPrice
  )
}

/** ₪ formatting for display. Input is agorot; output is for humans. */
export function formatAgorot(amount: Agorot): string {
  const shekels = amount / 100
  return `₪${shekels.toLocaleString('he-IL', {
    minimumFractionDigits: Number.isInteger(shekels) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}
