/**
 * The promotions read, walked over the demo dataset.
 *
 * The screen's premise is that there is no promotions catalogue: `promotion` is
 * a member of `PRICE_LINE_KINDS` and no table stores a campaign. So this file
 * proves the three things that *do* exist come back correctly — the commission
 * rules, the discount ceilings, and the reductions actually written onto
 * bookings — and pins the one distinction that is easy to invert.
 *
 * ── The distinction ───────────────────────────────────────────────────────
 *
 * `agent_commission_rules.property_ids` is nullable and 0015 is explicit that
 * `NULL` and `'{}'` are opposites: no list means **every** property, an emptied
 * list means **none**. `asStringArray` collapses both to `[]`. Getting it
 * backwards pays commission on the whole portfolio, which is the kind of bug
 * that is discovered by an accountant rather than by a test — unless there is a
 * test.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { PRICE_LINE_KINDS } from '@/lib/booking/types'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { DemoDataset } from '@/lib/demo/types'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import {
  GIVEAWAY_KINDS,
  NON_GIVEAWAY_KINDS,
  giveawayTotalAgorot,
  groupGiveaways,
  listDiscountCeilings,
  listGiveaways,
  listRateRules,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

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

/* ============================================================== the rules == */

describe('the commission rules', () => {
  it('serves the owner the seeded rule, with its scope and its conditions', async () => {
    const rules = await listRateRules({
      db: client(),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
    })

    expect(rules).toHaveLength(seeded('agent_commission_rules'))
    expect(rules).toHaveLength(1)

    const [rule] = rules
    expect(rule.name).toBe('סלים חדאד — רימונים')
    expect(rule.ruleKind).toBe('percentage')
    expect(rule.rulePercent).toBe(10)
    expect(rule.base).toBe('accommodation_only')
    expect(rule.priority).toBe(10)

    // The commission becomes payable when the guest has actually stayed — not
    // when the booking was made and not when the deposit landed.
    expect(rule.eligibility).toEqual(['stay_completed'])

    // The scope is one property, and it resolves to a name rather than to a
    // uuid.
    expect(rule.appliesEverywhere).toBe(false)
    expect(rule.propertyIds).toHaveLength(1)
    expect(rule.propertyNames).toHaveLength(1)
    expect(typeof rule.propertyNames[0]).toBe('string')

    // The payee is named on both sides: a person and the agency behind them.
    expect(typeof rule.agentName).toBe('string')
    expect(typeof rule.agencyName).toBe('string')
  })

  it('reads a rule with NO property list as applying EVERYWHERE', async () => {
    // The inversion this test exists for. Built rather than seeded, because the
    // dataset's rule names a property and the opposite case is the dangerous
    // one: a rule with a `NULL` list pays on the whole portfolio, and an
    // implementation that read it as `[]` would silently pay on nothing — or,
    // written the other way round, pay on everything when it should pay on
    // nothing.
    const rules = DEMO_DATASET.tables['agent_commission_rules'] ?? []
    const dataset: DemoDataset = {
      ...DEMO_DATASET,
      tables: {
        ...DEMO_DATASET.tables,
        agent_commission_rules: rules.map((row) => ({
          ...row,
          property_ids: null,
        })),
      },
    }

    const [rule] = await listRateRules({
      db: client(dataset),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
    })

    expect(rule.propertyIds).toBeNull()
    expect(rule.appliesEverywhere).toBe(true)
  })

  it('reads an EMPTIED property list as applying to NOTHING', async () => {
    const rules = DEMO_DATASET.tables['agent_commission_rules'] ?? []
    const dataset: DemoDataset = {
      ...DEMO_DATASET,
      tables: {
        ...DEMO_DATASET.tables,
        agent_commission_rules: rules.map((row) => ({
          ...row,
          property_ids: [],
        })),
      },
    }

    const [rule] = await listRateRules({
      db: client(dataset),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
    })

    // The opposite answer from the test above, from a value `asStringArray`
    // would have rendered identically.
    expect(rule.propertyIds).toEqual([])
    expect(rule.appliesEverywhere).toBe(false)
  })

  it('shows nothing to a reader without `commission.view`', async () => {
    const actor = await actorFor('reception')
    expect(holdsGrant(actor, 'commission.view')).toBe(false)
    expect(
      await listRateRules({
        db: client(),
        actor,
        organizationId: ORGANIZATION,
      }),
    ).toEqual([])
  })
})

/* =========================================================== the ceiling == */

describe('the discount ceilings', () => {
  it('reads the `numeric` cap as a number, not as a string', async () => {
    const ceilings = await listDiscountCeilings({
      db: client(),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
    })

    expect(ceilings).toHaveLength(seeded('agent_organization_settings'))

    const [ceiling] = ceilings
    // `discount_max_percent` arrives as "8.000" from a `numeric` column. Read
    // with `Number()` at a call site this becomes a cap nobody notices is
    // wrong; read through `asNumber` it is 8 and stays 8.
    expect(ceiling.maxPercent).toBe(8)
    expect(typeof ceiling.maxPercent).toBe('number')
    expect(ceiling.maxAgorot).toBe(30_000)
    expect(typeof ceiling.agentName).toBe('string')
  })

  it('shows nothing to a reader without `agent.view`', async () => {
    const actor = await actorFor('accountant')
    expect(holdsGrant(actor, 'agent.view')).toBe(false)
    expect(
      await listDiscountCeilings({
        db: client(),
        actor,
        organizationId: ORGANIZATION,
      }),
    ).toEqual([])
  })
})

/* ========================================================= what was given == */

describe('the reductions actually given', () => {
  it('finds the discount lines on real bookings', async () => {
    const lines = await listGiveaways({
      db: client(),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    expect(lines).not.toBeNull()
    expect(lines!.length).toBeGreaterThan(0)

    for (const line of lines!) {
      expect(GIVEAWAY_KINDS).toContain(line.kind)
      // A reduction is negative money — the table's own sign convention, so
      // that a booking's total is always a plain sum of its lines.
      expect(line.amountAgorot).toBeLessThan(0)
      expect(Number.isInteger(line.amountAgorot)).toBe(true)
      expect(line.label.length).toBeGreaterThan(0)
    }
  })

  it('totals them as a negative number, not as an absolute value', async () => {
    const lines = await listGiveaways({
      db: client(),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    const total = giveawayTotalAgorot(lines)
    expect(total).toBeLessThan(0)
    // Dressing a giveaway up as a positive figure makes it read as revenue on a
    // screen full of money.
    expect(total).toBe(lines!.reduce((sum, line) => sum + line.amountAgorot, 0))
  })

  it('groups by the label, which is the only identifier a reduction has', async () => {
    const lines = await listGiveaways({
      db: client(),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    const groups = groupGiveaways(lines!)
    expect(groups.length).toBeGreaterThan(0)

    // Every line lands in exactly one group, and the counts add up — the group
    // list is the closest honest answer to "which promotions are running", and
    // it must not lose or double a row.
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(
      lines!.length,
    )
    expect(groups.reduce((sum, group) => sum + group.totalAgorot, 0)).toBe(
      giveawayTotalAgorot(lines),
    )
  })

  it('withholds the reductions from a reader who may not see prices', async () => {
    const actor = await actorFor('sales-agent')
    expect(holdsGrant(actor, 'booking.view_price')).toBe(false)

    // `null`, never an empty list. "No discount has been given" and "you may
    // not see what was given" are different sentences, and the screen renders
    // them differently.
    expect(
      await listGiveaways({
        db: client(),
        actor,
        organizationId: ORGANIZATION,
        propertyId: null,
      }),
    ).toBeNull()
    expect(giveawayTotalAgorot(null)).toBeNull()
  })
})

/* ============================================================ the kinds == */

describe('the price-line vocabulary', () => {
  it('classifies every kind as a giveaway or not, with none left over', () => {
    // A kind added to `PRICE_LINE_KINDS` belongs to one list or the other. This
    // is what stops a new reduction kind being silently counted as a charge.
    expect([...GIVEAWAY_KINDS, ...NON_GIVEAWAY_KINDS].sort()).toEqual(
      [...PRICE_LINE_KINDS].sort(),
    )

    expect(NON_GIVEAWAY_KINDS).not.toContain('discount')
    expect(NON_GIVEAWAY_KINDS).not.toContain('promotion')
  })
})
