/**
 * Opening a task, driven end to end over the demo dataset.
 *
 * The read tests prove the four screens show the right rows to the right
 * people. This one proves the *write* exists at all, and that it goes down the
 * path the charter names rather than round it.
 *
 * What is asserted, in order of how expensive the mistake would be:
 *
 *   · a row actually lands in `public.tasks`, with the columns the board reads
 *     back out of it — a create that writes `task_type` into a column called
 *     `type` compiles, runs, and produces a task the board cannot render;
 *   · the status is derived and not accepted, so "assigned to nobody" and
 *     "status: assigned" cannot disagree;
 *   · exactly one audit event is recorded, named in a sentence rather than
 *     templated — the pipeline refuses to finish without one, and this is what
 *     proves the operation supplies a real one;
 *   · `incident.opened` is published for a fault report, because it is in
 *     `ALERT_EVENTS` and somebody has to learn the boiler is broken without
 *     opening a screen;
 *   · a second submission with the same idempotency key replays instead of
 *     opening a second task, which is the half of duplicate-submit protection
 *     a disabled button cannot provide;
 *   · a cleaner is refused `task.create` before a row is read, and allowed
 *     `incident.create`.
 *
 * `DemoDatabase` copies its rows on construction, so the writes here mutate a
 * private copy and `DEMO_DATASET` is untouched for every other test file.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { InMemoryAuditWriter } from '@/lib/audit/pipeline'
import { AuthorizationError, type Actor } from '@/lib/authz/can'
import { DemoDatabase, createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PLANS } from '@/lib/demo/dataset'
import { person } from '@/lib/demo/dataset-identity'
import { PROPERTY_IDS, TEAM_IDS } from '@/lib/demo/dataset-inventory'
import { DemoActorSource } from '@/lib/demo/session'
import { ValidationError } from '@/lib/errors'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import {
  InMemoryIdempotencyStore,
  noTransactionRunner,
  type OperationServices,
} from '@/lib/service'

import { defineTaskCreation, type CreateTaskInput } from './operations'

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
    // Honest about what it is. The real wiring asks for `postgresUnitOfWork`
    // first and falls back to `sequentialUnitOfWork`; neither is reproducible
    // over an array of objects, and pretending otherwise would be the one thing
    // the demo client's own header refuses to do.
    transactions: noTransactionRunner,
  }
}

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

function contextFor(actor: Actor) {
  return {
    actor,
    auditActor: { type: 'user' as const, userId: actor.userId, label: 'דנה' },
    correlationId: 'correlation-1',
  }
}

describe('opening an ordinary task', () => {
  it('writes a row the board can read back', async () => {
    const db = database()
    const audit = new InMemoryAuditWriter()
    const before = db.rows('tasks').length

    const outcome = await defineTaskCreation({
      name: 'task.create',
      permission: 'task.create',
      db: clientOn(db),
    }).run({
      request: { input: DRAFT },
      context: contextFor(await actorFor('general-manager', db)),
      services: servicesWith(audit),
    })

    expect(outcome.ok).toBe(true)
    expect(db.rows('tasks')).toHaveLength(before + 1)

    const written = db.rows('tasks').find((row) => row.id === outcome.data.id)
    expect(written).toBeDefined()
    expect(written?.title).toBe(DRAFT.title)
    expect(written?.task_type).toBe('custom')
    expect(written?.organization_id).toBe(ORGANIZATION)
    expect(written?.property_id).toBe(PROPERTY_IDS.rimonim)
  })

  it('derives the status rather than accepting one', async () => {
    const db = database()
    const operation = defineTaskCreation({
      name: 'task.create',
      permission: 'task.create',
      db: clientOn(db),
    })
    const context = contextFor(await actorFor('general-manager', db))

    const unassigned = await operation.run({
      request: { input: DRAFT },
      context,
      services: servicesWith(new InMemoryAuditWriter()),
    })
    const assigned = await operation.run({
      request: {
        input: {
          ...DRAFT,
          assignedToUserId: person('maintenance').userId,
          teamId: TEAM_IDS.maintenance,
        },
      },
      context,
      services: servicesWith(new InMemoryAuditWriter()),
    })

    const rowOf = (id: string) => db.rows('tasks').find((row) => row.id === id)

    expect(rowOf(unassigned.data.id)?.status).toBe('new')
    expect(rowOf(assigned.data.id)?.status).toBe('assigned')
  })

  it('records exactly one audit event, and it names the task', async () => {
    const db = database()
    const audit = new InMemoryAuditWriter()

    await defineTaskCreation({
      name: 'task.create',
      permission: 'task.create',
      db: clientOn(db),
    }).run({
      request: { input: DRAFT },
      context: contextFor(await actorFor('general-manager', db)),
      services: servicesWith(audit),
    })

    expect(audit.records).toHaveLength(1)
    // "task created" is what the charter forbids. The sentence has to be
    // useful to somebody reading the timeline six months later.
    expect(audit.records[0].summary).toContain(DRAFT.title)
    // The same id as the operation, the domain events and the log line, so a
    // support conversation about "what happened at 14:32" has one thread.
    expect(audit.records[0].requestId).toBe('correlation-1')
    expect(audit.records[0].resourceType).toBe('task')
    expect(audit.records[0].organizationId).toBe(ORGANIZATION)
  })

  it('refuses a due date that is not a date', async () => {
    const db = database()

    await expect(
      defineTaskCreation({
        name: 'task.create',
        permission: 'task.create',
        db: clientOn(db),
      }).run({
        request: { input: { ...DRAFT, dueOn: '2026-13-45' } },
        context: contextFor(await actorFor('general-manager', db)),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Nothing was written, and nothing was audited.
    expect(db.rows('tasks').length).toBe(database().rows('tasks').length)
  })
})

describe('reporting a fault', () => {
  it('is always a maintenance task, whatever the caller sent', async () => {
    // There is no `public.incidents` table. A "fault" the reporter typed as
    // `guest_request` would vanish from the register that exists to hold it, so
    // the type is fixed by the wiring rather than chosen on the form.
    const db = database()

    const outcome = await defineTaskCreation({
      name: 'incident.create',
      permission: 'incident.create',
      fixedType: 'maintenance',
      db: clientOn(db),
    }).run({
      request: { input: { ...DRAFT, taskType: 'guest_request' } },
      context: contextFor(await actorFor('housekeeping', db)),
      services: servicesWith(new InMemoryAuditWriter()),
    })

    expect(outcome.data.taskType).toBe('maintenance')
    expect(
      db.rows('tasks').find((row) => row.id === outcome.data.id)?.task_type,
    ).toBe('maintenance')
  })

  it('publishes incident.opened, which is an alert event', async () => {
    const db = database()

    const outcome = await defineTaskCreation({
      name: 'incident.create',
      permission: 'incident.create',
      fixedType: 'maintenance',
      db: clientOn(db),
    }).run({
      request: { input: DRAFT },
      context: contextFor(await actorFor('housekeeping', db)),
      services: servicesWith(new InMemoryAuditWriter()),
    })

    expect(outcome.events.map((event) => event.name)).toEqual([
      'incident.opened',
    ])
  })

  it('opens with no responsible team, because nobody has triaged it', async () => {
    const db = database()

    const outcome = await defineTaskCreation({
      name: 'incident.create',
      permission: 'incident.create',
      fixedType: 'maintenance',
      db: clientOn(db),
    }).run({
      request: { input: DRAFT },
      context: contextFor(await actorFor('housekeeping', db)),
      services: servicesWith(new InMemoryAuditWriter()),
    })

    // Inventing one would put the fault on a board somebody would then assume
    // was watching it.
    expect(
      db.rows('tasks').find((row) => row.id === outcome.data.id)?.team_id,
    ).toBeNull()
  })
})

describe('the second press of the button', () => {
  it('replays instead of opening a second task', async () => {
    const db = database()
    const operation = defineTaskCreation({
      name: 'incident.create',
      permission: 'incident.create',
      fixedType: 'maintenance',
      db: clientOn(db),
    })
    const context = contextFor(await actorFor('housekeeping', db))
    const services = servicesWith(new InMemoryAuditWriter())
    const before = db.rows('tasks').length

    const request = { input: DRAFT, idempotencyKey: 'one-form-instance' }
    const first = await operation.run({ request, context, services })
    const second = await operation.run({ request, context, services })

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.data.id).toBe(first.data.id)
    // A cleaner on a weak signal pressing "דווח" twice must not create two
    // identical faults for somebody to triage.
    expect(db.rows('tasks')).toHaveLength(before + 1)
  })
})

describe('who may open what', () => {
  it('refuses the cleaner an ordinary task', async () => {
    // She holds `task.view`, `task.update`, `task.complete` and
    // `incident.create`. Not `task.create`. The refusal happens before a row is
    // read, so it cannot be undermined by a load that throws or logs.
    const db = database()
    const before = db.rows('tasks').length

    await expect(
      defineTaskCreation({
        name: 'task.create',
        permission: 'task.create',
        db: clientOn(db),
      }).run({
        request: { input: DRAFT },
        context: contextFor(await actorFor('housekeeping', db)),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)

    expect(db.rows('tasks')).toHaveLength(before)
  })

  it('refuses the external seller a fault report', async () => {
    const db = database()

    await expect(
      defineTaskCreation({
        name: 'incident.create',
        permission: 'incident.create',
        fixedType: 'maintenance',
        db: clientOn(db),
      }).run({
        request: { input: DRAFT },
        context: contextFor(await actorFor('sales-agent', db)),
        services: servicesWith(new InMemoryAuditWriter()),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})
