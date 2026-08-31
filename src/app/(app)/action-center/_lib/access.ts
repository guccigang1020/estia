/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Who may open the action centre.
 *
 * WHY THIS IS NOT `requireGrant`. The screen is a union of five independent
 * questions — who arrives today, who leaves, what money is still owed, what
 * work is stuck, what decision is waiting — and no single grant in the
 * catalogue is held by everybody who legitimately has one of them to answer. A
 * receptionist holds `booking.view` and `payment.view` and no approval grant; a
 * finance manager holds `approval.decide` and `payment.view` and never opens a
 * task; a cleaner holds `task.view` and nothing else. Gating on any one of
 * those refuses somebody whose day this screen is about.
 *
 * `requireAnyGrant` is the shape `calendar/_lib/access.ts` set out for the same
 * reason, stated once in `components/shell-screens/access.ts`.
 *
 * IT IS THE DOOR, NOT THE ROWS. Being admitted answers nothing about which
 * panels have content. Every panel asks `holdsGrant` for its own grant before
 * it queries, and every row is checked again with `can()` against the property
 * it belongs to — so a receptionist admitted on `booking.view` sees no
 * approvals panel at all rather than an empty one, and a property manager sees
 * only their own property's rows.
 */

import { requireAnyGrant } from '@/components/shell-screens/access'

import { ACTION_CENTER_GRANTS } from './queries'

export function requireActionCenterAccess() {
  return requireAnyGrant(ACTION_CENTER_GRANTS)
}
