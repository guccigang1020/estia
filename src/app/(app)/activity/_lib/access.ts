/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Who may open the activity screen.
 *
 * WHY TWO GRANTS. The screen shows two records — the audit trail the product
 * writes, and the booking domain's own transition log — and they are gated
 * differently on purpose. `audit_events_select` demands `audit.view`, which in
 * the shipped role set is held only by the owner and the administrator.
 * `booking_status_history` is readable with `booking.view`, which the whole
 * booking desk holds.
 *
 * Gating the route on `audit.view` alone would refuse a receptionist a
 * chronological view of the bookings they themselves moved this morning, which
 * they may read one at a time on `/bookings/[id]` already. Gating it on
 * `booking.view` alone would refuse an accountant who holds the audit right and
 * not the booking one. So both open the door, each panel asks for its own grant
 * again, and the screen states which of the two records it is not showing the
 * reader rather than quietly rendering a shorter list.
 */

import { requireAnyGrant } from '@/components/shell-screens/access'

import { ACTIVITY_GRANTS } from './queries'

export function requireActivityAccess() {
  return requireAnyGrant(ACTIVITY_GRANTS)
}
