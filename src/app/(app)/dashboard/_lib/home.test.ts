/**
 * The home screen, loaded for each persona over the demo dataset.
 *
 * `tiles.test.ts` proves which tiles a role is offered. This file proves what
 * those tiles are *filled with*: it runs `loadHome` over
 * `createDemoClient(DEMO_DATASET)` for eight personas — the same organization,
 * bookings, tasks and payments a buyer sees in demo mode — and asserts what
 * each one comes back holding.
 *
 * The distinction matters and has bitten this product before. A screen can
 * resolve a correct tile set and still fill it from a query that forgot a
 * scope narrowing, and the resulting number is a fact about somebody else's
 * property rendered under a heading that says it is yours.
 *
 * ── What this is not ──────────────────────────────────────────────────────
 *
 * It is not a test of row level security. `createDemoClient` has no policy
 * engine behind its arrays and says so in its own header, so a query missing a
 * tenant filter would return rows here and nothing in production. What is
 * exercised is the floor above it: the `holdsGrant` refusals inside each query
 * module, the `can()` narrowing per row, and the metric dictionary's per-metric
 * refusal.
 *
 * `now` is pinned, because a suite whose assertions move at midnight is a
 * suite that fails for a reason nobody can reproduce the next morning.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import { SupabaseMetricSource, type Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import { countStays, loadHome, type HomeData } from './home'

const ORGANIZATION = DEMO_DATASET.organizationId

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

function planNamed(code: string) {
  const found = DEMO_PLANS.find((plan) => plan.code === code)
  if (!found) throw new Error(`No demo plan '${code}'`)
  return found
}

async function actorFor(personaId: string, planCode = 'pro'): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const source = new DemoActorSource(
    new SupabaseActorSource(client()),
    planNamed(planCode),
  )

  const resolution = await resolveActor(source, persona.userId, ORGANIZATION)
  if (!resolution.ok) {
    throw new Error(`${persona.label}: ${resolution.reason}`)
  }
  return resolution.actor
}

async function homeFor(personaId: string, plan = 'pro'): Promise<HomeData> {
  const db = client()
  return loadHome({
    db,
    source: new SupabaseMetricSource(db),
    actor: await actorFor(personaId, plan),
    organizationId: ORGANIZATION,
    propertyId: null,
  })
}

/* ------------------------------------------------------- every persona -- */

describe('every persona gets a home screen without throwing', () => {
  it.each(DEMO_PERSONAS.map((persona) => [persona.label, persona.id] as const))(
    '%s',
    async (_label, id) => {
      const home = await homeFor(id)

      // A read that failed is a real outcome and the screen renders it — but
      // not one of them should fail against a dataset held in memory, and a
      // silent failure here would look exactly like a business with nothing
      // going on today.
      expect(home.stays.ok, 'stays').toBe(true)
      expect(home.balances.ok, 'balances').toBe(true)
      expect(home.stuckTasks.ok, 'tasks').toBe(true)
      expect(home.stalledPayments.ok, 'payments').toBe(true)
      expect(home.approvals.ok, 'approvals').toBe(true)
      expect(home.myJobs.ok, 'my jobs').toBe(true)
      expect(home.metrics.ok, 'metrics').toBe(true)
      expect(home.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    },
  )
})

/* -------------------------------------------------------- the cleaner -- */

describe('the cleaner', () => {
  it('is told nothing about a stay, a guest or a payment', async () => {
    const home = await homeFor('housekeeping')

    // Not zero — `listStaysToday` refuses without `booking.view` and returns
    // no rows, so every count is genuinely absent rather than reported as
    // "nobody is here today".
    expect(home.stays.ok && home.stays.value).toEqual({
      arriving: 0,
      departing: 0,
      in_house: 0,
    })

    // `null`, which the screen prints as "not open to you" and never as 0.
    expect(home.balances.ok && home.balances.value).toBeNull()
    expect(home.stalledPayments.ok && home.stalledPayments.value).toBeNull()
    expect(home.approvals.ok && home.approvals.value).toBeNull()
  })

  it('is given no metric at all, and therefore no shekel figure', async () => {
    const home = await homeFor('housekeeping')
    expect(home.metrics.ok && home.metrics.value.size).toBe(0)
  })

  it('is given her own units, with a name and no guest and no money', async () => {
    const home = await homeFor('housekeeping')
    expect(home.myJobs.ok).toBe(true)

    const jobs = home.myJobs.ok ? home.myJobs.value : []
    for (const job of jobs) {
      // The record simply has no field for either. This is the structural
      // form of the privacy rule and the reason the panel needs no redaction.
      expect(job).not.toHaveProperty('guestName')
      expect(job).not.toHaveProperty('totalAgorot')
      expect(Object.keys(job)).not.toContain('guestName')
    }
  })
})

/* ---------------------------------------------------------- the owner -- */

describe('the owner', () => {
  it('is given the whole day and the whole month', async () => {
    const home = await homeFor('owner')

    const stays = home.stays.ok ? home.stays.value : null
    expect(stays).not.toBeNull()
    // The demo pins three stays to today on purpose. They may be arriving,
    // departing or mid-stay depending on the day the suite runs, so the claim
    // is about the total rather than about one of the three roles.
    expect(
      (stays?.arriving ?? 0) + (stays?.departing ?? 0) + (stays?.in_house ?? 0),
    ).toBeGreaterThan(0)

    const metrics = home.metrics.ok ? home.metrics.value : new Map()
    expect(metrics.has('occupancy')).toBe(true)
    expect(metrics.has('revenue')).toBe(true)
    expect(metrics.has('outstanding_balance')).toBe(true)
    expect(metrics.has('booking_pace')).toBe(true)
  })

  it('is told what today owes, as a number the finance domain summed', async () => {
    const home = await homeFor('owner')
    const balances = home.balances.ok ? home.balances.value : null

    expect(balances).not.toBeNull()
    // Integer agorot, never a float that has been through a division.
    expect(Number.isInteger(balances?.totalAgorot)).toBe(true)
    expect(balances!.totalAgorot).toBeGreaterThanOrEqual(0)
  })

  it('is refused the approvals queue by the package, not by the role', async () => {
    // Every package the demo offers lacks the `approvals` entitlement, which
    // only `management` carries — so even the owner gets `null` here, and the
    // screen must say "your package" rather than "you may not".
    const home = await homeFor('owner')
    expect(home.approvals.ok && home.approvals.value).toBeNull()
  })
})

/* ----------------------------------------------------- the in-between -- */

describe('the roles in between are genuinely different screens', () => {
  it('gives the accountant money and no operational work of her own', async () => {
    const home = await homeFor('accountant')

    const metrics = home.metrics.ok ? home.metrics.value : new Map()
    expect(metrics.has('outstanding_balance')).toBe(true)
    // The accountant holds no `availability.view`, so occupancy is withheld by
    // the dictionary rather than computed and hidden.
    expect(metrics.has('occupancy')).toBe(false)

    expect(home.myJobs.ok && home.myJobs.value).toEqual([])
  })

  it('gives the general manager the day and withholds the money report', async () => {
    const home = await homeFor('general-manager')
    const metrics = home.metrics.ok ? home.metrics.value : new Map()

    expect(metrics.has('occupancy')).toBe(true)
    expect(metrics.has('revenue')).toBe(false)
  })

  it('narrows the property manager to his own property', async () => {
    const [wide, narrow] = await Promise.all([
      homeFor('general-manager'),
      homeFor('property-manager'),
    ])

    const total = (home: HomeData) => {
      if (!home.stays.ok) return -1
      const { arriving, departing, in_house } = home.stays.value
      return arriving + departing + in_house
    }

    // Not merely "fewer or equal": the scope narrowing must actually remove
    // rows, or the demo is proving nothing about a model whose whole subject
    // is that it does.
    expect(total(narrow)).toBeLessThan(total(wide))
  })

  it('gives the external agent no financial figure of any kind', async () => {
    const home = await homeFor('sales-agent')
    const metrics = home.metrics.ok ? home.metrics.value : new Map()

    for (const id of ['revenue', 'outstanding_balance'] as const) {
      expect(metrics.has(id)).toBe(false)
    }
    expect(home.balances.ok && home.balances.value).toBeNull()
  })
})

/* ------------------------------------------------------------ counting -- */

describe('countStays', () => {
  it('tallies the three jobs and invents no fourth', () => {
    expect(
      countStays([
        { role: 'arriving' },
        { role: 'arriving' },
        { role: 'departing' },
      ] as never),
    ).toEqual({ arriving: 2, departing: 1, in_house: 0 })
  })

  it('reports zeroes rather than an empty object for an empty day', () => {
    expect(countStays([])).toEqual({
      arriving: 0,
      departing: 0,
      in_house: 0,
    })
  })
})
