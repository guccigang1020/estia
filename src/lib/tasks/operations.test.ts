/**
 * The four task operations, driven end to end over the demo dataset.
 *
 * Every test here runs the real Supabase adapter over `DemoDatabase`, and that
 * is the point rather than convenience: an operation that wrote `task_type`
 * into a column called `type` would compile, would pass against a hand-written
 * double, and would produce a task the board cannot render. The demo client
 * knows the column names, so a mapping mistake fails here.
 *
 * What is asserted, in order of how expensive the mistake would be:
 *
 *   · a reassignment is *recorded* — the person who held the job keeps their
 *     row, stamped `unassigned_at` — rather than overwritten, because "who was
 *     on this when it was missed" is the question actually asked afterwards;
 *   · a completed task cannot be cancelled, because the work happened and
 *     somebody is owed for the hours;
 *   · a task cannot be born `completed`, which is the rule the moved creation
 *     operation carried with it;
 *   · each operation refuses somebody who does not hold its grant, before a
 *     row is read.
 *
 * `DemoDatabase` copies its rows on construction, so the writes here mutate a
 * private copy and `DEMO_DATASET` is untouched for every other test file.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '../actor'
import { InMemoryAuditWriter } from '../audit/pipeline'
import { AuthorizationError, type Actor } from '../authz/can'
import { DemoDatabase, createDemoClient } from '../demo/client'
import { DEMO_DATASET, DEMO_PLANS } from '../demo/dataset'
import { person } from '../demo/dataset-identity'
import { PROPERTY_IDS } from '../demo/dataset-inventory'
import { DemoActorSource } from '../demo/session'
import type { DemoRow } from '../demo/types'
import { BusinessRuleError, ValidationError } from '../errors'
import type { Db } from '../persistence/client'
import { SupabaseActorSource } from '../persistence/actor'
import {
  InMemoryIdempotencyStore,
  noTransactionRunner,
  type OperationServices,
} from '../service'

import {
  defineTaskAssignment,
  defineTaskCancellation,
  defineTaskCreation,
  defineTaskPriorityChange,
} from './operations'
import { INITIAL_TASK_STATUSES, type CreateTaskInput } from './types'

const ORGANIZATION = DEMO_DATASET.organizationId

/** One private copy of the dataset per test, so writes cannot leak sideways. */
function database(): DemoDatabase {
  return new DemoDatabase(DEMO_DATASET)
}

function clientOn(db: DemoDatabase): Db {
  return createDemoClient(db) as unknown as Db
}

async function actorFor(key: string, db: DemoDatabase): Promise<Actor> {
  const plan = DEMO_PLANS.find((entry) => entry.code === 'pro')
  if (!plan) throw new Error("No demo plan 'pro'")

  const resolution = await resolveActor(
    new DemoActorSource(new SupabaseActorSource(clientOn(db)), plan),
    person(key).userId,
    ORGANIZATION,
  )
  if (!resolution.ok) {
    throw new Error(`${key} does not resolve to an actor: ${resolution.reason}`)
  }
  return resolution.actor
}

function servicesWith(audit: InMemoryAuditWriter): OperationServices {
  return {
    audit,
    idempotency: new InMemoryIdempotencyStore(),
    // Honest about what it is: `noTransactionRunner` is not a transaction, and
    // nothing over an array of objects could be.
    transactions: noTransactionRunner,
  }
}

function contextFor(actor: Actor, reason?: string) {
  return {
    actor,
    auditActor: { type: 'user' as const, userId: actor.userId, label: 'מיכל' },
    correlationId: 'correlation-1',
    reason: reason ?? null,
  }
}

/**
 * A task from the demo board, by what it is rather than by its id.
 *
 * The generated ids depend on how many stays fall inside the window, so
 * `taskIds(30)` is not a stable reference to anything — `dataset-operations.ts`
 * says so itself and looks its own standing tasks up by title.
 */
function taskRow(db: DemoDatabase, match: (row: DemoRow) => boolean): DemoRow {
  const found = db.rows('tasks').find(match)
  if (!found) {
    throw new Error(
      'The demo dataset has no task matching that description. The tests ' +
        'below choose tasks by status rather than by id; if the dataset ' +
        'stopped generating one, fix the choice rather than the assertion.',
    )
  }
  return found
}

const idOf = (row: DemoRow): string => String(row.id)

const assignmentsFor = (db: DemoDatabase, taskId: string): DemoRow[] =>
  db.rows('task_assignments').filter((row) => row.task_id === taskId)

/* -------------------------------------------------------------- creation -- */

const DRAFT: CreateTaskInput = {
  propertyId: PROPERTY_IDS.rimonim,
  unitId: null,
  teamId: null,
  assignedToUserId: null,
  taskType: 'custom',
  priority: 'normal',
  title: 'החלפת נורה בחדר האוכל',
  description: 'הנורה מהבהבת מאתמול.',
  dueOn: null,
}

describe('the creation operation, after the move', () => {
  it('refuses a completed initial status: it is not a field a caller has', async () => {
    // The status is derived from whether somebody was named, and the schema
    // names no `status` field at all — so a caller asking to open a task that
    // is already finished is refused as an unknown field rather than quietly
    // obeyed. `completed` would have the stamping trigger invent a completion
    // time for work nobody did.
    const db = database()
    const before = db.rows('tasks').length

    await expect(
      defineTaskCreation({
        name: 'task.create',
        permission: 'task.create',
        db: clientOn(db),
      }).run({
        request: { input: { ...DRAFT, status: 'completed' } },
        context: contextFor(await actorFor('general-manager', db)),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    expect(db.rows('tasks')).toHaveLength(before)
    expect(INITIAL_TASK_STATUSES).not.toContain('completed')
  })

  it('still writes a row the board can read back', async () => {
    const db = database()
    const audit = new InMemoryAuditWriter()

    const outcome = await defineTaskCreation({
      name: 'task.create',
      permission: 'task.create',
      db: clientOn(db),
    }).run({
      request: { input: DRAFT },
      context: contextFor(await actorFor('general-manager', db)),
      services: servicesWith(audit),
    })

    const written = db.rows('tasks').find((row) => row.id === outcome.data.id)
    expect(written?.title).toBe(DRAFT.title)
    expect(written?.status).toBe('new')
    expect(written?.organization_id).toBe(ORGANIZATION)
    expect(audit.records[0].summary).toContain(DRAFT.title)
  })
})

/* ------------------------------------------------------------ assignment -- */

describe('putting somebody on a task', () => {
  it('records the reassignment rather than overwriting it', async () => {
    const db = database()
    const audit = new InMemoryAuditWriter()

    const task = taskRow(
      db,
      (row) => row.status === 'in_progress' && row.assigned_to_user_id !== null,
    )
    const taskId = idOf(task)
    const held = String(task.assigned_to_user_id)
    const successor = person('second-cleaner').userId
    expect(held).not.toBe(successor)

    const outcome = await defineTaskAssignment({ db: clientOn(db) }).run({
      request: { input: { taskId, assigneeId: successor } },
      context: contextFor(await actorFor('general-manager', db)),
      services: servicesWith(audit),
    })

    const rows = assignmentsFor(db, taskId)
    const previous = rows.find((row) => row.user_id === held)
    const current = rows.find((row) => row.user_id === successor)

    // The row is kept and stamped. Deleting it would answer "who is on this?"
    // and destroy the answer to "who was on it when it was missed?".
    expect(previous).toBeDefined()
    expect(previous?.unassigned_at).not.toBeNull()
    expect(current?.unassigned_at ?? null).toBeNull()
    expect(rows).toHaveLength(2)

    expect(outcome.data.reassignment).toBe(true)
    expect(outcome.data.previousAssigneeId).toBe(held)
    expect(outcome.data.unassignedUserIds).toEqual([held])

    // The denormalised column follows the rows, because the `own_records`
    // scope narrows by it.
    expect(
      db.rows('tasks').find((row) => row.id === taskId)?.assigned_to_user_id,
    ).toBe(successor)

    // Named, both of them, and in the sentence a manager reads later.
    expect(audit.records).toHaveLength(1)
    expect(audit.records[0].summary).toContain(String(task.title))
    expect(audit.records[0].summary).toContain('הועברה')
  })

  it('refuses to put the same person on twice', async () => {
    const db = database()
    const task = taskRow(
      db,
      (row) => row.status === 'in_progress' && row.assigned_to_user_id !== null,
    )

    await expect(
      defineTaskAssignment({ db: clientOn(db) }).run({
        request: {
          input: {
            taskId: idOf(task),
            assigneeId: String(task.assigned_to_user_id),
          },
        },
        context: contextFor(await actorFor('general-manager', db)),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('moves a task nobody held out of new, and publishes task.assigned', async () => {
    const db = database()
    const task = taskRow(
      db,
      (row) => row.status === 'new' && row.assigned_to_user_id === null,
    )
    const taskId = idOf(task)

    const outcome = await defineTaskAssignment({ db: clientOn(db) }).run({
      request: {
        input: { taskId, assigneeId: person('housekeeping').userId },
      },
      context: contextFor(await actorFor('general-manager', db)),
      services: servicesWith(new InMemoryAuditWriter()),
    })

    expect(outcome.data.reassignment).toBe(false)
    expect(outcome.data.previousAssigneeId).toBeNull()
    expect(db.rows('tasks').find((row) => row.id === taskId)?.status).toBe(
      'assigned',
    )
    expect(outcome.events.map((event) => event.name)).toEqual(['task.assigned'])
  })

  it('refuses to staff a task that is already over', async () => {
    const db = database()
    const task = taskRow(db, (row) => row.status === 'cancelled')

    await expect(
      defineTaskAssignment({ db: clientOn(db) }).run({
        request: {
          input: {
            taskId: idOf(task),
            assigneeId: person('second-cleaner').userId,
          },
        },
        context: contextFor(await actorFor('general-manager', db)),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses the cleaner, who may update a task but not staff one', async () => {
    // She holds `task.view`, `task.update`, `task.complete` and
    // `incident.create`. Not `task.assign` — deciding who works is not the
    // same right as saying what happened to the work.
    const db = database()
    const task = taskRow(db, (row) => row.status === 'new')

    await expect(
      defineTaskAssignment({ db: clientOn(db) }).run({
        request: {
          input: {
            taskId: idOf(task),
            assigneeId: person('second-cleaner').userId,
          },
        },
        context: contextFor(await actorFor('housekeeping', db)),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})

/* -------------------------------------------------------------- priority -- */

describe('changing how urgent a task is', () => {
  it('raises it, and keeps the previous value for the undo', async () => {
    const db = database()
    const audit = new InMemoryAuditWriter()
    const task = taskRow(
      db,
      (row) => row.status === 'in_progress' && row.priority !== 'critical',
    )
    const taskId = idOf(task)
    // `db.rows()` hands back the live array — the row object below is the one
    // the update mutates — so what it held is read before, not after.
    const held = String(task.priority)
    const title = String(task.title)

    const outcome = await defineTaskPriorityChange({ db: clientOn(db) }).run({
      request: { input: { taskId, priority: 'critical' } },
      context: contextFor(await actorFor('general-manager', db)),
      services: servicesWith(audit),
    })

    expect(outcome.data.previousPriority).toBe(held)
    expect(db.rows('tasks').find((row) => row.id === taskId)?.priority).toBe(
      'critical',
    )
    // Both values, in Hebrew, in the sentence the timeline keeps.
    expect(audit.records[0].summary).toContain('קריטית')
    expect(audit.records[0].summary).toContain(title)
  })

  it('refuses a change to the value it already holds', async () => {
    const db = database()
    const task = taskRow(db, (row) => row.status === 'in_progress')

    await expect(
      defineTaskPriorityChange({ db: clientOn(db) }).run({
        request: {
          input: { taskId: idOf(task), priority: String(task.priority) },
        },
        context: contextFor(await actorFor('general-manager', db)),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a task that is already over', async () => {
    const db = database()
    const task = taskRow(db, (row) => row.status === 'verified')

    await expect(
      defineTaskPriorityChange({ db: clientOn(db) }).run({
        request: { input: { taskId: idOf(task), priority: 'critical' } },
        context: contextFor(await actorFor('general-manager', db)),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses the accountant, who holds no task grant at all', async () => {
    const db = database()
    const task = taskRow(db, (row) => row.status === 'in_progress')

    await expect(
      defineTaskPriorityChange({ db: clientOn(db) }).run({
        request: { input: { taskId: idOf(task), priority: 'critical' } },
        context: contextFor(await actorFor('accountant', db)),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})

/* --------------------------------------------------------- cancellation -- */

describe('stopping a task', () => {
  it('refuses to cancel work that was already completed', async () => {
    // The house was cleaned, the hours were worked and somebody is owed for
    // them. Rewriting that to `cancelled` is the product lying about labour
    // that happened.
    const db = database()
    const task = taskRow(db, (row) => row.status === 'completed')

    await expect(
      defineTaskCancellation({ db: clientOn(db) }).run({
        request: { input: { taskId: idOf(task) } },
        context: contextFor(
          await actorFor('general-manager', db),
          'התברר שאין צורך.',
        ),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)

    expect(db.rows('tasks').find((row) => row.id === idOf(task))?.status).toBe(
      'completed',
    )
  })

  it('stops an open task and writes the reason the constraint demands', async () => {
    const db = database()
    const audit = new InMemoryAuditWriter()
    const task = taskRow(db, (row) => row.status === 'assigned')
    const taskId = idOf(task)
    const reason = 'ההזמנה בוטלה, אין מי שיגיע ליחידה.'

    const outcome = await defineTaskCancellation({ db: clientOn(db) }).run({
      request: { input: { taskId } },
      context: contextFor(await actorFor('general-manager', db), reason),
      services: servicesWith(audit),
    })

    const written = db.rows('tasks').find((row) => row.id === taskId)
    expect(written?.status).toBe('cancelled')
    // `tasks_cancelled_has_reason` refuses the row without this.
    expect(written?.cancellation_reason).toBe(reason)
    expect(outcome.data.previousStatus).toBe('assigned')
    expect(audit.records[0].summary).toContain(reason)
  })

  it('refuses to stop a task without saying why', async () => {
    const db = database()
    const task = taskRow(db, (row) => row.status === 'assigned')

    await expect(
      defineTaskCancellation({ db: clientOn(db) }).run({
        request: { input: { taskId: idOf(task) } },
        context: contextFor(await actorFor('general-manager', db)),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses the accountant, who holds no task grant at all', async () => {
    const db = database()
    const task = taskRow(db, (row) => row.status === 'assigned')

    await expect(
      defineTaskCancellation({ db: clientOn(db) }).run({
        request: { input: { taskId: idOf(task) } },
        context: contextFor(await actorFor('accountant', db), 'לא נדרש.'),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})
