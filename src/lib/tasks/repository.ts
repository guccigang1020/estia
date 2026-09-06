/**
 * Reading and writing the two tables 0011 gives this module.
 *
 * A port and one adapter over an injected PostgREST-shaped client. The port
 * exists for the reason `src/lib/notifications/repository.ts` gives and the
 * same one `src/lib/payments/repository.ts` gives: `src/lib/persistence/**`
 * belongs to another owner and writes no task today, so the adapter for this
 * module's own tables lives beside the module that reads them.
 *
 * The client is always passed in. Nothing here constructs one, nothing here
 * reads `@/lib/env`, and every query therefore runs as whoever the caller is —
 * which under row level security is the floor beneath `assertCan` and refuses
 * regardless of what happens above it.
 *
 * ── Why the leaf imports, and not `@/lib/persistence` ─────────────────────
 *
 * `../persistence/mapping` and `../persistence/transaction` rather than the
 * barrel, which re-exports `postgres` and takes every route down with
 * `Can't resolve 'fs'` the moment anything a Client Component reaches imports
 * it. `scripts/client-bundle.mjs` records that happening three times in one
 * day and gives exactly this instruction. The mapping and transaction helpers
 * are pure and carry no driver.
 *
 * ── Every read is filtered by tenant as well as policed by one ────────────
 *
 * `organization_id` appears in the query even though the policy already
 * settles it. The policy is the enforcement; the filter is what stops a
 * mistake in this file from becoming a cross-tenant write the first time
 * somebody runs it as `service_role`.
 *
 * ── What is not here ──────────────────────────────────────────────────────
 *
 * `task_checklists`. 0011 creates it and nothing in this module ticks an item
 * off, so there is no port for it: an adapter method with no operation behind
 * it is a write that has skipped the pipeline waiting to be called.
 */

import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '../contracts/states'
import type { Db, Row } from '../persistence/client'
import {
  asNumber,
  asString,
  asStringOrNull,
  toRow,
  toRows,
} from '../persistence/mapping'
import { clientFor, recordWrite } from '../persistence/transaction'
import type { TransactionHandle } from '../service'

import type {
  AssignmentDraft,
  CreatedTask,
  TaskAssignment,
  TaskDraft,
  TaskPatch,
  TaskRecord,
} from './types'

/* ------------------------------------------------------------------ port -- */

export interface TaskRepository {
  /** `null` when there is no such task, or it is soft-deleted. */
  loadTask(taskId: string): Promise<TaskRecord | null>

  /** The people currently on the task. Ended assignments are not live. */
  liveAssignments(taskId: string): Promise<readonly TaskAssignment[]>

  insertTask(draft: TaskDraft, tx?: TransactionHandle): Promise<CreatedTask>

  updateTask(
    task: TaskRecord,
    patch: TaskPatch,
    tx?: TransactionHandle,
  ): Promise<void>

  insertAssignment(
    draft: AssignmentDraft,
    tx?: TransactionHandle,
  ): Promise<TaskAssignment>

  /**
   * Take somebody off, keeping the row.
   *
   * `unassigned_at` rather than a delete, because who held a job and until
   * when is the question a supervisor asks after the job was missed.
   */
  endAssignment(
    assignment: TaskAssignment,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<void>

  /**
   * Names for an audit sentence, by user id.
   *
   * Ids that have no profile — or that this caller may not read — are simply
   * absent from the map. The operations fall back to the id rather than to a
   * word like "משתמש", which would make two people indistinguishable in the
   * one record that exists to tell them apart.
   */
  personNames(userIds: readonly string[]): Promise<ReadonlyMap<string, string>>
}

/* --------------------------------------------------------------- mapping -- */

const TASK_COLUMNS =
  'id, organization_id, property_id, unit_id, team_id, task_type, status, ' +
  'priority, title, assigned_to_user_id, version'

const ASSIGNMENT_COLUMNS =
  'id, organization_id, task_id, user_id, assignment_role, assigned_at, ' +
  'unassigned_at'

/**
 * A vocabulary read back from the database, refused rather than coerced.
 *
 * A value outside the enum means 0011 and `contracts/states.ts` disagree, and
 * the honest response is a loud failure at the mapping boundary rather than a
 * task that renders with a blank status three screens later.
 */
function asMember<T extends string>(
  row: Row,
  column: string,
  known: readonly string[],
  what: string,
): T {
  const value = asString(row, column)
  if (!known.includes(value)) {
    throw new Error(`Unknown ${what} in ${column}: ${value}`)
  }
  return value as T
}

export function taskFromRow(row: Row): TaskRecord {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    unitId: asStringOrNull(row, 'unit_id'),
    teamId: asStringOrNull(row, 'team_id'),
    taskType: asMember<TaskType>(row, 'task_type', TASK_TYPES, 'task type'),
    status: asMember<TaskStatus>(row, 'status', TASK_STATUSES, 'task status'),
    priority: asMember<TaskPriority>(
      row,
      'priority',
      TASK_PRIORITIES,
      'task priority',
    ),
    title: asString(row, 'title'),
    assignedToUserId: asStringOrNull(row, 'assigned_to_user_id'),
    version: asNumber(row, 'version'),
  }
}

export function assignmentFromRow(row: Row): TaskAssignment {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    taskId: asString(row, 'task_id'),
    userId: asString(row, 'user_id'),
    assignmentRole: asString(row, 'assignment_role'),
    assignedAt: asString(row, 'assigned_at'),
    unassignedAt: asStringOrNull(row, 'unassigned_at'),
  }
}

/** The columns a patch touches, as the table spells them. */
function patchRow(patch: TaskPatch): Record<string, unknown> {
  const row: Record<string, unknown> = { updated_by: patch.updatedByUserId }

  if (patch.status !== undefined) row.status = patch.status
  if (patch.priority !== undefined) row.priority = patch.priority
  if (patch.assignedToUserId !== undefined) {
    row.assigned_to_user_id = patch.assignedToUserId
  }
  if (patch.cancellationReason !== undefined) {
    row.cancellation_reason = patch.cancellationReason
  }

  return row
}

/* --------------------------------------------------------------- adapter -- */

export class SupabaseTaskRepository implements TaskRepository {
  constructor(private readonly db: Db) {}

  async loadTask(taskId: string): Promise<TaskRecord | null> {
    const { data, error } = await this.db
      .from('tasks')
      .select(TASK_COLUMNS)
      .eq('id', taskId)
      // A soft-deleted task is gone as far as every screen is concerned, and
      // an operation that could still assign one would put work on a board
      // nobody is looking at.
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    return data ? taskFromRow(toRow(data)) : null
  }

  async liveAssignments(taskId: string): Promise<readonly TaskAssignment[]> {
    const { data, error } = await this.db
      .from('task_assignments')
      .select(ASSIGNMENT_COLUMNS)
      .eq('task_id', taskId)
      .is('unassigned_at', null)
      .order('assigned_at', { ascending: true })

    if (error) throw error
    return toRows(data).map(assignmentFromRow)
  }

  async insertTask(
    draft: TaskDraft,
    tx?: TransactionHandle,
  ): Promise<CreatedTask> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('tasks')
      .insert({
        organization_id: draft.organizationId,
        property_id: draft.propertyId,
        unit_id: draft.unitId,
        team_id: draft.teamId,
        task_type: draft.taskType,
        status: draft.status,
        priority: draft.priority,
        title: draft.title,
        description: draft.description,
        assigned_to_user_id: draft.assignedToUserId,
        due_at: draft.dueAt,
        created_by: draft.actorUserId,
        updated_by: draft.actorUserId,
      })
      .select('id, property_id, task_type')
      .single()

    if (error) throw error

    recordWrite(tx, 'tasks.insert')

    const row = toRow(data)
    return {
      id: asString(row, 'id'),
      propertyId: asString(row, 'property_id'),
      taskType: asString(row, 'task_type') as TaskType,
    }
  }

  async updateTask(
    task: TaskRecord,
    patch: TaskPatch,
    tx?: TransactionHandle,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    const { error } = await db
      .from('tasks')
      .update(patchRow(patch))
      .eq('id', task.id)
      .eq('organization_id', task.organizationId)

    if (error) throw error
    recordWrite(tx, 'tasks.update')
  }

  async insertAssignment(
    draft: AssignmentDraft,
    tx?: TransactionHandle,
  ): Promise<TaskAssignment> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('task_assignments')
      .insert({
        organization_id: draft.organizationId,
        task_id: draft.taskId,
        user_id: draft.userId,
        // Both written out rather than left to the column defaults, so the row
        // this adapter produces is the same row whichever client it went
        // through — and so the assignment's moment is the operation's `now`.
        assignment_role: draft.assignmentRole,
        assigned_at: draft.assignedAt,
        assigned_by: draft.assignedByUserId,
      })
      .select(ASSIGNMENT_COLUMNS)
      .single()

    if (error) throw error

    recordWrite(tx, 'task_assignments.insert')
    return assignmentFromRow(toRow(data))
  }

  async endAssignment(
    assignment: TaskAssignment,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    const { error } = await db
      .from('task_assignments')
      .update({ unassigned_at: at.toISOString() })
      .eq('id', assignment.id)
      .eq('organization_id', assignment.organizationId)

    if (error) throw error
    recordWrite(tx, 'task_assignments.unassign')
  }

  async personNames(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const wanted = [...new Set(userIds)]
    if (wanted.length === 0) return new Map()

    const { data, error } = await this.db
      .from('user_profiles')
      .select('id, full_name')
      .in('id', wanted)

    // A name is prose, not a fact the operation turns on. A read this caller
    // is not entitled to make must not stop them assigning a cleaner, so the
    // failure degrades to "no name" and the audit sentence falls back to the
    // id — see the port.
    if (error) return new Map()

    const names = new Map<string, string>()
    for (const row of toRows(data)) {
      const name = asStringOrNull(row, 'full_name')
      if (name !== null && name.trim().length > 0) {
        names.set(asString(row, 'id'), name)
      }
    }
    return names
  }
}
