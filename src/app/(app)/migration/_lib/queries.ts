/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the migration screen.
 *
 * ── One snapshot, read once ───────────────────────────────────────────────
 *
 * The dry run compares an entire file against everything already in ESTIA, and
 * it is a pure function over data — deliberately, so that it cannot write. That
 * design puts the loading here: units, guests, occupying bookings, the blocks
 * that are off sale, and the ledger of what has already been imported, all read
 * once and handed over as one `ExistingWorld`.
 *
 * ── Why the guest and booking reads are bounded ───────────────────────────
 *
 * An organization with four years of history has more bookings than belong in
 * one request. Both reads are therefore narrowed to what the comparison
 * actually needs: bookings that overlap the window the file covers, and guests
 * by their identity keys rather than all of them. A migration of a 2019 season
 * does not need to load 2026 to know whether a stay collides.
 *
 * The narrowing is by *window*, never by a `LIMIT` with no ordering. A limit
 * would silently make the dry run wrong — a booking outside the first thousand
 * rows would look free — and the whole value of the dry run is that an operator
 * can believe it.
 *
 * ── The schema may not be applied yet ─────────────────────────────────────
 *
 * `import_sessions`, `import_records`, `import_conflicts` and
 * `import_field_mappings` are proposed by this work and applied by whoever owns
 * migrations. Until then the reads below answer `provisioned: false` rather
 * than throwing, so the screen can say which of the two situations it is in —
 * "nothing imported yet" and "this deployment cannot store an import" need
 * different sentences and only one of them is somebody's mistake.
 */

import type { ExistingBlock, ExistingBooking, ExistingUnit } from '@/lib/migration'
import type { ExistingGuest } from '@/lib/migration'
import type { LedgerEntry } from '@/lib/migration'
import type { ExistingWorld } from '@/lib/migration'
import { SupabaseMigrationRepository } from '@/lib/migration'
import type { ImportEntity, SavedMapping } from '@/lib/migration'
import {
  BOOKING_STATUSES,
  OCCUPYING_STATUSES,
  type BookingStatus,
} from '@/lib/booking/types'
import {
  asString,
  asStringOrNull,
  toRows,
  type Db,
} from '@/lib/persistence'

/** Postgres says this when a table named in a query does not exist. */
const UNDEFINED_TABLE = '42P01'

export type MigrationWorld = {
  world: ExistingWorld
  savedMappings: readonly SavedMapping[]
  /** False when the import schema has not been applied to this deployment. */
  provisioned: boolean
}

export type WorldArgs = {
  db: Db
  organizationId: string
  entity: ImportEntity
  /** The earliest and latest date the file touches. Bounds the booking read. */
  window: { from: string; to: string } | null
}

export async function loadMigrationWorld(
  args: WorldArgs,
): Promise<MigrationWorld> {
  const [units, bookings, guests, ledger] = await Promise.all([
    loadUnits(args),
    loadOccupyingBookings(args),
    loadGuests(args),
    loadLedger(args),
  ])

  return {
    world: {
      guests,
      calendar: {
        units,
        bookings,
        // Owner stays and maintenance are held as holds, and a hold expires
        // within thirty days by design — `booking/holds.ts` refuses a longer
        // one. There is therefore no table today that holds "this villa is the
        // owner's every August", so this is empty rather than fabricated, and
        // the missing capability is named in the report accompanying this work.
        blocks: [] as readonly ExistingBlock[],
      },
      ledger: ledger.entries,
    },
    savedMappings: ledger.mappings,
    provisioned: ledger.provisioned,
  }
}

async function loadUnits(args: WorldArgs): Promise<readonly ExistingUnit[]> {
  const { data, error } = await args.db
    .from('units')
    .select('id, name, property_id, properties (name)')
    .eq('organization_id', args.organizationId)

  if (error) throw error

  return toRows(data).map((row) => ({
    id: asString(row, 'id'),
    name: asString(row, 'name'),
    propertyId: asStringOrNull(row, 'property_id'),
    propertyName: embeddedName(row.properties),
  }))
}

/** PostgREST returns an embedded row as an object or as a one-element array. */
function embeddedName(value: unknown): string | null {
  const row = Array.isArray(value) ? value[0] : value
  if (typeof row !== 'object' || row === null) return null
  const name = (row as { name?: unknown }).name
  return typeof name === 'string' ? name : null
}

async function loadOccupyingBookings(
  args: WorldArgs,
): Promise<readonly ExistingBooking[]> {
  if (args.window === null) return []

  const { data, error } = await args.db
    .from('bookings')
    .select(
      'id, reference, unit_id, guest_name, status, check_in, check_out, ' +
        'units (name)',
    )
    .eq('organization_id', args.organizationId)
    // Half-open, both ends: a stay ending on the window's first day does not
    // touch it, and one starting on the last day does not either.
    .lt('check_in', args.window.to)
    .gt('check_out', args.window.from)
    .in('status', [...OCCUPYING_STATUSES])

  if (error) throw error

  return toRows(data).map((row) => ({
    id: asString(row, 'id'),
    reference: asStringOrNull(row, 'reference') ?? asString(row, 'id'),
    unitId: asString(row, 'unit_id'),
    unitName: embeddedName(row.units) ?? '',
    // The name is behind `guest.view_name`; a reader without it gets a row
    // whose dates are still enough to settle a collision, which is what this
    // screen is asking about.
    guestName: asStringOrNull(row, 'guest_name') ?? 'אורח',
    status: asStatus(row.status),
    checkIn: asString(row, 'check_in'),
    checkOut: asString(row, 'check_out'),
  }))
}

function asStatus(value: unknown): BookingStatus {
  const found = BOOKING_STATUSES.find((candidate) => candidate === value)
  if (found === undefined) {
    throw new Error(`Unknown booking status from the database: ${String(value)}`)
  }
  return found
}

/**
 * The guests to compare against.
 *
 * Only the identity columns, and only for an import that is about guests or
 * bookings. `phone_e164` is the generated column `normalize_phone_il` fills, so
 * the comparison here and the database's own unique index agree by
 * construction rather than by two implementations happening to match.
 */
async function loadGuests(args: WorldArgs): Promise<readonly ExistingGuest[]> {
  if (args.entity !== 'guests' && args.entity !== 'bookings') return []

  const { data, error } = await args.db
    .from('guests')
    .select('id, full_name, phone_e164, email')
    .eq('organization_id', args.organizationId)

  if (error) throw error

  return toRows(data).map((row) => ({
    id: asString(row, 'id'),
    fullName: asStringOrNull(row, 'full_name') ?? '',
    phoneE164: asStringOrNull(row, 'phone_e164'),
    email: asStringOrNull(row, 'email'),
  }))
}

async function loadLedger(args: WorldArgs): Promise<{
  entries: readonly LedgerEntry[]
  mappings: readonly SavedMapping[]
  provisioned: boolean
}> {
  const repository = new SupabaseMigrationRepository(args.db)

  try {
    const [entries, mappings] = await Promise.all([
      repository.loadLedger(args.organizationId, args.entity),
      repository.listMappings(args.organizationId, args.entity),
    ])
    return { entries, mappings, provisioned: true }
  } catch (error) {
    if (isMissingTable(error)) {
      return { entries: [], mappings: [], provisioned: false }
    }
    throw error
  }
}

export function isMissingTable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === UNDEFINED_TABLE
}
