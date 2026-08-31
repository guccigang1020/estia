/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The route guard for the distribution section, and the one thing it does that
 * `requireGrant` cannot.
 *
 * ── Two refusals that must not look alike ─────────────────────────────────
 *
 * `requireGrant` redirects every refusal to `/dashboard?denied=…`, and the
 * dashboard renders one sentence for all of them: "המסך שביקשת דורש הרשאה שאין
 * לך". For a missing permission that is exactly right. For a plan refusal it is
 * false in the way that costs money — the person may do this, their role is
 * fine, and what is missing is a feature their package does not include. Telling
 * an owner they lack a permission they in fact hold sends them to their
 * administrator instead of to the upgrade they were one click from.
 *
 * `authorize()` already distinguishes the two: `plan_does_not_include` carries
 * the `Entitlement` that would unlock the screen. This file is the small amount
 * of plumbing that carries that distinction onto the screen rather than
 * flattening it into a redirect.
 *
 * IT IS NOT A WEAKER GATE. Every other outcome is the identical redirect
 * `guard.ts` performs, through the identical `routeAccess` decision — signed out
 * goes to sign-in, no workspace goes to the landing page, a genuine permission
 * refusal goes to the dashboard naming the grant. The only branch that changes
 * is the one where the answer is "yes, but your package does not include it",
 * and that branch renders a screen instead of hiding one.
 *
 * ── Which entitlement, and why it is not hard-coded ───────────────────────
 *
 * `agent.view` and `agency.manage` are mapped to `agent_network` in
 * `ENTITLEMENT_FOR_GRANT`, which Basic buys as a paid add-on — see the note in
 * `plans/catalog.ts`. `channel.manage` is mapped to `channels` and
 * `pricing.manage` to `dynamic_pricing`, and `quote.view` is deliberately
 * mapped to nothing at all, because the catalogue is explicit that a
 * single-cabin owner sending a quote is the core product and not an add-on.
 *
 * So the entitlement is read out of the decision rather than written down here.
 * A section-wide constant would have been a second answer to a question the
 * catalogue already answers, and it would have been wrong for three of the five
 * routes on the day it was written.
 */

import { redirect } from 'next/navigation'

import type { Actor, Resource } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import {
  ENTITLEMENT_FOR_GRANT,
  type Entitlement,
} from '@/lib/plans/entitlements'

import { routeAccess } from '../../_lib/access'
import { shellContext } from '../../_lib/context'

/** Matches `SHELL_HOME` in `_lib/guard.ts`. The same landing page. */
const SHELL_HOME = '/dashboard'

/** Matches `SIGN_IN_PATH` in `src/lib/supabase/proxy.ts`. */
const SIGN_IN = '/sign-in'

export type DistributionAccess =
  | { kind: 'allow'; actor: Actor }
  /**
   * Held the right; the organization has not bought the feature.
   *
   * `entitlement` is `null` only in the case the engine cannot name one, which
   * `authorize()` does not currently produce for this reason — the screen still
   * has to render something honest if it ever does, so the type says so.
   */
  | { kind: 'locked'; grant: Grant; entitlement: Entitlement | null }

/**
 * Allow, or render the upgrade. Everything else redirects.
 *
 * Fails closed: the `denied` branch below ends in a `redirect()`, which throws,
 * so there is no path out of this function that returns without an actor except
 * the plan lock.
 */
export async function requireDistributionGrant(
  grant: Grant,
  resource?: Resource,
): Promise<DistributionAccess> {
  const decision = routeAccess(await shellContext(), grant, resource)

  switch (decision.outcome) {
    case 'allow':
      return { kind: 'allow', actor: decision.actor }
    case 'sign_in':
      redirect(SIGN_IN)
    case 'no_workspace':
      redirect(SHELL_HOME)
    case 'denied':
      if (decision.reason === 'plan_does_not_include') {
        return {
          kind: 'locked',
          grant,
          entitlement: entitlementFor(grant),
        }
      }
      redirect(
        `${SHELL_HOME}?denied=${encodeURIComponent(grant)}&reason=${encodeURIComponent(decision.reason)}`,
      )
  }
}

/**
 * The feature this grant belongs to.
 *
 * Read from the catalogue's own map. `routeAccess` flattens the decision to a
 * reason string and drops the `entitlement` the engine computed, so it is
 * looked up again from the same table the engine used — which is the same
 * answer by construction, and not a second opinion.
 */
function entitlementFor(grant: Grant): Entitlement | null {
  return ENTITLEMENT_FOR_GRANT[grant] ?? null
}
