/**
 * The preparation board, driven end to end over the demo dataset.
 *
 * Every query below runs through `createDemoClient(DEMO_DATASET)`, so a shape
 * the client cannot serve throws `UnsupportedQuery` here rather than 500ing in
 * a browser — which is how the embeds on `tasks` were ruled out in the first
 * place. Everything between the persona and the row is the code a paying
 * customer runs.
 *
 * ── The two claims this file exists to prove ──────────────────────────────
 *
 * **The empty plan renders rather than errors.** `work_plans` and the
 * `preparation_*` tables carry no seeded rows on purpose: they are written by
 * `buildPlan`, and inventing them would be seeding the output of the code path
 * a demo exists to exercise. So a board full of real cleaning jobs sits above
 * no computed plan at all, and that has to be an ordinary state the screen
 * says out loud — never a blank, and never a thrown read.
 *
 * **A cleaner reaches her own work and no revenue figure at all.** This is the
 * sharpest privacy case in the product and it is asserted rather than
 * commented: the rows she gets back are her team's, the rows she does not get
 * are proven absent by naming a job that exists and is not hers, and the whole
 * result is run through `containsFinancialField` — the preparation domain's
 * own runtime scan for a field name that means money.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { addDays, localDate } from '@/lib/booking/dates'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { PROPERTY_IDS, TEAM_IDS } from '@/lib/demo/dataset-inventory'
import { DemoActorSource } from '@/lib/demo/session'
import type { DemoDataset } from '@/lib/demo/types'
import { SupabasePreparationPorts, type Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import { containsFinancialField } from '@/lib/preparation'

import type { Horizon } from './horizon'
import {
  READINESS_TASK_TYPES,
  countUndatedTasks,
  listPreparationTasks,
  loadPlansForTasks,
  scopeNarrowings,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

/**
 * A window wide enough to contain the dataset's tasks whenever this runs.
 *
 * The demo generates cleaning and preparation jobs for stays within a
 * fortnight either side of the day it is built, so a fixed week would be full
 * on some days of the year and empty on others.
 */
const HORIZON: Horizon = {
  from: addDays(localDate(new Date()), -20),
  to: addDays(localDate(new Date()), 20),
}

/*
 * These tests used to run against a locally patched copy of the dataset,
 * because `work_plans`, `preparation_catalogues` and `preparation_snapshots`
 * were absent from `DEMO_DATASET.tables` altogether and `DemoDatabase.rows`
 * raises `MissingDemoTable` for a key it has never heard of. The three keys
 * are declared now, so the patch is gone and every test below runs against the
 * dataset the product actually serves — which is the only version of this file
 * that can catch the omission coming back.
 */

function planNamed(code: string) {
  const found = DEMO_PLANS.find((plan) => plan.code === code)
  if (!found) throw new Error(`No demo plan '${code}'`)
  return found
}

function demoDb(dataset: DemoDataset = DEMO_DATASET): Db {
  return createDemoClient(dataset) as unknown as Db
}

/**
 * The actor a persona resolves to.
 *
 * `pro` because `task.view` is entitlement-gated on `operations`, and a
 * cleaner on the Basic package resolves to an actor who cannot see a task at
 * all — which is a true fact about packages and not the subject of this file.
 */
async function actorFor(personaId: string, planCode = 'pro'): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const source = new DemoActorSource(
    new SupabaseActorSource(demoDb()),
    planNamed(planCode),
  )

  const resolution = await resolveActor(source, persona.userId, ORGANIZATION)
  if (!resolution.ok) {
    throw new Error(
      `${persona.label} does not resolve to an actor: ${resolution.reason}`,
    )
  }
  return resolution.actor
}

function tasksFor(actor: Actor, propertyId: string | null = null) {
  return listPreparationTasks(demoDb(), { actor, propertyId, horizon: HORIZON })
}

/* ------------------------------------------- what the dataset cannot serve -- */

describe('the preparation tables in the demo', () => {
  it('are declared and empty, so the screen can say "nothing yet"', async () => {
    // This assertion was the other way round when it was written, and it was
    // right to be: `work_plans`, `preparation_catalogues` and
    // `preparation_snapshots` were missing from `dataset.ts` altogether, so
    // the read threw `MissingDemoTable` instead of answering. A table declared
    // and empty says "nothing yet"; a table that is absent says "no such
    // table", and a screen cannot tell the second from a broken deployment.
    //
    // The three keys are now declared, so this test holds the fix rather than
    // the defect: against the real `DEMO_DATASET`, not a locally patched copy.
    const ports = new SupabasePreparationPorts(demoDb(DEMO_DATASET))

    expect(await ports.loadPlan('any-booking-id')).toBeNull()
    expect(await ports.loadSnapshot('any-booking-id')).toBeNull()
  })
})

/* ------------------------------------------------------------- the owner -- */

describe('the owner, who reaches every property', () => {
  it('gets readiness work across both properties, and only readiness work', async () => {
    const tasks = await tasksFor(await actorFor('owner'))

    expect(tasks.length).toBeGreaterThan(0)

    const properties = new Set(tasks.map((task) => task.propertyId))
    expect(properties.size).toBe(2)

    for (const task of tasks) {
      expect(READINESS_TASK_TYPES).toContain(task.type)
      // A monthly stock count and a bottle of wine for a couple are real work
      // and neither is a unit's readiness.
      expect(['inventory', 'guest_request']).not.toContain(task.type)
    }
  })

  it('places every job on a property-local day inside the window', async () => {
    const tasks = await tasksFor(await actorFor('owner'))

    for (const task of tasks) {
      expect(task.dueOn >= HORIZON.from).toBe(true)
      expect(task.dueOn < HORIZON.to).toBe(true)
      // The day comes from `localDate`, not from slicing the UTC instant: a
      // job due at 01:00 in Jerusalem belongs to that morning, not to the
      // night before.
      expect(task.dueOn).toBe(localDate(new Date(task.dueAt)))
    }
  })

  it('orders the board by when the work is due', async () => {
    const tasks = await tasksFor(await actorFor('owner'))
    const dues = tasks.map((task) => task.dueAt)
    expect([...dues].sort((a, b) => a.localeCompare(b))).toEqual(dues)
  })

  it('finds the blocked job, with the reason the database made mandatory', async () => {
    const tasks = await tasksFor(await actorFor('owner'))
    const blocked = tasks.filter((task) => task.status === 'blocked')

    // `blocked` is a real status in this dataset — a boiler waiting on a
    // second quote — and it is the one a supervisor has to find in one pass.
    expect(blocked.length).toBeGreaterThan(0)
    for (const task of blocked) {
      expect(task.status).not.toBe('in_progress')
      expect(task.blockedReason).not.toBeNull()
      expect((task.blockedReason as string).length).toBeGreaterThan(0)
    }
  })

  it('resolves the unit, the property and the people on each job', async () => {
    const tasks = await tasksFor(await actorFor('owner'))
    const withUnit = tasks.filter((task) => task.unitId !== null)
    const assigned = tasks.filter((task) => task.assignees.length > 0)

    expect(withUnit.length).toBeGreaterThan(0)
    for (const task of withUnit) expect(task.unitName).not.toBeNull()
    for (const task of tasks) expect(task.propertyName).not.toBeNull()

    expect(assigned.length).toBeGreaterThan(0)
    for (const task of assigned) {
      for (const assignee of task.assignees) {
        expect(assignee.fullName).not.toBeNull()
        expect(typeof assignee.accepted).toBe('boolean')
      }
    }
  })

  it('distinguishes a job somebody accepted from one merely handed to them', async () => {
    const tasks = await tasksFor(await actorFor('owner'))
    const flags = tasks.flatMap((task) =>
      task.assignees.map((assignee) => assignee.accepted),
    )

    // A board that cannot tell the two apart has no idea whether the day is
    // covered, which is the reason `task_assignments.accepted_at` exists.
    expect(flags).toContain(true)
    expect(flags).toContain(false)
  })

  it('narrows to the property the shell switcher selected', async () => {
    const owner = await actorFor('owner')
    const narrowed = await tasksFor(owner, PROPERTY_IDS.kacholYam)

    expect(narrowed.length).toBeGreaterThan(0)
    for (const task of narrowed) {
      expect(task.propertyId).toBe(PROPERTY_IDS.kacholYam)
    }
  })
})

/* -------------------------------------------------- the property manager -- */

describe('the property manager, confined to one property', () => {
  it('sees only their own property, without asking to be narrowed', async () => {
    const tasks = await tasksFor(await actorFor('property-manager'))

    expect(tasks.length).toBeGreaterThan(0)
    for (const task of tasks) {
      expect(task.propertyId).toBe(PROPERTY_IDS.rimonim)
    }
  })

  it('cannot reach the other property even by asking for it', async () => {
    const manager = await actorFor('property-manager')

    // The membership scope is pushed into the query and checked again per
    // row, so naming the property they do not hold returns nothing rather
    // than somebody else's morning.
    expect(await tasksFor(manager, PROPERTY_IDS.kacholYam)).toEqual([])
  })

  it('sees strictly less than the owner over the same window', async () => {
    const [owner, manager] = await Promise.all([
      actorFor('owner'),
      actorFor('property-manager'),
    ])
    const [wide, narrow] = await Promise.all([
      tasksFor(owner),
      tasksFor(manager),
    ])

    expect(narrow.length).toBeGreaterThan(0)
    expect(narrow.length).toBeLessThan(wide.length)

    const visible = new Set(narrow.map((task) => task.id))
    for (const id of visible) {
      expect(wide.map((task) => task.id)).toContain(id)
    }
  })
})

/* ----------------------------------------------------------- the cleaner -- */

describe('the cleaner, the sharpest privacy case in the product', () => {
  it('reaches her own team’s work and nothing else', async () => {
    const cleaner = await actorFor('housekeeping')
    expect(cleaner.scope.kind).toBe('team')

    const tasks = await tasksFor(cleaner)
    expect(tasks.length).toBeGreaterThan(0)

    for (const task of tasks) {
      expect(task.teamId).toBe(TEAM_IDS.housekeeping)
    }
  })

  it('does not receive the maintenance team’s blocked job that the owner does', async () => {
    const [owner, cleaner] = await Promise.all([
      actorFor('owner'),
      actorFor('housekeeping'),
    ])
    const [wide, hers] = await Promise.all([tasksFor(owner), tasksFor(cleaner)])

    const blocked = wide.filter((task) => task.status === 'blocked')
    expect(blocked.length).toBeGreaterThan(0)

    // Named rather than counted: the row exists, the owner has it, and it is
    // absent from her result set — not merely hidden by a component.
    for (const task of blocked) {
      expect(hers.map((entry) => entry.id)).not.toContain(task.id)
    }
  })

  it('receives no field that means money, checked by name at runtime', async () => {
    const tasks = await tasksFor(await actorFor('housekeeping'))

    // The preparation domain's own scan, over what actually reached her. It
    // cannot catch a field called `x`, which is why the queries never select a
    // price column in the first place — this is the second line of defence.
    expect(containsFinancialField(tasks)).toEqual([])
  })

  it('holds none of the grants that would open a money screen', async () => {
    const cleaner = await actorFor('housekeeping')

    for (const grant of [
      'booking.view',
      'booking.view_price',
      'guest.view',
      'payment.view',
      'finance.view',
      'report.financial.view',
    ] as const) {
      expect(cleaner.grants.has(grant)).toBe(false)
    }

    // And the one she does hold, which is the whole route guard for this page.
    expect(cleaner.grants.has('task.view')).toBe(true)
  })
})

/* ------------------------------------------------------ the work plans -- */

describe('the work plans behind the board', () => {
  it('reports no plan for every stay, and does not throw doing it', async () => {
    const owner = await actorFor('owner')
    const tasks = await tasksFor(owner)
    const ports = new SupabasePreparationPorts(demoDb())

    const stays = await loadPlansForTasks(ports, tasks)

    // This is the honest empty state the screen renders: stays exist, jobs
    // exist, and no plan has been computed for any of them because
    // `buildPlan` is a write and nothing calls it yet.
    expect(stays.length).toBeGreaterThan(0)
    for (const stay of stays) {
      expect(stay.plan).toBeNull()
      expect(stay.snapshot).toBeNull()
    }
  })

  it('looks a plan up only for stays the reader’s own jobs point at', async () => {
    const cleaner = await actorFor('housekeeping')
    const tasks = await tasksFor(cleaner)
    const ports = new SupabasePreparationPorts(demoDb())

    const stays = await loadPlansForTasks(ports, tasks)
    const hers = new Set(
      tasks.map((task) => task.bookingId).filter((id) => id !== null),
    )

    // Not a query over `bookings`: she holds `task.view` and not
    // `booking.view`, so a board that reached for that table would show her
    // nothing at all.
    expect(stays.length).toBeGreaterThan(0)
    for (const stay of stays) expect(hers.has(stay.bookingId)).toBe(true)
  })

  it('honours its own ceiling on the lookup', async () => {
    const owner = await actorFor('owner')
    const tasks = await tasksFor(owner)
    const ports = new SupabasePreparationPorts(demoDb())

    expect((await loadPlansForTasks(ports, tasks, 3)).length).toBe(3)
  })
})

/* -------------------------------------------------------- undated work -- */

describe('work with no due date', () => {
  it('is counted rather than silently dropped from a dated board', async () => {
    const owner = await actorFor('owner')
    const count = await countUndatedTasks(demoDb(), {
      actor: owner,
      propertyId: null,
      horizon: HORIZON,
    })

    // Every seeded task carries a due time, so the honest answer today is
    // zero — and a zero that was actually asked for is what lets the screen
    // stay silent instead of guessing.
    expect(count).toBe(0)
  })
})

/* --------------------------------------------------- the scope narrowing -- */

describe('the scope, translated into query filters', () => {
  const base = { userId: 'u1', isPlatformStaff: false } as unknown as Actor

  it('narrows by the column each scope kind actually lives on', () => {
    expect(
      scopeNarrowings(base, { kind: 'properties', propertyIds: ['p1'] }),
    ).toEqual([{ kind: 'in', column: 'property_id', values: ['p1'] }])

    expect(scopeNarrowings(base, { kind: 'units', unitIds: ['u'] })).toEqual([
      { kind: 'in', column: 'unit_id', values: ['u'] },
    ])

    expect(scopeNarrowings(base, { kind: 'team', teamIds: ['t'] })).toEqual([
      { kind: 'in', column: 'team_id', values: ['t'] },
    ])

    expect(scopeNarrowings(base, { kind: 'all_organization' })).toEqual([
      { kind: 'none' },
    ])
  })

  it('splits own_records into the disjunction `scopeReaches` actually admits', () => {
    // Assigned to me *or* created by me. PostgREST spells that with `.or()`,
    // which the demo client and the transaction compiler both refuse on
    // purpose, so it is two queries merged — never one of the two halves.
    expect(scopeNarrowings(base, { kind: 'own_records' })).toEqual([
      { kind: 'eq', column: 'assigned_to_user_id', value: 'u1' },
      { kind: 'eq', column: 'created_by', value: 'u1' },
    ])
  })

  it('treats an empty scope as reaching nothing rather than as a wildcard', () => {
    expect(
      scopeNarrowings(base, { kind: 'properties', propertyIds: [] }),
    ).toEqual([{ kind: 'in', column: 'property_id', values: [] }])
  })
})
