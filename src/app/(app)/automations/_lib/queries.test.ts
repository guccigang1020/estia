/**
 * The dry run, walked the way the product walks it.
 *
 * `finance/_lib/queries.test.ts` made the argument this file follows: a unit
 * test over a pure function cannot tell you that a column name is wrong, that
 * an embed is not declared, or that a redaction hands over the very figure it
 * was meant to withhold. So this runs the *whole* pipeline the screen runs —
 * `loadDryRunInputs` → `candidateEvents` → `simulate` → `ruleViews` — over
 * `createDemoClient(DEMO_DATASET)`, once per persona, and asserts what each one
 * comes back with.
 *
 * It has already earned its keep. `OPEN_TASK` in `dry-run.ts` was an allow-list
 * containing `pending`, which is not a member of `TASK_STATUSES` at all, and
 * omitting `new`, `accepted`, `blocked` and `awaiting_approval`, which are. The
 * whole `task.overdue` trigger therefore produced zero candidates for every
 * reader on every dataset and rendered as "your business has no late work". No
 * unit test over `candidateEvents` with a hand-written row would have caught
 * it, because the hand-written row would have said `pending` too.
 *
 * ── Why the persona axis is the interesting one ───────────────────────────
 *
 * The simulation reads three tables behind three different grants. An owner
 * reads all three; a housekeeper reads tasks and neither bookings nor payments;
 * a property manager reads a subset of the stays. Those are not three sizes of
 * one answer — they are three different sets of rules that can be previewed at
 * all, and a dry run that quietly showed everybody the owner's numbers would be
 * a privacy leak dressed as a feature.
 *
 * ── Why the plan axis is the other one ────────────────────────────────────
 *
 * `automation` sits only in the Management package, which `DEMO_PLANS`
 * deliberately does not offer. So every persona the demo can seat is on a
 * package without the module, the engine refuses every action on the plan, and
 * that is asserted as the shipped reality. The entitled half is proved
 * separately by building Management from `SEED_PLANS`, exactly as the finance
 * suite builds it to prove the owners screen's entitled half.
 *
 * ── Dates are relative, because the dataset's are ─────────────────────────
 *
 * `dataset-support.ts` resolves `TODAY` from the real clock when the module
 * loads and every row is an offset from it. A literal instant here would pass
 * today and fail on a date this file never mentions, so `day()` is imported and
 * the two instants below are expressed the way the rows themselves are.
 *
 * ── What this is not ──────────────────────────────────────────────────────
 *
 * It is not a test of row level security. `createDemoClient` has no policy
 * engine behind its arrays, so a query that forgot its tenant filter would
 * return rows here and nothing in production. What is exercised is the floor
 * above it — the grant gate, the `can()` narrowing and the `redact()` field
 * rules the queries apply themselves.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { day } from '@/lib/demo/dataset-support'
import { DemoActorSource } from '@/lib/demo/session'
import type { DemoPlan } from '@/lib/demo/types'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import { SupabaseFinanceRepository } from '@/lib/persistence/finance'
import { SEED_PLANS } from '@/lib/plans/catalog'

import { candidateEvents, simulate } from './dry-run'
import { loadDryRunInputs, type DryRunInputs } from './queries'
import { headline, ruleViews, shippedRules, type RuleView } from './rules'

const ORGANIZATION = DEMO_DATASET.organizationId

/** The dataset's own "now", to the hour. */
const NOW = new Date(`${day(0)}T09:00:00.000Z`)

/**
 * Far enough forward that the open work is late.
 *
 * The demo's open tasks are due between today and twelve days out, so a preview
 * taken today finds none overdue — which is a true statement about a
 * well-run business and a useless one for testing the trigger. Nineteen days
 * puts every one of them behind.
 */
const LATER = new Date(`${day(19)}T09:00:00.000Z`)

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

function planNamed(code: string): DemoPlan {
  const found = DEMO_PLANS.find((plan) => plan.code === code)
  if (!found) throw new Error(`No demo plan '${code}'`)
  return found
}

/**
 * A package the demo switcher does not offer.
 *
 * `management` is the only package in `SEED_PLANS` carrying `automation`, and
 * `DEMO_PLANS` omits it on purpose. Built from the catalogue rather than by
 * retyping its entitlements, so this file cannot prove the feature against a
 * plan the product does not sell.
 */
function catalogPlan(code: string): DemoPlan {
  const seed = SEED_PLANS.find((plan) => plan.code === code)
  if (!seed) throw new Error(`No seed plan '${code}'`)
  return { code: seed.code, label: seed.name, entitlements: seed.entitlements }
}

/** The actor a persona resolves to, through the ordinary path. */
async function actorFor(personaId: string, plan: DemoPlan): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const source = new DemoActorSource(new SupabaseActorSource(client()), plan)
  const resolution = await resolveActor(source, persona.userId, ORGANIZATION)
  if (!resolution.ok) {
    throw new Error(
      `${persona.label} does not resolve to an actor: ${resolution.reason}`,
    )
  }
  return resolution.actor
}

interface Walked {
  actor: Actor
  inputs: DryRunInputs
  views: readonly RuleView[]
  totals: ReturnType<typeof headline>
}

/** Everything `/automations` does, for one persona on one package. */
async function walk(
  personaId: string,
  plan: DemoPlan = planNamed('pro'),
  now: Date = NOW,
): Promise<Walked> {
  const db = client()
  const actor = await actorFor(personaId, plan)
  const inputs = await loadDryRunInputs({
    db,
    repo: new SupabaseFinanceRepository(db),
    actor,
    propertyId: null,
  })
  const candidates = candidateEvents(ORGANIZATION, inputs.rows, now)
  const dryRun = await simulate(actor, shippedRules(), candidates)
  const views = ruleViews(actor, dryRun, candidates)

  return { actor, inputs, views, totals: headline(views, dryRun) }
}

const MANAGEMENT = catalogPlan('management')

function viewOf(views: readonly RuleView[], id: string): RuleView {
  const found = views.find((view) => view.rule.id === id)
  if (!found) throw new Error(`No rule '${id}' in the simulation`)
  return found
}

/* ------------------------------------------------------- what each reads -- */

describe('the rows the dry run may read, per persona', () => {
  it('gives the owner all three tables', async () => {
    const { inputs, totals } = await walk('owner', MANAGEMENT)

    expect(inputs.bookings.access).toBe('readable')
    expect(inputs.tasks.access).toBe('readable')
    expect(inputs.payments.access).toBe('readable')
    expect(inputs.bookings.count).toBeGreaterThan(0)
    expect(inputs.tasks.count).toBeGreaterThan(0)
    expect(inputs.payments.count).toBeGreaterThan(0)
    expect(totals.candidates).toBeGreaterThan(0)
  })

  it('gives the accountant the money and withholds the operation', async () => {
    const { inputs } = await walk('accountant', MANAGEMENT)

    expect(inputs.payments.access).toBe('readable')
    expect(inputs.payments.count).toBeGreaterThan(0)
    // No `task.view`: the finance role does not run the housekeeping board, so
    // the operations rules cannot be previewed by them at all. Reported as
    // unreadable rather than as zero — see `DryRunPanel`.
    expect(inputs.tasks.access).not.toBe('readable')
    expect(inputs.tasks.count).toBe(0)
  })

  it('gives housekeeping the tasks and neither the money nor the stays', async () => {
    const { inputs, totals } = await walk('housekeeping', MANAGEMENT)

    expect(inputs.tasks.access).toBe('readable')
    expect(inputs.tasks.count).toBeGreaterThan(0)
    expect(inputs.bookings.access).not.toBe('readable')
    expect(inputs.payments.access).not.toBe('readable')
    // Today nothing is late, so a cleaner's preview is honestly empty. The
    // trigger is exercised at `LATER` below.
    expect(totals.candidates).toBe(0)
  })

  it('withholds payments from a general manager, who may run the business and not the till', async () => {
    const { inputs } = await walk('general-manager', MANAGEMENT)

    expect(inputs.bookings.access).toBe('readable')
    expect(inputs.tasks.access).toBe('readable')
    expect(inputs.payments.access).not.toBe('readable')
  })

  it('narrows a property-scoped membership to the stays it reaches', async () => {
    const [manager, agent, owner] = await Promise.all([
      walk('property-manager', MANAGEMENT),
      walk('sales-agent', MANAGEMENT),
      walk('owner', MANAGEMENT),
    ])

    // The `can()` floor in `loadBookings` is what produces this. The demo
    // client has no policy engine, so without it a property-scoped membership
    // would preview the whole organization's stays.
    expect(manager.inputs.bookings.count).toBeGreaterThan(0)
    expect(manager.inputs.bookings.count).toBeLessThan(
      owner.inputs.bookings.count,
    )
    expect(manager.totals.candidates).toBeLessThan(owner.totals.candidates)

    // The external seller is scoped to the same property and reaches the same
    // stays, and neither the tasks nor the money behind them.
    expect(agent.inputs.bookings.count).toBe(manager.inputs.bookings.count)
    expect(agent.inputs.tasks.access).not.toBe('readable')
    expect(agent.inputs.payments.access).not.toBe('readable')
  })
})

/* ------------------------------------------------- the packages the demo has */

describe('every package the demo offers, without the automation module', () => {
  it('refuses every triggered rule on the plan and runs none', async () => {
    const { totals, views } = await walk('owner', planNamed('pro'))

    expect(totals.candidates).toBeGreaterThan(0)
    // The engine's module gate is asked after the trigger match, so a rule that
    // fired is counted as matched and refused rather than skipped — which is
    // what makes the refusal a number the upgrade argument can be made from.
    expect(totals.refused).toBeGreaterThan(0)
    expect(totals.wouldRun).toBe(0)
    expect(totals.actingRules).toBe(0)

    for (const view of views) {
      expect(view.readiness.status).toBe('module_locked')
    }
  })

  it('says the same on basic, and says it as a package rather than a permission', async () => {
    const { views } = await walk('owner', planNamed('basic'))

    const confirmed = viewOf(views, 'confirmed-notify-and-prepare')
    expect(confirmed.readiness.status).toBe('module_locked')
    expect(confirmed.blockers.some((entry) => entry.kind === 'plan')).toBe(true)
    // The distinction the whole section exists to protect: an owner holds every
    // grant, so nothing here may read as a missing permission.
    expect(
      confirmed.blockers.some((entry) => entry.kind === 'permission'),
    ).toBe(false)
  })

  it('calls an unreadable table a package limit when that is what it is', async () => {
    const { inputs } = await walk('owner', planNamed('basic'))

    // `task.view` is mapped to the `operations` entitlement, which Basic does
    // not carry. The owner holds the grant. Reporting this as a missing
    // permission would send the person who owns the business to ask themselves
    // for a right they already hold.
    expect(inputs.tasks.access).toBe('missing_feature')
    expect(inputs.bookings.access).toBe('readable')
    expect(inputs.payments.access).toBe('readable')
  })

  it('calls it a missing permission when the role is the thing that is short', async () => {
    const { inputs } = await walk('accountant', MANAGEMENT)

    // Management carries `operations`; the accountant's role does not carry
    // `task.view`. The opposite conversation, and the opposite sentence.
    expect(inputs.tasks.access).toBe('missing_permission')
  })

  it('counts the same refusal on pro as the module would have run', async () => {
    const [locked, entitled] = await Promise.all([
      walk('owner', planNamed('pro')),
      walk('owner', MANAGEMENT),
    ])

    // The figure the plan lock puts on screen. It is the entitled run's
    // `wouldRun`, refused — not an estimate, and not a different number.
    expect(locked.totals.refused).toBe(entitled.totals.wouldRun)
  })
})

/* --------------------------------------------- the package that includes it */

describe('the Management package, which is the one that carries the module', () => {
  it('runs the booking and payment rules over real demo rows', async () => {
    const { totals, views } = await walk('owner', MANAGEMENT)

    expect(totals.wouldRun).toBeGreaterThan(0)
    expect(totals.actingRules).toBeGreaterThan(0)

    const confirmed = viewOf(views, 'confirmed-notify-and-prepare')
    expect(confirmed.readiness.status).toBe('ready')
    expect(confirmed.simulation.matched).toBeGreaterThan(0)
    expect(confirmed.simulation.wouldRun).toBe(confirmed.simulation.matched)
    // The examples are the reason anybody believes the number, and they are
    // booking references rather than ids.
    expect(confirmed.simulation.examples.length).toBeGreaterThan(0)
    for (const example of confirmed.simulation.examples) {
      expect(example).toContain('אושרה')
    }
  })

  it('finds the late work once it is late, across every open status', async () => {
    const { views } = await walk('owner', MANAGEMENT, LATER)
    const overdue = viewOf(views, 'task-overdue-alert')

    expect(overdue.readiness.status).toBe('ready')
    // More than the two statuses the original allow-list would have admitted.
    // This is the assertion that fails if `OPEN_TASK` is narrowed again.
    expect(overdue.simulation.matched).toBeGreaterThan(10)
    expect(overdue.simulation.wouldRun).toBe(overdue.simulation.matched)
  })

  it('leaves a rule the library ships off at zero, because a disabled rule never reaches its conditions', async () => {
    const { views } = await walk('owner', MANAGEMENT)
    const review = viewOf(views, 'review-request-after-stay')

    expect(review.rule.enabled).toBe(false)
    expect(review.simulation.matched).toBe(0)
    // The stays it would have looked at do exist, so the zero is the library's
    // decision reaching the screen rather than an absence of data.
    const completed = viewOf(views, 'checkout-inspection')
    expect(completed.simulation.matched).toBeGreaterThan(0)
  })

  it('reports a trigger the preview cannot reconstruct as unmeasurable, not as zero', async () => {
    const { views } = await walk('owner', MANAGEMENT)
    const doorCode = viewOf(views, 'door-code-after-signoff')

    expect(doorCode.triggerSimulated).toBe(false)
    expect(doorCode.blockers.some((entry) => entry.kind === 'trigger')).toBe(
      true,
    )
    expect(doorCode.simulation.matched).toBe(0)
  })

  it('tells an accountant which half of a rule their role would refuse', async () => {
    const { views, totals } = await walk('accountant', MANAGEMENT)
    const confirmed = viewOf(views, 'confirmed-notify-and-prepare')

    // Holds `payment.view` and `invoice.issue`, holds neither `message.send`
    // nor `task.create`. Every action of every triggered rule is refused on the
    // permission — which must never be worded as a package problem.
    expect(confirmed.simulation.matched).toBeGreaterThan(0)
    expect(confirmed.simulation.wouldRun).toBe(0)
    expect(totals.refused).toBeGreaterThan(0)
    expect(
      confirmed.blockers.some((entry) => entry.kind === 'permission'),
    ).toBe(true)
    expect(confirmed.blockers.some((entry) => entry.kind === 'plan')).toBe(
      false,
    )
  })
})
