/**
 * Test support for the finance domain.
 *
 * Builders for the objects every finance test needs — an actor, a snapshot, a
 * payment — kept in one place so that eleven test files do not each grow their
 * own slightly different idea of what a booking's finances look like. When
 * those drift, a test passes because its fixture is wrong rather than because
 * the code is right.
 *
 * It ships inside the module rather than beside it for the same reason
 * `InMemoryPaymentProvider` and `InMemoryFinanceRepository` do: a double that
 * is maintained with the thing it doubles stays faithful to it, and a double
 * maintained in a `__tests__` folder does not.
 *
 * Actors are built from the **real** role catalogue. A test that hand-picked
 * its own grant set would prove that the code works for a permission set no
 * customer has; building `cleaner` from `grantsForSystemRole` is what makes
 * "a cleaner is refused every finance grant" a statement about the product.
 */

import type { Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { grantsForSystemRole, type SystemRole } from '../authz/roles'
import { priceStay } from '../booking/pricing'
import type { DateRange } from '../booking/types'
import { ENTITLEMENTS } from '../plans/entitlements'
import { captureFinanceSnapshot, type FinanceSnapshot } from './snapshot'
import type { CommissionRule, ExpenseRule } from './types'
import type { OwnerShareRule } from './snapshot'

export const ORG = '11111111-1111-4111-8111-111111111111'
export const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
export const PROPERTY = '33333333-3333-4333-8333-333333333333'
export const UNIT = '44444444-4444-4444-8444-444444444444'
export const BOOKING = '55555555-5555-4555-8555-555555555555'

export interface ActorOptions {
  userId?: string
  organizationId?: string
  /** Extra grants on top of the role's, for the rare test that needs one. */
  extraGrants?: readonly Grant[]
  scope?: Actor['scope']
}

/**
 * An actor holding exactly what a system role grants.
 *
 * Every entitlement is present, so a refusal in a test is always about the
 * permission and never about the package — the plan gate has its own tests in
 * `plans/`, and conflating the two makes both harder to read.
 */
export function actorFor(role: SystemRole, options: ActorOptions = {}): Actor {
  const grants = new Set<Grant>(grantsForSystemRole(role))
  for (const grant of options.extraGrants ?? []) grants.add(grant)

  return {
    userId: options.userId ?? `user-${role}`,
    organizationId: options.organizationId ?? ORG,
    membershipStatus: 'active',
    grants,
    scope: options.scope ?? { kind: 'all_organization' },
    entitlements: new Set(ENTITLEMENTS),
  }
}

/** The finance desk: takes money, gives it back, issues documents. */
export const financeActor = (): Actor => actorFor('finance_manager')

/** Owns the commercial relationship with agents, but never releases money. */
export const managerActor = (): Actor => actorFor('general_manager')

/** Four grants, none of them financial. The negative case, from the real role. */
export const cleanerActor = (): Actor => actorFor('cleaner')

export const AT = (iso: string): Date => new Date(iso)

// ── Snapshots ─────────────────────────────────────────────────────────────

export interface SnapshotOptions {
  range?: DateRange
  guests?: number
  baseNightlyAgorot?: number
  cleaningFeeAgorot?: number
  discountPercent?: number
  taxRatePercent?: number
  depositAgorot?: number
  commissionRule?: CommissionRule | null
  ownerShareRule?: OwnerShareRule | null
  expenseRules?: readonly ExpenseRule[]
  capturedAt?: Date
  bookingId?: string
}

/**
 * A snapshot built through the real pricing engine.
 *
 * Deliberately not a hand-written line array. A fixture that invented its own
 * lines could not catch a P&L that disagreed with what a guest was actually
 * quoted, which is most of what these tests are for.
 */
export function snapshotFor(options: SnapshotOptions = {}): FinanceSnapshot {
  const range = options.range ?? {
    checkIn: '2026-03-10',
    checkOut: '2026-03-13',
  }
  const guests = options.guests ?? 2

  const quote = priceStay({
    range,
    guests,
    baseNightlyAgorot: options.baseNightlyAgorot ?? 100_000,
    cleaningFeeAgorot: options.cleaningFeeAgorot ?? 25_000,
    discounts:
      options.discountPercent === undefined
        ? []
        : [
            {
              label: 'הנחת מבצע',
              kind: 'percent',
              value: options.discountPercent,
              lineKind: 'promotion',
            },
          ],
    taxRatePercent: options.taxRatePercent,
    depositAgorot: options.depositAgorot,
  })

  return captureFinanceSnapshot({
    bookingId: options.bookingId ?? BOOKING,
    organizationId: ORG,
    propertyId: PROPERTY,
    unitId: UNIT,
    capturedAt: options.capturedAt ?? AT('2026-02-01T09:00:00.000Z'),
    capturedByUserId: 'user-finance_manager',
    reason: 'ההזמנה אושרה',
    range,
    nights: quote.nights,
    guests,
    lines: quote.lines,
    stayTotalAgorot: quote.stayTotalAgorot,
    depositAgorot: quote.depositAgorot,
    taxAgorot: quote.taxAgorot,
    taxRatePercent: options.taxRatePercent ?? 0,
    currency: 'ILS',
    commissionRule: options.commissionRule ?? null,
    ownerShareRule: options.ownerShareRule ?? null,
    expenseRules: options.expenseRules ?? [],
  })
}

// ── Expense rules ─────────────────────────────────────────────────────────

export function fixedRule(overrides: Partial<ExpenseRule> = {}): ExpenseRule {
  return {
    id: 'rule-cleaning',
    organizationId: ORG,
    version: 1,
    label: 'חוזה ניקיון חודשי',
    category: 'cleaning',
    kind: 'fixed',
    scope: { kind: 'property', propertyId: PROPERTY },
    frequency: 'monthly',
    amountAgorot: 300_000,
    formula: null,
    allocation: 'per_occupied_night',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    approvalRequired: false,
    ...overrides,
  }
}

export function variableRule(
  overrides: Partial<ExpenseRule> = {},
): ExpenseRule {
  return {
    id: 'rule-laundry',
    organizationId: ORG,
    version: 1,
    label: 'כביסה',
    category: 'housekeeping',
    kind: 'variable',
    scope: { kind: 'organization' },
    frequency: 'one_time',
    amountAgorot: 0,
    formula: { kind: 'per_night', rateAgorot: 4_000 },
    allocation: 'per_booking',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    approvalRequired: false,
    ...overrides,
  }
}
