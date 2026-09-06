/**
 * EXECUTION CONTEXT — SERVER ONLY. The rows a revenue report is built from.
 *
 * ══ IT WRITES NOTHING, AND IT STORES NOTHING ════════════════════════════════
 *
 * Every figure is computed on read. There is no migration behind this screen
 * for the reason `listing-quality` gives: a stored occupancy figure drifts
 * from the bookings it describes the moment one of them is cancelled, and it
 * would be confidently wrong in the direction that makes an owner turn away
 * business.
 *
 * ══ THE DENOMINATOR COUNTS `active` UNITS ONLY ══════════════════════════════
 *
 * `unit_status` has five members. A `draft` unit was never for sale and an
 * `archived` one no longer is, so neither belongs in "how many nights could we
 * have sold". `maintenance` is the interesting one and it is excluded too: the
 * room is genuinely unavailable, and counting it would report an occupancy
 * failure for a fortnight where there was nothing to fail at. The cost of that
 * choice is that a business which leaves half its units in maintenance sees a
 * flattering number, which is why the screen states the unit count it used.
 *
 * ══ ACCOMMODATION REVENUE COMES FROM PRICE LINES, NOT THE TOTAL ═════════════
 *
 * `bookings.total_agorot` carries cleaning fees, extra beds, add-ons and tax.
 * ADR means what the ROOM cost per night, so it is summed from
 * `booking_price_lines` of kind `accommodation` — and a booking with no such
 * lines produces `null` here rather than a fallback, so `metrics.ts` can
 * exclude it and say how many it excluded.
 */

import {
  revenueReport,
  type RevenueBooking,
  type RevenueReport,
  type Window,
} from '@/lib/revenue'
import { toRows, type Db, type Row } from '@/lib/persistence'

export type RevenueScreen =
  | { readonly status: 'not_provisioned' }
  | {
      readonly status: 'ready'
      readonly report: RevenueReport
      readonly bookableUnits: number | null
      readonly unitsInMaintenance: number
      readonly demand: number
    }

function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '42P01' || code === 'PGRST205'
}

const str = (row: Row, key: string): string | null =>
  typeof row[key] === 'string' && row[key].trim() !== ''
    ? (row[key] as string)
    : null

const int = (row: Row, key: string): number =>
  typeof row[key] === 'number' ? (row[key] as number) : 0

export async function loadRevenueScreen(
  db: Db,
  organizationId: string,
  propertyIds: readonly string[],
  window: Window,
): Promise<RevenueScreen> {
  if (propertyIds.length === 0) {
    return {
      status: 'ready',
      report: revenueReport({ window, bookings: [], bookableUnits: null }),
      bookableUnits: null,
      unitsInMaintenance: 0,
      demand: 0,
    }
  }

  try {
    // Overlap, not containment: a stay that starts in July and ends in August
    // contributes its August nights, and `nightsInWindow` trims it. Asking for
    // `check_in >= from` would silently drop every straddling booking.
    const [bookings, units] = await Promise.all([
      db
        .from('bookings')
        .select(
          'id, property_id, unit_id, status, source, check_in, check_out, ' +
            'total_agorot, created_at',
        )
        .eq('organization_id', organizationId)
        .in('property_id', [...propertyIds])
        .is('deleted_at', null)
        .lt('check_in', window.to)
        .gt('check_out', window.from),
      db
        .from('units')
        .select('id, status')
        .eq('organization_id', organizationId)
        .in('property_id', [...propertyIds])
        .is('deleted_at', null),
    ])

    if (bookings.error) throw bookings.error
    if (units.error) throw units.error

    const bookingRows = toRows(bookings.data)
    const bookingIds = bookingRows
      .map((row) => str(row, 'id'))
      .filter((id): id is string => id !== null)

    const accommodation = new Map<string, number>()

    if (bookingIds.length > 0) {
      const lines = await db
        .from('booking_price_lines')
        .select('booking_id, amount_agorot, quantity')
        .eq('organization_id', organizationId)
        .eq('kind', 'accommodation')
        .in('booking_id', bookingIds)

      if (lines.error) throw lines.error

      for (const row of toRows(lines.data)) {
        const id = str(row, 'booking_id')
        if (id === null) continue
        // `quantity` is nights or guests depending on the line; the amount is
        // per unit of it, so the line total is the product. A quantity of zero
        // contributes zero rather than being read as one.
        const amount = int(row, 'amount_agorot') * int(row, 'quantity')
        accommodation.set(id, (accommodation.get(id) ?? 0) + amount)
      }
    }

    const revenueBookings: RevenueBooking[] = []
    for (const row of bookingRows) {
      const id = str(row, 'id')
      const propertyId = str(row, 'property_id')
      const unitId = str(row, 'unit_id')
      const status = str(row, 'status')
      const source = str(row, 'source')
      const checkIn = str(row, 'check_in')
      const checkOut = str(row, 'check_out')
      const createdAt = str(row, 'created_at')

      if (
        id === null ||
        propertyId === null ||
        unitId === null ||
        status === null ||
        source === null ||
        checkIn === null ||
        checkOut === null ||
        createdAt === null
      ) {
        continue
      }

      revenueBookings.push({
        id,
        propertyId,
        unitId,
        status: status as RevenueBooking['status'],
        source: source as RevenueBooking['source'],
        checkIn,
        checkOut,
        totalAgorot: int(row, 'total_agorot'),
        accommodationAgorot: accommodation.get(id) ?? null,
        createdAt,
      })
    }

    const unitRows = toRows(units.data)
    const active = unitRows.filter((row) => str(row, 'status') === 'active')
    const maintenance = unitRows.filter(
      (row) => str(row, 'status') === 'maintenance',
    )

    // Null rather than zero when there are no units at all: "we sold no nights
    // out of none available" is not zero percent occupancy, it is a business
    // that has not set up its inventory.
    const bookableUnits = active.length > 0 ? active.length : null

    return {
      status: 'ready',
      report: revenueReport({
        window,
        bookings: revenueBookings,
        bookableUnits,
      }),
      bookableUnits,
      unitsInMaintenance: maintenance.length,
      demand: revenueBookings.filter((b) =>
        ['inquiry', 'quote', 'option'].includes(b.status),
      ).length,
    }
  } catch (error) {
    if (isMissingSchema(error)) return { status: 'not_provisioned' }
    throw error
  }
}
