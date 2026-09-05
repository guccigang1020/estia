/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The route guard for the insights screen: the decision in `access.ts`, plus
 * the `redirect()` this file exists to perform.
 *
 * The same shape and the same argument as `automations/_lib/gate.ts`, copied
 * rather than imported for the reason that file states about the distribution
 * guard: a route guard shared across two screen groups makes one group's
 * refusal policy the other's dependency. The only line that matters — the
 * entitlement lookup — is read from the catalogue's own `ENTITLEMENT_FOR_GRANT`
 * in every copy, so they cannot disagree about the answer even though they are
 * several functions.
 *
 * IT IS NOT A WEAKER GATE. Every outcome except `plan_does_not_include` is the
 * identical redirect `guard.ts` performs, through the identical `routeAccess`
 * decision. The plan branch renders a screen rather than hiding one, and that
 * screen offers nothing the module would have said — see `page.tsx`.
 */

import { redirect } from 'next/navigation'

import type { Actor, Resource } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import type { Entitlement } from '@/lib/plans/entitlements'

import { shellContext } from '../../_lib/context'
import { INSIGHT_GRANTS, decideInsightAccess } from './access'

/** Matches `SHELL_HOME` in `_lib/guard.ts`. The same landing page. */
const SHELL_HOME = '/dashboard'

/** Matches `SIGN_IN_PATH` in `src/lib/supabase/proxy.ts`. */
const SIGN_IN = '/sign-in'

export type InsightGateResult =
  | { kind: 'allow'; actor: Actor }
  | {
      kind: 'locked'
      actor: Actor
      grant: Grant
      entitlement: Entitlement | null
    }

/**
 * Refuse unless one of the insight grants admits this reader.
 *
 * Fails closed. Every branch that is not an explicit allow or an explicit plan
 * lock ends in a redirect, and `redirect()` throws, so nothing after it runs.
 */
export async function requireAnyInsightGrant(
  grants: readonly [Grant, ...Grant[]] = INSIGHT_GRANTS,
  resource?: Resource,
): Promise<InsightGateResult> {
  const access = decideInsightAccess(await shellContext(), grants, resource)

  switch (access.outcome) {
    case 'allow':
      return { kind: 'allow', actor: access.actor }
    case 'locked':
      return {
        kind: 'locked',
        actor: access.actor,
        grant: access.grant,
        entitlement: access.entitlement,
      }
    case 'sign_in':
      redirect(SIGN_IN)
    // A person with no usable workspace has nowhere to be refused from; the
    // landing page explains the state they are actually in.
    case 'no_workspace':
      redirect(SHELL_HOME)
    case 'denied':
      redirect(
        `${SHELL_HOME}?denied=${encodeURIComponent(access.grant)}&reason=${encodeURIComponent(access.reason)}`,
      )
  }
}
