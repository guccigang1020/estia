/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The route guard for the authenticated area.
 *
 * Layered exactly the way the existing `(auth)/(protected)/layout.tsx` sets
 * out, and for the same reasons:
 *
 *   1. `src/proxy.ts` redirects optimistically, before rendering. It runs on
 *      prefetches too and is explicitly not the gate.
 *   2. `getCurrentUser()` revalidates the JWT against the auth server. That is
 *      the authentication gate, and it lives inside `shellContext()`.
 *   3. `authorize()` decides what the person may do. That is this file.
 *   4. Row level security refuses regardless of all three.
 *
 * `requireGrant` is what a feature route calls at the top of its own page.
 * Nothing about the navigation menu participates: an item hidden from the
 * sidebar is still refused here, and an item shown by mistake is still refused
 * here. That separation is the point — see the note in `access.ts`.
 */

import { redirect } from 'next/navigation'

import type { Actor, Resource } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'

import { routeAccess } from './access'
import { shellContext, type ShellContext } from './context'

/** Where a refused person lands, with the reason stated on arrival. */
const SHELL_HOME = '/dashboard'

/** Matches `SIGN_IN_PATH` in `src/lib/supabase/proxy.ts`. */
const SIGN_IN = '/sign-in'

/**
 * The context, or a redirect.
 *
 * Used by the shell layout, so that no page below it ever renders for a
 * signed-out request. `redirect()` throws, so nothing after this returns.
 */
export async function requireContext(): Promise<ShellContext> {
  const context = await shellContext()
  if (!context) redirect(SIGN_IN)
  return context
}

/**
 * Refuse unless the actor holds this grant.
 *
 * The refusal is a redirect to the shell's landing page carrying the grant
 * that was missing, rather than a thrown error: the person is legitimately
 * signed in and legitimately inside their organization, and a blank error
 * screen would tell them nothing about what happened. The `denied` parameter
 * is a grant code they just attempted, so it discloses nothing they did not
 * already know.
 *
 * Fails closed. Every branch that is not an explicit allow ends in a redirect.
 */
export async function requireGrant(
  grant: Grant,
  resource?: Resource,
): Promise<Actor> {
  const decision = routeAccess(await shellContext(), grant, resource)

  switch (decision.outcome) {
    case 'allow':
      return decision.actor
    case 'sign_in':
      redirect(SIGN_IN)
    // A person with no usable workspace has nowhere to be refused from; the
    // landing page explains the state they are actually in.
    case 'no_workspace':
      redirect(SHELL_HOME)
    case 'denied':
      redirect(
        `${SHELL_HOME}?denied=${encodeURIComponent(grant)}&reason=${encodeURIComponent(decision.reason)}`,
      )
  }
}
