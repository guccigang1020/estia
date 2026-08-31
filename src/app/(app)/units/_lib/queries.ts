/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the units screen.
 *
 * ── Why this is not `loadUnits` from the properties module ────────────────
 *
 * `properties/_lib/load.ts` already reads units, and it is the right function
 * for the job it does: the units *of one property*, on that property's own
 * page, where the property is already known and already authorised. This
 * screen asks a different question — every unit the reader may see, across
 * every property in their scope — and answering it with that function means
 * one round trip per property and a `can()` check that has already been made
 * for a resource that is no longer the one being decided.
 *
 * So the shape is the list-screen shape the finance queries settled on, and it
 * differs from the per-property read in three ways that matter:
 *
 *   · it names the property on each row, through the `units.properties` embed
 *     that `DEMO_RELATIONS` and PostgREST both already resolve;
 *   · it asks `can()` per unit with `family: 'inventory'`, so a membership
 *     scoped to one property does not see another property's inventory even
 *     though the grant is held;
 *   · it applies `redact()`, because a unit row carries three prices and a
 *     deposit, and holding `property.view` is not holding the right to see
 *     what the business charges.
 *
 * ── Three floors, and this file is the middle one ─────────────────────────
 *
 *   1. `requireGrant('property.view')` at the route, before a query is built.
 *   2. `can()` per row here, with `family: 'inventory'`.
 *   3. `units_select` in the database narrows by membership and
 *      `property_in_scope()` regardless of both.
 *
 * `redact()` is the fourth thing and is not a floor of the same kind: it
 * removes fields from rows this reader is entitled to, so that access to a
 * unit is not access to every column of it.
 *
 * ── Money ─────────────────────────────────────────────────────────────────
 *
 * Integer agorot, read through `asAgorot`, which refuses a float at the
 * border. Nothing here divides by 100 and nothing here adds prices up — a
 * total across units of different capacities is not a number that means
 * anything, so it is not offered.
 */

import { can, redact, type Actor, type Resource } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import type { Db } from '@/lib/persistence'
import {
  asAgorot,
  asNumber,
  asString,
  asStringOrNull,
  toRow,
  toRows,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shape -- */

/**
 * One line of the units list.
 *
 * The optional fields are optional because `redact()` genuinely removes them:
 * a reader without `rate.view_public` has no `basePriceAgorot` key at all, and
 * the type says so rather than letting a component read `undefined` out of a
 * field it was told was a number.
 *
 * `bathrooms` is a number and arrives as a string — `numeric(3,1)`, and 2.5
 * bathrooms is a real listing. `asNumber` accepts the string a numeric column
 * is sent as; rounding it in either direction is a complaint.
 */
export type UnitListItem = {
  id: string
  propertyId: string
  /** From the embed. Null when the property row was not readable. */
  propertyName: string | null
  code: string
  name: string
  unitType: string
  status: string
  maxGuests: number
  standardGuests: number
  bedrooms: number
  bathrooms: number
  beds: number
  sizeSqm: number | null
  minNights: number
  /** The nightly rate and what travels with it. Withheld without `rate.view_public`. */
  basePriceAgorot?: number
  extraGuestPriceAgorot?: number
  cleaningFeeAgorot?: number
  /** Withheld without `booking.view_deposit`, which is its own grant. */
  depositAgorot?: number
}

/**
 * The fields a reader may hold `property.view` and still not see.
 *
 * `rate.public` and `booking.deposit` are `SENSITIVE_FIELDS` entries from the
 * catalogue, not names invented here.
 *
 * The deposit is separated from the nightly rate on purpose, and it is not
 * pedantry: `booking.view_deposit` exists precisely because what a business
 * holds against damage is a different disclosure from what it charges for a
 * night. A `housekeeping_supervisor` holds `property.view` and neither, and
 * sees the inventory with no money on it at all — which is the privacy rule
 * working, on the screen where it is easiest to forget.
 */
const UNIT_REDACTIONS = [
  { key: 'basePriceAgorot', requires: 'rate.view_public' },
  { key: 'extraGuestPriceAgorot', requires: 'rate.view_public' },
  { key: 'cleaningFeeAgorot', requires: 'rate.view_public' },
  { key: 'depositAgorot', requires: 'booking.view_deposit' },
] as const satisfies ReadonlyArray<{
  key: keyof UnitListItem
  requires: Grant
}>

/**
 * `properties(name)` is an embed, and it is declared.
 *
 * `units.properties` is in `RELATIONS` for the transaction compiler and in
 * `DEMO_RELATIONS` for the demo client, and PostgREST resolves it from the
 * foreign key. Naming the property with a second `in` query over the property
 * table would work and would be a round trip for a label.
 *
 * `deleted_at` is selected so nothing has to guess whether the soft-delete
 * filter was applied — it is filtered on below, and the column being present
 * is what makes that checkable in a test.
 */
const UNIT_COLUMNS =
  'id, property_id, code, name, unit_type, status, max_guests, ' +
  'standard_guests, bedrooms, bathrooms, beds, size_sqm, min_nights, ' +
  'base_price_agorot, extra_guest_price_agorot, cleaning_fee_agorot, ' +
  'deposit_agorot, sort_order, properties(name)'

/** The ceiling on one page. Same number and same reasoning as the finance lists. */
export const UNIT_PAGE_SIZE = 200

export type ListUnitsArgs = {
  db: Db
  actor: Actor
  organizationId: string
  /** A single property, or null for every property in scope. */
  propertyId: string | null
  limit?: number
}

function inventoryResource(
  organizationId: string,
  propertyId: string,
): Resource {
  return { organizationId, propertyId, family: 'inventory' }
}

/**
 * Every unit this reader may see, in the order the business sorted them.
 *
 * `sort_order` then `code`, matching `loadUnits` in the properties module.
 * Sorting by name would put the same six units in a different order on two
 * screens of the same product, which is the kind of difference that makes a
 * person wonder which one is telling the truth.
 */
export async function listUnits(
  args: ListUnitsArgs,
): Promise<readonly UnitListItem[]> {
  const { db, actor, organizationId, propertyId } = args

  let query = db
    .from('units')
    .select(UNIT_COLUMNS)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { data, error } = await query
    .order('sort_order', { ascending: true })
    .order('code', { ascending: true })
    .limit(args.limit ?? UNIT_PAGE_SIZE)

  if (error) throw error

  return toRows(data)
    .filter((row) =>
      can(
        actor,
        'property.view',
        inventoryResource(organizationId, asString(row, 'property_id')),
      ),
    )
    .map((row) => {
      const propertyOfRow = asString(row, 'property_id')

      const item: UnitListItem = {
        id: asString(row, 'id'),
        propertyId: propertyOfRow,
        propertyName: embeddedName(row, 'properties'),
        code: asString(row, 'code'),
        name: asString(row, 'name'),
        unitType: asString(row, 'unit_type'),
        status: asString(row, 'status'),
        maxGuests: asNumber(row, 'max_guests'),
        standardGuests: asNumber(row, 'standard_guests'),
        bedrooms: asNumber(row, 'bedrooms'),
        bathrooms: asNumber(row, 'bathrooms'),
        beds: asNumber(row, 'beds'),
        sizeSqm: numberOrNull(row, 'size_sqm'),
        minNights: asNumber(row, 'min_nights'),
        basePriceAgorot: asAgorot(row, 'base_price_agorot'),
        extraGuestPriceAgorot: asAgorot(row, 'extra_guest_price_agorot'),
        cleaningFeeAgorot: asAgorot(row, 'cleaning_fee_agorot'),
        depositAgorot: asAgorot(row, 'deposit_agorot'),
      }

      return redact(
        actor,
        item,
        UNIT_REDACTIONS,
        inventoryResource(organizationId, propertyOfRow),
      )
    })
}

/**
 * How many units exist for this organization and property, before any filter.
 *
 * A `head` count, so "this business has no units yet" and "your filter matched
 * nothing" can be told apart without paying for the rows — the distinction
 * `resolveEmptyReason` takes two numbers to make.
 */
export async function countUnits(
  db: Db,
  organizationId: string,
  propertyId: string | null,
): Promise<number> {
  let query = db
    .from('units')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .is('deleted_at', null)

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { count, error } = await query
  if (error) throw error
  return count ?? 0
}

/* --------------------------------------------------------- what is sold -- */

/**
 * The units on screen that cannot be sold, and the ones that can.
 *
 * Not a cosmetic split. `loadRules` in `persistence/booking.ts` returns `null`
 * for any unit whose status is not `active`, and `checkAvailability` turns
 * that into a refusal — the engine cannot vouch for the unit, so it is not
 * sellable and the calendar shows it blocked all month. A draft unit is
 * therefore not "a unit that is nearly ready"; it is inventory that will
 * refuse every booking attempt until somebody changes its status, and the
 * screen says so above the table rather than leaving it to be discovered.
 *
 * The rule is `status === 'active'` and it is written once, here, because a
 * screen that decided it a second way would eventually disagree with the
 * booking engine about which units are for sale.
 */
export function sellableUnits(
  units: readonly UnitListItem[],
): readonly UnitListItem[] {
  return units.filter((unit) => unit.status === 'active')
}

export function unsellableUnits(
  units: readonly UnitListItem[],
): readonly UnitListItem[] {
  return units.filter((unit) => unit.status !== 'active')
}

/* ------------------------------------------------------------ internals -- */

/**
 * The `name` out of a one-cardinality embed, or `null`.
 *
 * Null is a real answer and is rendered as one: row level security can admit a
 * unit and refuse the property row above it, and filling the gap with the
 * property's uuid would print a truncated identifier where a name belongs.
 */
function embeddedName(row: Row, key: string): string | null {
  const embedded = row[key]
  if (embedded === null || embedded === undefined) return null
  if (Array.isArray(embedded)) return null
  return asStringOrNull(toRow(embedded), 'name')
}

/** `null` stays `null`; a numeric string becomes a number. */
function numberOrNull(row: Row, column: string): number | null {
  return row[column] === null || row[column] === undefined
    ? null
    : asNumber(row, column)
}
