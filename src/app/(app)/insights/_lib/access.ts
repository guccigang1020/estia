/**
 * The insights route's access decision, as a pure function.
 *
 * The same split the shell already makes between `_lib/access.ts` and
 * `_lib/guard.ts`: the part that can be decided without a request, a cookie jar
 * or the Next.js router lives here, and the `redirect()` wrapper that cannot
 * lives in `gate.ts`. That is what makes the ladder testable against the real
 * demo actors rather than against a description of it.
 *
 * ── Why this route needs a ladder and not a grant ─────────────────────────
 *
 * `MENU` declares this item as `anyOf: ['automation.view',
 * 'report.financial.view']`, and it has to. The accountant holds financial
 * reporting and not automation; the general manager holds automation and no
 * money grant at all. Both belong on this screen, and `requireGrant` takes one
 * grant — so gating on either alone would refuse somebody the catalogue says
 * is entitled.
 *
 * The order of the ladder is the whole decision:
 *
 *   1. **Any allow wins.** One open door is an open door.
 *   2. **A plan refusal beats a permission refusal.** A customer who buys the
 *      feature gets in; a customer granted the permission still would not. So
 *      the offer is the more useful answer, and it is the honest one — the
 *      person holds the right.
 *   3. Everything else is the shell's ordinary refusal, unchanged.
 */

import type { Actor, Resource } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import {
  ENTITLEMENT_FOR_GRANT,
  type Entitlement,
} from '@/lib/plans/entitlements'

import { routeAccess } from '../../_lib/access'
import type { ShellContext } from '../../_lib/context'

/**
 * The grants that admit somebody to `/insights`.
 *
 * Kept beside the decision and asserted against `MENU` by `access.test.ts`, so
 * the sidebar cannot start offering an item the route refuses — the failure
 * that had `reports` and `audit` removed from the menu once already.
 */
export const INSIGHT_GRANTS: readonly [Grant, ...Grant[]] = [
  'automation.view',
  'report.financial.view',
]

export type InsightAccess =
  | { outcome: 'allow'; actor: Actor }
  | { outcome: 'sign_in' }
  | { outcome: 'no_workspace' }
  /**
   * Every door refused, and at least one refused on the package.
   *
   * The actor is carried, because the screen under this lock still reads this
   * person's own rows with this person's own grants — see `page.tsx`. A lock
   * that discarded the actor could only render a brochure.
   */
  | {
      outcome: 'locked'
      actor: Actor
      grant: Grant
      entitlement: Entitlement | null
    }
  | { outcome: 'denied'; grant: Grant; reason: string }

export function decideInsightAccess(
  context: ShellContext | null,
  grants: readonly [Grant, ...Grant[]] = INSIGHT_GRANTS,
  resource?: Resource,
): InsightAccess {
  const decisions = grants.map((grant) => ({
    grant,
    decision: routeAccess(context, grant, resource),
  }))

  for (const entry of decisions) {
    if (entry.decision.outcome === 'allow') {
      return { outcome: 'allow', actor: entry.decision.actor }
    }
  }

  // Signed out and no workspace are answers about the person rather than about
  // any particular grant, so they are decided once and identically to
  // `requireGrant`. Every candidate returns the same one.
  const first = decisions[0].decision
  if (first.outcome === 'sign_in') return { outcome: 'sign_in' }
  if (first.outcome === 'no_workspace') return { outcome: 'no_workspace' }

  const planRefusal = decisions.find(
    (entry) =>
      entry.decision.outcome === 'denied' &&
      entry.decision.reason === 'plan_does_not_include',
  )

  if (planRefusal && context !== null && context.status === 'ready') {
    return {
      outcome: 'locked',
      actor: context.actor,
      grant: planRefusal.grant,
      entitlement: ENTITLEMENT_FOR_GRANT[planRefusal.grant] ?? null,
    }
  }

  // The last candidate, so the grant named in the query string is the one the
  // reader is most likely to recognise as the thing they were reaching for.
  const refused = decisions[decisions.length - 1]
  return {
    outcome: 'denied',
    grant: refused.grant,
    reason:
      refused.decision.outcome === 'denied'
        ? refused.decision.reason
        : 'missing_permission',
  }
}
