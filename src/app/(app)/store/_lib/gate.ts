/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The route guard for the store section.
 *
 * The same shape and the same argument as `automations/_lib/gate.ts`, which
 * made this case first: `requireGrant` flattens every refusal into one redirect
 * and one sentence — "המסך שביקשת דורש הרשאה שאין לך" — and that sentence is
 * false for a plan refusal in the way that costs money. An owner holds
 * `product.view`; every role that reaches this screen holds it. What Basic
 * does not carry is the `commerce` entitlement, and telling the owner they lack
 * a permission sends them to an administrator who cannot help, who then tells
 * them the product is broken.
 *
 * ── Why this is a copy and not an import ─────────────────────────────────
 *
 * `requireAutomationGrant` is identical in behaviour and lives inside another
 * screen group's `_lib`, whose owner is a different agent. Importing a route
 * guard across two groups makes one group's refusal policy the other's
 * dependency. The entitlement lookup — the only line that matters — is read
 * from the catalogue's own `ENTITLEMENT_FOR_GRANT` in both places, so the two
 * cannot disagree about the answer even though they are two functions.
 *
 * IT IS NOT A WEAKER GATE. Every outcome except `plan_does_not_include` is the
 * identical redirect `guard.ts` performs, through the identical `routeAccess`
 * decision. The plan branch renders a screen rather than hiding one.
 *
 * ── The second gate, which is not authorization ──────────────────────────
 *
 * `storeMode` answers a different question: the organization holds the grant
 * and bought the entitlement, and has switched the store OFF. That is not a
 * refusal — it is a setting, and `off` is the default and a first-class
 * answer. The screens read it and offer to turn the store on; nothing nags.
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

export type StoreAccess =
  | { kind: 'allow'; actor: Actor }
  /** Holds the right; the organization has not bought the feature. */
  | {
      kind: 'locked'
      actor: Actor
      grant: Grant
      entitlement: Entitlement | null
    }

export async function requireStoreGrant(
  grant: Grant,
  resource?: Resource,
): Promise<StoreAccess> {
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
