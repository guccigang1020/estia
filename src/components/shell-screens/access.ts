/**
 * EXECUTION CONTEXT — SERVER ONLY. Not a component.
 *
 * `requireGrant` for a route that more than one grant legitimately opens.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `requireGrant` in `app/(app)/_lib/guard.ts` takes exactly one grant, which is
 * right for `/bookings` and `/finance/payments` and wrong for a screen that is
 * a union of independent questions. `calendar/_lib/access.ts` hit this first —
 * the desk sees the booking behind a taken night, an external seller is told
 * only that the night is taken — and wrote the pattern out. Two more screens
 * need it: `/action-center` is five questions with four different grants, and
 * `/activity` shows an audit trail and a booking transition log, which are two
 * records with two grants and two different guarantees.
 *
 * Rather than a third and fourth copy of the same redirect, the pattern is
 * stated once here. It is deliberately *only* the door: it returns the grant
 * that admitted the person and decides nothing else. Whether a panel has
 * content, whether a row is in scope and whether a field may be read are asked
 * again, per panel and per row, by the query modules — which is what stops "was
 * admitted" from ever meaning "may see everything on the page".
 *
 * IT SHARES NOTHING WITH THE MENU. `src/components/nav/menu.ts` sits in the
 * same directory tree and neither file imports the other. Both ask
 * `authorize()` independently, exactly as `_lib/access.ts` sets out: deleting
 * the menu changes no access decision, and a menu entry listing the wrong
 * grants cannot open a route.
 *
 * It lives beside the screens that use it rather than in `app/(app)/_lib/`
 * because that directory is shared with every other feature route and is not
 * this work's to change.
 */

import { redirect } from 'next/navigation'

import { authorize, type Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { ALL_PROPERTIES, type ShellContext } from '@/app/(app)/_lib/context'
import { requireContext } from '@/app/(app)/_lib/guard'

/** Matches `SHELL_HOME` in `guard.ts`; a refusal lands where it explains itself. */
const SHELL_HOME = '/dashboard'

export interface ScreenAccess {
  actor: Actor
  organizationId: string
  /** A single property id, or null for every property in scope. */
  propertyId: string | null
  /** The property's own name, when one is selected and its row was readable. */
  propertyName: string | null
  /**
   * The grant that admitted them.
   *
   * Reported rather than acted on. It is useful for a screen that wants to say
   * "you are here on `availability.view`, which is why the prices are absent",
   * and it must never be used to decide a row — the query modules ask again.
   */
  grant: Grant
  /** The whole context, for a screen that needs the user or the role badges. */
  context: Extract<ShellContext, { status: 'ready' }>
}

/**
 * The screen's context, or a redirect.
 *
 * `grants` is ordered least-privileged first, so the grant reported on a
 * refusal is the smallest one that would have admitted this person — the one an
 * administrator would actually have to give them. The refusal carries the
 * engine's own reason, so the landing page can distinguish "you may not" from
 * "your package does not include this".
 *
 * Fails closed: every branch that is not an explicit allow ends in a redirect,
 * and `redirect()` throws, so nothing after a refusal runs.
 */
export async function requireAnyGrant(
  grants: readonly [Grant, ...Grant[]],
): Promise<ScreenAccess> {
  const context = await requireContext()

  // No usable workspace is not a refusal — the landing page explains which of
  // the three states the person is actually in. Same branch `guard.ts` takes.
  if (context.status !== 'ready') redirect(SHELL_HOME)

  const { actor } = context
  const admitted = grants.find((grant) => authorize(actor, grant).allowed)

  if (!admitted) {
    const decision = authorize(actor, grants[0])
    const reason = decision.allowed ? 'missing_permission' : decision.reason
    redirect(
      `${SHELL_HOME}?denied=${encodeURIComponent(grants[0])}` +
        `&reason=${encodeURIComponent(reason)}`,
    )
  }

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  return {
    actor,
    organizationId: context.workspace.organizationId,
    propertyId,
    propertyName:
      propertyId === null
        ? null
        : (context.properties.find((property) => property.id === propertyId)
            ?.name ?? null),
    grant: admitted,
    context,
  }
}
