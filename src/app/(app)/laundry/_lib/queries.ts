/**
 * EXECUTION CONTEXT — SERVER ONLY. Every read the laundry screens perform.
 *
 * ── Row level security is the filter, and the application does not repeat it ──
 *
 * Every query below asks broadly and lets the database narrow. `laundry_orders`
 * is behind `laundry.view` plus `property_in_scope`; `laundry_providers` is
 * behind `laundry.provider_manage`, which is how somebody can see what must be
 * clean by Friday and never learn who washes it or what it costs. Re-filtering
 * here would be a second copy of that rule, and the second copy is the one that
 * is wrong.
 *
 * `loadProviders` is the one place that has to know the asymmetry, and it
 * handles it by returning `null` for "you may not see these" rather than an
 * empty array — a screen that cannot tell refusal from absence renders
 * "no providers configured" at somebody who simply may not look.
 *
 * The person that actually happens to is the housekeeping supervisor: 0035
 * gives them `laundry.view`, `laundry.manage` and `laundry.order_create` and
 * withholds `laundry.order_send` and `laundry.provider_manage`. A cleaner holds
 * none of the five and is refused the section by the gate before any of this
 * runs.
 *
 * ── The demo dataset gap, reported rather than papered over ───────────────
 *
 * `src/lib/demo/dataset.ts` is the coordinator's file and the five laundry
 * tables are not yet declared in it. `DemoDatabase.rows` throws
 * `MissingDemoTable` for a key it has never heard of — deliberately, because
 * answering `[]` would render as "this business has no laundry", which is a
 * claim about the customer rather than about the wiring.
 *
 * So the reads below catch exactly that failure and report it as
 * `datasetGap`, and the screens render a panel naming the missing table and
 * what has to be added. That is not papering over the defect: it is the defect,
 * stated on the screen, with the fix in it. Every other failure propagates.
 */

import { createClient } from '@/lib/supabase/server'
import type { Actor } from '@/lib/authz/can'
import { holdsGrant } from '@/lib/authz/can'
import {
  asBoolean,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  toRow,
  toRows,
  type Row,
} from '@/lib/persistence'
import {
  defaultSettings,
  resolveSettings,
  type LaundryItemProfile,
  type LaundryOrder,
  type LaundryOrderLine,
  type LaundryProvider,
  type LaundrySettings,
  type ResolvedSettings,
} from '@/lib/laundry'
import type {
  ExplanationStep,
  LaundryChannel,
  LaundryDispatchMode,
  LaundryMode,
  LaundryRoute,
  LaundryStatus,
  RequirementUnit,
} from '@/lib/laundry'

/* ------------------------------------------------------- the demo gap --- */

/**
 * The name of a table the demo dataset has never heard of.
 *
 * Matched on the error's own name rather than by importing `MissingDemoTable`,
 * because `src/lib/demo` must not be imported by a screen — that rule is in
 * the demo's own header and it is a good one.
 */
export type DatasetGap = { table: string; detail: string }

function datasetGapFrom(error: unknown): DatasetGap | null {
  if (typeof error !== 'object' || error === null) return null
  const named = error as { name?: unknown; message?: unknown }
  if (named.name !== 'MissingDemoTable') return null

  const detail = String(named.message ?? '')
  const table = /'([a-z_]+)'/.exec(detail)?.[1] ?? 'unknown'
  return { table, detail }
}

/** Run a read, turning only the demo's missing-table failure into a value. */
async function tolerateDatasetGap<T>(
  read: () => Promise<T>,
): Promise<{ data: T; gap: null } | { data: null; gap: DatasetGap }> {
  try {
    return { data: await read(), gap: null }
  } catch (error) {
    const gap = datasetGapFrom(error)
    if (gap === null) throw error
    return { data: null, gap }
  }
}

/* ----------------------------------------------------------- mapping ---- */

function toSettings(row: Row): LaundrySettings {
  return {
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    mode: asString(row, 'mode') as LaundryMode,
    dispatchMode: asString(row, 'dispatch_mode') as LaundryDispatchMode,
    defaultChannel: asString(row, 'default_channel') as LaundryChannel,
    defaultProviderId: asStringOrNull(row, 'default_provider_id'),
    turnaroundHours: asNumber(row, 'turnaround_hours'),
    pickupDays: numbers(row, 'pickup_days'),
    deliveryDays: numbers(row, 'delivery_days'),
    forecastHorizonDays: asNumber(row, 'forecast_horizon_days'),
    standingNotes: asStringOrNull(row, 'standing_notes'),
  }
}

/** A `smallint[]` column, as PostgREST renders it. */
function numbers(row: Row, column: string): readonly number[] {
  const value = row[column]
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry))
}

function toProvider(row: Row): LaundryProvider {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    name: asString(row, 'name'),
    contactName: asStringOrNull(row, 'contact_name'),
    phone: asStringOrNull(row, 'phone'),
    email: asStringOrNull(row, 'email'),
    defaultChannel: asString(row, 'default_channel') as LaundryChannel,
    turnaroundHours: asNumber(row, 'turnaround_hours'),
    pickupDays: numbers(row, 'pickup_days'),
    deliveryDays: numbers(row, 'delivery_days'),
    minimumOrderUnits: asNumber(row, 'minimum_order_units'),
    notes: asStringOrNull(row, 'notes'),
    isActive: asBoolean(row, 'is_active'),
  }
}

function toProfile(row: Row): LaundryItemProfile {
  return {
    organizationId: asString(row, 'organization_id'),
    itemId: asString(row, 'item_id'),
    label: asString(row, 'label'),
    laundryManaged: asBoolean(row, 'laundry_managed'),
    washable: asBoolean(row, 'washable'),
    externalLaundryAllowed: asBoolean(row, 'external_laundry_allowed'),
    route: (asStringOrNull(row, 'route') as LaundryRoute | null) ?? null,
    defaultProviderId: asStringOrNull(row, 'default_provider_id'),
    turnaroundHours: asNumberOrNull(row, 'turnaround_hours'),
    unit: asString(row, 'unit') as RequirementUnit,
    bundleSize: asNumber(row, 'bundle_size'),
    minimumBuffer: asNumber(row, 'minimum_buffer'),
  }
}

function toLine(row: Row): LaundryOrderLine {
  const calculated = asNumber(row, 'calculated_quantity')
  const adjustment = asNumber(row, 'adjustment_quantity')

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    orderId: asString(row, 'order_id'),
    propertyId: asString(row, 'property_id'),
    itemId: asString(row, 'item_id'),
    label: asString(row, 'label'),
    unit: asString(row, 'unit') as RequirementUnit,
    quantity: {
      calculated,
      adjustment,
      // The database generates this column. Re-derived here from the same two
      // inputs rather than read, so a row that somehow disagreed would show
      // the arithmetic rather than the disagreement.
      final: calculated + adjustment,
      reason: asStringOrNull(row, 'adjustment_reason'),
      adjustedByUserId: asStringOrNull(row, 'adjusted_by'),
      adjustedAt: asStringOrNull(row, 'adjusted_at'),
    },
    requiredBy: asString(row, 'required_by'),
    sourceBookingId: asStringOrNull(row, 'source_booking_id'),
    explanation: explanationOf(row),
    notes: asStringOrNull(row, 'notes'),
  }
}

function explanationOf(row: Row): readonly ExplanationStep[] {
  const value = row.explanation
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const step = entry as Record<string, unknown>
    if (typeof step.text !== 'string' || typeof step.value !== 'number') {
      return []
    }
    return [
      {
        kind: String(step.kind ?? 'preparation') as ExplanationStep['kind'],
        text: step.text,
        value: step.value,
      },
    ]
  })
}

function toOrder(row: Row, lines: readonly LaundryOrderLine[]): LaundryOrder {
  const id = asString(row, 'id')
  return {
    id,
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    providerId: asStringOrNull(row, 'provider_id'),
    status: asString(row, 'status') as LaundryStatus,
    mode: asString(row, 'mode') as LaundryMode,
    dispatchMode: asString(row, 'dispatch_mode') as LaundryDispatchMode,
    channel: asString(row, 'channel') as LaundryChannel,
    reference: asString(row, 'reference'),
    requirementKey: asString(row, 'requirement_key'),
    requiredBy: asString(row, 'required_by'),
    pickupAt: asStringOrNull(row, 'pickup_at'),
    expectedReturnAt: asStringOrNull(row, 'expected_return_at'),
    returnedAt: asStringOrNull(row, 'returned_at'),
    sentAt: asStringOrNull(row, 'sent_at'),
    sentBody: asStringOrNull(row, 'sent_body'),
    internalNotes: asStringOrNull(row, 'internal_notes'),
    providerNotes: asStringOrNull(row, 'provider_notes'),
    lines: lines.filter((line) => line.orderId === id),
    version: asNumber(row, 'version'),
  }
}

/* ------------------------------------------------------------- reads ---- */

export type LaundryContext = {
  settings: ResolvedSettings
  profiles: readonly LaundryItemProfile[]
  gap: DatasetGap | null
}

/**
 * The mode and the item configuration: what every laundry screen needs first.
 *
 * Resolved before anything else, because the mode decides which sections exist
 * at all and a screen that reads orders before knowing the mode has already
 * assumed there are orders.
 */
export async function laundryContext(
  actor: Actor,
  propertyId: string | null,
): Promise<LaundryContext> {
  const supabase = await createClient()

  const settingsRead = await tolerateDatasetGap(async () => {
    const { data, error } = await supabase
      .from('laundry_settings')
      .select(
        'organization_id, property_id, mode, dispatch_mode, default_channel, default_provider_id, turnaround_hours, pickup_days, delivery_days, forecast_horizon_days, standing_notes',
      )
    if (error) throw error
    return toRows(data ?? []).map(toSettings)
  })

  if (settingsRead.gap !== null) {
    return {
      settings: {
        settings: defaultSettings(actor.organizationId),
        source: 'default',
      },
      profiles: [],
      gap: settingsRead.gap,
    }
  }

  const profileRead = await tolerateDatasetGap(async () => {
    const { data, error } = await supabase
      .from('laundry_item_profiles')
      .select(
        'organization_id, item_id, label, laundry_managed, washable, external_laundry_allowed, route, default_provider_id, turnaround_hours, unit, bundle_size, minimum_buffer',
      )
      .order('label')
    if (error) throw error
    return toRows(data ?? []).map(toProfile)
  })

  return {
    settings: resolveSettings(
      actor.organizationId,
      settingsRead.data,
      propertyId,
    ),
    profiles: profileRead.data ?? [],
    gap: profileRead.gap,
  }
}

export type OrdersRead = {
  orders: readonly LaundryOrder[]
  gap: DatasetGap | null
}

/**
 * Orders with their lines, newest deadline first.
 *
 * Two queries rather than an embed. `laundry_order_lines` has its own row
 * level security narrowed by `property_in_scope`, and a PostgREST embed
 * evaluates the child policy too — which is right — but it also means a
 * consolidated order whose second property is out of scope comes back with a
 * partial line list and no indication that it is partial. Reading them
 * separately makes the same thing happen and makes it visible: the order's own
 * `property_id` is NULL and the lines that came back are the ones this person
 * may see.
 */
export async function loadOrders(
  propertyId: string | null,
  limit: number,
): Promise<OrdersRead> {
  const supabase = await createClient()

  const read = await tolerateDatasetGap(async () => {
    let query = supabase
      .from('laundry_orders')
      .select(
        'id, organization_id, property_id, provider_id, status, mode, dispatch_mode, channel, reference, requirement_key, required_by, pickup_at, expected_return_at, returned_at, sent_at, sent_body, internal_notes, provider_notes, version',
      )
      .order('required_by', { ascending: false })
      .limit(limit)

    // A consolidated order carries NULL, so narrowing to one property must not
    // hide the run that includes it. `or` is supported by the demo client for
    // exactly this shape.
    if (propertyId !== null) {
      query = query.or(`property_id.eq.${propertyId},property_id.is.null`)
    }

    const { data, error } = await query
    if (error) throw error

    const orderRows = toRows(data ?? [])
    if (orderRows.length === 0) return []

    const ids = orderRows.map((row) => asString(row, 'id'))

    const { data: lineData, error: lineError } = await supabase
      .from('laundry_order_lines')
      .select(
        'id, organization_id, order_id, property_id, item_id, label, unit, calculated_quantity, adjustment_quantity, adjustment_reason, adjusted_by, adjusted_at, explanation, source_booking_id, required_by, notes',
      )
      .in('order_id', ids)

    if (lineError) throw lineError

    const lines = toRows(lineData ?? []).map(toLine)
    return orderRows.map((row) => toOrder(row, lines))
  })

  return { orders: read.data ?? [], gap: read.gap }
}

export async function loadOrder(
  id: string,
): Promise<{ order: LaundryOrder | null; gap: DatasetGap | null }> {
  const supabase = await createClient()

  const read = await tolerateDatasetGap(async () => {
    const { data, error } = await supabase
      .from('laundry_orders')
      .select(
        'id, organization_id, property_id, provider_id, status, mode, dispatch_mode, channel, reference, requirement_key, required_by, pickup_at, expected_return_at, returned_at, sent_at, sent_body, internal_notes, provider_notes, version',
      )
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const { data: lineData, error: lineError } = await supabase
      .from('laundry_order_lines')
      .select(
        'id, organization_id, order_id, property_id, item_id, label, unit, calculated_quantity, adjustment_quantity, adjustment_reason, adjusted_by, adjusted_at, explanation, source_booking_id, required_by, notes',
      )
      .eq('order_id', id)

    if (lineError) throw lineError

    return toOrder(toRow(data), toRows(lineData ?? []).map(toLine))
  })

  return { order: read.data ?? null, gap: read.gap }
}

/**
 * The providers, or `null` when this person may not see them.
 *
 * THE NULL IS THE POINT. A housekeeping supervisor holds `laundry.view` and
 * not `laundry.provider_manage`, and `laundry_providers_select` returns them
 * nothing — so an empty array here would be indistinguishable from a business
 * with no providers, and the screen would tell them something false about their
 * employer rather than something true about their own access.
 *
 * The grant is checked before the query rather than after, so the refusal does
 * not depend on a policy the demo client does not enforce. `client.ts` is
 * explicit that the demo has no RLS; this check is what makes the cleaner's
 * experience honest there too.
 */
export async function loadProviders(actor: Actor): Promise<{
  providers: readonly LaundryProvider[] | null
  gap: DatasetGap | null
}> {
  if (!holdsGrant(actor, 'laundry.provider_manage')) {
    return { providers: null, gap: null }
  }

  const supabase = await createClient()

  const read = await tolerateDatasetGap(async () => {
    const { data, error } = await supabase
      .from('laundry_providers')
      .select(
        'id, organization_id, name, contact_name, phone, email, default_channel, turnaround_hours, pickup_days, delivery_days, minimum_order_units, notes, is_active',
      )
      .is('deleted_at', null)
      .order('name')

    if (error) throw error
    return toRows(data ?? []).map(toProvider)
  })

  return { providers: read.data ?? [], gap: read.gap }
}

/** Property id → name, for every property in the person's scope. */
export async function propertyNames(): Promise<ReadonlyMap<string, string>> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('properties')
    .select('id, name')
    .is('deleted_at', null)

  if (error || !data) return new Map()

  return new Map(
    toRows(data).map((row) => [asString(row, 'id'), asString(row, 'name')]),
  )
}
