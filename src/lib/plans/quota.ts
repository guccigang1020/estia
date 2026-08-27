/**
 * Quotas — how many, as opposed to whether.
 *
 * A quota behaves differently from an entitlement on purpose. An entitlement
 * is a locked door: the customer never had the website module, so the button
 * is not there. A quota is a line the customer has already crossed by growing,
 * and slamming a door behind them is the wrong response.
 *
 * A business that cannot check a guest in because it added a fifteenth unit is
 * a business that cancels that afternoon, and tells other owners why. So the
 * rule here is: warn loudly, offer the upgrade, and never block the day's work.
 * Hard refusal is reserved for actions that can safely wait.
 */

import type { PlanLimits } from './entitlements'

export type QuotaKey = keyof PlanLimits

export interface QuotaState {
  key: QuotaKey
  current: number
  /** `null` means unlimited on this plan. */
  limit: number | null
  /** Within the allowance. */
  withinLimit: boolean
  /** Over the allowance, and allowed to continue. */
  inOverage: boolean
  /** At or approaching the line — worth telling the customer before they cross it. */
  approaching: boolean
}

/** Warn once the customer is this close to the line. */
const APPROACHING_RATIO = 0.8

export function checkQuota(
  key: QuotaKey,
  current: number,
  limits: PlanLimits,
): QuotaState {
  const limit = limits[key]

  if (limit === null) {
    return {
      key,
      current,
      limit: null,
      withinLimit: true,
      inOverage: false,
      approaching: false,
    }
  }

  const withinLimit = current <= limit
  return {
    key,
    current,
    limit,
    withinLimit,
    inOverage: !withinLimit,
    approaching: withinLimit && current >= Math.floor(limit * APPROACHING_RATIO),
  }
}

/**
 * Actions refused outright when the customer is already over their allowance.
 *
 * The test for membership of this list is simple: would refusing it stop the
 * business serving a guest today? If yes, it does not belong here. Inviting a
 * colleague can wait until the plan is upgraded; a check-in cannot.
 */
export const QUOTA_BLOCKS_ACTION: Record<QuotaKey, boolean> = {
  properties: false,
  units: false,
  members: true,
  storageGb: true,
}

export function isBlockedByQuota(state: QuotaState): boolean {
  return state.inOverage && QUOTA_BLOCKS_ACTION[state.key]
}
