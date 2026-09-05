/**
 * What a customer's package actually gives them, after the overrides.
 *
 * Pure. It takes what `organizations.ts` read and turns it into the two
 * answers the capability screen shows: which features are on, and how close
 * the account is to each limit.
 *
 * ── There is one override mechanism, and this is it ───────────────────────
 *
 * `organization_subscriptions.entitlement_grants`,
 * `entitlement_revocations` and `limit_overrides` are the per-customer
 * deviation, they have existed since 0003, and `effectiveEntitlements()` and
 * `effectiveLimits()` in `src/lib/plans/plan.ts` are what the product already
 * reads them through. So the console edits those three columns.
 *
 * It would have been easy to add a `platform_feature_flags` table instead —
 * it is the shape the phrase "feature flags" suggests, and 0041 has room for
 * it. It is not there deliberately. Two tables answering "does this customer
 * have the website builder" is two answers, and the day they disagree the one
 * the product reads and the one the console shows will be different tables.
 * A capability the console can set and the product does not consult is worse
 * than no console at all, because somebody will set it and go home.
 *
 * ── A quota is not a wall ─────────────────────────────────────────────────
 *
 * `checkQuota` is reused rather than reimplemented, so what the console says
 * about an account is what the account itself experiences. Note that the
 * product's rule is to warn rather than block on properties and units — a
 * business must never be unable to check a guest in — and the console shows
 * the overage as an overage, not as a violation.
 */

import type { Entitlement } from '@/lib/plans/entitlements'
import { ENTITLEMENTS } from '@/lib/plans/entitlements'
import type { PlanLimits } from '@/lib/plans/entitlements'
import { checkQuota, type QuotaKey, type QuotaState } from '@/lib/plans/quota'

import type { ConsoleSubscription, OrganizationUsage } from './organizations'

/* ------------------------------------------------------------ features -- */

/** Why a feature is on or off for this customer. */
export type CapabilityOrigin =
  /** Included in the package they bought. */
  | 'plan'
  /** Added for this customer specifically. */
  | 'granted'
  /** Withdrawn for this customer specifically. A revocation beats a grant. */
  | 'revoked'
  /** Not in the package and not added. */
  | 'absent'
  /**
   * The subscription is cancelled, so everything but `core` is off regardless
   * of what the plan or the overrides say. Shown as its own origin because
   * "you revoked this" and "they stopped paying" are different conversations.
   */
  | 'cancelled'

export interface CapabilityState {
  entitlement: Entitlement
  active: boolean
  origin: CapabilityOrigin
}

/**
 * Every feature the product has, and where this customer stands on it.
 *
 * The whole list rather than the active subset, because the screen's job is to
 * let somebody turn one on: a list of what is already enabled cannot be used
 * to enable anything, and a reader cannot tell an absent feature from one that
 * does not exist.
 */
export function capabilityStates(
  subscription: ConsoleSubscription,
): readonly CapabilityState[] {
  const planned = new Set(subscription.planEntitlements)
  const granted = new Set(subscription.entitlementGrants)
  const revoked = new Set(subscription.entitlementRevocations)
  const cancelled = subscription.status === 'cancelled'

  return ENTITLEMENTS.map((entitlement) => {
    // Mirrors `effectiveEntitlements()` exactly, including the order in which
    // it resolves a conflict: revocation last, and `core` always on.
    if (cancelled && entitlement !== 'core') {
      return { entitlement, active: false, origin: 'cancelled' as const }
    }

    if (revoked.has(entitlement)) {
      return { entitlement, active: false, origin: 'revoked' as const }
    }

    if (planned.has(entitlement)) {
      return { entitlement, active: true, origin: 'plan' as const }
    }

    if (granted.has(entitlement) || entitlement === 'core') {
      return {
        entitlement,
        active: true,
        origin: granted.has(entitlement)
          ? ('granted' as const)
          : ('plan' as const),
      }
    }

    return { entitlement, active: false, origin: 'absent' as const }
  })
}

/* -------------------------------------------------------------- limits -- */

/**
 * A limit and what is known about the usage against it.
 *
 * `usage` is `null` when nothing measures it. That is not the same as zero and
 * the type says so: `storageGb` has a limit on every package and no accounting
 * anywhere in this database, so the console shows the allowance and states
 * that consumption is not measured, rather than drawing an empty bar.
 */
export interface LimitState {
  key: QuotaKey
  limit: number | null
  usage: number | null
  /** `null` when usage is unknown — a quota cannot be judged without one. */
  quota: QuotaState | null
  /** Set when nothing in this database measures the usage. */
  unmeasuredReason: string | null
}

const LIMIT_KEYS: readonly QuotaKey[] = [
  'properties',
  'units',
  'members',
  'storageGb',
]

/**
 * Merge the plan's limits, the customer's overrides and the measured usage.
 *
 * `usage` of `null` — the definer function refused, or the deployment predates
 * 0041 — makes every `quota` null rather than making every `current` zero. An
 * account showing `0 / 5 properties` when it has four is a number somebody
 * upgrades or downgrades on.
 */
export function limitStates(
  subscription: ConsoleSubscription,
  usage: OrganizationUsage | null,
): readonly LimitState[] {
  const limits = mergedLimits(subscription)

  return LIMIT_KEYS.map((key) => {
    const limit = limits[key] ?? null
    const measured = measuredUsage(key, usage)

    return {
      key,
      limit,
      usage: measured,
      quota: measured === null ? null : checkQuota(key, measured, limits),
      unmeasuredReason: unmeasuredReason(key, usage),
    }
  })
}

/**
 * The limits actually in force.
 *
 * The same rule as `effectiveLimits()`: a present override wins, an absent key
 * falls through to the plan, and a key carrying `undefined` is not an
 * override — copying it over a real figure is how a customer gets locked out
 * of inviting staff by a key that meant nothing.
 */
export function mergedLimits(subscription: ConsoleSubscription): PlanLimits {
  const limits: PlanLimits = {
    properties: readLimit(subscription.planLimits, 'properties'),
    units: readLimit(subscription.planLimits, 'units'),
    members: readLimit(subscription.planLimits, 'members'),
    storageGb: readLimit(subscription.planLimits, 'storageGb'),
  }

  for (const key of LIMIT_KEYS) {
    const override = subscription.limitOverrides[key]
    if (override === undefined) continue
    limits[key] = override === null ? null : Number(override)
  }

  return limits
}

/** Whether this customer's limit differs from the package's. */
export function isOverridden(
  subscription: ConsoleSubscription,
  key: QuotaKey,
): boolean {
  return Object.prototype.hasOwnProperty.call(subscription.limitOverrides, key)
}

function readLimit(
  limits: Record<string, unknown>,
  key: QuotaKey,
): number | null {
  const value = limits[key]
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function measuredUsage(
  key: QuotaKey,
  usage: OrganizationUsage | null,
): number | null {
  if (!usage) return null
  if (key === 'storageGb') return null
  return usage[key]
}

/**
 * Why a usage figure is missing, in a sentence the screen can print.
 *
 * Two different absences, and they must not read the same. Storage has no
 * accounting anywhere in the product — that is permanent and is a gap worth
 * naming. The other three are missing only when the count could not be read,
 * which is a fault.
 */
function unmeasuredReason(
  key: QuotaKey,
  usage: OrganizationUsage | null,
): string | null {
  if (key === 'storageGb') {
    return 'אין במסד הנתונים ספירה של נפח אחסון. המכסה קיימת בחבילה, והצריכה בפועל אינה נמדדת בשום מקום — ולכן לא מוצג כאן מספר.'
  }

  if (!usage) {
    return 'ספירת השימוש לא נטענה. המספר אינו ידוע — הוא אינו אפס.'
  }

  return null
}
