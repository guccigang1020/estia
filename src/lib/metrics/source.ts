/**
 * Where the numbers come from.
 *
 * An interface, not a query — the same decision, for the same reason, as
 * `ActorSource`. A dashboard is where authorization, scope, rounding and
 * calendar arithmetic all meet, and every one of those is a place a customer
 * gets shown something they should not see or something that is simply wrong.
 * None of it can be exercised properly against code that opens a database
 * connection, so the fetching is injected and everything above it is pure:
 * rows in, `DashboardResponse` out, no I/O, no clock, no environment.
 *
 * The eventual Supabase implementation is a mapping and nothing more.
 *
 * ── The contract the implementation must honour ───────────────────────────
 *
 * **Return rows for the requested scope, and no wider.** `ResolvedScope` has
 * already been narrowed to what the actor may aggregate; the query filters on
 * it, and `filterToScope` filters again afterwards. Over-returning is a bug,
 * not a leak — but only because of that second floor.
 *
 * **Bookings: return the union, not the intersection.** Different metrics need
 * different bookings, and a source that returns only stays overlapping the
 * window silently zeroes half the dictionary. A row belongs in the result if
 * *any* of these is true:
 *
 *   · the stay overlaps `[start, end)` — occupancy, room revenue, commission;
 *   · `check_in` falls inside it — fees, balances, length of stay, lead time,
 *     cancellation rate;
 *   · it was created inside it — conversion rate;
 *   · it was committed inside it — booking pace;
 *   · it was cancelled inside it and would have arrived inside it.
 *
 * Returning more than that is harmless: every metric selects the rows it wants
 * by itself, so an over-broad source produces the same numbers, slower.
 *
 * **Dates are property-local calendar dates.** Convert with `localDate` from
 * `booking/dates.ts` before the row leaves the query layer. A booking created
 * at 23:00 Israel time belongs to that day's pace, not to yesterday's, and UTC
 * disagrees for two hours out of every twenty-four.
 *
 * **Money is integer agorot, net of tax.** See `rows.ts`.
 */

import type { BookingFactRow, OutOfServiceRow, UnitInventoryRow } from './rows'
import type { ResolvedScope } from './scope'
import type { MetricRange } from './types'

export interface MetricSource {
  /** Units that were part of the inventory at any point in the window. */
  loadUnits(
    scope: ResolvedScope,
    range: MetricRange,
  ): Promise<readonly UnitInventoryRow[]>

  /** Spans inside the window during which a unit could not be sold. */
  loadOutOfService(
    scope: ResolvedScope,
    range: MetricRange,
  ): Promise<readonly OutOfServiceRow[]>

  /** Bookings relevant to the window — see the union rule above. */
  loadBookings(
    scope: ResolvedScope,
    range: MetricRange,
  ): Promise<readonly BookingFactRow[]>
}
