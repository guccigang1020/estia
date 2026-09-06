/**
 * Test support for the owner portal.
 *
 * Builders in one place, for the reason `finance/testing.ts` states: when four
 * test files each grow their own idea of what a property's month looks like,
 * one of them eventually passes because its fixture is wrong rather than
 * because the code is right.
 *
 * Two decisions worth naming.
 *
 * **The P&L is built through the real finance engine**, not hand-written. A
 * fixture that invented `grossRevenueAgorot: 325_000` could not catch a
 * statement that disagreed with what the P&L screen would show, and catching
 * exactly that is why this module exists. `pnlFor` prices a stay, snapshots it,
 * runs `bookingPnl` and then `propertyPnl` — so every assertion about
 * reconciliation is an assertion about the two modules together.
 *
 * **Actors are built from the real role catalogue.** `ownerActor()` is
 * `property_owner` as `roles.ts` composes it, scoped to one property. A test
 * that hand-picked a grant set would prove the code works for a permission set
 * no customer has.
 */

import type { Actor } from '../authz/can'
import { bookingPnl, propertyPnl, type PropertyPnl } from '../finance/pnl'
import type { CostComponent } from '../finance/pnl'
import type { OwnerShareRule } from '../finance/snapshot'
import type { CommissionRule } from '../finance/types'
import {
  ORG,
  PROPERTY,
  actorFor,
  snapshotFor,
  type ActorOptions,
} from '../finance/testing'
import {
  FULL_SHARE_BPS,
  type OwnerPayout,
  type PropertyOwner,
  type PropertyOwnership,
} from './types'

export { ORG, PROPERTY, actorFor }

export const OTHER_PROPERTY = '66666666-6666-4666-8666-666666666666'
export const OWNER_A = '77777777-7777-4777-8777-777777777777'
export const OWNER_B = '88888888-8888-4888-8888-888888888888'
export const OWNER_A_USER = 'user-owner-a'
export const OWNER_B_USER = 'user-owner-b'

export const COMMISSION: CommissionRule = {
  basis: 'net_revenue',
  kind: 'percent',
  value: 10,
  label: 'עמלת סוכן',
}

export const OWNER_SHARE: OwnerShareRule = {
  basis: 'net_profit',
  kind: 'percent',
  value: 60,
  label: 'חלק הבעלים',
}

// ── Records ───────────────────────────────────────────────────────────────

export function ownerFor(
  overrides: Partial<PropertyOwner> = {},
): PropertyOwner {
  return {
    id: OWNER_A,
    organizationId: ORG,
    displayName: 'משפחת לוי',
    userId: OWNER_A_USER,
    email: null,
    phone: null,
    status: 'active',
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

export function ownershipFor(
  overrides: Partial<PropertyOwnership> = {},
): PropertyOwnership {
  return {
    id: `ownership-${overrides.ownerId ?? OWNER_A}`,
    organizationId: ORG,
    ownerId: OWNER_A,
    propertyId: PROPERTY,
    shareBps: FULL_SHARE_BPS,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

export function payoutFor(overrides: Partial<OwnerPayout> = {}): OwnerPayout {
  return {
    id: 'payout-1',
    organizationId: ORG,
    ownerId: OWNER_A,
    propertyId: PROPERTY,
    statementId: null,
    direction: 'to_owner',
    amountAgorot: 50_000,
    method: 'bank_transfer',
    paidOn: '2026-03-20',
    reference: 'העברה 4471',
    note: null,
    recordedBy: 'user-finance_manager',
    createdAt: '2026-03-20T10:00:00.000Z',
    ...overrides,
  }
}

// ── Actors ────────────────────────────────────────────────────────────────

/** The outside party: `property_owner`, scoped to one villa. */
export function ownerActor(
  userId: string = OWNER_A_USER,
  propertyIds: readonly string[] = [PROPERTY],
): Actor {
  return actorFor('property_owner', {
    userId,
    scope: { kind: 'properties', propertyIds },
  })
}

/** The insider who issues the documents. Holds `owner.view_commission`. */
export function financeActor(options: ActorOptions = {}): Actor {
  return actorFor('finance_manager', options)
}

// ── The property's month ──────────────────────────────────────────────────

export interface PnlOptions {
  /** How many stays in the period. Each is the same worked example. */
  bookings?: number
  discountPercent?: number
  commissionRule?: CommissionRule | null
  ownerShareRule?: OwnerShareRule | null
  variableCosts?: readonly CostComponent[]
  fixedCosts?: readonly CostComponent[]
  unallocatedFixedCostAgorot?: number
  propertyId?: string
}

/**
 * A property's period result, computed by the finance module itself.
 *
 * The default is the worked example `pnl.test.ts` uses — three nights at
 * ₪1,000, a ₪250 cleaning fee, 10% off — with a cleaning cost per stay, an
 * agent on 10% of net and an owner on 60% of profit. Every figure an owner
 * statement quotes comes out of this object and none is recomputed.
 */
export function pnlFor(options: PnlOptions = {}): PropertyPnl {
  const count = options.bookings ?? 2

  const bookings = Array.from({ length: count }, (_, index) =>
    bookingPnl({
      snapshot: snapshotFor({
        bookingId: `booking-${index}`,
        discountPercent: options.discountPercent ?? 10,
        taxRatePercent: 18,
        commissionRule:
          options.commissionRule === undefined
            ? COMMISSION
            : options.commissionRule,
        ownerShareRule:
          options.ownerShareRule === undefined
            ? OWNER_SHARE
            : options.ownerShareRule,
      }),
      variableCosts: options.variableCosts ?? [
        { ruleId: 'rule-cleaning', label: 'ניקיון', amountAgorot: 18_000 },
      ],
      fixedCosts: options.fixedCosts ?? [
        { ruleId: 'rule-insurance', label: 'ביטוח', amountAgorot: 5_000 },
      ],
    }),
  )

  return propertyPnl({
    propertyId: options.propertyId ?? PROPERTY,
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    bookings,
    unallocatedFixedCostAgorot: options.unallocatedFixedCostAgorot ?? 0,
  })
}
