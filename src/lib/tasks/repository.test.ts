/**
 * The adapter, against a client that knows the column names.
 *
 * Mapping is where the interesting mistakes are, and none of them is visible
 * from the operations: a `select` that asked for `type` instead of `task_type`
 * compiles, runs, and fails three screens later. So these run over
 * `DemoDatabase`, whose rows are the shapes 0011 creates.
 *
 * The two behaviours that are not mapping are asserted for the same reason
 * they exist: an assignment is *ended*, never deleted, and every write names
 * the tenant in the query as well as relying on the policy.
 */

import { describe, expect, it } from 'vitest'

import { DemoDatabase, createDemoClient } from '../demo/client'
import { DEMO_DATASET } from '../demo/dataset'
import { person } from '../demo/dataset-identity'
import { PROPERTY_IDS } from '../demo/dataset-inventory'
import type { DemoRow } from '../demo/types'
import type { Db } from '../persistence/client'

import { SupabaseTaskRepository } from './repository'
import type { TaskRecord } from './types'

const ORGANIZATION = DEMO_DATASET.organizationId

function fixture(): { db: DemoDatabase; repository: SupabaseTaskRepository } {
  const db = new DemoDatabase(DEMO_DATASET)
  const client = createDemoClient(db) as unknown as Db
  return { db, repository: new SupabaseTaskRepository(client) }
}

function anyTask(db: DemoDatabase, match?: (row: DemoRow) => boolean): DemoRow {
  const found = match ? db.rows('tasks').find(match) : db.rows('tasks')[0]
  if (!found) throw new Error('The demo dataset has no such task')
  return found
}

describe('reading a task', () => {
  it('maps the row the operations work from', async () => {
    const { db, repository } = fixture()
    const row = anyTask(
      db,
      (candidate) => candidate.assigned_to_user_id !== null,
    )

    const task = await repository.loadTask(String(row.id))

    expect(task).not.toBeNull()
    expect(task?.id).toBe(row.id)
    expect(task?.organizationId).toBe(ORGANIZATION)
    expect(task?.propertyId).toBe(row.property_id)
    expect(task?.taskType).toBe(row.task_type)
    expect(task?.status).toBe(row.status)
    expect(task?.priority).toBe(row.priority)
    expect(task?.title).toBe(row.title)
    expect(task?.assignedToUserId).toBe(row.assigned_to_user_id)
    expect(typeof task?.version).toBe('number')
  })

  it('is null for a task that is not there', async () => {
    const { repository } = fixture()
    expect(
      await repository.loadTask('00000000-0000-4000-8000-000000000000'),
    ).toBeNull()
  })

  it('refuses a status outside the frozen vocabulary', async () => {
    // A value the enum does not carry means 0011 and `contracts/states.ts`
    // have diverged. Failing loudly at the boundary is better than a board
    // rendering a blank chip and nobody knowing why.
    const { db, repository } = fixture()
    const row = anyTask(db)
    row.status = 'somebody_added_a_status'

    await expect(repository.loadTask(String(row.id))).rejects.toThrow(
      /Unknown task status/,
    )
  })
})

describe('who is on a task', () => {
  it('returns the live rows and leaves out the ended ones', async () => {
    const { db, repository } = fixture()
    const assignment = db.rows('task_assignments')[0]
    const taskId = String(assignment.task_id)

    expect(await repository.liveAssignments(taskId)).toHaveLength(1)

    await repository.endAssignment(
      {
        id: String(assignment.id),
        organizationId: ORGANIZATION,
        taskId,
        userId: String(assignment.user_id),
        assignmentRole: 'assignee',
        assignedAt: String(assignment.assigned_at),
        unassignedAt: null,
      },
      new Date('2026-03-01T09:00:00Z'),
    )

    expect(await repository.liveAssignments(taskId)).toHaveLength(0)
    // Ended, not deleted. The row is the record of who held the job.
    const kept = db
      .rows('task_assignments')
      .find((row) => row.id === assignment.id)
    expect(kept?.unassigned_at).toBe('2026-03-01T09:00:00.000Z')
  })
})

describe('writing', () => {
  it('inserts a task with the columns the board reads back', async () => {
    const { db, repository } = fixture()
    const before = db.rows('tasks').length

    const created = await repository.insertTask({
      organizationId: ORGANIZATION,
      propertyId: PROPERTY_IDS.rimonim,
      unitId: null,
      teamId: null,
      taskType: 'maintenance',
      status: 'new',
      priority: 'high',
      title: 'בדיקת גלאי עשן',
      description: null,
      assignedToUserId: null,
      dueAt: '2026-03-02T18:00:00+03:00',
      actorUserId: person('general-manager').userId,
    })

    expect(db.rows('tasks')).toHaveLength(before + 1)
    expect(created.taskType).toBe('maintenance')

    const written = db.rows('tasks').find((row) => row.id === created.id)
    expect(written?.title).toBe('בדיקת גלאי עשן')
    expect(written?.due_at).toBe('2026-03-02T18:00:00+03:00')
    expect(written?.created_by).toBe(person('general-manager').userId)
  })

  it('names the tenant in the update as well as relying on the policy', async () => {
    // Row level security already refuses another organization's task. The
    // filter is what stops a mistake in this file from becoming a
    // cross-tenant write the first time somebody runs it as `service_role`.
    const { db, repository } = fixture()
    const row = anyTask(db)
    const held = String(row.priority)

    const mislabelled: TaskRecord = {
      id: String(row.id),
      organizationId: '00000000-0000-4000-8000-0000000000ff',
      propertyId: String(row.property_id),
      unitId: null,
      teamId: null,
      taskType: 'custom',
      status: 'new',
      priority: 'normal',
      title: String(row.title),
      assignedToUserId: null,
      version: 1,
    }

    await repository.updateTask(mislabelled, {
      priority: 'critical',
      updatedByUserId: null,
    })

    expect(row.priority).toBe(held)
  })

  it('touches only the columns a patch names', async () => {
    const { db, repository } = fixture()
    const row = anyTask(db)
    const title = String(row.title)
    const status = String(row.status)

    const task = await repository.loadTask(String(row.id))
    if (!task) throw new Error('The task just read is gone')

    await repository.updateTask(task, {
      priority: 'critical',
      updatedByUserId: person('general-manager').userId,
    })

    expect(row.priority).toBe('critical')
    expect(row.status).toBe(status)
    expect(row.title).toBe(title)
    expect(row.updated_by).toBe(person('general-manager').userId)
  })
})

describe('names for a sentence', () => {
  it('answers with the people it found and simply omits the rest', async () => {
    const { repository } = fixture()

    const names = await repository.personNames([
      person('housekeeping').userId,
      '00000000-0000-4000-8000-000000000000',
    ])

    expect(names.get(person('housekeeping').userId)).toBe(
      person('housekeeping').fullName,
    )
    expect(names.size).toBe(1)
  })

  it('asks nothing when there is nobody to ask about', async () => {
    const { repository } = fixture()
    expect((await repository.personNames([])).size).toBe(0)
  })
})
