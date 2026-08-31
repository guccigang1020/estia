/**
 * EXECUTION CONTEXT — SERVER ONLY. What maintenance work is costing.
 *
 * The rows are read by `tasks/_lib/queries.ts` — a maintenance job is a task,
 * and there is one reading of a task row. What this file adds is the half the
 * board does not have: the money.
 *
 * ── `public.tasks` has no amount column, and that is correct ──────────────
 *
 * A job is not an expense. What a repair costs is either a sum somebody had to
 * approve or the stock it consumed, and both are recorded where they belong:
 *
 *   · `approvals.requested_agorot`, where `approvals.task_id` names the job.
 *     0011 gives approvals a `task_id` for exactly this. The status ladder
 *     matters and is kept: an `approved` request is money the business has
 *     committed, a `requested` one is money nobody has agreed to yet, and
 *     adding them together would report a quote as a cost.
 *   · `inventory_movements` with a `task_id` and a negative `quantity_delta`,
 *     priced at `inventory_items.unit_cost_agorot`. A movement is signed and
 *     append-only, so this is a sum over a ledger rather than a number somebody
 *     typed.
 *
 * Integer agorot throughout. Nothing here divides by 100 and nothing formats;
 * `formatAgorot` in the components is the product's one ₪ formatter.
 *
 * ── Who may see it ───────────────────────────────────────────────────────
 *
 * `expense.view`. Not `task.view`: the maintenance role holds `task.view`,
 * `task.update`, `task.complete`, `incident.*` and `inventory.view` and holds
 * no expense grant at all — the handyman fixes the boiler and does not see what
 * the business is paying for it. A property manager holds `expense.view` and
 * does. The figures are therefore withheld as *absent keys*, so the component
 * prints "לא זמין לצפייה" and never a ₪0 that reads as "this repair was free".
 */

import { holdsGrant, redact, type Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { APPROVAL_STATUSES, type ApprovalStatus } from '@/lib/contracts/states'
import { sumAgorot } from '@/lib/finance'
import {
  asEnum,
  asNumberOrNull,
  asString,
  asStringOrNull,
  toRows,
  type Db,
} from '@/lib/persistence'

import type { TaskListItem } from '../../tasks/_lib/queries'

/**
 * What one maintenance job has cost so far, as far as this reader may see.
 *
 * Three figures rather than one. "This repair cost ₪4,800" is a sentence that
 * means nothing when nobody has approved the quote yet: what has been
 * *committed*, what is still *waiting for a decision* and what was *taken off
 * the shelf* are three different facts, and a single total would be whichever
 * of them the reader assumed.
 *
 * Every key is optional because `redact()` genuinely removes them together: a
 * reader without `expense.view` gets a record with none of the four, and the
 * type says so rather than letting a component read `undefined` out of a field
 * it was told was a number.
 */
export type MaintenanceCost = {
  /** Approved requests. Money the business has agreed to spend. */
  approvedAgorot?: number
  /** Requested and undecided. A quote, not yet a cost. */
  pendingAgorot?: number
  /** Stock issued against this job, at the item's recorded unit cost. */
  partsAgorot?: number
  /** `approvedAgorot + partsAgorot`. Deliberately excludes the pending half. */
  committedAgorot?: number
  /** How many approvals are attached, so an empty cost is explicable. */
  approvalCount: number
  /** True when a decision is outstanding and the work may be waiting on it. */
  awaitingDecision: boolean
}

export type MaintenanceItem = TaskListItem & { cost: MaintenanceCost }

const COST_REDACTIONS = [
  { key: 'approvedAgorot', requires: 'expense.view' },
  { key: 'pendingAgorot', requires: 'expense.view' },
  { key: 'partsAgorot', requires: 'expense.view' },
  { key: 'committedAgorot', requires: 'expense.view' },
] as const satisfies ReadonlyArray<{
  key: keyof MaintenanceCost
  requires: Grant
}>

/** Statuses where the money is genuinely committed. */
const COMMITTED: readonly ApprovalStatus[] = ['approved']

/** Statuses where somebody still has to decide. */
const UNDECIDED: readonly ApprovalStatus[] = ['requested']

/**
 * Attach what each job is costing.
 *
 * Two `in` queries for the whole page rather than two per row, and a third only
 * when stock was actually consumed. The embeds would be the obvious move and
 * are not available — `DEMO_RELATIONS` declares the joins the demo client can
 * resolve and neither `approvals` nor `inventory_movements` has one — so an
 * embed here would be a screen that works against Postgres and throws
 * `UnsupportedQuery` in the demo.
 */
export async function withCosts(
  db: Db,
  actor: Actor,
  tasks: readonly TaskListItem[],
): Promise<readonly MaintenanceItem[]> {
  if (tasks.length === 0) return []

  const taskIds = tasks.map((task) => task.id)
  const maySeeMoney = holdsGrant(actor, 'expense.view')

  // Not merely hidden afterwards: a reader who may not see what a repair costs
  // has no business having the figures read on their behalf, and skipping the
  // queries is the version of that which cannot be got wrong.
  const [approvals, parts] = maySeeMoney
    ? await Promise.all([
        approvalsFor(db, actor.organizationId, taskIds),
        partsFor(db, actor.organizationId, taskIds),
      ])
    : [new Map<string, ApprovalLine[]>(), new Map<string, number>()]

  return tasks.map((task) => {
    const lines = approvals.get(task.id) ?? []

    const cost: MaintenanceCost = {
      approvedAgorot: sumAgorot(
        lines
          .filter((line) => COMMITTED.includes(line.status))
          .map((line) => line.agorot),
      ),
      pendingAgorot: sumAgorot(
        lines
          .filter((line) => UNDECIDED.includes(line.status))
          .map((line) => line.agorot),
      ),
      partsAgorot: parts.get(task.id) ?? 0,
      committedAgorot: 0,
      approvalCount: lines.length,
      awaitingDecision: lines.some((line) => UNDECIDED.includes(line.status)),
    }

    cost.committedAgorot = sumAgorot([
      cost.approvedAgorot ?? 0,
      cost.partsAgorot ?? 0,
    ])

    return { ...task, cost: redact(actor, cost, COST_REDACTIONS) }
  })
}

/**
 * What the jobs on screen have committed between them, or `null` when withheld.
 *
 * `null` rather than zero when the figures were redacted: a reader who may not
 * see one repair's cost may certainly not see the sum of twelve.
 */
export function maintenanceTotal(
  items: readonly MaintenanceItem[],
): { committedAgorot: number; pendingAgorot: number } | null {
  const committed: number[] = []
  const pending: number[] = []

  for (const item of items) {
    if (
      item.cost.committedAgorot === undefined ||
      item.cost.pendingAgorot === undefined
    ) {
      return null
    }
    committed.push(item.cost.committedAgorot)
    pending.push(item.cost.pendingAgorot)
  }

  return {
    committedAgorot: sumAgorot(committed),
    pendingAgorot: sumAgorot(pending),
  }
}

/* ------------------------------------------------------------ internals -- */

type ApprovalLine = { status: ApprovalStatus; agorot: number }

/**
 * The approvals attached to these jobs.
 *
 * `requested_agorot` is nullable — a discount approval carries basis points and
 * no shekel figure — and a null is skipped rather than counted as zero. A
 * refund request measured in percent is not a maintenance cost of ₪0.
 */
async function approvalsFor(
  db: Db,
  organizationId: string,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, ApprovalLine[]>> {
  if (taskIds.length === 0) return new Map()

  const { data, error } = await db
    .from('approvals')
    .select('id, task_id, status, requested_agorot')
    .eq('organization_id', organizationId)
    .in('task_id', [...taskIds])

  if (error) throw error

  const byTask = new Map<string, ApprovalLine[]>()
  for (const row of toRows(data)) {
    const taskId = asStringOrNull(row, 'task_id')
    const agorot = asNumberOrNull(row, 'requested_agorot')
    if (taskId === null || agorot === null) continue
    if (!Number.isInteger(agorot)) continue

    byTask.set(taskId, [
      ...(byTask.get(taskId) ?? []),
      { status: asEnum(row, 'status', APPROVAL_STATUSES), agorot },
    ])
  }
  return byTask
}

/**
 * The stock these jobs consumed, priced at the item's recorded unit cost.
 *
 * Only negative deltas count. A `return` movement puts a cot back on the shelf
 * and is not a negative cost on the repair that borrowed it; netting the two
 * would let a job that returned more than it took report a profit.
 *
 * An item with no `unit_cost_agorot` contributes nothing and is not guessed at.
 * That understates the cost, and understating it is the honest direction: an
 * invented unit price is a figure somebody would put in a report.
 */
async function partsFor(
  db: Db,
  organizationId: string,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (taskIds.length === 0) return new Map()

  const { data, error } = await db
    .from('inventory_movements')
    .select('task_id, item_id, quantity_delta')
    .eq('organization_id', organizationId)
    .in('task_id', [...taskIds])

  if (error) throw error

  const movements = toRows(data)
    .map((row) => ({
      taskId: asStringOrNull(row, 'task_id'),
      itemId: asString(row, 'item_id'),
      delta: asNumberOrNull(row, 'quantity_delta') ?? 0,
    }))
    .filter((movement) => movement.taskId !== null && movement.delta < 0)

  if (movements.length === 0) return new Map()

  const itemIds = [...new Set(movements.map((movement) => movement.itemId))]
  const { data: itemData, error: itemError } = await db
    .from('inventory_items')
    .select('id, unit_cost_agorot')
    .eq('organization_id', organizationId)
    .in('id', itemIds)

  if (itemError) throw itemError

  const unitCost = new Map<string, number>()
  for (const row of toRows(itemData)) {
    const cost = asNumberOrNull(row, 'unit_cost_agorot')
    if (cost !== null && Number.isInteger(cost)) {
      unitCost.set(asString(row, 'id'), cost)
    }
  }

  const byTask = new Map<string, number>()
  for (const movement of movements) {
    const cost = unitCost.get(movement.itemId)
    if (cost === undefined) continue
    const taskId = movement.taskId as string
    byTask.set(
      taskId,
      (byTask.get(taskId) ?? 0) + Math.abs(movement.delta) * cost,
    )
  }
  return byTask
}
