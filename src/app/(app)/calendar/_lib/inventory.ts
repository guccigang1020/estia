/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The units a calendar row can be drawn for, read from `public.units` and its
 * property.
 *
 * TWO FLOORS, AND THEY ANSWER DIFFERENT QUESTIONS. `units_select` in
 * `0008_accommodation.sql` narrows by membership and by `unit_in_scope()`, so a
 * property-scoped member physically cannot read a row outside their scope — the
 * enforcement is in the query, never a filter applied to the result. What that
 * policy deliberately does **not** check is a permission: it has no
 * `has_permission(...)` clause at all, unlike `units_insert`. So the grant
 * question is the application's, and it is asked here, per row, through
 * `can()`. Neither floor is redundant and neither is sufficient.
 *
 * WHY `family: 'inventory'`. An external seller's default scope is
 * `own_records`, and a unit belongs to nobody in particular — asked without the
 * family, every unit would fall to that default and be refused. The family is
 * what makes the per-family override apply, and `inventoryResource` is the one
 * place in the product that builds it, so this file does not invent a second.
 */

import { can, type Actor } from '@/lib/authz/can'
import { inventoryResource } from '@/lib/agents/types'
import type { Db } from '@/lib/persistence'
import {
  asAgorot,
  asBoolean,
  asNumber,
  asString,
  asStringOrNull,
  toRow,
  toRows,
} from '@/lib/persistence'

import { ALL_PROPERTIES } from '../../_lib/context'

/**
 * A unit as the calendar and the availability check need it.
 *
 * The money fields are the unit's configured rates, not a price: a price is
 * the sum of the lines `priceStay` produces, and nothing on this screen renders
 * one of these numbers directly.
 */
export interface CalendarUnit {
  id: string
  code: string
  name: string
  /** `active` is the only status the availability engine will sell. */
  status: string
  propertyId: string
  propertyName: string
  maxGuests: number
  standardGuests: number
  minNights: number
  basePriceAgorot: number
  extraGuestPriceAgorot: number
  cleaningFeeAgorot: number
  depositAgorot: number
  /** VAT in basis points, from the property. 1700 is 17%. */
  taxRateBps: number
  /** When true the configured rates already contain the tax. */
  taxIncludedInPrice: boolean
  /**
   * May this reader be told a booking from a hold on *this* unit?
   *
   * Per unit rather than per person, because the booking family can carry its
   * own scope override. A reader entitled to the internal diary on one property
   * and not on another gets the truthful answer for each row.
   */
  detailed: boolean
}

const UNIT_COLUMNS =
  'id, code, name, status, property_id, max_guests, standard_guests, ' +
  'min_nights, base_price_agorot, extra_guest_price_agorot, ' +
  'cleaning_fee_agorot, deposit_agorot, sort_order, ' +
  'properties!inner(id, name, tax_rate_bps, tax_included_in_price)'

export interface LoadUnitsArgs {
  db: Db
  actor: Actor
  organizationId: string
  /** `ALL_PROPERTIES`, or one property id the shell has already validated. */
  selectedPropertyId: string
}

/**
 * Every unit this person may see the calendar of, in display order.
 *
 * `properties!inner` is an inner embed on purpose, and it is the opposite
 * choice from the one `persistence/booking.ts` makes for the guest name. There
 * the join is a label and losing it costs a name; here the property is the
 * thing that carries the tax settings and the row's own name, and a unit whose
 * property is not readable is a unit this reader has no business drawing a
 * calendar for. Filtering is the correct behaviour.
 */
export async function loadCalendarUnits(
  args: LoadUnitsArgs,
): Promise<CalendarUnit[]> {
  const { db, actor, organizationId, selectedPropertyId } = args

  let query = db
    .from('units')
    .select(UNIT_COLUMNS)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('code', { ascending: true })

  if (selectedPropertyId !== ALL_PROPERTIES) {
    query = query.eq('property_id', selectedPropertyId)
  }

  const { data, error } = await query
  if (error) throw error

  const units: CalendarUnit[] = []

  for (const row of toRows(data)) {
    const property = embeddedProperty(row)
    if (!property) continue

    const unit: CalendarUnit = {
      id: asString(row, 'id'),
      code: asString(row, 'code'),
      name: asString(row, 'name'),
      status: asString(row, 'status'),
      propertyId: asString(row, 'property_id'),
      propertyName: asStringOrNull(property, 'name') ?? '',
      maxGuests: asNumber(row, 'max_guests'),
      standardGuests: asNumber(row, 'standard_guests'),
      minNights: asNumber(row, 'min_nights'),
      basePriceAgorot: asAgorot(row, 'base_price_agorot'),
      extraGuestPriceAgorot: asAgorot(row, 'extra_guest_price_agorot'),
      cleaningFeeAgorot: asAgorot(row, 'cleaning_fee_agorot'),
      depositAgorot: asAgorot(row, 'deposit_agorot'),
      taxRateBps: asNumber(property, 'tax_rate_bps'),
      taxIncludedInPrice: asBoolean(property, 'tax_included_in_price'),
      detailed: false,
    }

    const target = {
      organizationId,
      propertyId: unit.propertyId,
      unitId: unit.id,
    }

    // The permission floor the RLS policy deliberately leaves to us, asked
    // twice because they are two questions with two families and two possible
    // scopes: may this reader see the *bookings* on this unit, and may they
    // see its *free/busy*. Either one earns a row; neither means the unit is
    // not this person's to look at and it is dropped entirely.
    const detailed = can(actor, 'booking.view', {
      organizationId,
      propertyId: unit.propertyId,
      unitId: unit.id,
      family: 'booking',
    })
    const freeBusy = can(actor, 'availability.view', inventoryResource(target))

    if (!detailed && !freeBusy) continue

    unit.detailed = detailed
    units.push(unit)
  }

  return units
}

/** The embedded property row, whichever shape PostgREST returned it in. */
function embeddedProperty(row: Record<string, unknown>) {
  const embedded = row.properties
  const value = Array.isArray(embedded) ? embedded[0] : embedded
  return value ? toRow(value) : null
}
