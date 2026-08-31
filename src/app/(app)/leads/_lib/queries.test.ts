/**
 * The pipeline reads, walked over the demo dataset.
 *
 * The assertion this file exists for is the first one: that the four statuses
 * the screen calls "the pipeline" really are the ones before a sale is
 * committed, and that nothing won, lost or already occupied leaks into them. A
 * pipeline that quietly includes a confirmed booking is a forecast that is
 * wrong in the business's favour, which is the direction nobody checks.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { BOOKING_STATUSES } from '@/lib/booking/types'
import { localDate } from '@/lib/booking/dates'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import { BOOKING_SOURCE_LABEL, HOLD_REASON_LABEL } from './labels'
import {
  PIPELINE_ORDER,
  PIPELINE_STATUSES,
  attachHolds,
  byStage,
  listLeads,
  listLiveHolds,
  type LeadArgs,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId
const TODAY = localDate(new Date())

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

async function actorFor(personaId: string, planCode = 'pro'): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const plan = DEMO_PLANS.find((entry) => entry.code === planCode)
  if (!plan) throw new Error(`No demo plan '${planCode}'`)

  const resolution = await resolveActor(
    new DemoActorSource(new SupabaseActorSource(client()), plan),
    persona.userId,
    ORGANIZATION,
  )
  if (!resolution.ok) {
    throw new Error(
      `${persona.label} does not resolve to an actor: ${resolution.reason}`,
    )
  }
  return resolution.actor
}

async function argsFor(personaId: string): Promise<LeadArgs> {
  return {
    db: client(),
    actor: await actorFor(personaId),
    organizationId: ORGANIZATION,
    propertyId: null,
    today: TODAY,
  }
}

/* =========================================================== the stages == */

describe('what counts as the pipeline', () => {
  it('is the four statuses before money or a signature settles it', () => {
    // The cut is where the guest has paid something. `deposit_paid` is the
    // first such status in the enum, so it and everything after it are won.
    const first = BOOKING_STATUSES.indexOf('deposit_paid')
    for (const status of PIPELINE_STATUSES) {
      expect(BOOKING_STATUSES.indexOf(status)).toBeLessThan(first)
    }
    expect(PIPELINE_STATUSES).not.toContain('cancelled')
    expect(PIPELINE_STATUSES).not.toContain('no_show')
  })

  it('draws the board in the enum’s own order, not in one chosen here', () => {
    // 0009: "the order is load-bearing: it is the order the workflow runs in".
    expect([...PIPELINE_ORDER]).toEqual(
      BOOKING_STATUSES.filter((status) => PIPELINE_STATUSES.includes(status)),
    )
  })

  it('names every source and every hold reason in Hebrew', () => {
    // Total records over the frozen tuples, so a source added to the contract
    // fails the build rather than rendering `vrbo` at a Hebrew screen.
    for (const label of Object.values(BOOKING_SOURCE_LABEL)) {
      expect(label.length).toBeGreaterThan(0)
    }
    for (const label of Object.values(HOLD_REASON_LABEL)) {
      expect(label.length).toBeGreaterThan(0)
    }
  })
})

/* ============================================================== the list == */

describe('the open pipeline', () => {
  it('gives the owner only uncommitted stays', async () => {
    const leads = (await listLeads(await argsFor('owner'))) ?? []

    expect(leads.length).toBeGreaterThan(0)
    for (const lead of leads) {
      expect(PIPELINE_STATUSES).toContain(lead.status)
    }
  })

  it('leaves out every stay that is already won or lost', async () => {
    const leads = (await listLeads(await argsFor('owner'))) ?? []
    const ids = new Set(leads.map((lead) => lead.id))

    const settled = DEMO_DATASET.tables.bookings.filter(
      (row) =>
        !PIPELINE_STATUSES.includes(
          row.status as (typeof PIPELINE_STATUSES)[number],
        ),
    )
    expect(settled.length).toBeGreaterThan(0)
    for (const row of settled) {
      expect(ids.has(row.id as string)).toBe(false)
    }
  })

  it('is ordered oldest first, because the old one needs the phone call', async () => {
    const leads = (await listLeads(await argsFor('owner'))) ?? []
    for (let index = 1; index < leads.length; index += 1) {
      expect(leads[index].ageDays).toBeLessThanOrEqual(leads[index - 1].ageDays)
    }
  })

  it('carries the attribution the schema guarantees', async () => {
    const leads = (await listLeads(await argsFor('owner'))) ?? []

    for (const lead of leads) {
      // `bookings_agent_attributed`: a stay whose source is an agent must name
      // one, and anything else must not pretend to have had one.
      if (lead.source === 'agent') {
        expect(lead.agentUserId).not.toBeNull()
      }
      expect(BOOKING_SOURCE_LABEL[lead.source].length).toBeGreaterThan(0)
    }
  })

  it('gives the owner the guest name, the request and the price', async () => {
    const leads = (await listLeads(await argsFor('owner'))) ?? []
    expect(leads.some((lead) => lead.guestName !== null)).toBe(true)
    expect(leads.every((lead) => typeof lead.totalAgorot === 'number')).toBe(
      true,
    )
    expect(leads.every((lead) => 'guestNotes' in lead)).toBe(true)
  })

  it('gives reception the same pipeline', async () => {
    const [owner, reception] = await Promise.all([
      listLeads(await argsFor('owner')),
      listLeads(await argsFor('reception')),
    ])

    expect((reception ?? []).map((lead) => lead.id).sort()).toEqual(
      (owner ?? []).map((lead) => lead.id).sort(),
    )
    // Reception holds `lead.view` through the selling floor and `user.view`
    // through nothing, so a lead names who sold it by id and not by name.
    expect((reception ?? []).every((lead) => lead.agentName === null)).toBe(
      true,
    )
  })

  it('withholds the whole list from the cleaner, who holds neither grant', async () => {
    const cleaner = await actorFor('housekeeping')
    expect(holdsGrant(cleaner, 'lead.view')).toBe(false)
    expect(holdsGrant(cleaner, 'booking.view')).toBe(false)

    // `null`, not `[]`: the route would already have refused her, and the
    // query says "withheld" rather than "no leads" if it is ever reached.
    expect(await listLeads(await argsFor('housekeeping'))).toBeNull()
  })

  it('narrows the external agent to their own records', async () => {
    const agent = await actorFor('sales-agent')
    expect(holdsGrant(agent, 'lead.view')).toBe(true)

    const leads = (await listLeads(await argsFor('sales-agent'))) ?? []
    const owner = (await listLeads(await argsFor('owner'))) ?? []

    // An external seller's booking-family scope is not the whole organization,
    // so their pipeline is a strict subset of the owner's.
    expect(leads.length).toBeLessThan(owner.length)
    const ownerIds = new Set(owner.map((lead) => lead.id))
    for (const lead of leads) expect(ownerIds.has(lead.id)).toBe(true)
  })
})

/* ================================================================ holds == */

describe('inventory held while a sale closes', () => {
  it('lists the live holds and excludes released and converted ones', async () => {
    const holds = (await listLiveHolds(await argsFor('owner'))) ?? []

    expect(holds.length).toBeGreaterThan(0)
    for (const hold of holds) {
      expect(hold.convertedToBookingId).toBeNull()
      expect(HOLD_REASON_LABEL[hold.reason].length).toBeGreaterThan(0)
    }
  })

  it('keeps a lapsed hold on screen rather than hiding it', async () => {
    const holds = (await listLiveHolds(await argsFor('owner'))) ?? []

    // 0009: an expired hold does not block the exclusion constraint, so the
    // dates are already back on sale while whoever placed it still believes
    // they have them. Dropping such a row would hide the one case that costs a
    // sale — so it is kept and flagged.
    for (const hold of holds) {
      expect(hold.lapsed).toBe(hold.expiresOn < TODAY)
    }
  })

  it('names the unit without an embed the demo client cannot resolve', async () => {
    const holds = (await listLiveHolds(await argsFor('owner'))) ?? []
    // `holds.units` is not declared in `DEMO_RELATIONS`, so an embed would
    // throw `UnsupportedQuery`. The separate read must still produce a name.
    expect(holds.some((hold) => hold.unitName !== null)).toBe(true)
  })

  it('is withheld from a reader without hold.view', async () => {
    const accountant = await actorFor('accountant')
    expect(holdsGrant(accountant, 'hold.view')).toBe(false)
    expect(await listLiveHolds(await argsFor('accountant'))).toBeNull()
  })
})

/* ================================================================ merge == */

describe('holds attached to the leads they protect', () => {
  it('marks a lead whose unit and dates a live hold overlaps', async () => {
    const args = await argsFor('owner')
    const leads = (await listLeads(args)) ?? []
    const holds = (await listLiveHolds(args)) ?? []
    const attached = attachHolds(leads, holds)

    for (const lead of attached) {
      const expected = holds.find(
        (hold) =>
          !hold.lapsed &&
          hold.unitId === lead.unitId &&
          hold.checkIn < lead.checkOut &&
          hold.checkOut > lead.checkIn,
      )
      expect(lead.heldUntil).toBe(expected ? expected.expiresOn : null)
    }
  })

  it('never attaches a lapsed hold, because it protects nothing', async () => {
    const args = await argsFor('owner')
    const leads = (await listLeads(args)) ?? []
    const lapsed = ((await listLiveHolds(args)) ?? []).map((hold) => ({
      ...hold,
      lapsed: true,
    }))

    expect(
      attachHolds(leads, lapsed).every((lead) => lead.heldUntil === null),
    ).toBe(true)
  })

  it('leaves the leads untouched when holds are withheld', async () => {
    const leads = (await listLeads(await argsFor('owner'))) ?? []
    expect(attachHolds(leads, null)).toBe(leads)
  })
})

/* ============================================================== staging == */

describe('grouping by stage', () => {
  it('places every lead in exactly one stage, in workflow order', async () => {
    const leads = (await listLeads(await argsFor('owner'))) ?? []
    const stages = byStage(leads)

    expect(stages.map((stage) => stage.status)).toEqual([...PIPELINE_ORDER])
    expect(stages.reduce((total, stage) => total + stage.leads.length, 0)).toBe(
      leads.length,
    )
  })
})
