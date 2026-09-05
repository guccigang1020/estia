/**
 * The platform console's access decision, as a pure function.
 *
 * The customer side splits this the same way, for the same reason: the part
 * that decides can be tested without a request, a cookie jar or a database,
 * and the part that redirects cannot. `src/app/(platform)/_lib/guard.ts` is
 * the wrapper; this is the decision.
 *
 * ══ IT IS A DIFFERENT QUESTION, NOT A STRICTER ONE ════════════════════════
 *
 * `routeAccess()` in `src/app/(app)/_lib/access.ts` asks "may this member do
 * this inside their organization". This asks "is this person ESTIA staff, and
 * do they hold this platform grant". The two share no code and no fallback,
 * which is the property that matters:
 *
 *   · There is no branch here that consults a membership. A customer's owner,
 *     holding every grant their organization can issue, is refused by this
 *     function exactly as a stranger is, because none of those grants is a
 *     platform grant and none of them puts a row in `platform_staff`.
 *
 *   · There is no branch here that falls through to the customer guard. A
 *     refused caller is not redirected into their own dashboard — the console
 *     answers as though the route did not exist, so a customer who guesses the
 *     URL learns nothing from the answer they get.
 *
 * ── Deny by default, and the switch proves it ─────────────────────────────
 *
 * Every outcome below is produced by an explicit branch. `null` is refused
 * before anything else is read, and an unknown grant cannot reach `allow`
 * because `session.grants` is already narrowed to platform codes by
 * `platformGrants()`.
 */

import type { PlatformGrant, PlatformSession } from './staff'
import { holdsPlatformGrant } from './staff'

export type PlatformAccess =
  /** Signed out. There is nobody to ask about. */
  | { outcome: 'sign_in' }
  /**
   * Signed in and not ESTIA staff.
   *
   * The console must answer this the way it answers a request for a route
   * that does not exist. Distinguishing "you may not" from "there is nothing
   * here" would confirm the console's existence to every customer who tried
   * the URL, and its existence is the first thing an attacker needs.
   */
  | { outcome: 'not_staff' }
  /** ESTIA staff, and this particular grant is not theirs. */
  | { outcome: 'denied'; grant: PlatformGrant }
  | { outcome: 'allow'; session: PlatformSession }

/**
 * Decide whether this request may render this console route.
 *
 * `session` of `null` covers both "signed out" and "signed in but not on the
 * roster" — the resolver cannot tell them apart without disclosing which it
 * is, and the caller does not need to know: `signedIn` is passed separately so
 * the two produce different *responses* without this function ever asking the
 * database a second question.
 *
 * `grant` of `null` is a route that needs nothing beyond being staff. The
 * console's own landing page is the only one, and it is written out rather
 * than defaulted so that a page cannot forget to name its grant and silently
 * become the unguarded one.
 */
export function platformAccess(
  session: PlatformSession | null,
  signedIn: boolean,
  grant: PlatformGrant | null,
): PlatformAccess {
  if (!signedIn) return { outcome: 'sign_in' }
  if (!session) return { outcome: 'not_staff' }

  if (grant === null) return { outcome: 'allow', session }

  if (!holdsPlatformGrant(session, grant)) {
    return { outcome: 'denied', grant }
  }

  return { outcome: 'allow', session }
}

/**
 * Whether a console screen should offer a control at all.
 *
 * Convenience for rendering, never an access decision: the action behind every
 * control checks for itself, and a control shown by mistake is still refused
 * by the server action, by the database function's `has_platform_permission`
 * check, and by the row level security policy underneath it.
 */
export function mayUse(
  session: PlatformSession,
  grant: PlatformGrant,
): boolean {
  return holdsPlatformGrant(session, grant)
}
