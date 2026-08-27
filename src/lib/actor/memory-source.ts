/**
 * An `ActorSource` held in memory.
 *
 * This is not a mock in the throwaway sense. It is the reference
 * implementation of the contract: it demonstrates exactly what the Supabase
 * version must return, including the awkward cases — a membership that exists
 * but is suspended, an organization with no subscription row, a membership
 * with no scope — and it is what lets the resolution tests cover every one of
 * them without a database.
 *
 * Whoever wires the real source should read this file first and make the query
 * layer answer identically.
 */

import type { Entitlement, PlanLimits } from '../plans/entitlements'
import type {
  BillingInterval,
  EffectivePlan,
  Plan,
  Subscription,
  SubscriptionStatus,
} from '../plans/plan'
import type {
  ActorSource,
  MembershipRow,
  MembershipScopeRow,
  RoleAssignment,
} from './source'

/** Everything the source knows, keyed the way the tables are. */
export interface ActorWorld {
  memberships: readonly MembershipRow[]
  /** membership id → roles held. */
  roles?: Readonly<Record<string, readonly RoleAssignment[]>>
  /** membership id → scope row. */
  scopes?: Readonly<Record<string, MembershipScopeRow>>
  /** organization id → live subscription and its plan. */
  plans?: Readonly<Record<string, EffectivePlan>>
}

/**
 * Counts of what was asked for.
 *
 * Present so a test can prove the negative that matters: that a suspended
 * member's roles, scope and plan were never read. "It refused" and "it refused
 * before touching anything" are different claims.
 */
export interface ActorSourceCalls {
  loadMembership: number
  loadRoles: number
  loadScope: number
  loadPlan: number
}

export class InMemoryActorSource implements ActorSource {
  readonly calls: ActorSourceCalls = {
    loadMembership: 0,
    loadRoles: 0,
    loadScope: 0,
    loadPlan: 0,
  }

  constructor(private readonly world: ActorWorld) {}

  async loadMembership(
    userId: string,
    organizationId: string,
  ): Promise<MembershipRow | null> {
    this.calls.loadMembership += 1
    return (
      this.world.memberships.find(
        (m) => m.userId === userId && m.organizationId === organizationId,
      ) ?? null
    )
  }

  async loadRoles(membershipId: string): Promise<readonly RoleAssignment[]> {
    this.calls.loadRoles += 1
    return this.world.roles?.[membershipId] ?? []
  }

  async loadScope(membershipId: string): Promise<MembershipScopeRow | null> {
    this.calls.loadScope += 1
    return this.world.scopes?.[membershipId] ?? null
  }

  async loadPlan(organizationId: string): Promise<EffectivePlan | null> {
    this.calls.loadPlan += 1
    return this.world.plans?.[organizationId] ?? null
  }
}

// ── Fixture helpers ───────────────────────────────────────────────────────

const DEFAULT_LIMITS: PlanLimits = {
  properties: 5,
  units: 15,
  members: 10,
  storageGb: 50,
}

/**
 * Build an `EffectivePlan` without writing out twenty fields.
 *
 * The defaults describe a healthy mid-tier customer, so a test that cares
 * about one entitlement or one limit states only that one.
 */
export function makeEffectivePlan(
  options: {
    organizationId?: string
    planCode?: string
    entitlements?: readonly Entitlement[]
    limits?: Partial<PlanLimits>
    limitOverrides?: Partial<PlanLimits>
    entitlementGrants?: readonly Entitlement[]
    entitlementRevocations?: readonly Entitlement[]
    status?: SubscriptionStatus
    interval?: BillingInterval
  } = {},
): EffectivePlan {
  const organizationId = options.organizationId ?? 'org-a'

  const plan: Plan = {
    id: `plan-${options.planCode ?? 'pro'}`,
    code: options.planCode ?? 'pro',
    name: 'Pro',
    description: 'Fixture plan.',
    monthlyPrice: 64900,
    yearlyPrice: 649000,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    entitlements: options.entitlements ?? [
      'core',
      'payments',
      'invoicing',
      'team',
      'operations',
      'approvals',
    ],
    isPublic: true,
    sortOrder: 3,
  }

  const subscription: Subscription = {
    id: `sub-${organizationId}`,
    organizationId,
    planId: plan.id,
    status: options.status ?? 'active',
    interval: options.interval ?? 'monthly',
    agreedMonthlyPrice: plan.monthlyPrice,
    agreedYearlyPrice: plan.yearlyPrice,
    trialEndsAt: null,
    currentPeriodEnd: null,
    limitOverrides: options.limitOverrides ?? {},
    entitlementGrants: options.entitlementGrants ?? [],
    entitlementRevocations: options.entitlementRevocations ?? [],
  }

  return { plan, subscription }
}
