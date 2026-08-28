/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Who may open the calendar, and how much of it they are told.
 *
 * WHY THIS IS NOT `requireGrant`. The calendar is one screen for two different
 * people. The desk sees the booking behind a taken night; an external seller is
 * told only that the night is taken. `src/components/nav/menu.ts` already says
 * so — the item requires `booking.view` **or** `availability.view` — and
 * `requireGrant` takes exactly one grant, so a route gated on either one alone
 * would refuse somebody the menu correctly offered it to. `property_owner`,
 * `accountant` and `housekeeping_supervisor` hold `booking.view` without
 * `availability.view`; an agent on the availability rung holds the reverse.
 *
 * IT IS STILL THE SAME ENGINE. `authorize()` decides, once per grant, exactly
 * as `guard.ts` and `menu.ts` ask it independently. Nothing here compares a
 * role name, and the refusal lands on the same `/dashboard?denied=` screen so
 * that a person refused here reads the same explanation as one refused
 * anywhere else.
 */

import { redirect } from 'next/navigation'

import { authorize, type Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'

import { requireContext } from '../../_lib/guard'

/** Matches `SHELL_HOME` in `guard.ts`; a refusal lands where it explains itself. */
const SHELL_HOME = '/dashboard'

/**
 * Either of these opens the calendar.
 *
 * Ordered least-privileged first, so the grant reported back is the smallest
 * one that actually admitted this person. Per-unit checks below use it, which
 * means a reader is never judged against a right they were not admitted on.
 */
export const CALENDAR_GRANTS: readonly [Grant, ...Grant[]] = [
  'availability.view',
  'booking.view',
]

export interface CalendarAccess {
  actor: Actor
  organizationId: string
  /** `ALL_PROPERTIES` or a property id the shell has already validated. */
  selectedPropertyId: string
  /**
   * The grant that admitted them to the route.
   *
   * Reported rather than acted on: whether a *unit* may be drawn, and whether
   * its bookings may be named, is asked again per row in `inventory.ts` with
   * the right resource family. This is the door, not the row.
   */
  grant: Grant
}

/**
 * The calendar's context, or a redirect.
 *
 * Fails closed: every branch that is not an explicit allow ends in a redirect,
 * and `redirect()` throws, so nothing after a refusal runs.
 */
export async function requireCalendarAccess(): Promise<CalendarAccess> {
  const context = await requireContext()

  // No usable workspace is not a refusal — the landing page explains which of
  // the three states the person is actually in. Same branch `guard.ts` takes.
  if (context.status !== 'ready') redirect(SHELL_HOME)

  const { actor } = context

  const admitted = CALENDAR_GRANTS.find(
    (grant) => authorize(actor, grant).allowed,
  )

  if (!admitted) {
    // Report the refusal against the least-privileged of the two, which is the
    // one the person would have to be given. The reason comes from the engine
    // so the dashboard can distinguish "you may not" from "your plan does not
    // include this".
    const decision = authorize(actor, CALENDAR_GRANTS[0])
    const reason = decision.allowed ? 'missing_permission' : decision.reason
    redirect(
      `${SHELL_HOME}?denied=${encodeURIComponent(CALENDAR_GRANTS[0])}` +
        `&reason=${encodeURIComponent(reason)}`,
    )
  }

  return {
    actor,
    organizationId: context.workspace.organizationId,
    selectedPropertyId: context.selectedPropertyId,
    grant: admitted,
  }
}
