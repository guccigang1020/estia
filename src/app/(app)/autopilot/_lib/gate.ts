/**
 * EXECUTION CONTEXT — SERVER ONLY. The route guard for every Autopilot screen.
 *
 * ── Why not `requireGrant` ───────────────────────────────────────────────
 *
 * The same argument `automations/_lib/gate.ts` and `agents/_lib/gate.ts` both
 * make, and it applies here harder than to either of them. `requireGrant`
 * flattens every refusal into one redirect and one sentence — "המסך שביקשת
 * דורש הרשאה שאין לך" — and for Autopilot that sentence is false for almost
 * everybody who will see it.
 *
 * `autopilot` is the twentieth entitlement and 0046 refuses to put it on any
 * plan: it is add-on only, granted per customer through
 * `organization_subscriptions.entitlement_grants`. So the DEFAULT state of
 * every organization in the product is "holds the grants, lacks the feature",
 * and telling an owner they lack a permission would send them to an
 * administrator who cannot help — for a capability whose whole sales motion is
 * that ESTIA offers it deliberately.
 *
 * ── Why it is not the automations gate imported ──────────────────────────
 *
 * That gate lives inside another screen group's `_lib`, owned by another
 * worker, and importing it would make this section's refusal policy their
 * dependency. The one line that matters — which entitlement a grant needs — is
 * read from the catalogue's own `ENTITLEMENT_FOR_GRANT` in both places, so the
 * two functions cannot disagree about the answer.
 *
 * ── It is not a weaker gate ──────────────────────────────────────────────
 *
 * Every outcome except `plan_does_not_include` is the identical redirect
 * `guard.ts` performs, through the identical `routeAccess` decision. And it is
 * only the door: which panels have content, which rows are in scope and which
 * fields may be read are asked again by the query modules, and row level
 * security refuses underneath all of it — `autopilot_actions_select` requires
 * `autopilot.activity_view`, which `autopilot.view` does not imply.
 *
 * ── The capability state is not consulted here ───────────────────────────
 *
 * `autopilot_capability` records WHY a customer does or does not hold the
 * entitlement — trial, suspended, and who decided. It is deliberately not a
 * second gate: `platform/capabilities.ts` argues that two tables answering
 * "does this customer have X" is two answers, and the day they disagree nobody
 * knows which the customer is living in. The entitlement is the gate. The
 * capability row is something the screens READ, to say "בתקופת התנסות עד
 * ה־14" rather than to decide anything.
 */

import { redirect } from 'next/navigation'

import { routeAccess } from '@/app/(app)/_lib/access'
import { ALL_PROPERTIES, shellContext } from '@/app/(app)/_lib/context'
import type { ShellContext } from '@/app/(app)/_lib/context'
import type { Actor, Resource } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import {
  ENTITLEMENT_FOR_GRANT,
  type Entitlement,
} from '@/lib/plans/entitlements'

/** Matches `SHELL_HOME` in `_lib/guard.ts`. The same landing page. */
const SHELL_HOME = '/dashboard'

/** Matches `SIGN_IN_PATH` in `src/lib/supabase/proxy.ts`. */
const SIGN_IN = '/sign-in'

type ReadyContext = Extract<ShellContext, { status: 'ready' }>

export type AutopilotAccess = {
  /**
   * `locked` means: holds the grant, the package does not include the module.
   * The screen renders the offer rather than redirecting — see `plan-lock`.
   */
  kind: 'allow' | 'locked'
  actor: Actor
  organizationId: string
  /** A single property id, or null for every property in scope. */
  propertyId: string | null
  propertyName: string | null
  /** Null when the refusal named no entitlement, which should not happen here. */
  entitlement: Entitlement | null
  grant: Grant
  context: ReadyContext
}

export async function requireAutopilotGrant(
  grant: Grant,
  resource?: Resource,
): Promise<AutopilotAccess> {
  const context = await shellContext()
  const decision = routeAccess(context, grant, resource)

  if (decision.outcome === 'sign_in') redirect(SIGN_IN)
  if (decision.outcome === 'no_workspace') redirect(SHELL_HOME)

  if (
    decision.outcome === 'denied' &&
    (decision.reason !== 'plan_does_not_include' ||
      context === null ||
      context.status !== 'ready')
  ) {
    redirect(
      `${SHELL_HOME}?denied=${encodeURIComponent(grant)}` +
        `&reason=${encodeURIComponent(decision.reason)}`,
    )
  }

  // Narrowing for the type system. Every other branch above ends in a
  // `redirect()`, which throws, so nothing reaches here without a ready
  // context — but the compiler cannot know that and neither should a reader.
  if (context === null || context.status !== 'ready') redirect(SHELL_HOME)

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  return {
    kind: decision.outcome === 'allow' ? 'allow' : 'locked',
    actor: context.actor,
    organizationId: context.workspace.organizationId,
    propertyId,
    propertyName:
      propertyId === null
        ? null
        : (context.properties.find((property) => property.id === propertyId)
            ?.name ?? null),
    entitlement: ENTITLEMENT_FOR_GRANT[grant] ?? null,
    grant,
    context,
  }
}
