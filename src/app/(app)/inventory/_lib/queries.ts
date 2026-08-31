/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the stock screen.
 *
 * Two tables, and the relationship between them is the whole design.
 * `inventory_items` carries a quantity that **is not typed** — 0011 derives it
 * from `inventory_movements` by trigger, because a count somebody can overwrite
 * is a count that silently disagrees with the movements that produced it. So
 * this file reads the item for what is there now and the ledger for how it got
 * there, and never adds up a balance of its own.
 *
 * ── `available` is not `quantity` ─────────────────────────────────────────
 *
 * `quantity_reserved` is the column that stops two events being promised the
 * same twenty mattresses, and `ALLOCATABLE_INVENTORY_STATES` is the contract's
 * statement that only `available` stock can be promised at all. A screen that
 * printed `quantity` alone would show sufficient stock right up to the morning
 * both events need it, so what is free is computed and shown beside it — and it
 * is a subtraction of two columns on the same row, not a rule invented here.
 *
 * ── The shortage is a reading, never a decision ───────────────────────────
 *
 * `min_quantity` is the reorder point. Below it, somebody has to order more.
 * This file flags it and does not act on it: `inventory.shortage_detected` is a
 * domain event nothing publishes yet, and a screen is not the place to start.
 *
 * ── The team-scoped membership reaches none of this ───────────────────────
 *
 * `inventory_items` has no `team_id`, and `scopeReaches` answers a `team` scope
 * by looking for one. The handyman holds `inventory.view` and a team scope, and
 * therefore reaches no row — which is what `can()` would say and what
 * `narrowingsFor` produces without issuing a query. The screen states that,
 * rather than showing a blank list that reads as "this business has no stock".
 */

import { can, redact, type Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { localDate } from '@/lib/booking'
import { INVENTORY_STATES, type InventoryState } from '@/lib/contracts/states'
import {
  asEnum,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestampOrNull,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

import {
  INVENTORY_SCOPE_COLUMNS,
  narrowingsFor,
  operationsResource,
  reachesNothing,
} from '../../tasks/_lib/scope'
import { namesFrom, unique } from '../../tasks/_lib/queries'
import type { InventoryFilter } from './filters'

/** The ceiling on one page, for the same reason every other list has one. */
export const INVENTORY_PAGE_SIZE = 100

/** How many ledger rows the screen shows under the table. */
export const MOVEMENT_PAGE_SIZE = 25

/**
 * Why a quantity moved. `public.inventory_movement_kind`, 0011.
 *
 * Transcribed here rather than imported because it is the one operations
 * vocabulary that is **not** in `src/lib/contracts/states.ts` — the migration
 * says so in as many words ("Not from the contract: why a quantity moved"). A
 * frozen enum with no TypeScript counterpart is a gap, and it is reported
 * rather than left to be discovered by whoever adds the eighth value.
 */
export const INVENTORY_MOVEMENT_KINDS = [
  'receipt',
  'issue',
  'transfer',
  'return',
  'adjustment',
  'loss',
  'count',
] as const

export type InventoryMovementKind = (typeof INVENTORY_MOVEMENT_KINDS)[number]

/* ---------------------------------------------------------------- items -- */

export type InventoryListItem = {
  id: string
  name: string
  sku: string | null
  category: string | null
  state: InventoryState
  propertyId: string
  unitId: string | null
  propertyName: string | null
  unitName: string | null
  /** Where it physically is, in the business's own words. */
  location: string | null
  /** The unit of measure: "יח׳", "סט", "גליל". Never assumed to be "unit". */
  unitOfMeasure: string
  quantity: number
  quantityReserved: number
  /** `quantity − quantityReserved`. What may still be promised. */
  quantityFree: number
  /** The reorder point, or null because nobody set one. */
  minQuantity: number | null
  parLevel: number | null
  /** Property-local day of the last physical count, or null. */
  lastCountedOn: string | null
  /** Withheld without `expense.view`. What one of these costs. */
  unitCostAgorot?: number | null
  /** Withheld with it: quantity × unit cost, for the stock actually held. */
  valueAgorot?: number | null
}

/**
 * The fields a reader may hold `inventory.view` and still not see.
 *
 * `expense.view`, and not `inventory.view` itself. A housekeeping supervisor
 * holds `inventory.view` and `inventory.edit` and no expense grant: she counts
 * the linen and orders more, and what the business paid per set is not her
 * screen. `redact()` removes the keys so `Money` prints the absence in words —
 * a blank cell in a money column reads as ₪0, which is a number and a wrong
 * one.
 */
const ITEM_REDACTIONS = [
  { key: 'unitCostAgorot', requires: 'expense.view' },
  { key: 'valueAgorot', requires: 'expense.view' },
] as const satisfies ReadonlyArray<{
  key: keyof InventoryListItem
  requires: Grant
}>

const ITEM_COLUMNS =
  'id, organization_id, property_id, unit_id, sku, name, category, state, ' +
  'quantity, quantity_reserved, unit_of_measure, min_quantity, par_level, ' +
  'unit_cost_agorot, location, last_counted_at, created_by'

export type ListInventoryArgs = {
  db: Db
  actor: Actor
  propertyId: string | null
  filter: InventoryFilter
  limit?: number
}

/**
 * The stock this reader may see, by location and then by name.
 *
 * Not by quantity descending: a stock list is read to find a thing, and the
 * order somebody has in their head is the cupboard it is in. `location` is free
 * text the business wrote, so the sort is over its own words.
 */
export async function listInventoryItems(
  args: ListInventoryArgs,
): Promise<readonly InventoryListItem[]> {
  const limit = args.limit ?? INVENTORY_PAGE_SIZE
  const rows = await scopedItemRows(args, limit)
  if (rows.length === 0) return []

  const items = rows
    .map(toItem)
    // The second floor, as everywhere else: a row that survived the narrowing
    // and fails this is a query built wrong, and a list must then come out
    // short rather than wide.
    .filter((item) => isReachable(args.actor, item))
    .sort(byLocationThenName)
    .slice(0, limit)

  const [propertyNames, unitNames] = await Promise.all([
    namesFrom(args.db, 'properties', unique(items.map((i) => i.propertyId))),
    namesFrom(args.db, 'units', unique(items.map((i) => i.unitId))),
  ])

  return items.map((item) =>
    redact(
      args.actor,
      {
        ...item,
        propertyName: propertyNames.get(item.propertyId) ?? null,
        unitName:
          item.unitId === null ? null : (unitNames.get(item.unitId) ?? null),
      },
      ITEM_REDACTIONS,
    ),
  )
}

/**
 * How many items this membership reaches, before any filter.
 *
 * Through the same narrowing as the list, for the same reason `countTasks`
 * does: row level security narrows it in production and does not exist in the
 * demo, and a count that skipped the narrowing would report two different
 * numbers in the two places.
 */
export async function countInventoryItems(args: {
  db: Db
  actor: Actor
  propertyId: string | null
}): Promise<number> {
  const counts = await Promise.all(
    narrowingsFor(args.actor, INVENTORY_SCOPE_COLUMNS).map(
      async (narrowing) => {
        if (reachesNothing(narrowing)) return 0

        let query = args.db
          .from('inventory_items')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', args.actor.organizationId)
          .is('deleted_at', null)

        if (args.propertyId !== null) {
          query = query.eq('property_id', args.propertyId)
        }
        if (narrowing.kind === 'in') {
          query = query.in(narrowing.column, [...narrowing.values])
        } else if (narrowing.kind === 'eq') {
          query = query.eq(narrowing.column, narrowing.value)
        }

        const { count, error } = await query
        if (error) throw error
        return count ?? 0
      },
    ),
  )

  return Math.max(...counts, 0)
}

/**
 * Which items are at or below their reorder point.
 *
 * An item with no `min_quantity` is not short — nobody said what enough is —
 * and guessing one would put a permanent warning on a screen, which is how a
 * warning stops being read.
 */
export function itemsBelowReorderPoint(
  items: readonly InventoryListItem[],
): readonly InventoryListItem[] {
  return items.filter(
    (item) => item.minQuantity !== null && item.quantity <= item.minQuantity,
  )
}

/* ------------------------------------------------------------ movements -- */

export type InventoryMovement = {
  id: string
  itemId: string
  itemName: string | null
  kind: InventoryMovementKind
  /** Signed. Negative takes stock away. */
  quantityDelta: number
  fromState: InventoryState | null
  toState: InventoryState | null
  reason: string | null
  /** Property-local day it happened. */
  occurredOn: string
  /** The job it was consumed by, when there was one. */
  taskId: string | null
}

/**
 * The stock ledger for these items, newest first.
 *
 * Read for the items already on screen rather than for the organization, so a
 * reader whose scope reaches four items sees four items' worth of history and
 * not somebody else's. `inventory_movements` is append-only — a correction is a
 * compensating row and never an edit — so this is a history in the strict
 * sense and nothing in it was rewritten.
 */
export async function listMovements(
  db: Db,
  organizationId: string,
  items: readonly InventoryListItem[],
  limit = MOVEMENT_PAGE_SIZE,
): Promise<readonly InventoryMovement[]> {
  const itemIds = items.map((item) => item.id)
  if (itemIds.length === 0) return []

  const { data, error } = await db
    .from('inventory_movements')
    .select(
      'id, item_id, kind, quantity_delta, from_state, to_state, reason, ' +
        'occurred_at, task_id',
    )
    .eq('organization_id', organizationId)
    .in('item_id', itemIds)
    .order('occurred_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const names = new Map(items.map((item) => [item.id, item.name]))

  return toRows(data).map((row) => {
    const occurredAt = asTimestampOrNull(row, 'occurred_at')
    const itemId = asString(row, 'item_id')

    return {
      id: asString(row, 'id'),
      itemId,
      itemName: names.get(itemId) ?? null,
      kind: asEnum(row, 'kind', INVENTORY_MOVEMENT_KINDS),
      quantityDelta: asNumber(row, 'quantity_delta'),
      fromState: enumOrNull(row, 'from_state'),
      toState: enumOrNull(row, 'to_state'),
      reason: asStringOrNull(row, 'reason'),
      // `occurred_at` is `not null default now()`. A row without one did not
      // come from this database, and dating it today would put a correction
      // made in March at the top of the ledger.
      occurredOn:
        occurredAt === null
          ? localDate(new Date())
          : localDate(new Date(occurredAt)),
      taskId: asStringOrNull(row, 'task_id'),
    }
  })
}

/* ------------------------------------------------------------ internals -- */

function enumOrNull(row: Row, column: string): InventoryState | null {
  return row[column] === null || row[column] === undefined
    ? null
    : asEnum(row, column, INVENTORY_STATES)
}

/**
 * The same question `can()` asks, asked through the same engine.
 *
 * Written as a resource rather than as a scope comparison so that a per-family
 * override and platform staff behave here exactly as they do everywhere else.
 */
function isReachable(actor: Actor, item: InventoryListItem): boolean {
  return can(
    actor,
    'inventory.view',
    operationsResource(actor, {
      propertyId: item.propertyId,
      unitId: item.unitId,
    }),
  )
}

function byLocationThenName(
  a: InventoryListItem,
  b: InventoryListItem,
): number {
  const byLocation = (a.location ?? '').localeCompare(b.location ?? '', 'he')
  if (byLocation !== 0) return byLocation
  return a.name.localeCompare(b.name, 'he')
}

async function scopedItemRows(
  args: ListInventoryArgs,
  limit: number,
): Promise<readonly Row[]> {
  const results = await Promise.all(
    narrowingsFor(args.actor, INVENTORY_SCOPE_COLUMNS).map(
      async (narrowing) => {
        if (reachesNothing(narrowing)) return [] as Row[]

        let query = args.db
          .from('inventory_items')
          .select(ITEM_COLUMNS)
          .eq('organization_id', args.actor.organizationId)
          .is('deleted_at', null)

        if (args.propertyId !== null) {
          query = query.eq('property_id', args.propertyId)
        }
        if (args.filter.state !== null) {
          query = query.eq('state', args.filter.state)
        }
        if (narrowing.kind === 'in') {
          query = query.in(narrowing.column, [...narrowing.values])
        } else if (narrowing.kind === 'eq') {
          query = query.eq(narrowing.column, narrowing.value)
        }

        const { data, error } = await query.limit(limit)
        if (error) throw error
        return toRows(data)
      },
    ),
  )

  const merged = new Map<string, Row>()
  for (const row of results.flat()) merged.set(asString(row, 'id'), row)
  return [...merged.values()]
}

function toItem(row: Row): InventoryListItem {
  const quantity = asNumber(row, 'quantity')
  const reserved = asNumber(row, 'quantity_reserved')
  const unitCost = asNumberOrNull(row, 'unit_cost_agorot')
  const countedAt = asTimestampOrNull(row, 'last_counted_at')

  return {
    id: asString(row, 'id'),
    name: asString(row, 'name'),
    sku: asStringOrNull(row, 'sku'),
    category: asStringOrNull(row, 'category'),
    state: asEnum(row, 'state', INVENTORY_STATES),
    propertyId: asString(row, 'property_id'),
    unitId: asStringOrNull(row, 'unit_id'),
    propertyName: null,
    unitName: null,
    location: asStringOrNull(row, 'location'),
    unitOfMeasure: asString(row, 'unit_of_measure'),
    quantity,
    quantityReserved: reserved,
    // `inventory_items_reserved_within_quantity` guarantees this is never
    // negative, so the subtraction needs no clamp and a clamp would hide a
    // violation of that constraint if one ever reached the table.
    quantityFree: quantity - reserved,
    minQuantity: asNumberOrNull(row, 'min_quantity'),
    parLevel: asNumberOrNull(row, 'par_level'),
    lastCountedOn: countedAt === null ? null : localDate(new Date(countedAt)),
    unitCostAgorot: unitCost,
    // Null rather than zero when there is no unit cost: stock nobody priced has
    // no value on the books, and printing ₪0 would claim it is worthless.
    valueAgorot: unitCost === null ? null : unitCost * quantity,
  }
}
