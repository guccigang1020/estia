/**
 * EXECUTION CONTEXT — SERVER ONLY. Opening a task, and opening a fault report.
 *
 * ── Why this is here and not in `src/lib` ─────────────────────────────────
 *
 * It should be in `src/lib/operations`, beside `src/lib/booking` and
 * `src/lib/preparation`, behind a repository port. That module does not exist:
 * `public.tasks` has a migration, a permission catalogue, a demo dataset and
 * two frozen vocabularies, and no domain module and no adapter. Nothing in
 * `src/lib/persistence` writes a task.
 *
 * What did *not* seem acceptable was to answer that with
 * `db.from('tasks').insert(...)` inside a Server Action. The charter names one
 * path for every state-changing operation — authenticate, authorize, validate,
 * business rule, transaction, audit event, domain event — and `defineOperation`
 * is that path made unskippable: there is no way to reach `execute` without
 * having passed `assertCan`, and no way to finish successfully without an audit
 * event, because the caller never gets to write the sequence. So the operation
 * is declared here, with the real pipeline, using the real schema validator,
 * and it will move into a domain module unchanged when one exists. The missing
 * module is reported rather than worked around silently.
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
 * `tasks_blocked_has_reason`, `tasks_title_not_blank`,
 * `tasks_minutes_positive`, `tasks_schedule_ordered` and the status-stamping
 * trigger are all in 0011 and all still apply. What is here is the one rule the
 * database cannot express: a task is born in a status that means nobody has
 * done anything to it yet, and offering `completed` on a creation form would
 * offer a state the stamping trigger would then have to invent a
 * `completed_at` for.
 */

import type { Grant } from '@/lib/authz/permissions'
import { ValidationError } from '@/lib/errors'
import {
  TASK_PRIORITIES,
  TASK_TYPES,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '@/lib/contracts/states'
import { asString, clientFor, recordWrite, toRow } from '@/lib/persistence'
import type { Db } from '@/lib/persistence'
import { defineOperation, s, type Operation } from '@/lib/service'

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

const INPUT = s.object({
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
 * `db` is the request-scoped client, so every write runs as the signed-in
 * person under row level security — which is the floor beneath `assertCan` and
 * refuses regardless of what happens above it.
 */
export function defineTaskCreation(options: {
  /** Dotted. Scopes idempotency keys and names the audit event. */
  name: string
  permission: Grant
  /** Fixed for a fault report, chosen by the person for an ordinary task. */
  fixedType?: TaskType
  db: Db
}): TaskCreationOperation {
  return defineOperation<CreateTaskInput, null, CreatedTask>({
    name: options.name,
    permission: options.permission,
    resourceType: 'task',
    input: INPUT,

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
      const db = clientFor(tx, options.db)
      const taskType = options.fixedType ?? input.taskType

      const { data, error } = await db
        .from('tasks')
        .insert({
          organization_id: context.actor.organizationId,
          property_id: input.propertyId,
          unit_id: input.unitId,
          team_id: input.teamId,
          task_type: taskType,
          // Born in one of the two states nobody has acted on yet. Derived
          // from whether a person was named rather than offered as a choice,
          // so "assigned to nobody" and "status: assigned" cannot disagree.
          status: input.assignedToUserId === null ? 'new' : 'assigned',
          priority: input.priority,
          title: input.title,
          description: input.description,
          assigned_to_user_id: input.assignedToUserId,
          // The end of the working day at the property, so a job due "today"
          // is not overdue the moment it is written. `due_at` is a
          // `timestamptz` and the form collects a day.
          due_at: input.dueOn === null ? null : `${input.dueOn}T18:00:00+03:00`,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
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
    events({ input, result }) {
      return options.fixedType === 'maintenance'
        ? [
            {
              name: 'incident.opened' as const,
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
              name: 'task.created' as const,
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
