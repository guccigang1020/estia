/**
 * `MetricSource`, backed by Supabase.
 *
 * The reference implementation is `src/lib/metrics/memory-source.ts` and its
 * header asks whoever writes the real queries to read it first and answer
 * identically. The three rules it and `source.ts` between them impose are
 * followed literally:
 *
 * **Return the union, not the intersection.** A booking belongs in the result
 * if its stay overlaps the window, *or* it arrives in it, *or* it was created
 * in it, *or* it was committed in it, *or* it was cancelled in it. Different
 * metrics want different bookings, and a source that returned only overlapping
 * stays would silently zero conversion rate and booking pace — producing a
 * dashboard full of plausible, understated numbers, which is the worst
 * possible failure for a reporting layer. Filtering the union in SQL would
 * mean five OR'd predicates over four columns; this reads a slightly wider
 * window and lets `filterToScope` and each metric narrow. Over-returning is
 * explicitly harmless: "the same numbers, slower".
 *
 * **Dates are property-local.** Every timestamp is converted with `localDate`
 * from `booking/dates.ts` before it leaves this file. A booking created at
 * 23:00 in Israel belongs to that day's pace; in UTC it is still yesterday for
 * two hours out of every twenty-four, and a pace chart built on UTC is wrong
 * every single evening.
 *
 * **Money is integer agorot, net of tax.** VAT collected for the state was
 * never revenue, and including it overstates every figure by seventeen per
 * cent. The `tax` price lines are excluded from every total below.
 *
 * ── Three mappings the schema does not determine ──────────────────────────
 *
 * Named here rather than buried, because each is a decision this adapter had
 * to take and a future migration should take back.
 *
 * **1. A unit's in-service span.** `UnitInventoryRow` wants the first and last
 * night a unit was part of the inventory. `units` has no such columns, so
 * `created_at` and `deleted_at` stand in. The consequence is real and
 * one-directional: a business that has been running for years and adopts ESTIA
 * this month has every unit reporting `inServiceFrom` as this month, so
 * occupancy for any earlier window counts no available nights at all. That is
 * visibly wrong rather than subtly wrong, which is the better failure — but it
 * is a reason not to backfill history without an `in_service_from` column.
 *
 * **2. Out of service.** There is no maintenance-window table. The closest
 * real record is a hold with reason `maintenance_block`, which is exactly "a
 * span during which a unit could not be sold" and is how a staff member
 * actually blocks a unit today. Released holds are excluded; expired ones are
 * not, because a maintenance window that has passed still consumed the nights
 * it covered.
 *
 * **3. When a booking was committed.** `committedOn` is "the property-local
 * date it first reached a committed status". The domain does not define which
 * statuses those are, so this reads `booking_status_history` — the append-only
 * table the `bookings_record_status` trigger maintains — and takes the
 * earliest transition into an occupying status other than `option`. An option
 * is held, not sold, and counting it as a commitment would let a week of
 * speculative holds look like a week of sales.
 */

import { localDate } from '../booking/dates'
import {
  BOOKING_SOURCES,
  BOOKING_STATUSES,
  OCCUPYING_STATUSES,
  type BookingStatus,
} from '../booking/types'
import { SETTLED_PAYMENT_STATUSES } from '../contracts/states'
import type {
  BookingFactRow,
  OutOfServiceRow,
  UnitInventoryRow,
} from '../metrics/rows'
import type { ResolvedScope } from '../metrics/scope'
import type { MetricSource } from '../metrics/source'
import type { MetricRange } from '../metrics/types'
import { addDays } from '../booking/dates'
import type { Db, Row } from './client'
import {
  asAgorot,
  asEnum,
  asIsoDate,
  asString,
  asStringOrNull,
  toRows,
} from './mapping'

/**
 * Statuses that mean the guest committed.
 *
 * Derived from the booking contract rather than restated, so a status added
 * there cannot quietly fall out of booking pace. `option` is removed for the
 * reason `rows.ts` gives about ADR: it blocks the calendar and earns nothing.
 */
const COMMITTED_STATUSES: readonly BookingStatus[] = OCCUPYING_STATUSES.filter(
  (status) => status !== 'option',
)

/** Price-line kinds that are the room itself. */
const ROOM_KINDS = new Set(['accommodation', 'extra_guest'])
/** Everything else sold with the stay. */
const ANCILLARY_KINDS = new Set(['addon', 'cleaning_fee'])
/** Reductions. Negative amounts, netted into the room. */
const REDUCTION_KINDS = new Set(['discount', 'promotion'])

export class SupabaseMetricSource implements MetricSource {
  constructor(private readonly db: Db) {}

  async loadUnits(
    scope: ResolvedScope,
    range: MetricRange,
  ): Promise<readonly UnitInventoryRow[]> {
    let query = this.db
      .from('units')
      .select('id, property_id, created_at, deleted_at')
      .eq('organization_id', scope.organizationId)

    query = applyScope(query, scope)

    const { data, error } = await query
    if (error) throw error

    return toRows(data)
      .map((row) => {
        const createdOn = localDate(new Date(asString(row, 'created_at')))
        const deletedAt = asStringOrNull(row, 'deleted_at')
        return {
          unitId: asString(row, 'id'),
          propertyId: asString(row, 'property_id'),
          inServiceFrom: createdOn,
          inServiceUntil:
            deletedAt === null ? null : localDate(new Date(deletedAt)),
        }
      })
      .filter(
        // The same span test `InMemoryMetricSource` applies, kept here rather
        // than pushed into SQL: the columns standing in for the span are a
        // decision this file owns, so the arithmetic over them belongs beside
        // the decision.
        (unit) =>
          (unit.inServiceFrom === null || unit.inServiceFrom < range.end) &&
          (unit.inServiceUntil === null || unit.inServiceUntil > range.start),
      )
  }

  async loadOutOfService(
    scope: ResolvedScope,
    range: MetricRange,
  ): Promise<readonly OutOfServiceRow[]> {
    let query = this.db
      .from('holds')
      .select('unit_id, property_id, check_in, check_out')
      .eq('organization_id', scope.organizationId)
      .eq('reason', 'maintenance_block')
      // Released means the block was lifted; it never consumed those nights.
      // Expired is *not* excluded — a maintenance window that has since passed
      // still took the unit out of service while it ran.
      .is('released_at', null)
      .lt('check_in', range.end)
      .gt('check_out', range.start)

    query = applyScope(query, scope)

    const { data, error } = await query
    if (error) throw error

    return toRows(data).map((row) => ({
      unitId: asString(row, 'unit_id'),
      propertyId: asString(row, 'property_id'),
      from: asIsoDate(row, 'check_in'),
      to: asIsoDate(row, 'check_out'),
    }))
  }

  async loadBookings(
    scope: ResolvedScope,
    range: MetricRange,
  ): Promise<readonly BookingFactRow[]> {
    // The union rule, approximated by widening rather than by five OR'd
    // predicates. A booking qualifies through its stay, its arrival, its
    // creation, its commitment or its cancellation — and every one of those
    // dates sits within a stay's length of the window, except creation and
    // cancellation, which precede arrival. Reading from a year before the
    // window start covers all five with one range test, and `source.ts` is
    // explicit that over-returning changes nothing but speed.
    const widened = {
      start: addDays(range.start, -LEAD_TIME_DAYS),
      end: range.end,
    }

    let query = this.db
      .from('bookings')
      .select(
        'id, property_id, unit_id, status, source, check_in, check_out, ' +
          'created_at, metadata, ' +
          'booking_price_lines(kind, amount_agorot), ' +
          'booking_status_history(to_status, occurred_at), ' +
          'payments(status, amount_agorot, amount_refunded_agorot), ' +
          'commissions(amount_agorot, status)',
      )
      .eq('organization_id', scope.organizationId)
      .is('deleted_at', null)
      .gte('check_out', widened.start)
      .lt('created_at', `${range.end}T00:00:00Z`)

    query = applyScope(query, scope)

    const { data, error } = await query
    if (error) throw error

    return toRows(data).map((row) => this.toFact(row))
  }

  private toFact(row: Row): BookingFactRow {
    const lines = toRows(row.booking_price_lines)
    const history = toRows(row.booking_status_history)
    const payments = toRows(row.payments)
    const commissions = toRows(row.commissions)
    const status = asEnum(row, 'status', BOOKING_STATUSES)

    return {
      bookingId: asString(row, 'id'),
      propertyId: asString(row, 'property_id'),
      unitId: asString(row, 'unit_id'),
      status,
      source: asEnum(row, 'source', BOOKING_SOURCES),
      checkIn: asIsoDate(row, 'check_in'),
      checkOut: asIsoDate(row, 'check_out'),
      createdOn: localDate(new Date(asString(row, 'created_at'))),
      committedOn: firstTransitionInto(history, COMMITTED_STATUSES),
      cancelledOn: firstTransitionInto(history, ['cancelled']),
      // Accommodation and extra-guest lines, with discounts and promotions
      // netted in — `rows.ts`: "`roomRevenue` is what the guest actually owes
      // for the room". `tax` is absent from every set, which is how the whole
      // figure comes out net.
      roomRevenue:
        sumLines(lines, ROOM_KINDS) + sumLines(lines, REDUCTION_KINDS),
      ancillaryRevenue: sumLines(lines, ANCILLARY_KINDS),
      // From the `commissions` table, not from the `agent_commission` price
      // line. The table is what an agent is actually owed and what a payout
      // settles against; the price line is a presentational restatement, and
      // reading both would give two answers to one question. Cancelled
      // commissions are excluded — nobody is owed them. Stored positive, as
      // `rows.ts` requires of a cost.
      commission: Math.abs(
        commissions
          .filter((entry) => asString(entry, 'status') !== 'cancelled')
          .reduce(
            (total, entry) => total + asAgorot(entry, 'amount_agorot'),
            0,
          ),
      ),
      collected: collectedFrom(payments),
      // No column for it. A complimentary stay is a real concept the schema
      // does not model, so it is read from `bookings.metadata.isComplimentary`
      // — an adapter-owned convention a migration should replace with a
      // column. Absent means false, which is the safe reading: a stay is a
      // sale unless somebody said otherwise.
      isComplimentary:
        row.metadata !== null &&
        typeof row.metadata === 'object' &&
        (row.metadata as Record<string, unknown>).isComplimentary === true,
    }
  }
}

/**
 * How far before a window a relevant booking can have been created.
 *
 * A year. Long enough to catch the conversion-rate denominator for a stay
 * booked eleven months ahead, short enough that a dashboard does not read the
 * whole table. The cost of getting this wrong in one direction is a slower
 * query; in the other it is an understated conversion rate, so it errs long.
 */
const LEAD_TIME_DAYS = 365

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Narrow a query to the scope the actor may aggregate.
 *
 * `ResolvedScope` has already been reduced to what this membership is allowed
 * to see, and `filterToScope` narrows again after the rows come back. Both
 * floors are deliberate: this one keeps the query from reading rows it has no
 * business reading, and the second one means a mistake here is a bug rather
 * than a leak. `null` on either field means "not narrowed", which for a
 * property-scoped membership is still bounded by `organization_id` above.
 */
function applyScope<T extends ScopedQuery>(query: T, scope: ResolvedScope): T {
  let narrowed = query
  if (scope.propertyIds !== null) {
    narrowed = narrowed.in('property_id', [...scope.propertyIds]) as T
  }
  if (scope.unitIds !== null) {
    narrowed = narrowed.in('unit_id', [...scope.unitIds]) as T
  }
  return narrowed
}

interface ScopedQuery {
  in(column: string, values: readonly string[]): unknown
}

/** The property-local date of the earliest transition into any of `targets`. */
function firstTransitionInto(
  history: readonly Row[],
  targets: readonly string[],
): string | null {
  const wanted = new Set(targets)
  let earliest: string | null = null

  for (const entry of history) {
    if (!wanted.has(asString(entry, 'to_status'))) continue
    const occurredAt = asString(entry, 'occurred_at')
    if (earliest === null || occurredAt < earliest) earliest = occurredAt
  }

  return earliest === null ? null : localDate(new Date(earliest))
}

function sumLines(lines: readonly Row[], kinds: ReadonlySet<string>): number {
  return lines
    .filter((line) => kinds.has(asString(line, 'kind')))
    .reduce((total, line) => total + asAgorot(line, 'amount_agorot'), 0)
}

/**
 * What has actually been received against this booking, net of refunds.
 *
 * Only settled statuses count. A `pending` payment is an intention and an
 * `authorized` one is a hold on somebody's card — neither is money the
 * business has, and counting either would report cash that is not there.
 */
function collectedFrom(payments: readonly Row[]): number {
  const settled = new Set<string>(SETTLED_PAYMENT_STATUSES)
  return payments
    .filter((payment) => settled.has(asString(payment, 'status')))
    .reduce(
      (total, payment) =>
        total +
        asAgorot(payment, 'amount_agorot') -
        asAgorot(payment, 'amount_refunded_agorot'),
      0,
    )
}
