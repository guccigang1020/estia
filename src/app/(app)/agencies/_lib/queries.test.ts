/**
 * The agencies read, walked over the demo dataset.
 *
 * One agency, one agency membership, one agreement — and the question this
 * screen exists to answer correctly: **a commission may be owed to a company
 * rather than to a person**, because `commissions.agent_user_id` is nullable
 * and `commissions_has_a_payee` requires an agent *or* an agency.
 *
 * The seeded dataset gives every commission both a person and an agency, so the
 * agency-only case is not reachable through `DEMO_DATASET` as it stands. That
 * is a real gap in the fixture and is stated rather than skipped: the test
 * below builds a one-row variant with `agent_user_id` nulled and drives the same
 * query over it, which is the only way to prove that grouping by the agency
 * finds money grouping by the person would drop.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { DemoDataset } from '@/lib/demo/types'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import { countAgreements, listAgencies } from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

/** A date inside the seeded agreement's window. It began 120 days ago. */
const TODAY = new Date().toISOString().slice(0, 10)

function client(dataset: DemoDataset = DEMO_DATASET): Db {
  return createDemoClient(dataset) as unknown as Db
}

async function actorFor(personaId: string, planCode = 'pro'): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const source = new DemoActorSource(
    new SupabaseActorSource(client()),
    DEMO_PLANS.find((plan) => plan.code === planCode)!,
  )

  const resolution = await resolveActor(source, persona.userId, ORGANIZATION)
  if (!resolution.ok) throw new Error(resolution.reason)
  return resolution.actor
}

function seeded(table: string): number {
  return DEMO_DATASET.tables[table]?.length ?? 0
}

/* ============================================================== the list == */

describe('the agencies list', () => {
  it('serves the owner the agency, its agreement and its people', async () => {
    const agencies = await listAgencies({
      db: client(),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      on: TODAY,
    })

    expect(agencies).toHaveLength(seeded('agencies'))
    expect(agencies).toHaveLength(1)

    const [agency] = agencies
    expect(typeof agency.name).toBe('string')
    expect(agency.taxId).toBe('514772290')
    expect(agency.contactPhoneE164).toMatch(/^\+972/)
    expect(agency.status).toBe('active')

    expect(agency.agreements).toHaveLength(seeded('agency_agreements'))
    expect(agency.members).not.toBeNull()
    expect(agency.members).toHaveLength(seeded('agency_memberships'))
    expect(agency.members![0].role).toBe('agent')
    expect(typeof agency.members![0].displayName).toBe('string')
  })

  it('reads the agreement’s terms through the domain’s own union', async () => {
    const [agency] = await listAgencies({
      db: client(),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      on: TODAY,
    })
    const [agreement] = agency.agreements

    // Rebuilt, not cast. The adapter casts the same JSON with
    // `as unknown as CommissionRule`, which is a claim the data has not earned
    // — and on a screen the fallthrough renders as a blank commission beside a
    // live agreement.
    expect(agreement.rule).not.toBeNull()
    expect(agreement.rule!.kind).toBe('percentage')
    if (agreement.rule!.kind === 'percentage') {
      expect(agreement.rule!.percent).toBe(10)
    }
    expect(agreement.base).toBe('accommodation_only')
    expect(agreement.paymentTermsDays).toBe(30)
    expect(agreement.status).toBe('active')
    expect(agreement.activeUntil).toBeNull()
  })

  it('decides liveness against the date, not against the status column', async () => {
    const args = {
      db: client(),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
    }

    const today = await listAgencies({ ...args, on: TODAY })
    expect(today[0].agreements[0].live).toBe(true)

    // The same row, the same `status = 'active'`, a date before it began. An
    // agreement is live because the calendar says so — a background job that
    // stops running must not be able to keep granting reach it was supposed to
    // remove, and the mirror of that is that it must not grant reach early.
    const beforeItBegan = await listAgencies({
      ...args,
      db: client(),
      on: '2000-01-01',
    })
    expect(beforeItBegan[0].agreements[0].status).toBe('active')
    expect(beforeItBegan[0].agreements[0].live).toBe(false)
  })

  it('totals what is owed to the agency across its commissions', async () => {
    const [agency] = await listAgencies({
      db: client(),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      on: TODAY,
    })

    // Every seeded commission names this agency, so the owner's view is all of
    // them.
    expect(agency.commissionCount).toBe(seeded('commissions'))
    expect(agency.owedAgorot).toBeGreaterThan(0)
    expect(Number.isInteger(agency.owedAgorot)).toBe(true)
    // Unpaid is a strict subset: paid and cancelled rows are excluded.
    expect(agency.unpaidAgorot).toBeLessThan(agency.owedAgorot!)
  })

  it('shows a cleaner nothing at all', async () => {
    const actor = await actorFor('housekeeping')

    // `requireDistributionGrant('agency.manage')` refuses this person at the
    // route. This asserts the floor underneath: even handed the query, `can()`
    // admits nothing.
    expect(holdsGrant(actor, 'agency.manage')).toBe(false)
    expect(
      await listAgencies({
        db: client(),
        actor,
        organizationId: ORGANIZATION,
        on: TODAY,
      }),
    ).toEqual([])
  })

  it('counts the agreements for the empty-state decision', async () => {
    expect(await countAgreements(client(), ORGANIZATION)).toBe(
      seeded('agency_agreements'),
    )
  })
})

/* ================================================== the agency as payee == */

describe('a commission owed to a company rather than to a person', () => {
  /**
   * The dataset gives every commission both a person and an agency, so this
   * builds the case it does not carry: one commission with `agent_user_id`
   * nulled, exactly as `commissions_has_a_payee` permits.
   *
   * Constructed here rather than seeded, because `dataset-finance.ts` belongs
   * to another module and a fixture change is not this screen's to make. The
   * gap itself is worth reporting: the demo cannot currently demonstrate the
   * agency-payee path on any screen.
   */
  function withAgencyOnlyCommission(): DemoDataset {
    const commissions = DEMO_DATASET.tables['commissions'] ?? []
    expect(commissions.length).toBeGreaterThan(0)

    return {
      ...DEMO_DATASET,
      tables: {
        ...DEMO_DATASET.tables,
        commissions: commissions.map((row, index) =>
          index === 0 ? { ...row, agent_user_id: null } : { ...row },
        ),
      },
    }
  }

  it('finds it, because the read is by agency and not by person', async () => {
    const dataset = withAgencyOnlyCommission()

    const [agency] = await listAgencies({
      db: client(dataset),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      on: TODAY,
    })

    // The row with no person on it is still counted and still totalled. A read
    // grouped by `agent_user_id` would have dropped it silently, which on an
    // agencies screen is the one row the screen exists for.
    expect(agency.commissionCount).toBe(
      DEMO_DATASET.tables['commissions']!.length,
    )
    expect(agency.owedAgorot).toBeGreaterThan(0)
  })

  it('is a case the seeded dataset cannot reach on its own', () => {
    // Stated as an assertion rather than left as a comment, so the day somebody
    // seeds an agency-only commission this line tells them the gap is closed
    // and the constructed fixture above can go.
    const commissions = DEMO_DATASET.tables['commissions'] ?? []
    expect(commissions.every((row) => row.agent_user_id !== null)).toBe(true)
  })
})
