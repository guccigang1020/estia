/**
 * Can this rule actually run here, for this person, on this package?
 *
 * The engine answers that per action while an event is in flight. A screen
 * needs the same answer *before* anything happens, so that a card can say "this
 * rule cannot open a task because your role does not include it" instead of
 * offering a switch that would quietly do nothing.
 *
 * ── One answer, computed once ─────────────────────────────────────────────
 *
 * Both callers go through `holdsGrant`, which is permission and plan asked
 * together. This file adds no rule of its own: it walks the actions, asks the
 * same question the engine asks, and separates the two refusals — because a
 * missing permission is a conversation with an administrator and a missing
 * feature is a conversation with billing, and telling somebody the wrong one
 * sends them to a person who cannot help.
 *
 * ── Partially runnable is a real state and is reported as one ─────────────
 *
 * A rule that notifies the team and opens a task, held by somebody who may
 * notify and may not open tasks, is not "blocked". Half of it would run. The
 * screen has to be able to say that, because enabling it is still worth doing
 * and the missing half is still worth fixing.
 */

import { holdsGrant, type Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { ENTITLEMENT_FOR_GRANT, type Entitlement } from '../plans/entitlements'

import { AUTOMATION_ACTIONS, AUTOMATION_ENTITLEMENT } from './types'
import type { AutomationAction, AutomationRule } from './types'

export type ActionReadiness =
  | { status: 'ready'; action: AutomationAction; grant: Grant }
  | { status: 'missing_permission'; action: AutomationAction; grant: Grant }
  | {
      status: 'missing_feature'
      action: AutomationAction
      grant: Grant
      entitlement: Entitlement
    }

export type RuleReadinessStatus =
  /** Every action would run. */
  | 'ready'
  /** Some would, some would not. */
  | 'partial'
  /** None would. */
  | 'blocked'
  /** The automation module itself is not in the package. */
  | 'module_locked'

export interface RuleReadiness {
  rule: AutomationRule
  status: RuleReadinessStatus
  actions: readonly ActionReadiness[]
  /**
   * Features that would unlock something here, deduplicated.
   *
   * Includes `automation` itself when the module is locked, so a screen has one
   * list to render rather than a list plus a special case.
   */
  missingFeatures: readonly Entitlement[]
  /** Grants a role would need. Empty when the only problem is the package. */
  missingGrants: readonly Grant[]
}

export function ruleReadiness(
  actor: Actor,
  rule: AutomationRule,
): RuleReadiness {
  const actions = rule.actions.map((action) => actionReadiness(actor, action))

  const missingGrants = [
    ...new Set(
      actions
        .filter((entry) => entry.status === 'missing_permission')
        .map((entry) => entry.grant),
    ),
  ]
  const missingFeatures = new Set<Entitlement>(
    actions
      .filter((entry) => entry.status === 'missing_feature')
      .map((entry) => (entry as { entitlement: Entitlement }).entitlement),
  )

  if (!actor.entitlements.has(AUTOMATION_ENTITLEMENT)) {
    // The module gate comes first in the engine too. Reported as its own
    // status rather than as `blocked`, because nothing about the role is
    // wrong and saying "blocked" invites the customer to go and fix a
    // permission that is already correct.
    missingFeatures.add(AUTOMATION_ENTITLEMENT)
    return {
      rule,
      status: 'module_locked',
      actions,
      missingFeatures: [...missingFeatures],
      missingGrants,
    }
  }

  const ready = actions.filter((entry) => entry.status === 'ready').length
  const status: RuleReadinessStatus =
    ready === actions.length ? 'ready' : ready === 0 ? 'blocked' : 'partial'

  return {
    rule,
    status,
    actions,
    missingFeatures: [...missingFeatures],
    missingGrants,
  }
}

export function actionReadiness(
  actor: Actor,
  action: AutomationAction,
): ActionReadiness {
  const grant = AUTOMATION_ACTIONS[action.kind].requires

  // The order matches `engine.ts`: the role is asked first, so somebody whose
  // role does not carry the right is never told to buy a feature that would
  // not help them.
  if (!actor.grants.has(grant)) {
    return { status: 'missing_permission', action, grant }
  }
  if (!holdsGrant(actor, grant)) {
    const entitlement = ENTITLEMENT_FOR_GRANT[grant]
    // `holdsGrant` returned false with the grant present, so the catalogue
    // named an entitlement. The fallback keeps the type total rather than
    // asserting; `automation` is the honest answer if it ever fires.
    return {
      status: 'missing_feature',
      action,
      grant,
      entitlement: entitlement ?? AUTOMATION_ENTITLEMENT,
    }
  }
  return { status: 'ready', action, grant }
}

/** Hebrew for a readiness status, so every screen says the same words. */
export const READINESS_LABEL: Record<RuleReadinessStatus, string> = {
  ready: 'פעילה במלואה',
  partial: 'פעילה חלקית',
  blocked: 'לא תפעל',
  module_locked: 'לא כלולה בחבילה',
}
