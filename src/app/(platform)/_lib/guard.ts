/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The route guard for the ESTIA platform console.
 *
 * ══ THE REFUSAL IS A 404, AND THAT IS THE DESIGN ══════════════════════════
 *
 * The customer guard in `src/app/(app)/_lib/guard.ts` redirects a refused
 * member to their own dashboard carrying the grant they lacked. That is right
 * there: the person is legitimately signed in, legitimately inside their
 * organization, and the grant code discloses nothing they did not already
 * know.
 *
 * It would be wrong here. A customer who types `/platform` and is bounced to
 * their dashboard with `?denied=platform.organization.view` has just been told
 * that ESTIA has a console, where it lives, and what it is called. So the
 * console answers a non-staff caller the way the application answers a request
 * for a page that does not exist — `notFound()`, resolved by the same root
 * `not-found.tsx` a stranger gets — and there is no branch anywhere in this
 * file that falls through to a customer membership.
 *
 * ── The four layers, same as everywhere else in this product ──────────────
 *
 *   1. `src/proxy.ts` redirects a signed-out request to `/sign-in` before
 *      rendering. `/platform` is not in `PUBLIC_PREFIXES`, so this happens
 *      without a line of code here. It is optimistic and is not the gate.
 *   2. `getCurrentUser()` revalidates the JWT against the auth server.
 *   3. This file asks whether that person is on `platform_staff` and holds
 *      the grant.
 *   4. Row level security refuses regardless — every console read is admitted
 *      by `has_platform_permission(...)` in a policy, which never consults
 *      anything in this directory.
 *
 * A bug in this file therefore leaks nothing: the queries behind every screen
 * would still return no rows.
 */

import { cache } from 'react'

import { notFound, redirect } from 'next/navigation'

import { platformAccess, resolvePlatformSession } from '@/lib/platform'
import type { PlatformGrant, PlatformSession } from '@/lib/platform'
import { createClient, getCurrentUser } from '@/lib/supabase/server'

/** Matches `SIGN_IN_PATH` in `src/lib/supabase/proxy.ts`. */
const SIGN_IN = '/sign-in'

/** Where a staff member lands when they are refused one screen of the console. */
const CONSOLE_HOME = '/platform'

/**
 * Who is asking.
 *
 * Wrapped in React `cache` so the layout, the page and any fragment below them
 * share one resolution — and, more importantly, so they cannot disagree about
 * whether the viewer is staff halfway down the tree.
 */
export const platformContext = cache(
  async (): Promise<{ signedIn: boolean; session: PlatformSession | null }> => {
    const user = await getCurrentUser()
    if (!user) return { signedIn: false, session: null }

    const db = await createClient()
    return {
      signedIn: true,
      session: await resolvePlatformSession(db, user.id),
    }
  },
)

/**
 * The session, or a refusal. Used by the console layout.
 *
 * `redirect()` and `notFound()` both throw, so nothing after them returns.
 */
export async function requirePlatformStaff(): Promise<PlatformSession> {
  return decide(null)
}

/**
 * Refuse unless the caller is staff AND holds this grant.
 *
 * Two different refusals, deliberately:
 *
 *   · Not staff → `notFound()`. See the header.
 *   · Staff without the grant → back to the console's landing page with the
 *     grant named. They already know the console exists — they are standing in
 *     it — and a support-role colleague who cannot open the suspend screen
 *     deserves a sentence rather than a blank 404 that reads like an outage.
 */
export async function requirePlatformGrant(
  grant: PlatformGrant,
): Promise<PlatformSession> {
  return decide(grant)
}

async function decide(grant: PlatformGrant | null): Promise<PlatformSession> {
  const { signedIn, session } = await platformContext()
  const decision = platformAccess(session, signedIn, grant)

  switch (decision.outcome) {
    case 'allow':
      return decision.session

    case 'sign_in':
      redirect(SIGN_IN)

    // The console does not exist, as far as this caller is concerned.
    case 'not_staff':
      notFound()

    case 'denied':
      redirect(`${CONSOLE_HOME}?denied=${encodeURIComponent(decision.grant)}`)
  }
}
