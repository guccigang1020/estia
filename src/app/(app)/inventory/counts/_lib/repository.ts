/**
 * EXECUTION CONTEXT — SERVER ONLY. Storage for the stocktake.
 *
 * ══ THE TABLES MAY NOT EXIST YET, AND THAT IS A STATE ══════════════════════
 *
 * `src/lib/inventory/counts.ts` is written against a schema that has been
 * proposed and not yet applied — the migration is the coordinator's to write.
 * So `isMissingSchema` turns a "relation does not exist" into a reported
 * absence rather than a 500, exactly the way
 * `src/app/(app)/channels/_lib/manager.ts` does, and for the same reason: a
 * derived "the stocktake tables are not installed in this deployment" goes
 * away by itself the moment the migration runs, with no change to this file.
 *
 * Two codes, because the two layers report it differently: Postgres raises
 * `42P01` for an unknown relation and PostgREST answers `PGRST205` when the
 * table is not in its schema cache. **Everything else is rethrown.** Swallowing
 * every error here would turn a broken policy into a screen that says "not
 * installed", which is the most misleading sentence this page could produce.
 *
 * ══ THE LEDGER IS READ THROUGH THE EXISTING REPOSITORY ═════════════════════
 *
 * `snapshotExpected` calls `SupabaseInventoryRepository.loadForecastItems` —
 * the same read the forecast, the shortage screen and the item list already
 * use, which groups `inventory_items` rows into the things a person would name
 * and derives `onHandClean` from `ALLOCATABLE_INVENTORY_STATES`. It does not
 * issue its own sum over `inventory_movements` and it does not read `quantity`
 * directly. A second answer to "how many towels does this villa have" is the
 * one defect this module must not introduce, and the way to not introduce it
 * is to have no second query.
 *
 * The consequence worth knowing: a line's `item_id` is the *group* id, which
 * is the allocatable row's id, because that is the row the grouping picks and
 * the row a reservation increments.
 *
 * ══ NOTHING HERE DECIDES ANYTHING ══════════════════════════════════════════
 *
 * No variance is computed in this file, no classification is chosen and no
 * exposure is estimated. `reconcile` and `lossEffect` own those, they are
 * pure, and they are tested without a database. This adapter moves rows.
 */

import {
  COUNT_SESSION_STATUSES,
  expectedFromLedger,
  type CountLine,
  type CountPorts,
  type CountSessionRecord,
  type CountSessionStatus,
  type CountVariance,
  type CountVarianceRecord,
  type ExpectedStock,
  type NewCountSession,
} from '@/lib/inventory/counts'
import { LOSS_CLASSES, type LossClass } from '@/lib/inventory/loss'
import { INVENTORY_STATES, type InventoryState } from '@/lib/contracts/states'
import { SupabaseInventoryRepository } from '@/lib/persistence/inventory'
import {
  asBoolean,
  asEnum,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------- provisioning -- */

/** Is this the database saying the stocktake tables were never installed? */
export function isMissingSchema(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === '42P01' || code === 'PGRST205'
}

/**
 * Run a read, and answer `{ ok: false }` for a table that is not there.
 *
 * Only for that. Every other failure is rethrown to the caller, which is what
 * keeps a broken policy from being reported as a missing migration.
 */
export async function orNotProvisioned<T>(
  read: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    if (isMissingSchema(error)) return { ok: false }
    throw error
  }
}

/* -------------------------------------------------------------- columns -- */

const SESSION_COLUMNS =
  'id, organization_id, property_id, label, status, blind, scheduled_for, ' +
  'task_id, counting_started_at, reconciling_started_at, closed_at, note, ' +
  'version'

const LINE_COLUMNS =
  'id, session_id, organization_id, property_id, item_id, counted_quantity, ' +
  'counted_at, note'

const EXPECTATION_COLUMNS =
  'item_id, expected_on_shelf, owned_total, circulating_total, states, ' +
  'replacement_cost_agorot, captured_at'

const VARIANCE_COLUMNS =
  'id, session_id, organization_id, property_id, item_id, expected_quantity, ' +
  'counted_quantity, variance, circulating, replacement_cost_agorot, ' +
  'classification, classification_note, classified_at, movement_id'

/** The statuses a stocktake is still live in. One per property, at most. */
export const LIVE_STATUSES: readonly CountSessionStatus[] = [
  'open',
  'counting',
  'reconciling',
]

/** What PostgREST resolves to, in the only shape this file needs. */
type Answer = PromiseLike<{ data?: unknown; error?: unknown }>

/** Item facts a sheet line needs and the count tables do not store. */
interface ItemFacts {
  label: string
  unitOfMeasure: string
  location: string | null
  unitCostAgorot: number | null
}

/* ----------------------------------------------------------- the adapter -- */

export class SupabaseCountRepository implements CountPorts {
  private readonly inventory: SupabaseInventoryRepository

  constructor(private readonly db: Db) {
    this.inventory = new SupabaseInventoryRepository(db)
  }

  /** Delegated, so one settings read serves operations, commands and counts. */
  async loadSettings(organizationId: string) {
    return this.inventory.loadSettings(organizationId)
  }

  async loadSession(args: {
    organizationId: string
    sessionId: string
  }): Promise<CountSessionRecord | null> {
    const rows = await this.rows(
      this.db
        .from('inventory_count_sessions')
        .select(SESSION_COLUMNS)
        .eq('organization_id', args.organizationId)
        .eq('id', args.sessionId)
        .limit(1),
    )

    return rows.length === 0 ? null : toSession(rows[0])
  }

  async liveSessionFor(args: {
    organizationId: string
    propertyId: string
  }): Promise<{ id: string; status: CountSessionStatus } | null> {
    const rows = await this.rows(
      this.db
        .from('inventory_count_sessions')
        .select('id, status')
        .eq('organization_id', args.organizationId)
        .eq('property_id', args.propertyId)
        .in('status', [...LIVE_STATUSES])
        .limit(1),
    )

    if (rows.length === 0) return null
    return {
      id: asString(rows[0], 'id'),
      status: asEnum(rows[0], 'status', COUNT_SESSION_STATUSES),
    }
  }

  /**
   * The session and its sheet.
   *
   * An empty `itemIds` means "everything at this property", resolved through
   * the forecast grouping rather than by a query of this file's own: which
   * rows make up "bath towels" is a question the stock module already answers,
   * and answering it twice is how two screens count different cupboards.
   */
  async createSession(
    draft: NewCountSession,
  ): Promise<{ id: string; lines: number }> {
    const items =
      draft.itemIds.length > 0
        ? [...draft.itemIds]
        : (
            await this.inventory.loadForecastItems({
              organizationId: draft.organizationId,
              propertyIds: [draft.propertyId],
            })
          ).map((item) => item.itemId)

    const created = await this.one(
      this.db
        .from('inventory_count_sessions')
        .insert({
          organization_id: draft.organizationId,
          property_id: draft.propertyId,
          label: draft.label,
          status: 'open',
          blind: draft.blind,
          scheduled_for: draft.scheduledFor,
          task_id: draft.taskId,
          note: draft.note,
        })
        .select('id')
        .single(),
    )

    const id = asString(created, 'id')

    if (items.length > 0) {
      await this.run(
        this.db.from('inventory_count_lines').insert(
          items.map((itemId) => ({
            session_id: id,
            organization_id: draft.organizationId,
            property_id: draft.propertyId,
            item_id: itemId,
          })),
        ),
      )
    }

    return { id, lines: items.length }
  }

  async advanceSession(args: {
    organizationId: string
    sessionId: string
    to: CountSessionStatus
    at: string
    reason: string | null
  }): Promise<void> {
    // The stage timestamps are columns rather than an event log because every
    // screen asks "when did this start" and none asks for the whole history.
    const patch: Record<string, unknown> = { status: args.to }
    if (args.to === 'counting') patch.counting_started_at = args.at
    if (args.to === 'reconciling') patch.reconciling_started_at = args.at
    if (args.to === 'closed') patch.closed_at = args.at
    if (args.to === 'cancelled') patch.cancelled_reason = args.reason

    await this.run(
      this.db
        .from('inventory_count_sessions')
        .update(patch)
        .eq('organization_id', args.organizationId)
        .eq('id', args.sessionId),
    )
  }

  /**
   * Freeze what the ledger believes, and answer with a count.
   *
   * The return type is deliberate and is one of the three things that make a
   * blind count blind: the operation that starts one cannot leak an expected
   * quantity, because this method never hands one back. See the header of
   * `src/lib/inventory/counts.ts`.
   */
  async snapshotExpected(args: {
    organizationId: string
    sessionId: string
  }): Promise<{ items: number }> {
    const session = await this.loadSession(args)
    if (session === null) return { items: 0 }

    const lines = await this.lineRows(args)
    const wanted = new Set(lines.map((row) => asString(row, 'item_id')))

    const ledger = await this.inventory.loadForecastItems({
      organizationId: args.organizationId,
      propertyIds: [session.propertyId],
    })
    const facts = await this.itemFacts(args.organizationId, [...wanted])
    const capturedAt = new Date().toISOString()

    const rows = ledger
      .filter((item) => wanted.has(item.itemId))
      .map((item) => {
        const expected = expectedFromLedger({
          item,
          replacementCostAgorot: facts.get(item.itemId)?.unitCostAgorot ?? null,
          capturedAt,
        })

        return {
          session_id: args.sessionId,
          organization_id: args.organizationId,
          property_id: session.propertyId,
          item_id: expected.itemId,
          expected_on_shelf: expected.onShelf,
          owned_total: expected.owned,
          circulating_total: expected.circulating,
          states: expected.elsewhere,
          replacement_cost_agorot: expected.replacementCostAgorot,
          captured_at: capturedAt,
        }
      })

    if (rows.length > 0) {
      await this.run(this.db.from('inventory_count_expectations').insert(rows))
    }

    return { items: rows.length }
  }

  async loadExpected(args: {
    organizationId: string
    sessionId: string
  }): Promise<readonly ExpectedStock[]> {
    const rows = await this.rows(
      this.db
        .from('inventory_count_expectations')
        .select(EXPECTATION_COLUMNS)
        .eq('organization_id', args.organizationId)
        .eq('session_id', args.sessionId),
    )

    return rows.map((row) => ({
      itemId: asString(row, 'item_id'),
      onShelf: asNumber(row, 'expected_on_shelf'),
      owned: asNumber(row, 'owned_total'),
      elsewhere: toStates(row['states']),
      circulating: asNumber(row, 'circulating_total'),
      replacementCostAgorot: asNumberOrNull(row, 'replacement_cost_agorot'),
      capturedAt: asString(row, 'captured_at'),
    }))
  }

  async loadLines(args: {
    organizationId: string
    sessionId: string
  }): Promise<readonly CountLine[]> {
    const rows = await this.lineRows(args)
    const facts = await this.itemFacts(
      args.organizationId,
      rows.map((row) => asString(row, 'item_id')),
    )

    return rows.map((row) => {
      const itemId = asString(row, 'item_id')
      const fact = facts.get(itemId)

      return {
        id: asString(row, 'id'),
        sessionId: asString(row, 'session_id'),
        itemId,
        // The id, when the item row has gone. A blank line on a stocktake is
        // worse than an ugly one: the counter cannot tell what to look for.
        label: fact?.label ?? itemId,
        unitOfMeasure: fact?.unitOfMeasure ?? 'יח׳',
        location: fact?.location ?? null,
        countedQuantity: asNumberOrNull(row, 'counted_quantity'),
        countedAt: asStringOrNull(row, 'counted_at'),
        note: asStringOrNull(row, 'note'),
      }
    })
  }

  async saveCount(args: {
    organizationId: string
    sessionId: string
    itemId: string
    countedQuantity: number
    countedAt: string
    note: string | null
  }): Promise<void> {
    await this.run(
      this.db
        .from('inventory_count_lines')
        .update({
          counted_quantity: args.countedQuantity,
          counted_at: args.countedAt,
          note: args.note,
        })
        .eq('organization_id', args.organizationId)
        .eq('session_id', args.sessionId)
        .eq('item_id', args.itemId),
    )
  }

  async saveVariances(args: {
    organizationId: string
    sessionId: string
    variances: readonly CountVariance[]
  }): Promise<{ written: number }> {
    if (args.variances.length === 0) return { written: 0 }

    const session = await this.loadSession({
      organizationId: args.organizationId,
      sessionId: args.sessionId,
    })
    if (session === null) return { written: 0 }

    await this.run(
      this.db.from('inventory_count_variances').insert(
        args.variances.map((variance) => ({
          session_id: args.sessionId,
          organization_id: args.organizationId,
          property_id: session.propertyId,
          item_id: variance.itemId,
          expected_quantity: variance.expected,
          counted_quantity: variance.counted,
          circulating: variance.circulating,
          replacement_cost_agorot: variance.replacementCostAgorot,
        })),
      ),
    )

    return { written: args.variances.length }
  }

  async loadVariance(args: {
    organizationId: string
    varianceId: string
  }): Promise<CountVarianceRecord | null> {
    const rows = await this.rows(
      this.db
        .from('inventory_count_variances')
        .select(VARIANCE_COLUMNS)
        .eq('organization_id', args.organizationId)
        .eq('id', args.varianceId)
        .limit(1),
    )
    if (rows.length === 0) return null

    const itemId = asString(rows[0], 'item_id')
    const facts = await this.itemFacts(args.organizationId, [itemId])

    return toVariance(rows[0], facts.get(itemId)?.label ?? itemId)
  }

  async saveClassification(args: {
    organizationId: string
    varianceId: string
    classification: LossClass
    note: string | null
    movementId: string | null
    classifiedAt: string
  }): Promise<void> {
    await this.run(
      this.db
        .from('inventory_count_variances')
        .update({
          classification: args.classification,
          classification_note: args.note,
          classified_at: args.classifiedAt,
          movement_id: args.movementId,
        })
        .eq('organization_id', args.organizationId)
        .eq('id', args.varianceId),
    )
  }

  /** The ledger. Delegated, so there is one writer of `inventory_movements`. */
  async recordMovement(args: {
    organizationId: string
    movement: {
      itemId: string
      propertyId: string
      kind: 'receipt' | 'issue' | 'adjustment' | 'loss' | 'count'
      quantityDelta: number
      toState: string | null
      reason: string
    }
  }): Promise<{ id: string }> {
    return this.inventory.recordMovement(args)
  }

  async stampLastCounted(args: {
    organizationId: string
    sessionId: string
    at: string
  }): Promise<{ items: number }> {
    const rows = await this.lineRows(args)
    const counted = rows.filter(
      (row) => asNumberOrNull(row, 'counted_quantity') !== null,
    )
    if (counted.length === 0) return { items: 0 }

    // Only the lines somebody actually counted. Stamping an uncounted item as
    // counted would make the next stocktake believe this cupboard was seen.
    await this.run(
      this.db
        .from('inventory_items')
        .update({ last_counted_at: args.at })
        .eq('organization_id', args.organizationId)
        .in(
          'id',
          counted.map((row) => asString(row, 'item_id')),
        ),
    )

    return { items: counted.length }
  }

  async unexplainedCount(args: {
    organizationId: string
    sessionId: string
  }): Promise<number> {
    const rows = await this.rows(
      this.db
        .from('inventory_count_variances')
        .select('id, classification')
        .eq('organization_id', args.organizationId)
        .eq('session_id', args.sessionId),
    )

    // `null` and `unknown` are both unexplained and they are different facts.
    // The domain owns that distinction; this only counts what it names.
    return rows.filter((row) => {
      const value = row['classification']
      return value === null || value === undefined || value === 'unknown'
    }).length
  }

  /* ---------------------------------------------------------- the reads -- */

  /** Sessions this reader may see, newest first. */
  async listSessions(args: {
    organizationId: string
    propertyIds: readonly string[]
    limit: number
  }): Promise<readonly CountSessionRecord[]> {
    const base = this.db
      .from('inventory_count_sessions')
      .select(SESSION_COLUMNS)
      .eq('organization_id', args.organizationId)

    const scoped =
      args.propertyIds.length > 0
        ? base.in('property_id', [...args.propertyIds])
        : base

    const rows = await this.rows(
      scoped.order('created_at', { ascending: false }).limit(args.limit),
    )

    return rows.map(toSession)
  }

  async listVariances(args: {
    organizationId: string
    sessionId: string
  }): Promise<readonly CountVarianceRecord[]> {
    const rows = await this.rows(
      this.db
        .from('inventory_count_variances')
        .select(VARIANCE_COLUMNS)
        .eq('organization_id', args.organizationId)
        .eq('session_id', args.sessionId),
    )

    const facts = await this.itemFacts(
      args.organizationId,
      rows.map((row) => asString(row, 'item_id')),
    )

    return rows.map((row) => {
      const itemId = asString(row, 'item_id')
      return toVariance(row, facts.get(itemId)?.label ?? itemId)
    })
  }

  /* ----------------------------------------------------------- plumbing -- */

  private async lineRows(args: {
    organizationId: string
    sessionId: string
  }): Promise<readonly Row[]> {
    return this.rows(
      this.db
        .from('inventory_count_lines')
        .select(LINE_COLUMNS)
        .eq('organization_id', args.organizationId)
        .eq('session_id', args.sessionId)
        .order('item_id', { ascending: true }),
    )
  }

  /**
   * The item facts a sheet needs, read from `inventory_items`.
   *
   * A separate query rather than a PostgREST embed, on purpose: an embed is
   * one of the filters `FakeSupabaseClient` does not implement, and a query
   * nobody can unit-test is how a wrong column name ships.
   */
  private async itemFacts(
    organizationId: string,
    itemIds: readonly string[],
  ): Promise<ReadonlyMap<string, ItemFacts>> {
    if (itemIds.length === 0) return new Map()

    const rows = await this.rows(
      this.db
        .from('inventory_items')
        .select('id, name, unit_of_measure, location, unit_cost_agorot')
        .eq('organization_id', organizationId)
        .in('id', [...new Set(itemIds)]),
    )

    return new Map(
      rows.map((row) => [
        asString(row, 'id'),
        {
          label: asString(row, 'name'),
          unitOfMeasure: asString(row, 'unit_of_measure'),
          location: asStringOrNull(row, 'location'),
          unitCostAgorot: asNumberOrNull(row, 'unit_cost_agorot'),
        },
      ]),
    )
  }

  private async rows(answer: Answer): Promise<readonly Row[]> {
    const { data, error } = await answer
    if (error) throw asThrowable(error)
    return toRows(data)
  }

  private async one(answer: Answer): Promise<Row> {
    const { data, error } = await answer
    if (error) throw asThrowable(error)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('the insert returned no row')
    }
    return data as Row
  }

  private async run(answer: Answer): Promise<void> {
    const { error } = await answer
    if (error) throw asThrowable(error)
  }
}

/* -------------------------------------------------------------- mapping -- */

/**
 * A PostgREST error object is not an `Error`, and throwing it directly loses
 * the stack. It is wrapped, and the `code` is carried across so
 * `isMissingSchema` can still read it.
 */
function asThrowable(error: unknown): unknown {
  if (error instanceof Error) return error
  if (typeof error === 'object' && error !== null) {
    const detail = error as { message?: unknown; code?: unknown }
    const wrapped = new Error(
      typeof detail.message === 'string' ? detail.message : 'database error',
    )
    return Object.assign(wrapped, { code: detail.code })
  }
  return new Error('database error')
}

function toSession(row: Row): CountSessionRecord {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    label: asStringOrNull(row, 'label'),
    status: asEnum(row, 'status', COUNT_SESSION_STATUSES),
    blind: asBoolean(row, 'blind'),
    scheduledFor: asStringOrNull(row, 'scheduled_for'),
    taskId: asStringOrNull(row, 'task_id'),
    countingStartedAt: asStringOrNull(row, 'counting_started_at'),
    reconcilingStartedAt: asStringOrNull(row, 'reconciling_started_at'),
    closedAt: asStringOrNull(row, 'closed_at'),
    note: asStringOrNull(row, 'note'),
    version: asNumber(row, 'version'),
  }
}

function toVariance(row: Row, label: string): CountVarianceRecord {
  const raw = row['classification']
  const classification =
    typeof raw === 'string' && (LOSS_CLASSES as readonly string[]).includes(raw)
      ? (raw as LossClass)
      : null

  return {
    id: asString(row, 'id'),
    sessionId: asString(row, 'session_id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    itemId: asString(row, 'item_id'),
    label,
    expected: asNumber(row, 'expected_quantity'),
    counted: asNumber(row, 'counted_quantity'),
    variance: asNumber(row, 'variance'),
    circulating: asNumber(row, 'circulating'),
    replacementCostAgorot: asNumberOrNull(row, 'replacement_cost_agorot'),
    classification,
  }
}

/**
 * The per-state breakdown, defensively.
 *
 * A state the contract does not name is dropped rather than carried: the
 * snapshot is written by this product and read by it, and a key nobody
 * recognises is corruption, not data.
 */
function toStates(value: unknown): Partial<Record<InventoryState, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }

  const known = new Set<string>(INVENTORY_STATES)
  const states: Partial<Record<InventoryState, number>> = {}

  for (const [state, quantity] of Object.entries(value)) {
    if (typeof quantity !== 'number') continue
    if (!known.has(state)) continue
    states[state as InventoryState] = quantity
  }

  return states
}
