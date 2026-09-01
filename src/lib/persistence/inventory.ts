/**
 * The stock engine's storage, backed by `0011_operations.sql` and
 * `0030_inventory_forecast.sql`.
 *
 * ── What each method reads ────────────────────────────────────────────────
 *
 *   `loadSettings`        → `public.inventory_settings`, or the `off` default
 *   `loadForecastItems`   → `public.inventory_items`, grouped
 *   `loadReservations`    → `public.inventory_reservations`
 *   `reserve` / `release` → `public.reserve_inventory` and its counterpart
 *   `loadDiscrepancies`   → `public.inventory_discrepancies`
 *   `loadTransfers`       → `public.inventory_transfers`
 *
 * ── A missing settings row is `off`, and that is not an error ─────────────
 *
 * Every other adapter in this directory raises `SchemaNotProvisionedError`
 * rather than answering `null`, because "nothing found" and "this deployment
 * cannot answer" must not look the same. Settings are the deliberate
 * exception, and only in one direction: a missing *row* means the business
 * never opened the stock module, which is the default and a real answer. A
 * missing *table* is a deployment that has not run 0030, and that is reported
 * — `provisioned: false` — so a screen can say which of the two it is instead
 * of showing an empty cupboard.
 *
 * ── Why an item is a group of rows ────────────────────────────────────────
 *
 * 0011 gives each `inventory_items` row one `state`, so a business with sixty
 * towels of which thirty are in the wash has two rows. That is the right
 * shape for a ledger and the wrong shape for a forecast, which asks "how many
 * towels are there, and how many can Friday use". So rows are grouped by
 * `(property, sku or name)` — the same identity the CSV import uses, on
 * purpose — and the group carries the per-state counts.
 *
 * The group's id is the allocatable row's id, because that is the row a
 * reservation increments and the row `inventory_items_reserved_within_quantity`
 * constrains. Picking any other member would move `quantity_reserved` onto
 * stock that is in a laundry van.
 *
 * ── No `lte` ─────────────────────────────────────────────────────────────
 *
 * The date-window reads below use `gte` and `lt` with an exclusive upper
 * bound rather than `lte`. That is not taste: `FakeSupabaseClient` implements
 * the filter set the adapters actually use, an adapter reaching for one it
 * does not have cannot be unit-tested at all, and a query nobody can test is
 * how a wrong column name ships.
 */

import { addDays } from '../booking/dates'
import {
  ALLOCATABLE_INVENTORY_STATES,
  INVENTORY_MODES,
  INVENTORY_STATES,
  type InventoryState,
} from '../contracts/states'
import { defaultInventorySettings } from '../inventory/settings'
import { claimDateOf } from '../inventory/reservation'
import {
  DISCREPANCY_RESOLUTIONS,
  RESERVATION_STATUSES,
  type DemandLine,
  type Discrepancy,
  type ForecastItem,
  type InventorySettings,
  type Reservation,
} from '../inventory/types'

import type { Db, Row } from './client'
import {
  asBoolean,
  asEnum,
  asIsoDate,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  toRows,
} from './mapping'

/* ---------------------------------------------------------------- shapes -- */

export interface SettingsResult {
  settings: InventorySettings
  /**
   * False when `inventory_settings` could not be read at all — the migration
   * has not run here. The settings are the `off` default either way, which is
   * the safe answer, but a screen may say which it is looking at.
   */
  provisioned: boolean
}

export interface ReserveResult {
  reservationId: string
  itemId: string
  propertyId: string
  quantity: number
  freeAfter: number
}

export interface TransferRecord {
  id: string
  itemId: string
  label: string | null
  fromPropertyId: string
  toPropertyId: string
  quantity: number
  status: string
  neededBy: string | null
  reason: string | null
}

export interface WindowQuery {
  organizationId: string
  /** Empty means every property the caller's policy admits. */
  propertyIds?: readonly string[]
  from: string
  to: string
}

const SETTINGS_COLUMNS =
  'organization_id, mode, safety_buffer_units, safety_buffer_percent, ' +
  'shortage_warning_horizon_days, forecast_horizon_days, ' +
  'linen_turnaround_days, shared_stock, reservations_enabled, ' +
  'warehouse_enabled, discrepancy_tracking, transfers_enabled'

const ITEM_COLUMNS =
  'id, organization_id, property_id, unit_id, sku, name, category, state, ' +
  'quantity, quantity_reserved, unit_of_measure, min_quantity, par_level, ' +
  'location'

const RESERVATION_COLUMNS =
  'id, organization_id, property_id, item_id, booking_id, quantity, status, ' +
  'needed_from, needed_to, note'

const DISCREPANCY_COLUMNS =
  'id, organization_id, property_id, item_id, booking_id, expected_quantity, ' +
  'collected_quantity, difference, resolution, resolution_note, detected_at, ' +
  'resolved_at'

const TRANSFER_COLUMNS =
  'id, organization_id, item_id, from_property_id, to_property_id, quantity, ' +
  'status, needed_by, reason'

const TRANSFER_STATUSES = [
  'suggested',
  'requested',
  'approved',
  'rejected',
  'in_transit',
  'completed',
  'cancelled',
] as const

/* ------------------------------------------------------------ repository -- */

export class SupabaseInventoryRepository {
  constructor(private readonly db: Db) {}

  /**
   * What this organization has asked the stock module to do.
   *
   * Never throws. An organization that has never opened the module gets the
   * `off` default, and so does a deployment that has not run 0030 — the
   * difference is in `provisioned`, not in whether the caller has to handle an
   * exception before it can render a booking screen.
   */
  async loadSettings(organizationId: string): Promise<SettingsResult> {
    const fallback = defaultInventorySettings(organizationId)

    let rows: readonly Row[]
    try {
      const { data, error } = await this.db
        .from('inventory_settings')
        .select(SETTINGS_COLUMNS)
        .eq('organization_id', organizationId)
        .limit(1)

      if (error) return { settings: fallback, provisioned: false }
      rows = toRows(data)
    } catch {
      // The demo database raises for a table it has never been told about, and
      // PostgREST answers 42P01 for one the migration has not created. Both
      // mean the same thing here and neither is the user's problem.
      return { settings: fallback, provisioned: false }
    }

    if (rows.length === 0) return { settings: fallback, provisioned: true }

    return { settings: toSettings(rows[0], organizationId), provisioned: true }
  }

  /**
   * The stock, grouped into the things a person would name.
   *
   * `onHandClean` counts only the states `ALLOCATABLE_INVENTORY_STATES` names.
   * Forty sets in a laundry van are the business's property and are not
   * Friday's answer, and a forecast that added them would promise a changeover
   * it cannot deliver.
   */
  async loadForecastItems(args: {
    organizationId: string
    propertyIds?: readonly string[]
  }): Promise<readonly ForecastItem[]> {
    let query = this.db
      .from('inventory_items')
      .select(ITEM_COLUMNS)
      .eq('organization_id', args.organizationId)
      .is('deleted_at', null)

    if (args.propertyIds && args.propertyIds.length > 0) {
      query = query.in('property_id', [...args.propertyIds])
    }

    const { data, error } = await query.limit(1000)
    if (error) throw error

    return groupItems(toRows(data))
  }

  /** `inventory_items.id` → the group id the forecast knows it by. */
  async itemGroupIndex(args: {
    organizationId: string
    propertyIds?: readonly string[]
  }): Promise<ReadonlyMap<string, string>> {
    let query = this.db
      .from('inventory_items')
      .select('id, property_id, sku, name, state')
      .eq('organization_id', args.organizationId)
      .is('deleted_at', null)

    if (args.propertyIds && args.propertyIds.length > 0) {
      query = query.in('property_id', [...args.propertyIds])
    }

    const { data, error } = await query.limit(1000)
    if (error) throw error

    const index = new Map<string, string>()
    for (const group of groupRows(toRows(data))) {
      for (const row of group.rows) {
        index.set(asString(row, 'id'), group.id)
      }
    }
    return index
  }

  /**
   * Live reservations whose window touches the forecast horizon.
   *
   * A reservation starting before the window and running into it still claims
   * stock inside it, so the filter is an overlap and not a containment. Losing
   * that is how a five-night stay that began on Wednesday disappears from
   * Thursday's forecast.
   */
  async loadReservations(query: WindowQuery): Promise<readonly Reservation[]> {
    let builder = this.db
      .from('inventory_reservations')
      .select(RESERVATION_COLUMNS)
      .eq('organization_id', query.organizationId)
      .eq('status', 'reserved')
      .gte('needed_to', query.from)
      // Exclusive upper bound rather than `lte`. See the header.
      .lt('needed_from', addDays(query.to, 1))

    if (query.propertyIds && query.propertyIds.length > 0) {
      builder = builder.in('property_id', [...query.propertyIds])
    }

    try {
      const { data, error } = await builder.limit(1000)
      if (error) throw error
      return toRows(data).map(toReservation)
    } catch (cause) {
      if (isMissingRelation(cause)) return []
      throw cause
    }
  }

  /**
   * The reservations, as the forecast's demand lines.
   *
   * One claim on `needed_from` and not one per night: linen leaves the
   * cupboard once, at the start of the stay. `claimDateOf` owns that decision
   * and is called rather than reproduced.
   */
  async loadDemand(
    query: WindowQuery,
    groupOf?: ReadonlyMap<string, string>,
  ): Promise<readonly DemandLine[]> {
    const reservations = await this.loadReservations(query)

    return reservations.map((reservation) => ({
      date: claimDateOf(reservation),
      propertyId: reservation.propertyId,
      itemId: groupOf?.get(reservation.itemId) ?? reservation.itemId,
      quantity: reservation.quantity,
      bookingId: reservation.bookingId,
      reservationId: reservation.id,
      label: null,
    }))
  }

  /**
   * Promise stock to a booking.
   *
   * One call to `public.reserve_inventory` and nothing else. The function
   * locks the item row, adds to `quantity_reserved` relatively, and leans on
   * `inventory_items_reserved_within_quantity` to refuse an oversell — see
   * `src/lib/inventory/reservation.ts`, which sets out all three defences.
   *
   * Doing this as a select followed by an update from here would lose one of
   * two concurrent reservations and pass every unit test while doing it.
   */
  async reserve(request: {
    itemId: string
    quantity: number
    neededFrom: string
    neededTo: string
    bookingId?: string | null
    note?: string | null
  }): Promise<ReserveResult> {
    const { data, error } = await this.db.rpc('reserve_inventory', {
      p_item_id: request.itemId,
      p_quantity: request.quantity,
      p_needed_from: request.neededFrom,
      p_needed_to: request.neededTo,
      p_booking_id: request.bookingId ?? null,
      p_note: request.note ?? null,
    })

    if (error) throw error

    const payload = (data ?? {}) as Record<string, unknown>
    return {
      reservationId: String(payload.reservationId ?? ''),
      itemId: String(payload.itemId ?? request.itemId),
      propertyId: String(payload.propertyId ?? ''),
      quantity: Number(payload.quantity ?? request.quantity),
      freeAfter: Number(payload.freeAfter ?? 0),
    }
  }

  /** Give promised stock back, with the reason the release policy demands. */
  async releaseReservation(
    reservationId: string,
    reason: string,
  ): Promise<{ released: boolean }> {
    const { data, error } = await this.db.rpc('release_inventory_reservation', {
      p_reservation_id: reservationId,
      p_reason: reason,
    })

    if (error) throw error

    const payload = (data ?? {}) as Record<string, unknown>
    return { released: payload.released === true }
  }

  /** Differences between expected and collected, newest first. */
  async loadDiscrepancies(args: {
    organizationId: string
    propertyIds?: readonly string[]
    openOnly?: boolean
    limit?: number
  }): Promise<readonly Discrepancy[]> {
    let builder = this.db
      .from('inventory_discrepancies')
      .select(DISCREPANCY_COLUMNS)
      .eq('organization_id', args.organizationId)

    if (args.propertyIds && args.propertyIds.length > 0) {
      builder = builder.in('property_id', [...args.propertyIds])
    }
    if (args.openOnly === true) {
      builder = builder.eq('resolution', 'unresolved')
    }

    try {
      const { data, error } = await builder
        .order('detected_at', { ascending: false })
        .limit(args.limit ?? 100)
      if (error) throw error
      return toRows(data).map(toDiscrepancy)
    } catch (cause) {
      if (isMissingRelation(cause)) return []
      throw cause
    }
  }

  /* ------------------------------------------------------------ writes -- */

  /**
   * Turn the module on, off, or sideways.
   *
   * An upsert on the primary key, because "configure" is one act whether or
   * not a row already exists and a caller should not have to know which.
   */
  async saveSettings(settings: InventorySettings): Promise<void> {
    const { error } = await this.db.from('inventory_settings').upsert(
      {
        organization_id: settings.organizationId,
        mode: settings.mode,
        safety_buffer_units: settings.safetyBufferUnits,
        safety_buffer_percent: settings.safetyBufferPercent,
        shortage_warning_horizon_days: settings.shortageWarningHorizonDays,
        forecast_horizon_days: settings.forecastHorizonDays,
        linen_turnaround_days: settings.linenTurnaroundDays,
        shared_stock: settings.sharedStock,
        reservations_enabled: settings.reservationsEnabled,
        warehouse_enabled: settings.warehouseEnabled,
        discrepancy_tracking: settings.discrepancyTracking,
        transfers_enabled: settings.transfersEnabled,
      },
      { onConflict: 'organization_id' },
    )

    if (error) throw error
  }

  /**
   * A new item, and the movement that explains its opening count.
   *
   * The row is created with `quantity` zero and the opening number arrives as
   * a `receipt` movement, so 0011's trigger produces the quantity rather than
   * the caller asserting it. That is not ceremony: the very first number in
   * the ledger then has a row saying where it came from, and every number
   * after it is a sum of rows rather than an edit somebody made.
   */
  async createItem(args: {
    organizationId: string
    item: {
      propertyId: string
      name: string
      sku: string | null
      category: string | null
      location: string | null
      unitOfMeasure: string
      quantity: number
      minQuantity: number | null
      parLevel: number | null
      unitCostAgorot: number | null
    }
  }): Promise<{ id: string }> {
    const { item } = args
    const { data, error } = await this.db
      .from('inventory_items')
      .insert({
        organization_id: args.organizationId,
        property_id: item.propertyId,
        name: item.name.trim(),
        sku: item.sku,
        category: item.category,
        location: item.location,
        unit_of_measure: item.unitOfMeasure,
        state: 'available',
        quantity: 0,
        quantity_reserved: 0,
        min_quantity: item.minQuantity,
        par_level: item.parLevel,
        unit_cost_agorot: item.unitCostAgorot,
      })
      .select('id')
      .single()

    if (error) throw error

    const id = asString(toRows(data === null ? [] : [data])[0] ?? {}, 'id')

    if (item.quantity > 0) {
      await this.recordMovement({
        organizationId: args.organizationId,
        movement: {
          itemId: id,
          propertyId: item.propertyId,
          kind: 'receipt',
          quantityDelta: item.quantity,
          toState: 'available',
          reason: `ספירת פתיחה של ${item.name.trim()}.`,
        },
      })
    }

    return { id }
  }

  /** Rename, relocate, re-price. Never the quantity — that is a movement. */
  async updateItem(args: {
    organizationId: string
    itemId: string
    patch: Record<string, unknown>
  }): Promise<void> {
    const { error } = await this.db
      .from('inventory_items')
      .update(args.patch)
      .eq('organization_id', args.organizationId)
      .eq('id', args.itemId)

    if (error) throw error
  }

  /**
   * One row in the ledger.
   *
   * `inventory_movements` is append-only by trigger and the quantity is
   * applied by another one, so this is the only way any count in the product
   * changes. A movement that would take stock below zero fails on
   * `inventory_items_quantity_nonnegative` — refused by a constraint rather
   * than by a branch.
   */
  async recordMovement(args: {
    organizationId: string
    movement: {
      itemId: string
      propertyId: string
      kind: string
      quantityDelta: number
      toState: string | null
      reason: string
      bookingId?: string | null
    }
  }): Promise<{ id: string }> {
    const { movement } = args
    const { data, error } = await this.db
      .from('inventory_movements')
      .insert({
        organization_id: args.organizationId,
        property_id: movement.propertyId,
        item_id: movement.itemId,
        kind: movement.kind,
        quantity_delta: movement.quantityDelta,
        to_state: movement.toState,
        booking_id: movement.bookingId ?? null,
        reason: movement.reason,
      })
      .select('id')
      .single()

    if (error) throw error
    return { id: asString(toRows(data === null ? [] : [data])[0] ?? {}, 'id') }
  }

  /** The item as the reservation guard needs to see it. */
  async loadReservableItem(args: {
    organizationId: string
    itemId: string
    bookingId: string | null
  }): Promise<{
    itemId: string
    label: string
    propertyId: string
    quantity: number
    quantityReserved: number
    existingQuantity?: number
  } | null> {
    const { data, error } = await this.db
      .from('inventory_items')
      .select('id, property_id, name, quantity, quantity_reserved')
      .eq('organization_id', args.organizationId)
      .eq('id', args.itemId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    const row = toRows(data === null ? [] : [data])[0]
    if (row === undefined) return null

    let existingQuantity: number | undefined
    if (args.bookingId !== null) {
      // Raising an existing reservation is a change, not a second promise.
      // Without this a party growing by two on a nearly-full cupboard is
      // refused while the stock sits in that very booking's reservation.
      const existing = await this.db
        .from('inventory_reservations')
        .select('quantity')
        .eq('organization_id', args.organizationId)
        .eq('item_id', args.itemId)
        .eq('booking_id', args.bookingId)
        .eq('status', 'reserved')
        .maybeSingle()

      if (!existing.error && existing.data !== null) {
        existingQuantity = asNumber(
          toRows([existing.data])[0] ?? { quantity: 0 },
          'quantity',
        )
      }
    }

    return {
      itemId: asString(row, 'id'),
      label: asString(row, 'name'),
      propertyId: asString(row, 'property_id'),
      quantity: asNumber(row, 'quantity'),
      quantityReserved: asNumber(row, 'quantity_reserved'),
      existingQuantity,
    }
  }

  /**
   * Ask for stock from another property.
   *
   * Lands as `requested`, never `approved`. The source property has to be able
   * to see what is being asked of it before anything leaves its cupboard.
   */
  async requestTransfer(args: {
    organizationId: string
    itemId: string
    fromPropertyId: string
    toPropertyId: string
    quantity: number
    neededBy: string | null
    reason: string
  }): Promise<{ id: string }> {
    const { data, error } = await this.db
      .from('inventory_transfers')
      .insert({
        organization_id: args.organizationId,
        item_id: args.itemId,
        from_property_id: args.fromPropertyId,
        to_property_id: args.toPropertyId,
        quantity: args.quantity,
        status: 'requested',
        needed_by: args.neededBy,
        reason: args.reason,
        requested_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error) throw error
    return { id: asString(toRows(data === null ? [] : [data])[0] ?? {}, 'id') }
  }

  /** One counted difference, for the resolution path. */
  async loadDiscrepancy(args: {
    organizationId: string
    discrepancyId: string
  }): Promise<{
    id: string
    itemId: string
    propertyId: string
    label: string
    difference: number
    version: number
  } | null> {
    const { data, error } = await this.db
      .from('inventory_discrepancies')
      .select(
        'id, item_id, property_id, expected_quantity, collected_quantity, version',
      )
      .eq('organization_id', args.organizationId)
      .eq('id', args.discrepancyId)
      .maybeSingle()

    if (error) throw error
    const row = toRows(data === null ? [] : [data])[0]
    if (row === undefined) return null

    return {
      id: asString(row, 'id'),
      itemId: asString(row, 'item_id'),
      propertyId: asString(row, 'property_id'),
      // Named by the caller, which has the item on screen already.
      label: '',
      difference:
        asNumber(row, 'collected_quantity') -
        asNumber(row, 'expected_quantity'),
      version: asNumber(row, 'version'),
    }
  }

  /** Close a difference, with the movement it produced, if any. */
  async resolveDiscrepancy(args: {
    organizationId: string
    discrepancyId: string
    resolution: string
    note: string
    movementId: string | null
  }): Promise<void> {
    const { error } = await this.db
      .from('inventory_discrepancies')
      .update({
        resolution: args.resolution,
        resolution_note: args.note,
        movement_id: args.movementId,
        resolved_at: new Date().toISOString(),
      })
      .eq('organization_id', args.organizationId)
      .eq('id', args.discrepancyId)

    if (error) throw error
  }

  /** Transfers between properties, whatever their status. */
  async loadTransfers(args: {
    organizationId: string
    limit?: number
  }): Promise<readonly TransferRecord[]> {
    try {
      const { data, error } = await this.db
        .from('inventory_transfers')
        .select(TRANSFER_COLUMNS)
        .eq('organization_id', args.organizationId)
        .order('created_at', { ascending: false })
        .limit(args.limit ?? 100)

      if (error) throw error
      return toRows(data).map(toTransfer)
    } catch (cause) {
      if (isMissingRelation(cause)) return []
      throw cause
    }
  }
}

/* -------------------------------------------------------------- grouping -- */

interface ItemGroup {
  id: string
  rows: Row[]
}

/**
 * Rows keyed by what a person would call the thing.
 *
 * SKU first where there is one — it is the identity 0011's unique index
 * already enforces — and the name otherwise, because a villa owner's
 * spreadsheet has no SKU column and never will.
 */
function groupRows(rows: readonly Row[]): ItemGroup[] {
  const buckets = new Map<string, Row[]>()

  for (const row of rows) {
    const property = asString(row, 'property_id')
    const sku = asStringOrNull(row, 'sku')
    const name = asString(row, 'name')
    const key = `${property}:${(sku ?? name).trim().toLowerCase()}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }

  return [...buckets.values()].map((bucket) => ({
    id: canonicalIdOf(bucket),
    rows: bucket,
  }))
}

/**
 * Which row of the group is the one a reservation increments.
 *
 * The allocatable one. `quantity_reserved` is constrained per row against that
 * row's `quantity`, so reserving against the laundry row would refuse
 * perfectly available stock and, worse, would succeed once the wash came back.
 */
function canonicalIdOf(rows: readonly Row[]): string {
  const allocatable = rows.find((row) =>
    (ALLOCATABLE_INVENTORY_STATES as readonly string[]).includes(
      asString(row, 'state'),
    ),
  )
  return asString(allocatable ?? rows[0], 'id')
}

function groupItems(rows: readonly Row[]): readonly ForecastItem[] {
  return groupRows(rows).map((group) => {
    const byState: Partial<Record<InventoryState, number>> = {}
    let onHandClean = 0
    let reservedTotal = 0
    let minQuantity: number | null = null
    let parLevel: number | null = null

    for (const row of group.rows) {
      const state = asEnum(row, 'state', INVENTORY_STATES)
      const quantity = asNumber(row, 'quantity')
      byState[state] = (byState[state] ?? 0) + quantity
      reservedTotal += asNumber(row, 'quantity_reserved')

      if ((ALLOCATABLE_INVENTORY_STATES as readonly string[]).includes(state)) {
        onHandClean += quantity
      }

      const rowMin = asNumberOrNull(row, 'min_quantity')
      const rowPar = asNumberOrNull(row, 'par_level')
      // The largest floor any member of the group carries. A business that set
      // a reorder point on the clean row and left the laundry row blank meant
      // the point, not the blank.
      if (rowMin !== null) minQuantity = Math.max(minQuantity ?? 0, rowMin)
      if (rowPar !== null) parLevel = Math.max(parLevel ?? 0, rowPar)
    }

    const head =
      group.rows.find((row) => asString(row, 'id') === group.id) ??
      group.rows[0]

    return {
      itemId: group.id,
      label: asString(head, 'name'),
      propertyId: asString(head, 'property_id'),
      location: asStringOrNull(head, 'location'),
      unitOfMeasure: asString(head, 'unit_of_measure'),
      onHandClean,
      byState,
      reservedTotal,
      minQuantity,
      parLevel,
    }
  })
}

/* --------------------------------------------------------------- mapping -- */

function toSettings(row: Row, organizationId: string): InventorySettings {
  return {
    organizationId,
    mode: asEnum(row, 'mode', INVENTORY_MODES),
    safetyBufferUnits: asNumber(row, 'safety_buffer_units'),
    safetyBufferPercent: asNumber(row, 'safety_buffer_percent'),
    shortageWarningHorizonDays: asNumber(row, 'shortage_warning_horizon_days'),
    forecastHorizonDays: asNumber(row, 'forecast_horizon_days'),
    linenTurnaroundDays: asNumberOrNull(row, 'linen_turnaround_days'),
    sharedStock: asBoolean(row, 'shared_stock'),
    reservationsEnabled: asBoolean(row, 'reservations_enabled'),
    warehouseEnabled: asBoolean(row, 'warehouse_enabled'),
    discrepancyTracking: asBoolean(row, 'discrepancy_tracking'),
    transfersEnabled: asBoolean(row, 'transfers_enabled'),
  }
}

function toReservation(row: Row): Reservation {
  return {
    id: asString(row, 'id'),
    propertyId: asString(row, 'property_id'),
    itemId: asString(row, 'item_id'),
    bookingId: asStringOrNull(row, 'booking_id'),
    quantity: asNumber(row, 'quantity'),
    status: asEnum(row, 'status', RESERVATION_STATUSES),
    neededFrom: asIsoDate(row, 'needed_from'),
    neededTo: asIsoDate(row, 'needed_to'),
    note: asStringOrNull(row, 'note'),
  }
}

function toDiscrepancy(row: Row): Discrepancy {
  const expected = asNumber(row, 'expected_quantity')
  const collected = asNumber(row, 'collected_quantity')
  const detectedAt = asStringOrNull(row, 'detected_at')
  const resolvedAt = asStringOrNull(row, 'resolved_at')

  return {
    id: asString(row, 'id'),
    propertyId: asString(row, 'property_id'),
    itemId: asString(row, 'item_id'),
    // Filled in by the caller, which already has the item names on screen. A
    // second read per row to name a thing the page has in hand is a query per
    // row, which is the shape that makes a list slow at two hundred.
    label: '',
    bookingId: asStringOrNull(row, 'booking_id'),
    expected,
    collected,
    // Recomputed rather than read: the column is `generated always`, and a
    // deployment where the two disagree is one where the read is wrong.
    difference: collected - expected,
    resolution: asEnum(row, 'resolution', DISCREPANCY_RESOLUTIONS),
    resolutionNote: asStringOrNull(row, 'resolution_note'),
    detectedOn: (detectedAt ?? '').slice(0, 10),
    resolvedOn: resolvedAt === null ? null : resolvedAt.slice(0, 10),
  }
}

function toTransfer(row: Row): TransferRecord {
  return {
    id: asString(row, 'id'),
    itemId: asString(row, 'item_id'),
    label: null,
    fromPropertyId: asString(row, 'from_property_id'),
    toPropertyId: asString(row, 'to_property_id'),
    quantity: asNumber(row, 'quantity'),
    status: asEnum(row, 'status', TRANSFER_STATUSES),
    neededBy: asStringOrNull(row, 'needed_by'),
    reason: asStringOrNull(row, 'reason'),
  }
}

/**
 * Is this failure "the migration has not run here"?
 *
 * `42P01` is PostgreSQL's `undefined_table`, `PGRST205` is PostgREST failing
 * to find it in its schema cache, and the demo database raises a plain
 * `MissingDemoTable` for a key it was never given. All three mean the same
 * thing to a screen, and none of them is the user's problem — a shortage list
 * for a deployment that has no shortage table is honestly empty.
 *
 * Deliberately narrow. Every other failure is rethrown, because a read that
 * silently answers "nothing" for a permission error would show a full cupboard
 * as an empty one.
 */
function isMissingRelation(cause: unknown): boolean {
  if (cause === null || typeof cause !== 'object') return false
  const candidate = cause as { code?: unknown; name?: unknown }
  if (candidate.code === '42P01' || candidate.code === 'PGRST205') return true
  return candidate.name === 'MissingDemoTable'
}
