/**
 * The operations reads, walked the way the product walks them.
 *
 * `dataset-actor.test.ts` proved the personas resolve to genuinely different
 * actors, and `finance/_lib/queries.test.ts` proved the finance *screens*
 * differ. This is the same step for the task board and the fault register: it
 * runs the queries those two routes make over `createDemoClient(DEMO_DATASET)`
 * — the same 29 tasks, 23 assignments and 40 checklists a person sees in demo
 * mode — and asserts what an owner, a property manager confined to one
 * property, and a cleaner confined to her team each come back with.
 *
 * ── Why this is worth writing ─────────────────────────────────────────────
 *
 * A unit test over a pure function cannot tell you that a column name is
 * wrong, that a `redact` rule hands over the very field it was meant to
 * withhold, or that a scope narrowing names a column the table does not have.
 * Running the real query over a real dataset can.
 *
 * ── What this is not ──────────────────────────────────────────────────────
 *
 * It is not a test of row level security. `createDemoClient` says so in its own
 * header and it bears repeating: there is no policy engine behind these arrays,
 * so a query that forgot its tenant filter would return rows here and nothing
 * in production. What is exercised is the floor above it — the scope narrowing,
 * the `can()` check per row and the `redact()` field rules the queries apply
 * themselves, which is what decides that a cleaner gets her team's work and no
 * link to a guest's stay.
 *
 * ── The helper is duplicated on purpose ───────────────────────────────────
 *
 * `actorFor` is lifted from `dataset-actor.test.ts` rather than shared, exactly
 * as the finance test lifted it: these are the same modules a paying customer's
 * request runs through, and the point of all three files is that nothing
 * demo-specific is substituted for them.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PLANS } from '@/lib/demo/dataset'
import { person } from '@/lib/demo/dataset-identity'
import { PROPERTY_IDS, TEAM_IDS } from '@/lib/demo/dataset-inventory'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import { NO_TASK_FILTER } from './filters'
import {
  INCIDENT_TASK_TYPES,
  MAINTENANCE_TASK_TYPES,
  countTasks,
  daysOpen,
  listTasks,
  summariseTasks,
  type TaskListItem,
} from './queries'
import { isReachableTarget, listTaskTargets } from './targets'

const ORGANIZATION = DEMO_DATASET.organizationId

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

function planNamed(code: string) {
  const found = DEMO_PLANS.find((plan) => plan.code === code)
  if (!found) throw new Error(`No demo plan '${code}'`)
  return found
}

/**
 * The actor a member resolves to, through the ordinary path.
 *
 * Keyed off `PEOPLE` rather than `DEMO_PERSONAS`, because the handyman and the
 * second cleaner are members without a persona label — they exist so that
 * assignments and approvals point at real people — and the maintenance role is
 * the one that proves a team-scoped membership reaches no inventory.
 */
async function actorFor(key: string, planCode = 'pro'): Promise<Actor> {
  const source = new DemoActorSource(
    new SupabaseActorSource(client()),
    planNamed(planCode),
  )

  const resolution = await resolveActor(
    source,
    person(key).userId,
    ORGANIZATION,
  )
  if (!resolution.ok) {
    throw new Error(`${key} does not resolve to an actor: ${resolution.reason}`)
  }
  return resolution.actor
}

/** The arguments the board makes, for an unfiltered organization-wide read. */
async function boardFor(key: string) {
  return {
    db: client(),
    actor: await actorFor(key),
    propertyId: null,
    filter: NO_TASK_FILTER,
    grant: 'task.view' as const,
  }
}

/** How many rows the dataset holds, so assertions cannot drift from it. */
function seeded(table: string): number {
  return DEMO_DATASET.tables[table]?.length ?? 0
}

function rowsOf(table: string) {
  return DEMO_DATASET.tables[table] ?? []
}

/* ================================================================ board == */

describe('the task board', () => {
  it('serves the owner every seeded task', async () => {
    const tasks = await listTasks(await boardFor('owner'))

    expect(tasks).toHaveLength(seeded('tasks'))
    expect(tasks.length).toBeGreaterThanOrEqual(20)

    for (const task of tasks) {
      // Every column the screen prints, present and of the right kind. A
      // renamed column would surface here as `undefined` rather than as a
      // blank cell somebody notices in production.
      expect(typeof task.id).toBe('string')
      expect(typeof task.title).toBe('string')
      expect(typeof task.type).toBe('string')
      expect(typeof task.status).toBe('string')
      expect(typeof task.priority).toBe('string')
      expect(typeof task.propertyId).toBe('string')
      expect(task.openedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(
        task.dueOn === null || /^\d{4}-\d{2}-\d{2}$/.test(task.dueOn),
      ).toBe(true)
    }
  })

  it('names the unit and the property rather than printing an id', async () => {
    const tasks = await listTasks(await boardFor('owner'))
    const withUnit = tasks.filter((task) => task.unitId !== null)

    expect(withUnit.length).toBeGreaterThan(0)
    expect(withUnit.every((task) => typeof task.unitName === 'string')).toBe(
      true,
    )
    expect(tasks.every((task) => typeof task.propertyName === 'string')).toBe(
      true,
    )
  })

  it('sorts the soonest first and puts the undated last', async () => {
    const tasks = await listTasks(await boardFor('owner'))
    const dated = tasks.filter((task) => task.dueAt !== null)
    const firstUndated = tasks.findIndex((task) => task.dueAt === null)

    // Every dated row is before every undated one, or there are none.
    if (firstUndated !== -1) {
      expect(tasks.slice(firstUndated).every((t) => t.dueAt === null)).toBe(
        true,
      )
    }

    for (let index = 1; index < dated.length; index += 1) {
      expect(
        (dated[index - 1].dueAt as string) <= (dated[index].dueAt as string),
      ).toBe(true)
    }
  })

  it('carries the assignees, and marks who has not accepted yet', async () => {
    const tasks = await listTasks(await boardFor('owner'))
    const assigned = tasks.filter((task) => task.assignees.length > 0)

    expect(assigned.length).toBe(seeded('task_assignments'))
    expect(
      assigned.every((task) =>
        task.assignees.every((who) => typeof who.userId === 'string'),
      ),
    ).toBe(true)
    // The owner holds `user.view`, so the names are real values here.
    expect(
      assigned.some((task) =>
        task.assignees.some((who) => typeof who.fullName === 'string'),
      ),
    ).toBe(true)
    // A rota where nobody has accepted anything is a rota nobody has read.
    expect(
      assigned.some((task) => task.assignees.some((who) => who.accepted)),
    ).toBe(true)
  })

  it('finds blocked work, and every blocked row can say what it waits for', async () => {
    const tasks = await listTasks(await boardFor('owner'))
    const blocked = tasks.filter((task) => task.status === 'blocked')

    // `blocked` is the whole reason the board exists. A dataset with none of it
    // would make this screen untestable and the distinction unobservable.
    expect(blocked.length).toBeGreaterThan(0)
    // `tasks_blocked_has_reason` guarantees the reason at the database, and the
    // table prints it in words under the badge.
    expect(
      blocked.every(
        (task) =>
          typeof task.blockedReason === 'string' &&
          task.blockedReason.trim().length > 0,
      ),
    ).toBe(true)
    // And it is not the same thing as being in progress.
    expect(blocked.every((task) => task.status !== 'in_progress')).toBe(true)
  })
})

/* ================================================================ scope == */

describe('the property manager, confined to one property', () => {
  it('sees only that property, and fewer tasks than the owner', async () => {
    const [mine, everything] = await Promise.all([
      listTasks(await boardFor('property-manager')),
      listTasks(await boardFor('owner')),
    ])

    expect(mine.length).toBeGreaterThan(0)
    expect(mine.length).toBeLessThan(everything.length)
    expect(mine.every((task) => task.propertyId === PROPERTY_IDS.rimonim)).toBe(
      true,
    )
  })

  it('counts what she reaches, not what the organization holds', async () => {
    // The count feeds `resolveEmptyReason`, which decides between "you have no
    // tasks" and "your filter matched nothing". A count over the whole
    // organization would tell a property manager her filter was at fault when
    // the property genuinely has nothing.
    const reachable = await countTasks(await boardFor('property-manager'))
    const listed = await listTasks(await boardFor('property-manager'))

    expect(reachable).toBe(listed.length)
    expect(reachable).toBeLessThan(seeded('tasks'))
  })
})

describe('the cleaner, confined to her team', () => {
  it('reaches her team’s work and nothing else', async () => {
    const tasks = await listTasks(await boardFor('housekeeping'))

    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks.every((task) => task.teamId === TEAM_IDS.housekeeping)).toBe(
      true,
    )
    // The maintenance team's jobs exist and are not hers.
    expect(tasks.some((task) => task.teamId === TEAM_IDS.maintenance)).toBe(
      false,
    )
  })

  it('is never handed the stay behind the job', async () => {
    // `booking.view` is the grant that leads to the guest's name and the price
    // of the night. A cleaner holds `task.view`, `task.update`,
    // `task.complete` and `incident.create` and none of it — so the key is
    // absent, not null, and the table renders no link at all.
    const actor = await actorFor('housekeeping')
    expect(holdsGrant(actor, 'booking.view')).toBe(false)
    expect(holdsGrant(actor, 'guest.view_name')).toBe(false)
    expect(holdsGrant(actor, 'booking.view_price')).toBe(false)

    const tasks = await listTasks(await boardFor('housekeeping'))
    expect(tasks.every((task) => !('bookingId' in task))).toBe(true)

    // Belt to that brace: no value anywhere on a row is a guest's name.
    const guestNames = rowsOf('guests')
      .map((guest) => guest.full_name)
      .filter((name): name is string => typeof name === 'string')
    const printed = JSON.stringify(tasks)
    for (const name of guestNames) expect(printed).not.toContain(name)
  })

  it('is not handed her colleagues’ names either', async () => {
    // She has no `user.view`, so the profile query is never issued and the
    // reporter's key is removed. The table then says "מוקצה" without inventing
    // a name — `redact` cannot reach `assignees[].fullName`, which is why the
    // read is skipped rather than the field hidden afterwards.
    const tasks = await listTasks(await boardFor('housekeeping'))

    expect(tasks.every((task) => !('reportedBy' in task))).toBe(true)
    expect(
      tasks.every((task) =>
        task.assignees.every((who) => who.fullName === null),
      ),
    ).toBe(true)
  })

  it('the owner, by contrast, gets both', async () => {
    const tasks = await listTasks(await boardFor('owner'))

    expect(tasks.every((task) => 'bookingId' in task)).toBe(true)
    expect(tasks.every((task) => 'reportedBy' in task)).toBe(true)
    expect(tasks.some((task) => typeof task.reportedBy === 'string')).toBe(true)
  })
})

/* =============================================================== filters == */

describe('filtering', () => {
  it('narrows to one status without changing what the row says', async () => {
    const base = await boardFor('owner')
    const all = await listTasks(base)
    const blocked = await listTasks({
      ...base,
      filter: { ...NO_TASK_FILTER, status: 'blocked' },
    })

    expect(blocked.length).toBeGreaterThan(0)
    expect(blocked.every((task) => task.status === 'blocked')).toBe(true)
    expect(blocked.length).toBe(
      all.filter((task) => task.status === 'blocked').length,
    )
  })

  it('narrows to one type', async () => {
    const base = await boardFor('owner')
    const cleaning = await listTasks({
      ...base,
      filter: { ...NO_TASK_FILTER, type: 'cleaning' },
    })

    expect(cleaning.length).toBeGreaterThan(0)
    expect(cleaning.every((task) => task.type === 'cleaning')).toBe(true)
  })

  it('restricts the maintenance queue to repairs and inspections', async () => {
    const base = await boardFor('owner')
    const work = await listTasks({ ...base, types: MAINTENANCE_TASK_TYPES })

    expect(work.length).toBeGreaterThan(0)
    expect(
      work.every((task) => MAINTENANCE_TASK_TYPES.includes(task.type)),
    ).toBe(true)
    // A departure clean belongs to `/preparation`, not to the repair queue.
    expect(work.some((task) => task.type === 'cleaning')).toBe(false)
  })
})

/* ============================================================= incidents == */

describe('the fault register', () => {
  it('is the maintenance-typed tasks, read under incident.view', async () => {
    const actor = await actorFor('owner')
    const incidents = await listTasks({
      db: client(),
      actor,
      propertyId: null,
      filter: NO_TASK_FILTER,
      grant: 'incident.view',
      types: INCIDENT_TASK_TYPES,
    })

    expect(incidents.length).toBeGreaterThan(0)
    expect(incidents.every((task) => task.type === 'maintenance')).toBe(true)
  })

  it('comes back empty for the cleaner, because the grant is what admits a row', async () => {
    // The asymmetry the screen carries: she may report a fault and may not
    // browse them. `requireIncidentAccess` refuses her the register outright;
    // this proves the query underneath would refuse her too, so the two floors
    // agree rather than the screen being the only thing in the way.
    const actor = await actorFor('housekeeping')
    expect(holdsGrant(actor, 'incident.create')).toBe(true)
    expect(holdsGrant(actor, 'incident.view')).toBe(false)

    const incidents = await listTasks({
      db: client(),
      actor,
      propertyId: null,
      filter: NO_TASK_FILTER,
      grant: 'incident.view',
      types: INCIDENT_TASK_TYPES,
    })

    expect(incidents).toHaveLength(0)
  })

  it('serves the handyman, who holds incident.view and a team scope', async () => {
    const actor = await actorFor('maintenance')
    expect(holdsGrant(actor, 'incident.view')).toBe(true)

    const incidents = await listTasks({
      db: client(),
      actor,
      propertyId: null,
      filter: NO_TASK_FILTER,
      grant: 'incident.view',
      types: INCIDENT_TASK_TYPES,
    })

    expect(incidents.length).toBeGreaterThan(0)
    expect(
      incidents.every((task) => task.teamId === TEAM_IDS.maintenance),
    ).toBe(true)
  })
})

/* =============================================================== summary == */

describe('the strip above the board', () => {
  it('counts blocked separately from open, because they are opposite states', async () => {
    const tasks = await listTasks(await boardFor('owner'))
    const summary = summariseTasks(tasks, '2999-01-01')

    expect(summary.total).toBe(tasks.length)
    expect(summary.blocked).toBe(
      tasks.filter((task) => task.status === 'blocked').length,
    )
    expect(summary.blocked).toBeGreaterThan(0)
    // Everything not finished, verified or cancelled is open — including the
    // blocked ones, which are open and stuck rather than not open.
    expect(summary.open).toBeGreaterThanOrEqual(summary.blocked)
    // Against a date far in the future every unfinished job is late.
    expect(summary.overdue).toBeGreaterThan(0)
  })

  it('reports no overdue work when read from before the window', async () => {
    const tasks = await listTasks(await boardFor('owner'))
    expect(summariseTasks(tasks, '2000-01-01').overdue).toBe(0)
  })

  it('ages a job from the day it was written down', async () => {
    const tasks = await listTasks(await boardFor('owner'))
    // Still open, so the age runs to whatever "today" is.
    const task = { ...tasks[0], completedOn: null }

    expect(daysOpen(task, task.openedOn)).toBe(0)
    expect(daysOpen(task, addDays(task.openedOn, 5))).toBe(5)
    // Never negative: a clock that disagrees must not report a fault opened
    // tomorrow as minus one day old.
    expect(daysOpen(task, addDays(task.openedOn, -3))).toBe(0)
  })

  it('stops the clock on the day the work finished', async () => {
    // A repair that took two days and closed a fortnight ago is two days old,
    // not sixteen. The maintenance queue is read for exactly this number.
    const tasks = await listTasks(await boardFor('owner'))
    const finished = tasks.find((task) => task.completedOn !== null)
    expect(finished).toBeDefined()

    const task = finished as TaskListItem
    expect(daysOpen(task, '2999-01-01')).toBe(
      daysOpen(task, task.completedOn as string),
    )
  })
})

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/* =============================================================== targets == */

describe('where a person may open work', () => {
  it('gives the owner every property in the organization', async () => {
    const targets = await listTaskTargets(client(), await actorFor('owner'))

    expect(targets.properties.length).toBe(seeded('properties'))
    expect(targets.units.length).toBeGreaterThan(0)
    expect(targets.teams.length).toBe(seeded('teams'))
  })

  it('gives the property manager her property and no other', async () => {
    const targets = await listTaskTargets(
      client(),
      await actorFor('property-manager'),
    )

    expect(targets.properties.map((property) => property.id)).toEqual([
      PROPERTY_IDS.rimonim,
    ])
    expect(
      targets.units.every((unit) => unit.propertyId === PROPERTY_IDS.rimonim),
    ).toBe(true)
  })

  it('gives the cleaner the places her own work already puts her', async () => {
    // Her scope is a team and a property carries no team, so `can()` cannot
    // answer "may she report a fault at this property" at all. The set is
    // derived from the tasks she already holds — nothing she could not read on
    // `/tasks` — which is what makes the incident form reachable for her.
    const actor = await actorFor('housekeeping')
    const targets = await listTaskTargets(client(), actor)

    expect(targets.properties.length).toBeGreaterThan(0)
    expect(targets.units.length).toBeGreaterThan(0)
    // Her own team, and only it: routing work to a team she cannot see would
    // be sending it somewhere she cannot follow it.
    expect(targets.teams.map((team) => team.id)).toEqual([
      TEAM_IDS.housekeeping,
    ])
  })

  it('refuses a property the person does not reach', async () => {
    const targets = await listTaskTargets(
      client(),
      await actorFor('property-manager'),
    )

    expect(
      isReachableTarget(targets, {
        propertyId: PROPERTY_IDS.rimonim,
        unitId: null,
        teamId: null,
      }),
    ).toBe(true)

    // The second property is not hers, and the action refuses the submission
    // rather than letting row level security answer with a constraint error.
    expect(
      isReachableTarget(targets, {
        propertyId: PROPERTY_IDS.kacholYam,
        unitId: null,
        teamId: null,
      }),
    ).toBe(false)
  })

  it('refuses a unit that belongs to a different property from the one named', async () => {
    const targets = await listTaskTargets(client(), await actorFor('owner'))
    const unit = targets.units.find(
      (candidate) => candidate.propertyId === PROPERTY_IDS.kacholYam,
    )
    expect(unit).toBeDefined()

    // 0011's `tasks_unit_fkey` is a three-column key over (unit, organization,
    // property) and would refuse this at the database. A form that let somebody
    // get that far would produce a constraint error instead of a sentence.
    expect(
      isReachableTarget(targets, {
        propertyId: PROPERTY_IDS.rimonim,
        unitId: (unit as { id: string }).id,
        teamId: null,
      }),
    ).toBe(false)
  })
})

/** Keeps the type import honest where a helper needs the shape. */
export type { TaskListItem }
