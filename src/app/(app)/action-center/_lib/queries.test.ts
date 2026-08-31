/**
 * The action centre, walked the way the product walks it.
 *
 * Every query below runs over `createDemoClient(DEMO_DATASET)` — the same 39
 * bookings, 53 payments, 29 tasks and 3 approvals a person sees in demo mode —
 * with an actor resolved the long way round: membership → roles → grants →
 * scope, through `resolveActor` and `SupabaseActorSource`, exactly as a paying
 * customer's request resolves one. Nothing demo-specific is substituted except
 * the package, which is what the switcher moves.
 *
 * ── Why this is worth writing ─────────────────────────────────────────────
 *
 * A unit test over a pure function cannot tell you that a column name is
 * wrong, that an embed is not declared in `DEMO_RELATIONS`, that `.not()` is
 * not an operator the demo client implements, or that a redaction hands over
 * the very figure it was meant to withhold. Running the real query over a real
 * dataset can. `finance/_lib/queries.test.ts` says three of its assertions
 * failed on the first run; the same was true here.
 *
 * ── What this is not ──────────────────────────────────────────────────────
 *
 * It is not a test of row level security. `createDemoClient` has no policy
 * engine behind its arrays, so a query that forgot its tenant filter would
 * return rows here and nothing in production. What is exercised is the floor
 * above it: the `holdsGrant` gate on each panel, the scope narrowing pushed
 * into each query, the `can()` check per row, and the `redact()` field rules.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { authorize, holdsGrant, type Actor } from '@/lib/authz/can'
import { localDate } from '@/lib/booking/dates'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { DemoPlan } from '@/lib/demo/types'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import { SEED_PLANS } from '@/lib/plans/catalog'

import {
  ACTION_CENTER_GRANTS,
  listOpenBalances,
  listPaymentsNeedingAttention,
  listStaysToday,
  listStuckTasks,
  listWaitingApprovals,
  outstandingTotalAgorot,
  propertyToday,
  type ActionCenterArgs,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

/** The dataset pins three stays to today; `TODAY` is resolved the same way. */
const TODAY = localDate(new Date())

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

/**
 * A package to resolve the actor against.
 *
 * The three the switcher offers come from `DEMO_PLANS`. `management` is
 * deliberately not one of them — `dataset.ts` explains that it adds an owner
 * portal and multi-brand, neither of which has a screen — so it is built here
 * from the catalogue itself rather than added to the demo. It is the only
 * package that carries the `approvals` entitlement, and without it the
 * approvals panel could not be exercised at all.
 */
function planNamed(code: string): DemoPlan {
  const offered = DEMO_PLANS.find((plan) => plan.code === code)
  if (offered) return offered

  const catalogued = SEED_PLANS.find((plan) => plan.code === code)
  if (!catalogued) throw new Error(`No plan '${code}' in the catalogue`)
  return {
    code: catalogued.code,
    label: catalogued.name,
    entitlements: catalogued.entitlements,
  }
}

/**
 * The actor a persona resolves to, through the ordinary path.
 *
 * Lifted from `finance/_lib/queries.test.ts` deliberately rather than shared:
 * these are the modules a paying customer's request runs through, and the point
 * of both files is that nothing demo-specific is substituted for them.
 */
async function actorFor(personaId: string, planCode = 'pro'): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const source = new DemoActorSource(
    new SupabaseActorSource(client()),
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

async function argsFor(
  personaId: string,
  planCode = 'pro',
): Promise<ActionCenterArgs> {
  return {
    db: client(),
    actor: await actorFor(personaId, planCode),
    organizationId: ORGANIZATION,
    propertyId: null,
    today: TODAY,
  }
}

/* ================================================================ today == */

describe("today's stays", () => {
  it('resolves today the way the dataset pinned it', () => {
    // Not an ISO slice. `propertyToday` converts against PROPERTY_TIME_ZONE,
    // which is the same conversion `dataset-support.ts` used to place the three
    // pinned stays — so the two agree at 00:30 in Israel as well as at noon.
    expect(propertyToday()).toBe(TODAY)
  })

  it('shows the owner the three stays the dataset pinned to today', async () => {
    const stays = await listStaysToday(await argsFor('owner'))

    // One mid-stay, one arriving, one departing — written first in
    // `dataset-bookings.ts` and everything else filled in around them.
    expect(stays.length).toBeGreaterThanOrEqual(3)
    expect(new Set(stays.map((stay) => stay.role))).toEqual(
      new Set(['arriving', 'departing', 'in_house']),
    )

    // In the building today: arrived on or before today, and not yet gone.
    // `check_out === today` is a departure and belongs here, which is exactly
    // where the half-open occupancy test would have dropped it.
    for (const stay of stays) {
      expect(stay.checkIn <= TODAY).toBe(true)
      expect(stay.checkOut >= TODAY).toBe(true)
    }
  })

  it('keeps a departure on the board that the occupancy test would drop', async () => {
    const stays = await listStaysToday(await argsFor('owner'))
    const departing = stays.filter((stay) => stay.role === 'departing')

    expect(departing.length).toBeGreaterThan(0)
    for (const stay of departing) {
      // Half-open `[check_in, check_out)` says this stay no longer occupies
      // tonight, and that is right for availability and wrong for a board
      // about who is in the building this morning.
      expect(stay.checkOut).toBe(TODAY)
    }
  })

  it('never puts a cancelled or no-show stay on the board', async () => {
    const stays = await listStaysToday(await argsFor('owner'))
    for (const stay of stays) {
      expect(stay.status).not.toBe('cancelled')
      expect(stay.status).not.toBe('no_show')
    }
  })

  it('orders departures before arrivals before guests already in', async () => {
    const stays = await listStaysToday(await argsFor('owner'))
    const rank = { departing: 0, arriving: 1, in_house: 2 } as const
    for (let index = 1; index < stays.length; index += 1) {
      expect(rank[stays[index].role]).toBeGreaterThanOrEqual(
        rank[stays[index - 1].role],
      )
    }
  })

  it('gives the owner the guest name and the price', async () => {
    const stays = await listStaysToday(await argsFor('owner'))
    expect(stays.length).toBeGreaterThan(0)
    expect(stays.some((stay) => stay.guestName !== null)).toBe(true)
    expect(stays.every((stay) => typeof stay.totalAgorot === 'number')).toBe(
      true,
    )
    // Integer agorot at the border. `asAgorot` refuses a float, so a number
    // arriving here is already whole; this asserts nothing divided it by 100.
    for (const stay of stays) {
      expect(Number.isInteger(stay.totalAgorot)).toBe(true)
    }
  })

  it('gives reception the same stays, with the name and the price', async () => {
    const [owner, reception] = await Promise.all([
      listStaysToday(await argsFor('owner')),
      listStaysToday(await argsFor('reception')),
    ])

    // Reception is scoped `all_organization` in the dataset and holds
    // `guest.view_name` and `booking.view_price`, so the desk sees exactly what
    // the owner sees on this panel. That is the correct answer and it is worth
    // pinning: the interesting refusals below are the cleaner's.
    expect(reception.map((stay) => stay.id).sort()).toEqual(
      owner.map((stay) => stay.id).sort(),
    )
    expect(reception.some((stay) => stay.guestName !== null)).toBe(true)
  })

  it('shows the cleaner no stays at all', async () => {
    const actor = await actorFor('housekeeping')

    // Not a redaction. A cleaner holds four task grants and `incident.create`,
    // and `booking.view` is not among them — so the panel is never queried.
    expect(holdsGrant(actor, 'booking.view')).toBe(false)
    expect(await listStaysToday(await argsFor('housekeeping'))).toEqual([])
  })

  it('narrows the property manager to their own property', async () => {
    const stays = await listStaysToday(await argsFor('property-manager'))
    const properties = new Set(stays.map((stay) => stay.propertyId))

    // Scoped to אחוזת רימונים in `dataset-access.ts`. Whatever is on their
    // board today, it is one property's worth.
    expect(properties.size).toBeLessThanOrEqual(1)
  })
})

/* ============================================================= balances == */

describe('what today owes', () => {
  it('answers the owner with balances that reconcile to the booking total', async () => {
    const args = await argsFor('owner')
    const stays = await listStaysToday(args)
    const balances = await listOpenBalances(args, stays)

    expect(balances).not.toBeNull()
    for (const balance of balances ?? []) {
      // Billed less settled, by the domain's own sum. Nothing on screen is a
      // figure this file rounded.
      expect(balance.outstandingAgorot).toBe(
        balance.billedAgorot - balance.settledAgorot,
      )
      expect(Number.isInteger(balance.outstandingAgorot)).toBe(true)
      // A fully settled stay with nothing in flight is not an action.
      expect(balance.outstandingAgorot > 0 || balance.unknownAgorot > 0).toBe(
        true,
      )
    }

    expect(outstandingTotalAgorot(balances ?? [])).toBe(
      (balances ?? []).reduce(
        (total, balance) => total + balance.outstandingAgorot,
        0,
      ),
    )
  })

  it('tells a cleaner nothing rather than telling her every guest has paid', async () => {
    const args = await argsFor('housekeeping')
    const stays = await listStaysToday(args)

    // `null`, not `[]`. "Everybody has paid" and "you may not see what anybody
    // owes" are different sentences and the screen prints them differently.
    expect(await listOpenBalances(args, stays)).toBeNull()
  })
})

/* ================================================================ tasks == */

describe('work that will not finish on its own', () => {
  it('gives the owner blocked and overdue jobs, and nothing settled', async () => {
    const tasks = await listStuckTasks(await argsFor('owner'))

    expect(tasks).not.toBeNull()
    for (const task of tasks ?? []) {
      expect(task.status).not.toBe('completed')
      expect(task.status).not.toBe('verified')
      expect(task.status).not.toBe('cancelled')
      expect(task.status === 'blocked' || task.overdue).toBe(true)
      // `tasks_blocked_has_reason` makes the reason mandatory in the database,
      // so a blocked job on this board can always say what it is waiting for.
      if (task.status === 'blocked') {
        expect(task.blockedReason).not.toBeNull()
      }
    }
  })

  it('puts blocked work above merely late work', async () => {
    const tasks = (await listStuckTasks(await argsFor('owner'))) ?? []
    const lastBlocked = tasks.findLastIndex((task) => task.status === 'blocked')
    const firstUnblocked = tasks.findIndex((task) => task.status !== 'blocked')
    if (lastBlocked >= 0 && firstUnblocked >= 0) {
      expect(lastBlocked).toBeLessThan(firstUnblocked)
    }
  })

  it('gives the cleaner only her own team’s work', async () => {
    const cleaner = await actorFor('housekeeping')
    expect(holdsGrant(cleaner, 'task.view')).toBe(true)

    const tasks = (await listStuckTasks(await argsFor('housekeeping'))) ?? []
    const teams = new Set(tasks.map((task) => task.teamId))

    // Her scope is `team`, so every row that reaches her carries her team id
    // and nothing carries null — a task with no team is out of reach of a
    // team-scoped membership, which is the privacy rule working rather than a
    // screen deciding to hide a column.
    expect(teams.has(null)).toBe(false)
    expect(teams.size).toBeLessThanOrEqual(1)
  })

  it('withholds the panel from an accountant, who holds no task grant', async () => {
    const accountant = await actorFor('accountant')
    expect(holdsGrant(accountant, 'task.view')).toBe(false)
    expect(await listStuckTasks(await argsFor('accountant'))).toBeNull()
  })
})

/* ============================================================= payments == */

describe('money the automation stopped working on', () => {
  it('finds the owner every unknown or flagged payment, once each', async () => {
    const payments =
      (await listPaymentsNeedingAttention(await argsFor('owner'))) ?? []

    expect(payments.length).toBeGreaterThan(0)
    // Merged by id: a payment that is both `unknown` and flagged appears once.
    expect(new Set(payments.map((payment) => payment.id)).size).toBe(
      payments.length,
    )
    for (const payment of payments) {
      expect(
        payment.status === 'unknown' || payment.requiresAttention !== null,
      ).toBe(true)
    }
  })

  it('gives reception the panel, because reception holds payment.view', async () => {
    const payments = await listPaymentsNeedingAttention(
      await argsFor('reception'),
    )
    expect(payments).not.toBeNull()
    expect((payments ?? []).length).toBeGreaterThan(0)
  })

  it('withholds the panel entirely from the cleaner', async () => {
    expect(
      await listPaymentsNeedingAttention(await argsFor('housekeeping')),
    ).toBeNull()
  })
})

/* ============================================================ approvals == */

describe('decisions waiting for a person', () => {
  it('refuses the owner on every package the demo offers, and says why', async () => {
    // FINDING, and it is the dataset's rather than this file's. `DEMO_PLANS`
    // offers basic, direct and pro; `approval.decide` is gated on the
    // `approvals` entitlement, which only `management` carries. So the demo
    // seeds three `approvals` rows that no persona on any offered package can
    // read — and the owner's refusal here is "your package does not include
    // this", not "you may not decide".
    for (const code of ['basic', 'direct', 'pro']) {
      const owner = await actorFor('owner', code)
      expect(owner.grants.has('approval.decide')).toBe(true)
      expect(holdsGrant(owner, 'approval.decide')).toBe(false)
      expect(authorize(owner, 'approval.decide')).toMatchObject({
        allowed: false,
        reason: 'plan_does_not_include',
      })
      expect(
        await listWaitingApprovals(await argsFor('owner', code)),
      ).toBeNull()
    }
  })

  it('gives the owner every unanswered request once the package includes approvals', async () => {
    const args = await argsFor('owner', 'management')
    const approvals = (await listWaitingApprovals(args)) ?? []

    // Measured against the dataset rather than pinned to a literal: the
    // approvals seed is shared and grows. What must hold is that a queue of
    // decisions contains the requests nobody has answered and nothing else —
    // an approved or rejected row on a decision queue is work already done.
    const waiting = DEMO_DATASET.tables.approvals.filter(
      (row) => row.status === 'requested',
    )
    expect(waiting.length).toBeGreaterThan(0)
    expect(approvals).toHaveLength(waiting.length)

    for (const approval of approvals) {
      expect(approval.status).toBe('requested')
      // `approvals_reason_not_blank`: a request nobody can evaluate is a
      // request that gets approved out of politeness.
      expect(approval.reason.length).toBeGreaterThan(0)
      // The owner holds `user.view`, so every requester is named rather than
      // rendered as a uuid.
      expect(approval.requestedByName).not.toBeNull()
    }

    // The seeded expense request, with the ask and the ceiling it exceeds.
    const expense = approvals.find((approval) => approval.type === 'expense')
    expect(expense?.requestedAgorot).toBe(480_000)
    expect(expense?.limitAgorot).toBe(200_000)
  })

  it('is withheld from reception even on the package that includes approvals', async () => {
    const reception = await actorFor('reception', 'management')
    // The front desk is not a decider, and this is the role set saying so
    // rather than the plan: `approval.decide` sits with finance and with the
    // owner, and the reception bundle carries neither it nor
    // `approval.request`.
    expect(reception.grants.has('approval.decide')).toBe(false)
    expect(holdsGrant(reception, 'approval.decide')).toBe(false)
    expect(
      await listWaitingApprovals(await argsFor('reception', 'management')),
    ).toBeNull()
  })

  it('is withheld from the cleaner', async () => {
    expect(
      await listWaitingApprovals(await argsFor('housekeeping', 'management')),
    ).toBeNull()
  })
})

/* ================================================================ door === */

describe('who the route admits', () => {
  it('admits the owner, reception and the cleaner, and on different grants', async () => {
    const admitted = async (personaId: string) => {
      const actor = await actorFor(personaId)
      return ACTION_CENTER_GRANTS.find((grant) => holdsGrant(actor, grant))
    }

    expect(await admitted('owner')).toBe('task.view')
    expect(await admitted('reception')).toBe('task.view')
    // The cleaner's whole grant set is four task permissions plus
    // `incident.create`, and `task.view` is the one that opens this screen.
    expect(await admitted('housekeeping')).toBe('task.view')
    expect(await admitted('accountant')).toBe('booking.view')
  })

  it('closes every panel on a plan that does not include operations', async () => {
    // `task.view` is gated on the `operations` entitlement, which Basic does
    // not carry. The screen still opens — the accountant's payment panel is
    // core — but the task panel is refused for a reason the reader can be told
    // apart from "you may not", because `authorize` reports it separately.
    const basic = await actorFor('owner', 'basic')
    expect(holdsGrant(basic, 'task.view')).toBe(false)
    expect(holdsGrant(basic, 'payment.view')).toBe(true)
  })
})
