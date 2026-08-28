/**
 * The route access decision, as a pure function.
 *
 * This is the part of route guarding that can be tested without a request, a
 * cookie jar or a database, so it is separated from the `redirect()` wrapper
 * in `guard.ts` that cannot.
 *
 * IT SHARES NOTHING WITH THE MENU. `src/components/nav/menu.ts` does not
 * import this file and this file does not import it. They ask the same engine
 * — `authorize()` in `src/lib/authz/can.ts` — and they ask it independently,
 * which is the property that matters: deleting the menu changes no access
 * decision, and a bug in the menu cannot open a route. A menu entry is a hint
 * about where to go; this is the thing that says yes or no.
 */

import { authorize, type Actor, type Resource } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'

import type { ShellContext } from './context'

export type AccessDecision =
  /** Signed out. There is no actor to ask about. */
  | { outcome: 'sign_in' }
  /**
   * Signed in, but there is no workspace to act in — no membership, a
   * suspended one, or an organization with no live subscription. The person
   * is sent to the shell's own landing state, which explains which of the
   * three it is.
   */
  | { outcome: 'no_workspace'; reason: ShellContext['status'] }
  /** Signed in, in a workspace, and refused. */
  | { outcome: 'denied'; grant: Grant; reason: string }
  | { outcome: 'allow'; actor: Actor }

/**
 * Decide whether this request may render this route.
 *
 * `context` of `null` means signed out. Every other outcome is derived from
 * the authorization engine, including the refusal reason, so the screen can
 * distinguish "you may not" from "your plan does not include this" without a
 * second rule written somewhere else.
 */
export function routeAccess(
  context: ShellContext | null,
  grant: Grant | null,
  resource?: Resource,
): AccessDecision {
  if (!context) return { outcome: 'sign_in' }

  if (context.status !== 'ready') {
    return { outcome: 'no_workspace', reason: context.status }
  }

  // A route that requires nothing beyond an active membership. The shell's own
  // landing page is the only one of these, and it is written out rather than
  // defaulted so that `requireGrant(null)` cannot happen by accident.
  if (grant === null) return { outcome: 'allow', actor: context.actor }

  const decision = authorize(context.actor, grant, resource)

  if (!decision.allowed) {
    return { outcome: 'denied', grant, reason: decision.reason }
  }

  return { outcome: 'allow', actor: context.actor }
}
