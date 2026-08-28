/**
 * `PreparationPorts`, as far as the schema goes — which is `loadStock` and
 * very little else.
 *
 * ── What exists ───────────────────────────────────────────────────────────
 *
 *   `loadStock`              → `public.inventory_items`
 *   `loadTransferrableStock` → the same table, elsewhere in the organization
 *   `nextPlanId`             → not storage at all
 *
 * ── What does not, and why projecting it would be worse than blocking ─────
 *
 * `WorkPlan`, `PreparationSnapshot` and `PreparationCatalogue` have no tables
 * in any migration to 0017. `tasks`, `task_checklists` and `inventory_items`
 * are adjacent and are not the same things.
 *
 * The temptation is to project a work plan onto `tasks`: a plan is a list of
 * jobs, a task is a job, and the mapping almost writes itself. It would be a
 * mistake, and a quiet one. A `WorkPlan` is a *versioned computed artefact*
 * with a frozen `PreparationSnapshot` beside it, and the snapshot is the entire
 * mechanism that stops historical drift — it is why a plan built in March still
 * costs what it cost in March after the catalogue's prices change in April.
 * `tasks` has no revision chain and nothing to freeze a catalogue into, so the
 * projection would lose precisely the thing the type exists for, and the loss
 * would surface as a slowly wrong number on an owner's statement months later.
 *
 * `operations.ts` makes the same point structurally: it deliberately has no
 * `loadCatalogue(bookingId)`, so that every path except a brand-new plan is
 * *forced* through the stored snapshot. Implementing these against `tasks`
 * would quietly delete that guarantee.
 *
 * So they raise `SchemaNotProvisionedError` — never `null`, which would look
 * like a booking with no plan rather than a deployment that cannot hold one.
 *
 * `loadBooking` and `loadAllocationContexts` are blocked for a smaller reason:
 * `PreparationBooking` carries preparation facts — the event type, the extras,
 * the sleeping arrangement — that `bookings` has no columns for. Returning a
 * booking with an invented event type would drive a work plan for the wrong
 * kind of stay.
 */

import { INVENTORY_STATES } from '../contracts/states'
import type { FixedAllocationInput } from '../preparation/costing'
import type {
  PreparationBooking,
  PreparationCatalogue,
  PreparationSnapshot,
  StockLevel,
  WorkPlan,
} from '../preparation/types'
import type { PreparationPorts } from '../preparation/operations'
import type { Db, Row } from './client'
import { SchemaNotProvisionedError } from './errors'
import { asEnum, asNumber, asNumberOrNull, asString, toRows } from './mapping'

const STOCK_COLUMNS =
  'id, organization_id, property_id, name, state, quantity, ' +
  'quantity_reserved, min_quantity'

export class SupabasePreparationPorts implements PreparationPorts {
  constructor(private readonly db: Db) {}

  /**
   * What this property has.
   *
   * Note the signature: `loadStock(propertyId)` takes no organization. That is
   * not an omission in the port — RLS is what scopes it, and `inventory_items`
   * carries `organization_id` with a policy over `my_organizations()`. A
   * property id from another tenant returns nothing rather than somebody
   * else's linen cupboard.
   *
   * Soft-deleted rows are excluded. A deleted item is not stock.
   */
  async loadStock(propertyId: string): Promise<readonly StockLevel[]> {
    const { data, error } = await this.db
      .from('inventory_items')
      .select(STOCK_COLUMNS)
      .eq('property_id', propertyId)
      .is('deleted_at', null)
      .order('name', { ascending: true })

    if (error) throw error
    return toRows(data).map(toStockLevel)
  }

  /**
   * Stock that exists elsewhere in the organization and could be moved.
   *
   * Optional on the port, and worth implementing: the alternative to a
   * transfer suggestion is a purchase, and a business that owns forty spare
   * towels in the next village should be told before it buys more.
   */
  async loadTransferrableStock(
    organizationId: string,
    excludingPropertyId: string,
  ): Promise<readonly StockLevel[]> {
    const { data, error } = await this.db
      .from('inventory_items')
      .select(STOCK_COLUMNS)
      .eq('organization_id', organizationId)
      .neq('property_id', excludingPropertyId)
      .is('deleted_at', null)
      .order('name', { ascending: true })

    if (error) throw error
    return toRows(data).map(toStockLevel)
  }

  /**
   * A fresh plan id. Not storage, so nothing blocks it.
   *
   * `randomUUID` rather than something derived from the booking: a booking can
   * have several plans over its life — a rebuild after the party size changes —
   * and an id derived from the booking would collide with the plan it is meant
   * to supersede.
   */
  nextPlanId(): string {
    return crypto.randomUUID()
  }

  // ── Blocked on migrations. See the header. ──────────────────────────────

  async loadBooking(): Promise<PreparationBooking | null> {
    throw blocked(
      'preparation columns on public.bookings',
      'reading the booking a work plan is built for. PreparationBooking ' +
        'carries the event type, the extras and the sleeping arrangement, and ' +
        'bookings has a column for none of them',
    )
  }

  async loadCatalogue(): Promise<PreparationCatalogue | null> {
    throw blocked(
      'preparation_catalogues',
      'reading the catalogue a plan is priced from',
    )
  }

  async loadSnapshot(): Promise<PreparationSnapshot | null> {
    throw blocked(
      'preparation_snapshots',
      'reading the frozen catalogue a stored plan was built against. This is ' +
        'the record that keeps a March plan costing what it cost in March',
    )
  }

  async loadPlan(): Promise<WorkPlan | null> {
    throw blocked(
      'work_plans',
      'reading a stored work plan. public.tasks is not the same thing: a plan ' +
        'is a versioned computed artefact with a frozen snapshot beside it, ' +
        'and tasks can hold neither the revision chain nor the snapshot',
    )
  }

  async loadAllocationContexts(): Promise<FixedAllocationInput['contexts']> {
    throw blocked(
      'preparation allocation contexts',
      'spreading a fixed cost across the stays that should carry it',
    )
  }

  async savePlan(): Promise<void> {
    throw blocked('work_plans', 'storing a work plan')
  }

  async saveSnapshot(): Promise<void> {
    throw blocked(
      'preparation_snapshots',
      'freezing a catalogue against a plan',
    )
  }
}

// ── Row mapping ───────────────────────────────────────────────────────────

/**
 * One row is one item in one state.
 *
 * `byState` therefore has exactly one key. That is faithful rather than
 * convenient: `inventory_items` has no stable identity above the row — no
 * sku-level key that survives a state change — so a business tracking linen as
 * several rows per sku sees them here as several items, which is what the
 * table actually says. Summing rows by `sku` to synthesise one item with a
 * spread across states would be inventing an identity the schema does not
 * have, and the linen cycle in `inventory.ts` would then be moving quantities
 * between rows that no foreign key connects.
 */
function toStockLevel(row: Row): StockLevel {
  return {
    itemId: asString(row, 'id'),
    label: asString(row, 'name'),
    location: { kind: 'property', propertyId: asString(row, 'property_id') },
    onHand: asNumber(row, 'quantity'),
    reserved: asNumber(row, 'quantity_reserved'),
    // `min_quantity` is the floor a business keeps for the booking it has not
    // taken yet — which is what `safetyStock` means. `par_level` is the target
    // to reorder *up to*, a different number, and using it would report a
    // safety breach every time stock dipped below the reorder point.
    safetyStock: asNumberOrNull(row, 'min_quantity') ?? 0,
    byState: {
      [asEnum(row, 'state', INVENTORY_STATES)]: asNumber(row, 'quantity'),
    },
  }
}

function blocked(missing: string, purpose: string): SchemaNotProvisionedError {
  return new SchemaNotProvisionedError(missing, purpose)
}
