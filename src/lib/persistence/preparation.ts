/**
 * `PreparationPorts`, backed by `0011_operations.sql` and `0021_preparation.sql`.
 *
 * ── What each port reads ──────────────────────────────────────────────────
 *
 *   `loadStock`              → `public.inventory_items`
 *   `loadTransferrableStock` → the same table, elsewhere in the organization
 *   `loadCatalogue`          → `public.preparation_catalogues`
 *   `loadSnapshot`           → `public.preparation_snapshots`
 *   `loadPlan` / `savePlan`  → `public.work_plans`
 *   `nextPlanId`             → not storage at all
 *
 * ── Why these are three tables and not a projection onto `tasks` ──────────
 *
 * The temptation was always to project a work plan onto `tasks`: a plan is a
 * list of jobs, a task is a job, and the mapping almost writes itself. 0021
 * did not take it, and its header says why in the same words this file used to
 * refuse in. A `WorkPlan` is a *versioned computed artefact* with a frozen
 * `PreparationSnapshot` beside it, and the snapshot is the entire mechanism
 * that stops historical drift — it is why a plan built in March still costs
 * what it cost in March after the catalogue's prices change in April. `tasks`
 * has no revision chain and nothing to freeze a catalogue into.
 *
 * `operations.ts` makes the same point structurally: it deliberately has no
 * `loadCatalogue(bookingId)`, so that every path except a brand-new plan is
 * *forced* through the stored snapshot. `preparation_snapshots` is append-only
 * by trigger — against `service_role` and `postgres` too, which RLS cannot do
 * — so that guarantee is now the database's rather than this file's.
 *
 * ── `work_plans.version` is not `tg_touch_row`'s ──────────────────────────
 *
 * It is the domain's plan revision, written by the caller. 0021 gave the table
 * `tg_touch_updated_at` rather than `tg_touch_row` for exactly this reason, and
 * a trigger refuses an update that lowers it. So `savePlan` **sends** `version`
 * — the opposite of every other write in this directory — and does not use it
 * as an optimistic predicate, because the domain already advanced it before the
 * record arrived and locking on it would refuse every revision.
 *
 * ── Two ports still have nowhere to read from ─────────────────────────────
 *
 * `loadBooking` and `loadAllocationContexts`. Neither is a table 0021 forgot;
 * both want facts nothing in the schema records. They still raise
 * `SchemaNotProvisionedError` — never `null` and never `[]`, which would look
 * like a booking with no extras and a month with no occupancy rather than a
 * deployment that cannot answer.
 */

import { INVENTORY_STATES } from '../contracts/states'
import type { PriceLine } from '../booking/types'
import type { FixedAllocationInput } from '../preparation/costing'
import type {
  PreparationBooking,
  PreparationCatalogue,
  PreparationSnapshot,
  StockLevel,
  WorkPlan,
} from '../preparation/types'
import type { PreparationPorts } from '../preparation/operations'
import type { TransactionHandle } from '../service'
import { NotFoundError } from '../errors'
import type { Db, Row } from './client'
import { SchemaNotProvisionedError } from './errors'
import {
  RowShapeError,
  asEnum,
  asIsoDate,
  asJsonRecord,
  asNumber,
  asNumberOrNull,
  asString,
  asTimestamp,
  toRow,
  toRows,
} from './mapping'
import { clientFor, recordWrite } from './transaction'

const STOCK_COLUMNS =
  'id, organization_id, property_id, name, state, quantity, ' +
  'quantity_reserved, min_quantity'

/** The catalogue is its jsonb parts. Every one is `NOT NULL DEFAULT`. */
const CATALOGUE_COLUMNS =
  'organization_id, property_id, bed_types, rules, event_templates, ' +
  'property_configuration, variable_costs, fixed_costs, commission_rules, ' +
  'complexity, readiness_policy, section_labels'

const SNAPSHOT_COLUMNS =
  'organization_id, property_id, booking_id, hash, captured_at, ' +
  'effective_on, bed_types, rules, event_templates, property_configuration, ' +
  'variable_costs, fixed_costs, commission_rule, complexity, ' +
  'readiness_policy, section_labels, price_lines'

const PLAN_COLUMNS =
  'id, organization_id, property_id, unit_id, booking_id, version, ' +
  'snapshot_hash, sections, critical_path_minutes, recommended_staff, ' +
  'created_at'

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

  // ── The catalogue, the snapshot and the plan ────────────────────────────

  /**
   * The live configuration for one property.
   *
   * `(organization_id, property_id)` is unique, so `maybeSingle` is the whole
   * query. A property with nothing configured returns `null`, and
   * `buildPlan` turns that into a `NotFoundError` naming the property — which
   * is the right answer, because "nobody has set up preparation here yet" is
   * an ordinary state with an ordinary remedy.
   */
  async loadCatalogue(
    organizationId: string,
    propertyId: string,
  ): Promise<PreparationCatalogue | null> {
    const { data, error } = await this.db
      .from('preparation_catalogues')
      .select(CATALOGUE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('property_id', propertyId)
      .maybeSingle()

    if (error) throw error
    return data ? toCatalogue(toRow(data)) : null
  }

  /**
   * The frozen ruleset this booking was computed against.
   *
   * One row per booking — `preparation_snapshots_booking_key` — and the table
   * is append-only, so there is no "newest capture" to choose between. No
   * organization filter is possible or needed: the port passes only a booking
   * id, and `preparation_snapshots_select` scopes the read to the caller's
   * organizations and property scope.
   */
  async loadSnapshot(bookingId: string): Promise<PreparationSnapshot | null> {
    const { data, error } = await this.db
      .from('preparation_snapshots')
      .select(SNAPSHOT_COLUMNS)
      .eq('booking_id', bookingId)
      .maybeSingle()

    if (error) throw error
    return data ? toSnapshot(toRow(data)) : null
  }

  async loadPlan(bookingId: string): Promise<WorkPlan | null> {
    const { data, error } = await this.db
      .from('work_plans')
      .select(PLAN_COLUMNS)
      .eq('booking_id', bookingId)
      .maybeSingle()

    if (error) throw error
    return data ? toPlan(toRow(data)) : null
  }

  /**
   * Store a plan: update if it is there, insert if it is not.
   *
   * Deliberately not an upsert. PostgREST compiles one into
   * `insert … on conflict do update`, which needs *both* the insert and the
   * update policy — and 0021 separates them on purpose: creating a plan is
   * `task.create`, advancing one is `task.update`/`complete`/`verify`. A
   * cleaner ticking off a section holds the second and not the first, and an
   * upsert would refuse them for a row they are entitled to change.
   *
   * `version` is written, unlike everywhere else in this directory. It is the
   * domain's plan revision — `work_plans` carries `tg_touch_updated_at` and not
   * `tg_touch_row` — and `tg_work_plans_record_version` copies each revision
   * into `work_plan_versions`, which is what makes a `PlanDelta` answerable
   * three weeks later. A separate trigger refuses a version that moves
   * backwards, which is the failure that actually matters here: silently
   * discarding a revision.
   */
  async savePlan(plan: WorkPlan, tx: TransactionHandle): Promise<void> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('work_plans')
      .update({
        version: plan.version,
        snapshot_hash: plan.snapshotHash,
        sections: plan.sections,
        critical_path_minutes: plan.criticalPathMinutes,
        recommended_staff: plan.recommendedStaff,
      })
      .eq('id', plan.id)
      .eq('organization_id', plan.organizationId)
      .select('id')

    if (error) throw error

    if (toRows(data).length === 0) {
      const inserted = await db.from('work_plans').insert({
        id: plan.id,
        organization_id: plan.organizationId,
        property_id: plan.propertyId,
        unit_id: plan.unitId,
        booking_id: plan.bookingId,
        version: plan.version,
        snapshot_hash: plan.snapshotHash,
        sections: plan.sections,
        critical_path_minutes: plan.criticalPathMinutes,
        recommended_staff: plan.recommendedStaff,
        created_at: plan.createdAt,
      })
      if (inserted.error) throw inserted.error
    }

    recordWrite(tx, `work_plans(${plan.id})`)
  }

  /**
   * Freeze the catalogue against a booking. Once, and never again.
   *
   * `property_id` is read from the booking rather than taken from the caller:
   * the column is `NOT NULL` because both foreign keys are checked against it,
   * and `PreparationSnapshot` has no property field. Reading it from a row we
   * already name is the move `finance.ts` makes for a payment with no property
   * — the fact exists, so fetching it is not a guess. Inventing it would let a
   * snapshot claim a booking belongs to a property it does not.
   *
   * A plain insert, because the table refuses updates and deletes by trigger. A
   * second capture for the same booking fails on
   * `preparation_snapshots_booking_key`, loudly, which is what should happen:
   * the whole point of the record is that it does not move.
   */
  async saveSnapshot(
    bookingId: string,
    snapshot: PreparationSnapshot,
    tx: TransactionHandle,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    const { error } = await db.from('preparation_snapshots').insert({
      organization_id: snapshot.organizationId,
      property_id: await this.propertyOf(db, bookingId),
      booking_id: bookingId,
      hash: snapshot.hash,
      captured_at: snapshot.capturedAt,
      effective_on: snapshot.effectiveOn,
      bed_types: snapshot.bedTypes,
      rules: snapshot.rules,
      event_templates: snapshot.eventTemplates,
      property_configuration: snapshot.propertyConfiguration,
      variable_costs: snapshot.variableCosts,
      fixed_costs: snapshot.fixedCosts,
      commission_rule: snapshot.commissionRule,
      complexity: snapshot.complexity,
      readiness_policy: snapshot.readinessPolicy,
      section_labels: snapshot.sectionLabels,
      price_lines: snapshot.priceLines,
    })

    if (error) throw error
    recordWrite(tx, `preparation_snapshots(${bookingId})`)
  }

  // ── Blocked, and not on a table somebody forgot ─────────────────────────

  /**
   * Blocked. `bookings` records the stay, not what preparing it involves.
   *
   * 0021 created the three tables this file was waiting for and deliberately
   * did not touch `bookings`. `PreparationBooking` needs `eventType`, `extras`
   * and the sleeping arrangement, and there is no column for any of them —
   * `metadata` is not one either, because a jsonb blob nothing constrains would
   * make "this is a wedding" a claim rather than a fact. Returning a booking
   * with an invented event type would drive a work plan for the wrong kind of
   * stay, and nobody would notice until the linen ran out.
   */
  async loadBooking(): Promise<PreparationBooking | null> {
    throw blocked(
      'preparation columns on public.bookings',
      'reading the booking a work plan is built for. PreparationBooking ' +
        'carries the event type, the extras and the sleeping arrangement, and ' +
        'bookings has a column for none of them — 0021 added the catalogue, ' +
        'the snapshot and the plan, and deliberately did not touch bookings',
    )
  }

  /**
   * Blocked. These are measurements of a month, and nothing measures it.
   *
   * `AllocationContext` is the set of denominators a fixed cost is divided by
   * — days in the period, nights sold, bookings taken, guests hosted, revenue
   * earned, units available. The domain's own comment says they are *measured
   * facts, not estimates*, which is why they are supplied rather than computed
   * inside the costing engine.
   *
   * Assembling them here from `bookings` would be this adapter deciding what
   * counts: whether a cancelled booking is a booking, whether a comped night is
   * occupied, whether revenue means gross or net. Each of those is a business
   * rule, each changes the number on an owner's statement, and none of them
   * belongs in a mapping layer. What is missing is the rule, not the storage.
   */
  async loadAllocationContexts(): Promise<FixedAllocationInput['contexts']> {
    throw blocked(
      'a stored or derived period occupancy summary',
      'spreading a fixed cost across the stays that should carry it. ' +
        'AllocationContext is six measured facts about a period — days, ' +
        'occupied nights, bookings, guests, revenue and units — and deciding ' +
        'whether a cancelled booking counts is a business rule this layer ' +
        'must not invent',
    )
  }

  /** The property a booking belongs to. See `saveSnapshot`. */
  private async propertyOf(db: Db, bookingId: string): Promise<string> {
    const { data, error } = await db
      .from('bookings')
      .select('property_id')
      .eq('id', bookingId)
      .maybeSingle()

    if (error) throw error
    if (!data) throw new NotFoundError('booking', bookingId)
    return asString(toRow(data), 'property_id')
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

/**
 * The jsonb columns are carried through, not reassembled.
 *
 * Every one of them holds a domain value the domain itself wrote — a rule, a
 * cost model, a set of section labels — and 0021 constrains the *shape* of each
 * with a `jsonb_typeof` CHECK so an object cannot arrive where an array
 * belongs. Re-validating each field here would be a second copy of types that
 * already exist in `src/lib/preparation/types.ts`, and the copy is what drifts.
 *
 * What is checked is the boundary: an array column that is not an array, or an
 * object column that is not an object, fails here rather than three layers up.
 */
function jsonArray<T>(row: Row, column: string): readonly T[] {
  const value = row[column]
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) {
    throw new RowShapeError(column, 'a json array', value)
  }
  return value as T[]
}

function toCatalogue(row: Row): PreparationCatalogue {
  return {
    organizationId: asString(row, 'organization_id'),
    bedTypes: jsonArray(row, 'bed_types'),
    rules: jsonArray(row, 'rules'),
    eventTemplates: jsonArray(row, 'event_templates'),
    propertyConfiguration: asJsonRecord(
      row,
      'property_configuration',
    ) as unknown as PreparationCatalogue['propertyConfiguration'],
    variableCosts: jsonArray(row, 'variable_costs'),
    fixedCosts: jsonArray(row, 'fixed_costs'),
    commissionRules: jsonArray(row, 'commission_rules'),
    complexity: asJsonRecord(
      row,
      'complexity',
    ) as unknown as PreparationCatalogue['complexity'],
    readinessPolicy: asJsonRecord(
      row,
      'readiness_policy',
    ) as unknown as PreparationCatalogue['readinessPolicy'],
    sectionLabels: asJsonRecord(
      row,
      'section_labels',
    ) as unknown as PreparationCatalogue['sectionLabels'],
  }
}

function toSnapshot(row: Row): PreparationSnapshot {
  return {
    organizationId: asString(row, 'organization_id'),
    hash: asString(row, 'hash'),
    capturedAt: asTimestamp(row, 'captured_at'),
    // A `date`, and it stays a string. Parsing it into an instant would make
    // which rules were in force depend on the server's time zone.
    effectiveOn: asIsoDate(row, 'effective_on'),
    bedTypes: jsonArray(row, 'bed_types'),
    rules: jsonArray(row, 'rules'),
    eventTemplates: jsonArray(row, 'event_templates'),
    propertyConfiguration: asJsonRecord(
      row,
      'property_configuration',
    ) as unknown as PreparationSnapshot['propertyConfiguration'],
    variableCosts: jsonArray(row, 'variable_costs'),
    fixedCosts: jsonArray(row, 'fixed_costs'),
    // Singular and nullable. The catalogue carries every commission rule; the
    // snapshot carries the one that was selected, or none — and `null` here is
    // "no commission on this stay", which is a real answer.
    commissionRule: (row.commission_rule ??
      null) as PreparationSnapshot['commissionRule'],
    complexity: asJsonRecord(
      row,
      'complexity',
    ) as unknown as PreparationSnapshot['complexity'],
    readinessPolicy: asJsonRecord(
      row,
      'readiness_policy',
    ) as unknown as PreparationSnapshot['readinessPolicy'],
    sectionLabels: asJsonRecord(
      row,
      'section_labels',
    ) as unknown as PreparationSnapshot['sectionLabels'],
    priceLines: jsonArray<PriceLine>(row, 'price_lines'),
  }
}

function toPlan(row: Row): WorkPlan {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    bookingId: asString(row, 'booking_id'),
    propertyId: asString(row, 'property_id'),
    unitId: asString(row, 'unit_id'),
    // The domain's plan revision, not an optimistic lock. See the header.
    version: asNumber(row, 'version'),
    snapshotHash: asString(row, 'snapshot_hash'),
    createdAt: asTimestamp(row, 'created_at'),
    sections: jsonArray(row, 'sections'),
    criticalPathMinutes: asNumber(row, 'critical_path_minutes'),
    recommendedStaff: asNumber(row, 'recommended_staff'),
  }
}

function blocked(missing: string, purpose: string): SchemaNotProvisionedError {
  return new SchemaNotProvisionedError(missing, purpose)
}
