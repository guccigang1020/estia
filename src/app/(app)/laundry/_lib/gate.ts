/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The route guard for the laundry section.
 *
 * The same shape and the same argument as `automations/_lib/gate.ts`, copied
 * into this group rather than imported across the boundary — importing a route
 * guard from another screen group makes one group's refusal policy the other's
 * dependency, and the entitlement lookup that is the only line that matters is
 * read from `ENTITLEMENT_FOR_GRANT` in both, so the two cannot disagree about
 * the answer even though they are two functions.
 *
 * `requireGrant` flattens every refusal into one redirect and one sentence —
 * "המסך שביקשת דורש הרשאה שאין לך" — and that sentence is false for a plan
 * refusal in the way that costs money. All five laundry grants carry the
 * `laundry` entitlement, so an owner on a package without it holds every
 * permission this screen asks for and is told they lack one, which sends them
 * to an administrator who cannot help.
 *
 * IT IS NOT A WEAKER GATE. Every outcome except `plan_does_not_include` is the
 * identical redirect `guard.ts` performs, through the identical `routeAccess`
 * decision.
 *
 * ── The mode is NOT part of the gate ──────────────────────────────────────
 *
 * `off` is a configuration answer, not a refusal, and the two must not share a
 * code path. A person with the grant and the entitlement whose business runs
 * `off` has not been refused anything — there is simply nothing here — and the
 * right response is a page that says so plainly and points at the settings,
 * not a redirect carrying `?denied=`. `laundrySection` below resolves the mode
 * and the page decides; see `src/components/laundry/mode-off.tsx`.
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

export type LaundryAccess =
  | { kind: 'allow'; actor: Actor }
  /**
   * Holds the right; the organization has not bought the feature.
   *
   * The actor is carried through so the locked screen can still describe what
   * the module would do against this business's own shape — how many
   * properties, which arrivals — without performing anything.
   */
  | {
      kind: 'locked'
      actor: Actor
      grant: Grant
      entitlement: Entitlement | null
    }

export async function requireLaundryGrant(
  grant: Grant,
  resource?: Resource,
): Promise<LaundryAccess> {
  const context = await shellContext()
  const decision = routeAccess(context, grant, resource)

  switch (decision.outcome) {
    case 'allow':
      return { kind: 'allow', actor: decision.actor }
    case 'sign_in':
      redirect(SIGN_IN)
    case 'no_workspace':
      redirect(SHELL_HOME)
    case 'denied':
      if (
        decision.reason === 'plan_does_not_include' &&
        context !== null &&
        context.status === 'ready'
      ) {
        return {
          kind: 'locked',
          actor: context.actor,
          grant,
          entitlement: ENTITLEMENT_FOR_GRANT[grant] ?? null,
        }
      }
      redirect(
        `${SHELL_HOME}?denied=${encodeURIComponent(grant)}&reason=${encodeURIComponent(decision.reason)}`,
      )
  }
}
