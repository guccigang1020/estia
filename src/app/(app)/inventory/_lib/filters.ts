/**
 * What the stock list is filtered by, as a pure function of the URL.
 *
 * The key is `state`, which is the column's name in 0011. An inventory item has
 * no status — it has a place in a cycle — and naming the query parameter after
 * the wrong concept is how the next person writes `?status=laundry` and finds
 * nothing.
 *
 * A value outside `INVENTORY_STATES` is dropped rather than queried, which is
 * the honest behaviour for a hand-edited URL and stops a value the enum does
 * not contain reaching PostgREST as a database error the reader cannot act on.
 */

import { firstParam, type SearchParams } from '@/app/(auth)/_lib/search-params'
import { INVENTORY_STATES, type InventoryState } from '@/lib/contracts/states'

/** Kept as a constant so the form, the parser and the query string agree. */
export const INVENTORY_STATE_KEY = 'state'

export type InventoryFilter = { state: InventoryState | null }

export const NO_INVENTORY_FILTER: InventoryFilter = { state: null }

export function parseInventoryFilter(params: SearchParams): InventoryFilter {
  const raw = firstParam(params[INVENTORY_STATE_KEY])
  if (raw === null) return { state: null }
  return {
    state: (INVENTORY_STATES as readonly string[]).includes(raw)
      ? (raw as InventoryState)
      : null,
  }
}

/**
 * Is anything hiding rows?
 *
 * `propertyId` is included because narrowing to one property is a filter the
 * reader did not set on this screen — it is the shell's property switcher — and
 * it is the one they are most likely to have forgotten about.
 */
export function hasActiveInventoryFilter(
  filter: InventoryFilter,
  propertyId: string | null,
): boolean {
  return filter.state !== null || propertyId !== null
}

/** The filter, said back to the person whose data it is hiding. */
export function describeInventoryFilter(
  filter: InventoryFilter,
  labels: Record<InventoryState, string>,
  propertyName?: string | null,
): string {
  const parts: string[] = []
  if (propertyName) parts.push(propertyName)
  if (filter.state !== null) parts.push(labels[filter.state])
  return parts.join(' · ')
}
