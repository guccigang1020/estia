/**
 * EXECUTION CONTEXT — SERVER ONLY. The four things this module lets a person
 * do to a task: open one, put somebody on it, change how urgent it is, and
 * stop it.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 *
 * The creation operation was written in `src/app/(app)/tasks/_lib/operations.ts`
 * with the real pipeline, and its header said in as many words that it belonged
 * in `src/lib` beside `src/lib/booking` and `src/lib/preparation` and would
 * move here unchanged when a module existed. This is that module. The factory
 * below is that operation, moved: same schema, same derived status, same
 * `due_at`, same audit sentences, same two events. What changed is where the
 * row is written — through the port in `repository.ts` rather than through a
 * client held by the operation — and nothing a caller can observe.
 *
 * The other three are new, and they are the reason the move happened now.
 * Autopilot's action catalogue names `tasks.createTask`, `tasks.assignTask` and
 * `tasks.changePriority`, and its executor recorded all three as
 * `command_not_implemented` because no operation in `src/lib` answered to them.
 * `tasks.cancelTask` is the undo path for the first.
 *
 * ── Two operations, one shape ─────────────────────────────────────────────
 *
 * `task.create` and `incident.create` are different grants held by different
 * people — a cleaner holds the second and not the first — and they write the
 * same table. So the definition is a factory and the *permission* is the
 * parameter, rather than one operation that decides internally which grant to
 * check. A single operation would have had to ask "is this an incident?" after
 * `assertCan` had already run against the wrong grant.
 *
 * ── The rules the database owns are not re-implemented ────────────────────
 *
 * `tasks_blocked_has_reason`, `tasks_title_not_blank`, `tasks_minutes_positive`,
 * `tasks_schedule_ordered` and the status-stamping trigger are all in 0011 and
 * all still apply. What is here is what the database cannot express: that a
 * task is born in a status nobody has acted on yet, that a reassignment is an
 * event rather than an overwrite, and that a task which is already over cannot
 * be assigned, re-prioritised or cancelled again.
 *
 * ── Why none of these demands a version ───────────────────────────────────
 *
 * `tasks` carries `version` and the pipeline checks it whenever a caller states
 * one, so a screen that knows which revision it is editing gets optimistic
 * locking for free. None of the three writes sets `requiresVersion`, because
 * Autopilot's undo knows a task id and nothing else, and an operation that
 * refused it would leave an action that cannot be reversed — which is a worse
 * failure than the lost update it would prevent on a two-column change.
 */

import type { Resource } from '../authz/can'
import type { Grant } from '../authz/permissions'
import type { DomainEventName } from '../contracts/events'
import { TASK_PRIORITIES, TASK_TYPES, type TaskType } from '../contracts/states'
import { BusinessRuleError, ValidationError } from '../errors'
import type { Db } from '../persistence/client'
import { defineOperation, s, type Operation } from '../service'

import { SupabaseTaskRepository, type TaskRepository } from './repository'
import {
  isSettled,
  TASK_PRIORITY_LABELS,
  type AssignTaskInput,
  type CancelTaskInput,
  type ChangePriorityInput,
  type CreatedTask,
  type CreateTaskInput,
  type PriorityChangeResult,
  type TaskAssignment,
  type TaskAssignmentResult,
  type TaskCancellationResult,
  type TaskRecord,
} from './types'

/**
 * How an operation in this module reaches the database.
 *
 * `db` is the request-scoped client, so every write runs as the signed-in
 * person under row level security — the floor beneath `assertCan`, which
 * refuses regardless of what happens above it. `tasks` is here for a caller
 * that already holds a port; when it is absent the Supabase adapter is built
 * over `db`, which is what every call site does today.
 */
export interface TaskOperationOptions {
  db: Db
  tasks?: TaskRepository
}

function repositoryFor(options: TaskOperationOptions): TaskRepository {
  return options.tasks ?? new SupabaseTaskRepository(options.db)
}

/**
 * An event draft, narrowed to the frozen catalogue.
 *
 * The service pipeline's own draft type accepts any `something.something`
 * string, which is right for a generic pipeline and wrong here: an event name
 * this module invents is an event nothing subscribes to, and the failure is
 * silent.
 */
interface TaskEventDraft {
  name: DomainEventName
  propertyId?: string | null
  payload: unknown
}

/** What the second `assertCan` reads: the tenant, and where the task sits. */
function resourceFor(task: TaskRecord): Resource {
  return {
    organizationId: task.organizationId,
    propertyId: task.propertyId,
    ...(task.unitId === null ? {} : { unitId: task.unitId }),
    ...(task.teamId === null ? {} : { teamId: task.teamId }),
    // The `own_records` scope narrows by this, which is why 0011 denormalises
    // it onto the task at all.
    ...(task.assignedToUserId === null
      ? {}
      : { assignedToUserId: task.assignedToUserId }),
  }
}

/**
 * Refuse to touch a task that is already over.
 *
 * The database has no opinion here — nothing stops an `update` on a completed
 * row — and every one of the three write operations below would otherwise be
 * able to put a cleaner on a job that finished last Tuesday.
 */
function assertOpen(task: TaskRecord, what: string): void {
  if (!isSettled(task.status)) return

  throw new BusinessRuleError({
    code: 'task_already_settled',
    message: `Task ${task.id} is ${task.status}; cannot ${what}`,
    userMessage: 'המשימה כבר נסגרה, ולכן לא ניתן לשנות אותה.',
  })
}

/* ---------------------------------------------------------- opening one -- */

const CREATE_INPUT = s.object({
  propertyId: s.uuid({ label: 'נכס' }),
  unitId: s.nullable(s.uuid({ label: 'יחידה' })),
  teamId: s.nullable(s.uuid({ label: 'צוות' })),
  assignedToUserId: s.nullable(s.uuid({ label: 'אחראי' })),
  taskType: s.enumOf(TASK_TYPES, { label: 'סוג' }),
  priority: s.enumOf(TASK_PRIORITIES, { label: 'עדיפות' }),
  title: s.string({ label: 'כותרת', min: 2, max: 200, trim: true }),
  description: s.nullable(s.string({ label: 'תיאור', max: 2000, trim: true })),
  dueOn: s.nullable(s.string({ label: 'מועד', min: 10, max: 10 })),
})

export type TaskCreationOperation = Operation<
  CreateTaskInput,
  null,
  CreatedTask
>

/**
 * The one path a task row is written along.
 *
 * Moved from `src/app/(app)/tasks/_lib/operations.ts` unchanged in behaviour.
 * The factory shape and the permission parameter are load-bearing — see the
 * header — and are not to be collapsed into a branch inside one operation.
 */
export function defineTaskCreation(
  options: TaskOperationOptions & {
    /** Dotted. Scopes idempotency keys and names the audit event. */
    name: string
    permission: Grant
    /** Fixed for a fault report, chosen by the person for an ordinary task. */
    fixedType?: TaskType
  },
): TaskCreationOperation {
  const tasks = repositoryFor(options)

  return defineOperation<CreateTaskInput, null, CreatedTask>({
    name: options.name,
    permission: options.permission,
    resourceType: 'task',
    input: CREATE_INPUT,

    /**
     * The rule the database cannot express.
     *
     * A `ValidationError` rather than a business-rule error, because from the
     * person's side this is a field with a wrong value in it, and the schema is
     * where a wrong field belongs. `dueOn` is checked here rather than in the
     * schema because "a real calendar date" is a fact about the value and not
     * about its shape, and `s.string({min: 10, max: 10})` only says it is the
     * right length.
     */
    rule({ input }) {
      if (
        input.dueOn !== null &&
        Number.isNaN(Date.parse(`${input.dueOn}T12:00:00Z`))
      ) {
        throw new ValidationError([
          {
            field: 'dueOn',
            code: 'invalid_date',
            message: 'המועד אינו תאריך תקין.',
            label: 'מועד',
          },
        ])
      }
    },

    async execute({ input, context, tx }) {
      return tasks.insertTask(
        {
          organizationId: context.actor.organizationId,
          propertyId: input.propertyId,
          unitId: input.unitId,
          teamId: input.teamId,
          taskType: options.fixedType ?? input.taskType,
          // Born in one of the two states nobody has acted on yet. Derived
          // from whether a person was named rather than offered as a choice,
          // so "assigned to nobody" and "status: assigned" cannot disagree.
          status: input.assignedToUserId === null ? 'new' : 'assigned',
          priority: input.priority,
          title: input.title,
          description: input.description,
          assignedToUserId: input.assignedToUserId,
          // The end of the working day at the property, so a job due "today"
          // is not overdue the moment it is written. `due_at` is a
          // `timestamptz` and the form collects a day.
          dueAt: input.dueOn === null ? null : `${input.dueOn}T18:00:00+03:00`,
          actorUserId: context.actor.userId,
        },
        tx,
      )
    },

    /**
     * The sentence the timeline keeps.
     *
     * Named, not templated: "נפתחה תקלה: משאבת הבריכה מרעישה" is what somebody
     * reading an audit trail six months later needs, and a generic "task
     * created" is the thing the charter forbids.
     */
    audit({ input, result }) {
      return {
        summary:
          options.fixedType === 'maintenance'
            ? `נפתח דיווח תקלה: ${input.title}`
            : `נפתחה משימה: ${input.title}`,
        resourceId: result.id,
        propertyId: result.propertyId,
        after: {
          taskType: result.taskType,
          priority: input.priority,
          title: input.title,
          assignedToUserId: input.assignedToUserId,
          dueOn: input.dueOn,
        },
      }
    },

    /**
     * `incident.opened` is in `DOMAIN_EVENTS` and in `ALERT_EVENTS`, which is
     * the list of events a person is meant to be told about. Publishing it is
     * the whole reason a fault report is not just a task: somebody has to learn
     * that the boiler is broken without opening a screen.
     */
    events({ input, result }): readonly TaskEventDraft[] {
      return options.fixedType === 'maintenance'
        ? [
            {
              name: 'incident.opened',
              payload: {
                taskId: result.id,
                propertyId: result.propertyId,
                unitId: input.unitId,
                priority: input.priority,
                title: input.title,
              },
            },
          ]
        : [
            {
              name: 'task.created',
              payload: {
                taskId: result.id,
                propertyId: result.propertyId,
                taskType: result.taskType,
                assignedToUserId: input.assignedToUserId,
              },
            },
          ]
    },
  })
}

/* ------------------------------------------------------- putting somebody -- */
/*                                                               on the job    */

/**
 * What an assignment operation loads: the task, and who is on it now.
 *
 * The live rows are read as well as the denormalised `assigned_to_user_id`,
 * because they are what makes a reassignment recordable — the column can only
 * say who holds the job, never who held it and until when.
 */
interface AssignmentEntity {
  task: TaskRecord
  live: readonly TaskAssignment[]
}

export type TaskAssignmentOperation = Operation<
  AssignTaskInput,
  AssignmentEntity,
  TaskAssignmentResult
>

/**
 * Put somebody on a task, and take off whoever was on it.
 *
 * ── Why a reassignment is two writes and not one ──────────────────────────
 *
 * `task_assignments_live_idx` is a partial unique index on
 * `(task_id, user_id) where unassigned_at is null`, and the table exists at
 * all — rather than an array on the task — because being given a job, taking
 * it, refusing it and being taken off it are events with times. So the person
 * being replaced is stamped `unassigned_at`, their row is kept, and the new
 * person gets a row of their own. Overwriting `tasks.assigned_to_user_id` and
 * calling it done would answer "who is on this?" and destroy the answer to
 * "who was on it when it was missed?", which is the question actually asked.
 */
export function defineTaskAssignment(
  options: TaskOperationOptions,
): TaskAssignmentOperation {
  const tasks = repositoryFor(options)

  return defineOperation<
    AssignTaskInput,
    AssignmentEntity,
    TaskAssignmentResult
  >({
    name: 'task.assign',
    permission: 'task.assign',
    resourceType: 'task',
    input: s.object({
      taskId: s.uuid({ label: 'משימה' }),
      assigneeId: s.uuid({ label: 'משויך' }),
    }),

    async loadResource({ input }) {
      const task = await tasks.loadTask(input.taskId)
      if (!task) return null

      const live = await tasks.liveAssignments(task.id)
      return {
        resource: resourceFor(task),
        entity: { task, live },
        version: task.version,
      }
    },

    rule({ entity, input }) {
      assertOpen(entity.task, 'assign it')

      // The partial unique index would refuse this as a 23505 the caller
      // would have to know the constraint's name to interpret. Refusing it
      // here says the true thing in Hebrew instead — and a "reassignment"
      // from somebody to themselves would otherwise take them off the job
      // and put them back on it, losing when they were first given it.
      if (entity.live.some((row) => row.userId === input.assigneeId)) {
        throw new BusinessRuleError({
          code: 'task_already_assigned_to_person',
          message: `Task ${entity.task.id} is already assigned to ${input.assigneeId}`,
          userMessage: 'המשימה כבר משויכת לאדם הזה.',
        })
      }
    },

    async execute({ entity, input, context, now, tx }) {
      const replaced = entity.live.filter(
        (row) => row.userId !== input.assigneeId,
      )

      for (const assignment of replaced) {
        await tasks.endAssignment(assignment, now, tx)
      }

      const assignment = await tasks.insertAssignment(
        {
          organizationId: entity.task.organizationId,
          taskId: entity.task.id,
          userId: input.assigneeId,
          assignmentRole: 'assignee',
          assignedAt: now.toISOString(),
          assignedByUserId: context.actor.userId,
        },
        tx,
      )

      await tasks.updateTask(
        entity.task,
        {
          assignedToUserId: input.assigneeId,
          // A task nobody had been given is now given to somebody. Every
          // other status is a transition its holder performs, and moving one
          // back to `assigned` here would erase that they had started.
          status: entity.task.status === 'new' ? 'assigned' : undefined,
          updatedByUserId: context.actor.userId,
        },
        tx,
      )

      // Read inside the transaction and carried on the result, because
      // `audit` is synchronous — the pipeline builds the sentence from what
      // the work returned, and cannot go back to the database for a name.
      const previousAssigneeId = entity.task.assignedToUserId
      const names = await tasks.personNames(
        previousAssigneeId === null
          ? [input.assigneeId]
          : [input.assigneeId, previousAssigneeId],
      )

      return {
        taskId: entity.task.id,
        assignmentId: assignment.id,
        assigneeId: input.assigneeId,
        assigneeName: names.get(input.assigneeId) ?? null,
        previousAssigneeId,
        previousAssigneeName:
          previousAssigneeId === null
            ? null
            : (names.get(previousAssigneeId) ?? null),
        reassignment: replaced.length > 0 || previousAssigneeId !== null,
        unassignedUserIds: replaced.map((row) => row.userId),
      }
    },

    audit({ entity, result }) {
      const to = result.assigneeName ?? result.assigneeId
      const from =
        result.previousAssigneeName ?? result.previousAssigneeId ?? null

      return {
        resourceId: result.taskId,
        propertyId: entity.task.propertyId,
        summary:
          from === null
            ? `המשימה "${entity.task.title}" שויכה ל${to}`
            : `המשימה "${entity.task.title}" הועברה מ${from} ל${to}`,
        before: { assignedToUserId: result.previousAssigneeId },
        after: {
          assignedToUserId: result.assigneeId,
          unassigned: result.unassignedUserIds,
        },
      }
    },

    /**
     * `task.assigned` is the frozen name for exactly this, and the person it
     * reaches is the one who now has to do the work.
     */
    events({ entity, result }): readonly TaskEventDraft[] {
      return [
        {
          name: 'task.assigned',
          propertyId: entity.task.propertyId,
          payload: {
            taskId: result.taskId,
            assignedToUserId: result.assigneeId,
            previousAssigneeId: result.previousAssigneeId,
            taskType: entity.task.taskType,
            priority: entity.task.priority,
            title: entity.task.title,
          },
        },
      ]
    },
  })
}

/* --------------------------------------------------------- how urgent it is -- */

export type TaskPriorityOperation = Operation<
  ChangePriorityInput,
  TaskRecord,
  PriorityChangeResult
>

/**
 * Change how urgent a task is.
 *
 * `task.update` and not `task.assign`: this is a statement about the work, not
 * about who does it. Autopilot's `maintenance.raise_priority` runs it to lift a
 * fault as an arrival approaches, and its undo runs it again the other way —
 * which is why the previous value is on the result rather than only in the
 * audit row.
 */
export function defineTaskPriorityChange(
  options: TaskOperationOptions,
): TaskPriorityOperation {
  const tasks = repositoryFor(options)

  return defineOperation<ChangePriorityInput, TaskRecord, PriorityChangeResult>(
    {
      name: 'task.priority.change',
      permission: 'task.update',
      resourceType: 'task',
      input: s.object({
        taskId: s.uuid({ label: 'משימה' }),
        priority: s.enumOf(TASK_PRIORITIES, { label: 'דחיפות' }),
      }),

      async loadResource({ input }) {
        const task = await tasks.loadTask(input.taskId)
        if (!task) return null
        return {
          resource: resourceFor(task),
          entity: task,
          version: task.version,
        }
      },

      rule({ entity, input }) {
        assertOpen(entity, 'change its priority')

        // A change to the value it already holds would record an audit
        // sentence saying nothing happened, and hand Autopilot's activity feed
        // a success it did not achieve. A retry of the *same* dispatch replays
        // through the idempotency key instead, which is the case that matters.
        if (entity.priority === input.priority) {
          throw new BusinessRuleError({
            code: 'task_priority_unchanged',
            message: `Task ${entity.id} is already ${input.priority}`,
            userMessage: 'המשימה כבר בדחיפות הזו.',
          })
        }
      },

      async execute({ entity, input, context, tx }) {
        await tasks.updateTask(
          entity,
          { priority: input.priority, updatedByUserId: context.actor.userId },
          tx,
        )

        return {
          taskId: entity.id,
          title: entity.title,
          priority: input.priority,
          previousPriority: entity.priority,
        }
      },

      audit({ entity, result }) {
        return {
          resourceId: result.taskId,
          propertyId: entity.propertyId,
          summary:
            `דחיפות המשימה "${result.title}" שונתה מ` +
            `${TASK_PRIORITY_LABELS[result.previousPriority]} ל` +
            `${TASK_PRIORITY_LABELS[result.priority]}`,
          before: { priority: result.previousPriority },
          after: { priority: result.priority },
        }
      },

      /**
       * THE CATALOGUE HAS NO EVENT FOR THIS. `src/lib/contracts/events.ts` is
       * frozen and carries no `task.priority_changed`, so the closest existing
       * name is used and the gap is reported rather than the file edited.
       *
       * `task.created` and not `task.assigned` or `task.overdue`, deliberately:
       * those two are in the notification catalogue and would tell a person
       * "משימה חדשה שויכה אליך" or "משימה באיחור", neither of which happened.
       * `task.created` reaches no subscriber today, so the wrong name stays in
       * the event log — where the payload below says what actually changed —
       * instead of becoming a false alert on somebody's phone.
       */
      events({ entity, result }): readonly TaskEventDraft[] {
        return [
          {
            name: 'task.priority_changed',
            propertyId: entity.propertyId,
            payload: {
              taskId: result.taskId,
              change: 'priority',
              priority: result.priority,
              previousPriority: result.previousPriority,
              taskType: entity.taskType,
              title: result.title,
            },
          },
        ]
      },
    },
  )
}

/* ------------------------------------------------------------ stopping it -- */

export type TaskCancellationOperation = Operation<
  CancelTaskInput,
  TaskRecord,
  TaskCancellationResult
>

/**
 * Stop a task that should not be done.
 *
 * ── Why a completed task cannot be cancelled ──────────────────────────────
 *
 * The work happened. Somebody cleaned the house, the hours were worked and
 * somebody is owed for them, and moving that row to `cancelled` because the
 * job turned out to be unnecessary is the product lying about labour that
 * occurred. `preparation.plan.cancel` keeps completed sections for the same
 * reason. The database would allow the update — this is the rule it cannot
 * express.
 *
 * ── Why a reason is mandatory ─────────────────────────────────────────────
 *
 * `tasks_cancelled_has_reason` refuses the row without one, so an operation
 * that did not demand it would fail at the constraint with a message nobody
 * can act on. `requiresReason` turns that into a field error on the form, and
 * Autopilot already passes the prose it composed when it decided to undo.
 */
export function defineTaskCancellation(
  options: TaskOperationOptions,
): TaskCancellationOperation {
  const tasks = repositoryFor(options)

  return defineOperation<CancelTaskInput, TaskRecord, TaskCancellationResult>({
    name: 'task.cancel',
    permission: 'task.update',
    resourceType: 'task',
    requiresReason: true,
    input: s.object({ taskId: s.uuid({ label: 'משימה' }) }),

    async loadResource({ input }) {
      const task = await tasks.loadTask(input.taskId)
      if (!task) return null
      return {
        resource: resourceFor(task),
        entity: task,
        version: task.version,
      }
    },

    rule({ entity }) {
      if (entity.status === 'cancelled') {
        throw new BusinessRuleError({
          code: 'task_already_cancelled',
          message: `Task ${entity.id} is already cancelled`,
          userMessage: 'המשימה כבר בוטלה.',
        })
      }

      if (isSettled(entity.status)) {
        throw new BusinessRuleError({
          code: 'task_already_done',
          message: `Task ${entity.id} is ${entity.status}; completed work is not cancelled`,
          userMessage:
            'המשימה כבר הושלמה, ולכן לא ניתן לבטל אותה. עבודה שבוצעה נשמרת כהיסטוריה.',
        })
      }
    },

    async execute({ entity, context, tx }) {
      // The pipeline has already refused a blank reason — `requiresReason` —
      // so this fallback is unreachable and is here for the type rather than
      // as a second policy.
      const reason = context.reason ?? ''

      await tasks.updateTask(
        entity,
        {
          status: 'cancelled',
          cancellationReason: reason,
          updatedByUserId: context.actor.userId,
        },
        tx,
      )

      // `cancelled_at` is deliberately not written: `tg_tasks_stamp_status`
      // stamps it, and a moment typed here would be a second opinion about
      // when the work stopped.
      return {
        taskId: entity.id,
        title: entity.title,
        previousStatus: entity.status,
        reason,
      }
    },

    audit({ entity, result, context }) {
      return {
        resourceId: result.taskId,
        propertyId: entity.propertyId,
        reason: context.reason ?? null,
        summary: `המשימה "${result.title}" בוטלה לפני שהושלמה: ${result.reason}`,
        before: { status: result.previousStatus },
        after: { status: 'cancelled' },
      }
    },

    /**
     * THE CATALOGUE HAS NO EVENT FOR THIS EITHER. There is no `task.cancelled`
     * in the frozen list, and `task.completed` is the closest: both say the
     * work on this task has ended and neither reaches a subscriber today. The
     * payload carries `status: 'cancelled'` so anything that later listens can
     * tell the two apart, and the gap is reported rather than the frozen file
     * edited.
     */
    events({ entity, result }): readonly TaskEventDraft[] {
      return [
        {
          name: 'task.cancelled',
          propertyId: entity.propertyId,
          payload: {
            taskId: result.taskId,
            status: 'cancelled',
            cancelled: true,
            previousStatus: result.previousStatus,
            reason: result.reason,
            taskType: entity.taskType,
            title: result.title,
          },
        },
      ]
    },
  })
}
