/**
 * A `MetricSource` held in memory.
 *
 * The reference implementation of the contract, not a throwaway mock. It shows
 * exactly what the Supabase version must return — including the union rule for
 * bookings, which is the part that is easy to get wrong and impossible to
 * notice, because a source that returns too few rows produces a dashboard full
 * of plausible, quietly understated numbers.
 *
 * Whoever writes the real queries should read this file first and make them
 * answer identically.
 */

import { rangesOverlap } from '../booking/types'
import type { BookingFactRow, OutOfServiceRow, UnitInventoryRow } from './rows'
import { filterToScope, type ResolvedScope } from './scope'
import type { MetricSource } from './source'
import { containsDate, type MetricRange } from './types'

export interface MetricWorld {
  units?: readonly UnitInventoryRow[]
  outOfService?: readonly OutOfServiceRow[]
  bookings?: readonly BookingFactRow[]
}

/** Counts of what was asked for, so a test can prove nothing was read. */
export interface MetricSourceCalls {
  loadUnits: number
  loadOutOfService: number
  loadBookings: number
}

export class InMemoryMetricSource implements MetricSource {
  readonly calls: MetricSourceCalls = {
    loadUnits: 0,
    loadOutOfService: 0,
    loadBookings: 0,
  }

  constructor(private readonly world: MetricWorld) {}

  async loadUnits(
    scope: ResolvedScope,
    range: MetricRange,
  ): Promise<readonly UnitInventoryRow[]> {
    this.calls.loadUnits += 1
    const units = this.world.units ?? []
    return filterToScope(
      scope,
      units.filter(
        (unit) =>
          (unit.inServiceFrom === null || unit.inServiceFrom < range.end) &&
          (unit.inServiceUntil === null || unit.inServiceUntil > range.start),
      ),
    )
  }

  async loadOutOfService(
    scope: ResolvedScope,
    range: MetricRange,
  ): Promise<readonly OutOfServiceRow[]> {
    this.calls.loadOutOfService += 1
    const blocks = this.world.outOfService ?? []
    return filterToScope(
      scope,
      blocks.filter(
        (block) => block.from < range.end && block.to > range.start,
      ),
    )
  }

  async loadBookings(
    scope: ResolvedScope,
    range: MetricRange,
  ): Promise<readonly BookingFactRow[]> {
    this.calls.loadBookings += 1
    const bookings = this.world.bookings ?? []
    return filterToScope(
      scope,
      bookings.filter((booking) => isRelevant(booking, range)),
    )
  }
}

/** The union rule from `source.ts`, written out. */
function isRelevant(booking: BookingFactRow, range: MetricRange): boolean {
  if (rangesOverlap(booking, { checkIn: range.start, checkOut: range.end })) {
    return true
  }
  if (containsDate(range, booking.checkIn)) return true
  if (containsDate(range, booking.createdOn)) return true
  if (booking.committedOn !== null && containsDate(range, booking.committedOn))
    return true
  if (booking.cancelledOn !== null && containsDate(range, booking.cancelledOn))
    return true
  return false
}

// ── Fixture helpers ───────────────────────────────────────────────────────

/**
 * A booking row without writing out fifteen fields.
 *
 * The defaults describe the ordinary case — a confirmed, paid, direct booking —
 * so a test that cares about cancellation or about a comp night states only
 * that.
 */
export function makeBooking(
  overrides: Partial<BookingFactRow> & Pick<BookingFactRow, 'bookingId'>,
): BookingFactRow {
  return {
    propertyId: 'prop-1',
    unitId: 'unit-1',
    status: 'confirmed',
    source: 'direct_website',
    checkIn: '2026-03-01',
    checkOut: '2026-03-04',
    createdOn: '2026-02-01',
    committedOn: '2026-02-01',
    cancelledOn: null,
    roomRevenue: 90_000,
    ancillaryRevenue: 0,
    commission: 0,
    collected: 90_000,
    isComplimentary: false,
    ...overrides,
  }
}

/** A unit that has always existed and still does. */
export function makeUnit(
  overrides: Partial<UnitInventoryRow> & Pick<UnitInventoryRow, 'unitId'>,
): UnitInventoryRow {
  return {
    propertyId: 'prop-1',
    inServiceFrom: null,
    inServiceUntil: null,
    ...overrides,
  }
}
