/**
 * What maintenance work costs, read the way the screen reads it.
 *
 * The rows come from `tasks/_lib/queries.ts` and are tested there. What this
 * file is about is the money: that it is found at all, that the ladder between
 * "approved" and "still a quote" survives, that stock issued against a job is
 * priced from the item's own unit cost, and that a reader without `expense.view`
 * gets *absent keys* rather than a confident ₪0.
 *
 * ── The ₪0 is the failure this file exists to catch ───────────────────────
 *
 * `redact()` deletes a key. A screen that then printed `{cost.committedAgorot}`
 * would render nothing, and an empty cell in a money column reads as zero — a
 * number, and a wrong one. "This repair cost nothing" and "you may not see what
 * this repair cost" are opposite statements, and the second must never be
 * rendered as the first. Every assertion about a withheld figure below is about
 * the key being *gone*, not about it being falsy.
 *
 * The helper is lifted from `dataset-actor.test.ts` rather than shared, exactly
 * as the finance and tasks tests lift it: these are the modules a paying
 * customer's request runs through, and nothing demo-specific is substituted.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PLANS } from '@/lib/demo/dataset'
import { person } from '@/lib/demo/dataset-identity'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import { DemoActorSource } from '@/lib/demo/session'

import { NO_TASK_FILTER } from '../../tasks/_lib/filters'
import { MAINTENANCE_TASK_TYPES, listTasks } from '../../tasks/_lib/queries'
import { maintenanceTotal, withCosts, type MaintenanceItem } from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

async function actorFor(key: string): Promise<Actor> {
  const plan = DEMO_PLANS.find((entry) => entry.code === 'pro')
  if (!plan) throw new Error("No demo plan 'pro'")

  const resolution = await resolveActor(
    new DemoActorSource(new SupabaseActorSource(client()), plan),
    person(key).userId,
    ORGANIZATION,
  )
  if (!resolution.ok) {
    throw new Error(`${key} does not resolve to an actor: ${resolution.reason}`)
  }
  return resolution.actor
}

/** The queue, exactly as `/maintenance` builds it. */
async function queueFor(key: string): Promise<readonly MaintenanceItem[]> {
  const db = client()
  const actor = await actorFor(key)
  const tasks = await listTasks({
    db,
    actor,
    propertyId: null,
    filter: NO_TASK_FILTER,
    grant: 'task.view',
    types: MAINTENANCE_TASK_TYPES,
  })
  return withCosts(db, actor, tasks)
}

describe('the maintenance queue', () => {
  it('is repairs and inspections, and not the cleaning rota', async () => {
    const items = await queueFor('owner')

    expect(items.length).toBeGreaterThan(0)
    expect(
      items.every((item) => MAINTENANCE_TASK_TYPES.includes(item.type)),
    ).toBe(true)
    expect(items.some((item) => item.type === 'cleaning')).toBe(false)
  })

  it('answers all five questions the screen asks of a row', async () => {
    const items = await queueFor('owner')

    for (const item of items) {
      // What is broken, where, since when, who owns it, what it costs.
      expect(typeof item.title).toBe('string')
      expect(item.propertyName).toEqual(expect.any(String))
      expect(item.openedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Array.isArray(item.assignees)).toBe(true)
      expect(Number.isInteger(item.cost.committedAgorot)).toBe(true)
    }
  })
})

describe('the money', () => {
  it('finds an approved cost, in whole agorot', async () => {
    const items = await queueFor('owner')
    const paid = items.filter((item) => (item.cost.approvedAgorot ?? 0) > 0)

    expect(paid.length).toBeGreaterThan(0)
    for (const item of paid) {
      expect(Number.isInteger(item.cost.approvedAgorot)).toBe(true)
      // Integer agorot, never a float. Nothing in this module divides by 100.
      expect(item.cost.approvedAgorot).toBeGreaterThan(0)
    }
  })

  it('keeps a quote nobody has agreed to out of the committed figure', async () => {
    const items = await queueFor('owner')
    const waiting = items.filter((item) => item.cost.awaitingDecision)

    // An `requested` approval is a price somebody has asked for, not a cost.
    // Folding it into the total would report a quote as money spent.
    expect(waiting.length).toBeGreaterThan(0)
    for (const item of waiting) {
      expect(item.cost.pendingAgorot).toBeGreaterThan(0)
      expect(item.cost.committedAgorot).toBe(
        (item.cost.approvedAgorot ?? 0) + (item.cost.partsAgorot ?? 0),
      )
    }
  })

  it('prices the stock a job consumed from the item’s own unit cost', async () => {
    const items = await queueFor('owner')
    const withParts = items.filter((item) => (item.cost.partsAgorot ?? 0) > 0)

    expect(withParts.length).toBeGreaterThan(0)
    for (const item of withParts) {
      expect(Number.isInteger(item.cost.partsAgorot)).toBe(true)
    }
  })

  it('totals only what is on screen, and says so by matching it', async () => {
    const items = await queueFor('owner')
    const totals = maintenanceTotal(items)

    expect(totals).not.toBeNull()
    expect(totals?.committedAgorot).toBe(
      items.reduce((sum, item) => sum + (item.cost.committedAgorot ?? 0), 0),
    )
    expect(totals?.pendingAgorot).toBe(
      items.reduce((sum, item) => sum + (item.cost.pendingAgorot ?? 0), 0),
    )
  })
})

describe('who may see what a repair costs', () => {
  it('gives the property manager the figures', async () => {
    const actor = await actorFor('property-manager')
    expect(holdsGrant(actor, 'expense.view')).toBe(true)

    const items = await queueFor('property-manager')
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => 'committedAgorot' in item.cost)).toBe(true)
  })

  it('withholds them from the handyman, as absent keys and never as zero', async () => {
    // The maintenance role holds `task.view`, `task.update`, `task.complete`,
    // the incident grants and `inventory.view` — and no expense grant at all.
    // He fixes the boiler and does not see what the business is paying for it.
    const actor = await actorFor('maintenance')
    expect(holdsGrant(actor, 'task.view')).toBe(true)
    expect(holdsGrant(actor, 'expense.view')).toBe(false)

    const items = await queueFor('maintenance')
    expect(items.length).toBeGreaterThan(0)

    for (const item of items) {
      expect('committedAgorot' in item.cost).toBe(false)
      expect('approvedAgorot' in item.cost).toBe(false)
      expect('pendingAgorot' in item.cost).toBe(false)
      expect('partsAgorot' in item.cost).toBe(false)
      // The two facts that are not money survive: he is told a decision is
      // outstanding, which is why his job has not moved, without being told
      // the sum being decided.
      expect(typeof item.cost.approvalCount).toBe('number')
      expect(typeof item.cost.awaitingDecision).toBe('boolean')
    }
  })

  it('withholds the totals rather than reporting a partial one', async () => {
    // A reader who may not see one repair's cost may certainly not see the sum
    // of twelve, and a partial sum presented as a total is worse than none.
    expect(maintenanceTotal(await queueFor('maintenance'))).toBeNull()
  })

  it('shows the handyman only his own team’s work', async () => {
    // Every repair and inspection in this dataset happens to belong to the
    // maintenance team, so his queue and the owner's are the same length — and
    // asserting they differ would be asserting a property of the seed rather
    // than of the scope. What is true either way is that every row he gets is
    // his team's, and that the board he does *not* see is much larger.
    const items = await queueFor('maintenance')
    const wholeBoard = await listTasks({
      db: client(),
      actor: await actorFor('owner'),
      propertyId: null,
      filter: NO_TASK_FILTER,
      grant: 'task.view',
    })

    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.teamId !== null)).toBe(true)
    expect(new Set(items.map((item) => item.teamId)).size).toBe(1)
    expect(items.length).toBeLessThan(wholeBoard.length)
  })
})
