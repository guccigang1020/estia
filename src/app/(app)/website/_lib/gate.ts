/**
 * EXECUTION CONTEXT — SERVER ONLY. The route guard for the website studio.
 *
 * The same shape and the same argument as `store/_lib/gate.ts`, which made this
 * case first: `requireGrant` flattens every refusal into one redirect and one
 * sentence — "המסך שביקשת דורש הרשאה שאין לך" — and that sentence is false for
 * a plan refusal in the way that costs money. An owner holds `site.view`; every
 * role that reaches this screen holds it. What Basic does not carry is the
 * `website` entitlement, and telling the owner they lack a permission sends
 * them to an administrator who cannot help.
 *
 * ── Why this is a copy and not an import ─────────────────────────────────
 *
 * `requireStoreGrant` is identical in behaviour and lives inside another
 * screen group's `_lib`, whose owner is a different worker. Importing a route
 * guard across two groups makes one group's refusal policy the other's
 * dependency. The entitlement lookup — the only line that matters — is read
 * from `ENTITLEMENT_FOR_GRANT` in both places, so the two cannot disagree
 * about the answer even though they are two functions.
 *
 * IT IS NOT A WEAKER GATE. Every outcome except `plan_does_not_include` is the
 * identical redirect `guard.ts` performs, through the identical `routeAccess`
 * decision. The plan branch renders a screen rather than hiding one.
 *
 * ── Three entitlements, not one ──────────────────────────────────────────
 *
 * The module spans `website`, `custom_domain` and `ai_content`, and they lock
 * different amounts of it. A business on a plan with `website` and without
 * `ai_content` has a fully working studio and one panel that offers an
 * upgrade — so the gate returns `locked` per grant and each screen decides
 * whether that means a whole page or one card.
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

export type SiteAccess =
  | { kind: 'allow'; actor: Actor }
  /** Holds the right; the organization has not bought the feature. */
  | {
      kind: 'locked'
      actor: Actor
      grant: Grant
      entitlement: Entitlement | null
    }

export async function requireSiteGrant(
  grant: Grant,
  resource?: Resource,
): Promise<SiteAccess> {
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

/**
 * Which studio tabs this person may actually open.
 *
 * Re-exported from `tabs.ts`, which imports nothing but the authorization
 * engine so it can be tested without a Supabase project — this file reaches
 * `shellContext` and therefore `@/lib/env`, which throws at import time in a
 * test. Callers keep importing it from the gate, which is where a screen looks.
 */
export { studioTabs, type StudioTab } from './tabs'
