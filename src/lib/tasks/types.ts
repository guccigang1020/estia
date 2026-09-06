/**
 * The shapes the task module works in.
 *
 * Nothing here reaches a database and nothing here decides anything. The three
 * vocabularies — `TASK_STATUSES`, `TASK_PRIORITIES`, `TASK_TYPES` — are
 * consumed from `src/lib/contracts/states.ts` and deliberately not restated:
 * a second list of statuses is a list that disagrees with the enum in 0011 the
 * first time somebody adds one, and the disagreement surfaces as a task the
 * board cannot render rather than as a compile error.
 *
 * ── What the database owns, and is therefore absent here ──────────────────
 *
 * `tasks_blocked_has_reason`, `tasks_title_not_blank`, `tasks_minutes_positive`
 * and `tasks_schedule_ordered` are in 0011, along with the trigger that stamps
 * `started_at`, `completed_at`, `verified_at` and `cancelled_at` from the
 * status. None of them is re-implemented in this module. What is here is the
 * vocabulary those constraints are written in, plus the two readings of a
 * status the database has no opinion about: which statuses a task may be born
 * in, and which ones mean it is over.
 */

import type { TaskPriority, TaskStatus, TaskType } from '../contracts/states'

/**
 * The statuses a task may be born in.
 *
 * `new` when nobody is named and `assigned` when somebody is. Everything else
 * in `TASK_STATUSES` is a transition somebody performs afterwards, and the
 * database stamps `started_at`, `completed_at` and `verified_at` from those
 * transitions. A creation form offering `completed` would be asking the trigger
 * to invent a completion time for work nobody did.
 */
export const INITIAL_TASK_STATUSES: readonly TaskStatus[] = ['new', 'assigned']

/**
 * The statuses that mean the job is over, one way or another.
 *
 * A reading of `TASK_STATUSES` and not a second vocabulary: every member is
 * typed as one, so a rename in contracts breaks this line rather than quietly
 * leaving a settled task open to being cancelled twice.
 */
export const SETTLED_TASK_STATUSES: readonly TaskStatus[] = [
  'completed',
  'verified',
  'cancelled',
]

/** Whether the work is behind somebody rather than ahead of them. */
export function isSettled(status: TaskStatus): boolean {
  return SETTLED_TASK_STATUSES.includes(status)
}

/**
 * How a priority is named in an audit sentence.
 *
 * Feminine, because the noun in the sentence is דחיפות. This lives in the
 * domain and not in a component because the string it builds is *stored* — an
 * audit summary a manager reads three weeks later — and a rendering concern
 * must not be the source of a recorded sentence.
 */
export const TASK_PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = {
  low: 'נמוכה',
  normal: 'רגילה',
  high: 'גבוהה',
  critical: 'קריטית',
}

/* ----------------------------------------------------------- the records -- */

/**
 * A task, as much of it as the operations in this module read.
 *
 * Deliberately not the whole row. Nothing here schedules, blocks, verifies or
 * completes a task, and a type that carried `estimated_minutes` would invite an
 * operation that wrote it without the rule that governs it.
 */
export interface TaskRecord {
  id: string
  organizationId: string
  propertyId: string
  unitId: string | null
  teamId: string | null
  taskType: TaskType
  status: TaskStatus
  priority: TaskPriority
  title: string
  /** The person answerable, denormalised onto the task by 0011. */
  assignedToUserId: string | null
  version: number
}

/** One person's place on one task. A row, because it has events. */
export interface TaskAssignment {
  id: string
  organizationId: string
  taskId: string
  userId: string
  assignmentRole: string
  assignedAt: string
  /** Set when they were taken off. `null` while the assignment is live. */
  unassignedAt: string | null
}

/* ------------------------------------------------------------- the writes -- */

/**
 * What is written when a task is opened.
 *
 * `status` and `dueAt` are already decided by the time they reach here: the
 * operation derives the status from whether a person was named, and turns the
 * day the work is wanted into a moment at the property. The repository maps;
 * it does not choose.
 */
export interface TaskDraft {
  organizationId: string
  propertyId: string
  unitId: string | null
  teamId: string | null
  taskType: TaskType
  status: TaskStatus
  priority: TaskPriority
  title: string
  description: string | null
  assignedToUserId: string | null
  /** ISO instant, or `null`. */
  dueAt: string | null
  actorUserId: string | null
}

/**
 * What may be changed on an existing task by this module.
 *
 * An absent key is a column left alone, which is why every field is optional
 * and `updatedByUserId` is not: a write that cannot say who made it is a write
 * this module will not make.
 */
export interface TaskPatch {
  status?: TaskStatus
  priority?: TaskPriority
  assignedToUserId?: string | null
  /** Required by `tasks_cancelled_has_reason` whenever status is cancelled. */
  cancellationReason?: string
  updatedByUserId: string | null
}

export interface AssignmentDraft {
  organizationId: string
  taskId: string
  userId: string
  assignmentRole: string
  /**
   * ISO instant. Written rather than left to `default now()`, so that the
   * moment on the assignment row is the same `now` the pipeline injected and
   * the audit event carries — two clocks for one action is how a timeline
   * starts disagreeing with itself.
   */
  assignedAt: string
  assignedByUserId: string | null
}

/* ------------------------------------------------------------- the inputs -- */

export type CreateTaskInput = {
  propertyId: string
  unitId: string | null
  teamId: string | null
  assignedToUserId: string | null
  taskType: TaskType
  priority: TaskPriority
  title: string
  description: string | null
  /** ISO date, YYYY-MM-DD. The day the work is wanted, or null. */
  dueOn: string | null
}

export type CreatedTask = { id: string; propertyId: string; taskType: TaskType }

export interface AssignTaskInput {
  taskId: string
  assigneeId: string
}

export interface ChangePriorityInput {
  taskId: string
  priority: TaskPriority
}

export interface CancelTaskInput {
  taskId: string
}

/* ------------------------------------------------------------ the results -- */

/**
 * What an assignment did.
 *
 * `previousAssigneeId` is on the result rather than only in the audit row
 * because Autopilot's undo reads it: putting an assignment back means naming
 * the person it was taken from, and a result that dropped them would leave an
 * action that cannot be reversed.
 */
export interface TaskAssignmentResult {
  taskId: string
  assignmentId: string
  assigneeId: string
  assigneeName: string | null
  previousAssigneeId: string | null
  previousAssigneeName: string | null
  /** True when somebody was taken off for this person to be put on. */
  reassignment: boolean
  /** Everybody whose live assignment was ended. Ids, in the order ended. */
  unassignedUserIds: readonly string[]
}

export interface PriorityChangeResult {
  taskId: string
  title: string
  priority: TaskPriority
  /** Read back by Autopilot's undo to restore what was there. */
  previousPriority: TaskPriority
}

export interface TaskCancellationResult {
  taskId: string
  title: string
  /** The status the task was in when it was stopped. */
  previousStatus: TaskStatus
  reason: string
}
