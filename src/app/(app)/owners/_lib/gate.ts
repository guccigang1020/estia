/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The route guard for the owner portal.
 *
 * The same shape and the same argument as `automations/_lib/gate.ts`, which is
 * the case this copies: `requireGrant` flattens every refusal into one redirect
 * carrying "המסך שביקשת דורש הרשאה שאין לך", and that sentence is false for a
 * plan refusal in the way that costs money.
 *
 * It is more acute here than anywhere else in the product. **Every** grant in
 * the owner family — `owner.view`, `owner.manage`, `owner_statement.view`,
 * `owner_statement.issue`, `owner.view_commission` — is mapped to
 * `owner_portal` in `ENTITLEMENT_FOR_GRANT`. On a package without it, nobody in
 * the business holds any of them however their role is composed, including the
 * organization owner. Telling that person they lack a permission sends them to
 * an administrator who finds no toggle, and the conversation ends with "the
 * product is broken" rather than "we can add this to the package".
 *
 * IT IS NOT A WEAKER GATE. Every outcome except `plan_does_not_include` is the
 * identical redirect `guard.ts` performs, through the identical `routeAccess`
 * decision. The plan branch renders a screen instead of hiding one.
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

export type OwnerAccess =
  | { kind: 'allow'; actor: Actor }
  /**
   * Holds the right; the organization has not bought the feature.
   *
   * The actor is carried through so the locked screen can still say something
   * true about this business — how many properties are managed for outside
   * owners today — rather than rendering a brochure.
   */
  | {
      kind: 'locked'
      actor: Actor
      grant: Grant
      entitlement: Entitlement | null
    }

export async function requireOwnerGrant(
  grant: Grant,
  resource?: Resource,
): Promise<OwnerAccess> {
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
