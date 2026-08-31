/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The one route in the product whose door is wider than its room.
 *
 * ── The asymmetry, and where it comes from ────────────────────────────────
 *
 * The permission catalogue splits reporting a fault from reading the faults:
 *
 *   · `cleaner` holds `incident.create` and nothing else about incidents.
 *   · `reception` holds `incident.create` and nothing else about incidents.
 *   · `maintenance` and `housekeeping_supervisor` hold `incident.view` too.
 *
 * That is a deliberate product decision, not an oversight. A cleaner who finds
 * a cracked shower screen must be able to report it in ten seconds from a
 * landing, and must not be handed a register of every fault in the business —
 * which is a list of what is wrong with the buildings, who reported it, and by
 * implication which units are unlettable this weekend.
 *
 * `requireGrant` takes one grant and cannot express "either of these", so this
 * is that guard. It does not re-implement the decision: it asks `routeAccess`,
 * which asks `authorize()`, exactly as `guard.ts` does — once per grant — and
 * returns which of them was admitted so the page can render the right screen.
 * Deny by default: every branch that is not an explicit allow ends in a
 * redirect, and the redirect carries the *viewing* grant because that is the
 * one the person attempted by opening this URL.
 *
 * The menu is not involved and cannot be. `src/components/nav/menu.ts` offers
 * `/incidents` to anybody holding either grant, and that entry is a hint about
 * where to go; this is the thing that says yes or no. Deleting the menu changes
 * no decision here, and a menu bug cannot open the register.
 */

import { redirect } from 'next/navigation'

import type { Actor } from '@/lib/authz/can'

import { routeAccess } from '../../_lib/access'
import { shellContext } from '../../_lib/context'

/** Matches `SHELL_HOME` in `(app)/_lib/guard.ts`. */
const SHELL_HOME = '/dashboard'

/** Matches `SIGN_IN_PATH` in `src/lib/supabase/proxy.ts`. */
const SIGN_IN = '/sign-in'

export type IncidentAccess = {
  actor: Actor
  /** May read the organization's faults. False for a cleaner. */
  mayBrowse: boolean
  /** May report one. True for everybody who reaches this route at all. */
  mayReport: boolean
}

/**
 * Admit anybody who may either read the register or write to it.
 *
 * `redirect()` throws, so nothing after a refusal returns.
 */
export async function requireIncidentAccess(): Promise<IncidentAccess> {
  const context = await shellContext()

  const viewing = routeAccess(context, 'incident.view')
  const reporting = routeAccess(context, 'incident.create')

  if (viewing.outcome === 'sign_in') redirect(SIGN_IN)

  // A person with no usable workspace has nowhere to be refused from; the
  // landing page explains the state they are actually in.
  if (viewing.outcome === 'no_workspace') redirect(SHELL_HOME)

  if (viewing.outcome === 'allow') {
    return {
      actor: viewing.actor,
      mayBrowse: true,
      mayReport: reporting.outcome === 'allow',
    }
  }

  if (reporting.outcome === 'allow') {
    return { actor: reporting.actor, mayBrowse: false, mayReport: true }
  }

  // Neither. The refusal names `incident.view`, which is the grant they
  // attempted by opening this URL — and which discloses nothing they did not
  // already know.
  redirect(
    `${SHELL_HOME}?denied=${encodeURIComponent('incident.view')}&reason=${encodeURIComponent(
      viewing.reason,
    )}`,
  )
}
