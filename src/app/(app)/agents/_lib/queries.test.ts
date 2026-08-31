/**
 * The agent reads, walked the way the product walks them.
 *
 * The same method `finance/_lib/queries.test.ts` established and for the same
 * reason: a unit test over a pure function cannot tell you that a column name is
 * wrong, that an embed is not declared, or that a redaction hands over the very
 * field it was meant to withhold. Running the real query over
 * `createDemoClient(DEMO_DATASET)` can — the same 1 agency, 1 agency
 * membership, 1 agreement, 1 commission rule, 1 agent settings row and 7
 * commissions a person sees in demo mode.
 *
 * ── What this is and is not ───────────────────────────────────────────────
 *
 * It is not a test of row level security. `createDemoClient` says so in its own
 * header and it bears repeating: there is no policy engine behind these arrays,
 * so a query that forgot its tenant filter would return rows here and nothing in
 * production. What is exercised is the floor above it — the `can()` narrowing
 * and the `redact()` field rules the queries apply themselves.
 *
 * ── The claim that matters ────────────────────────────────────────────────
 *
 * The external agent sees **4 of the 7 commissions, by scope rather than by a
 * filter**. Nothing in `agentProduction` or `agentCommissions` mentions the
 * agent, the demo, or a property id: the narrowing is `can(actor,
 * 'commission.view', { propertyId, family: 'finance' })`, the agent's membership
 * scope is one property, and four of the seven agent bookings happen to be
 * there. Delete the `can()` call and this file fails; delete a filter that does
 * not exist and nothing happens.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { authorize, holdsGrant, type Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import {
  agentAuditTrail,
  agentBookings,
  agentCommissions,
  agentProduction,
  agentResource,
  countAgents,
  listAgents,
  propertyNames,
} from './queries'

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
 * The actor a persona resolves to, through the ordinary path.
 *
 * Lifted from `dataset-actor.test.ts` deliberately rather than shared: these are
 * the same modules a paying customer's request runs through, and the point of
 * every file that does this is that nothing demo-specific is substituted for
 * them.
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

async function argsFor(personaId: string, planCode = 'pro') {
  return {
    db: client(),
    actor: await actorFor(personaId, planCode),
    organizationId: ORGANIZATION,
    status: null,
  }
}

/** How many rows the dataset holds, so the assertions cannot drift from it. */
function seeded(table: string): number {
  return DEMO_DATASET.tables[table]?.length ?? 0
}

/** The one agent the dataset carries, by the id the settings row names. */
function seededAgentUserId(): string {
  const row = DEMO_DATASET.tables['agent_organization_settings']?.[0]
  if (!row) throw new Error('The demo dataset seeds no agent settings row')
  return String(row.agent_user_id)
}

/* ================================================================ list == */

describe('the agents list', () => {
  it('serves the owner the seeded relationship, ladders and all', async () => {
    const agents = await listAgents(await argsFor('owner'))

    expect(agents).toHaveLength(seeded('agent_organization_settings'))
    expect(agents).toHaveLength(1)

    const [agent] = agents

    // Every field the screen prints, present and of the right kind. A renamed
    // column would surface here rather than as a blank cell in production.
    expect(agent.agentUserId).toBe(seededAgentUserId())
    expect(typeof agent.membershipId).toBe('string')
    expect(typeof agent.displayName).toBe('string')
    expect(agent.phoneE164).toMatch(/^\+972/)
    expect(agent.joinedOn).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(Number.isInteger(agent.version)).toBe(true)

    // The status comes off the *membership* embed, not off the terms row —
    // 0019 put it there and kept it there, and a copy would be a second answer
    // to "is this agent suspended".
    expect(agent.status).toBe('active')
  })

  it('rebuilds the access ladders through the union, coherently', async () => {
    const [agent] = await listAgents(await argsFor('owner'))

    // The demo's own row: sees availability and may book on it, sees the agent
    // rate and not the net rate, sees a guest's name and phone and never their
    // email. That combination is a row, not a special case in a screen.
    expect(agent.access.calendar).toBe('availability_booking')
    expect(agent.access.price).toBe('agent')
    expect(agent.access.guestData).toBe('phone')

    // The booking-rung rights exist only at the booking rung, and the union is
    // what makes that true rather than a convention.
    if (agent.access.calendar === 'availability_booking') {
      expect(agent.access.amendments).toEqual(['guest_details', 'guest_count'])
      expect(agent.access.cancellation).toEqual({ kind: 'until_paid' })
      expect(agent.access.paymentLink).toBe(true)
    } else {
      throw new Error('The seeded agent is expected at the booking rung')
    }
  })

  it('reads the inventory reach without widening it', async () => {
    const [agent] = await listAgents(await argsFor('owner'))

    expect(agent.inventory.kind).toBe('properties')
    if (agent.inventory.kind === 'properties') {
      expect(agent.inventory.propertyIds).toHaveLength(1)
    }
    expect(agent.inventoryPropertyIds).toHaveLength(1)

    // And the reach resolves to a real property name rather than to a uuid.
    const names = await propertyNames(
      client(),
      ORGANIZATION,
      agent.inventoryPropertyIds,
    )
    expect(names.size).toBe(1)
    expect(typeof [...names.values()][0]).toBe('string')
  })

  it('reads the two guardrails as stored, including a `numeric` cap', async () => {
    const [agent] = await listAgents(await argsFor('owner'))

    // `discount_max_percent` is `numeric` and arrives as the string "8.000".
    // Read with `Number()` at a call site this becomes a cap nobody notices is
    // wrong; read through `asNumber` it is 8.
    expect(agent.discountCap.maxPercent).toBe(8)
    expect(agent.discountCap.maxAgorot).toBe(30_000)

    expect(agent.holdLimits.maxConcurrent).toBe(3)
    expect(agent.holdLimits.maxPerDay).toBe(10)
    expect(agent.holdLimits.defaultMinutes).toBe(30)
    expect(agent.holdLimits.maxMinutes).toBe(120)
    expect(agent.reputationScore).toBe(72)
  })

  it('names the agency behind the seller', async () => {
    const [agent] = await listAgents(await argsFor('owner'))

    expect(agent.agencyId).not.toBeNull()
    expect(typeof agent.agencyName).toBe('string')
  })

  it('serves the general manager the same relationship as the owner', async () => {
    const owner = await actorFor('owner')
    const manager = await actorFor('general-manager')

    // The premise, stated rather than assumed. Both reach the screen, and in
    // the shipped role set a general manager also *manages* the network — so
    // the private note is legitimately theirs and this assertion is about the
    // record surviving intact, not about a redaction.
    expect(holdsGrant(owner, 'agent.view')).toBe(true)
    expect(holdsGrant(manager, 'agent.view')).toBe(true)
    expect(holdsGrant(manager, 'agent.manage')).toBe(true)

    const [seenByOwner] = await listAgents(await argsFor('owner'))
    const [seenByManager] = await listAgents(await argsFor('general-manager'))

    expect(seenByManager.agentUserId).toBe(seenByOwner.agentUserId)
    expect(seenByManager.access).toEqual(seenByOwner.access)
    expect(seenByManager.status).toBe('active')
    expect(typeof seenByManager.internalNote).toBe('string')
  })

  it('withholds the owner’s private note from a reader without `agent.manage`', async () => {
    const manager = await actorFor('general-manager')

    // NOBODY IN THE SHIPPED ROLE SET HOLDS `agent.view` WITHOUT
    // `agent.manage`, so this redaction withholds nothing today — the same
    // situation `PAYMENT_REDACTIONS` documents in the finance module. It is
    // written because the catalogue lets a business compose a role that says
    // "may see the network, may not run it", and the honest render of that is a
    // missing note rather than an owner's private assessment of a competitor's
    // seller handed to an agency manager.
    //
    // Proving it needs an actor the personas do not supply, so one is derived
    // from a real resolved actor by removing exactly one grant. Nothing else
    // about them changes, which is what makes the assertion about the grant.
    const withoutManage: Actor = {
      ...manager,
      grants: new Set(
        [...manager.grants].filter((grant) => grant !== 'agent.manage'),
      ),
    }

    expect(holdsGrant(withoutManage, 'agent.view')).toBe(true)
    expect(holdsGrant(withoutManage, 'agent.manage')).toBe(false)

    const [agent] = await listAgents({
      db: client(),
      actor: withoutManage,
      organizationId: ORGANIZATION,
      status: null,
    })

    // The key is *gone*, not null and not an empty string — which is what
    // distinguishes "no note was written" from "this reader may not see it".
    expect('internalNote' in agent).toBe(false)
    // And withholding a note must not withhold the relationship.
    expect(agent.access.calendar).toBe('availability_booking')
    expect(agent.status).toBe('active')
    expect(agent.reputationScore).toBe(72)
  })

  it('shows the external agent nothing: they do not run the network they are in', async () => {
    const actor = await actorFor('sales-agent')

    // Worth stating explicitly, because the route name invites the opposite
    // assumption. `AGENT_BASE` grants a seller their leads and their own pay
    // and does **not** grant `agent.view` — the agents screen is where a
    // business manages its sellers, not where a seller reads their own terms.
    // So `/agents` is refused to them at the route and returns nothing here.
    expect(holdsGrant(actor, 'agent.view')).toBe(false)
    expect(await listAgents(await argsFor('sales-agent'))).toEqual([])
  })

  it('shows a cleaner nothing at all', async () => {
    const actor = await actorFor('housekeeping')

    // `requireDistributionGrant('agent.view')` redirects this person before a
    // query is built. This asserts the second floor: even handed the query, the
    // per-row `can()` narrowing admits none of it.
    expect(holdsGrant(actor, 'agent.view')).toBe(false)
    expect(await listAgents(await argsFor('housekeeping'))).toEqual([])
  })

  it('filters by membership status, and the filter is the contract’s tuple', async () => {
    const base = await argsFor('owner')

    const active = await listAgents({ ...base, status: 'active' })
    const suspended = await listAgents({ ...base, status: 'suspended' })

    expect(active).toHaveLength(1)
    expect(active.every((agent) => agent.status === 'active')).toBe(true)

    // `suspended` is a real status in the product and the filter must be able
    // to ask for it even when the dataset seeds none — a screen that could not
    // select it would hide exactly the rows an owner is hunting for.
    expect(suspended).toEqual([])
  })

  it('counts every relationship for the empty-state decision', async () => {
    expect(await countAgents(client(), ORGANIZATION)).toBe(
      seeded('agent_organization_settings'),
    )
  })
})

/* ========================================================== production == */

describe('what an agent has produced', () => {
  it('counts the owner’s view of the whole network', async () => {
    const actor = await actorFor('owner')
    const production = await agentProduction(
      client(),
      actor,
      ORGANIZATION,
      seededAgentUserId(),
    )

    expect(production.commissionCount).toBe(seeded('commissions'))
    expect(production.commissionCount).toBe(7)
    expect(production.bookingCount).toBeGreaterThan(0)
    expect(Number.isInteger(production.owedAgorot)).toBe(true)
    expect(production.owedAgorot).toBeGreaterThan(0)

    // Unpaid is a strict subset: the dataset carries paid and cancelled rows,
    // and both are excluded from what is still owed.
    expect(production.unpaidAgorot).toBeLessThan(production.owedAgorot!)
  })

  it('CONFINES THE EXTERNAL AGENT TO 4 OF THE 7 COMMISSIONS, BY SCOPE', async () => {
    const owner = await actorFor('owner')
    const agent = await actorFor('sales-agent')

    // The premise: the agent holds the grant and their scope is one property.
    expect(holdsGrant(agent, 'commission.view')).toBe(true)
    expect(agent.scope.kind).toBe('properties')
    if (agent.scope.kind === 'properties') {
      expect(agent.scope.propertyIds).toHaveLength(1)
    }

    const everything = await agentCommissions(
      client(),
      owner,
      ORGANIZATION,
      seededAgentUserId(),
    )
    const theirs = await agentCommissions(
      client(),
      agent,
      ORGANIZATION,
      seededAgentUserId(),
    )

    expect(everything).not.toBeNull()
    expect(theirs).not.toBeNull()
    expect(everything).toHaveLength(7)
    expect(theirs).toHaveLength(4)

    // By scope, not by a filter: every row they see is in the one property
    // their membership reaches, and the three they do not see are elsewhere.
    const reachable = new Set(theirs!.map((line) => line.propertyId))
    expect(reachable.size).toBe(1)
    expect(everything!.length - theirs!.length).toBe(3)
  })

  it('agrees with itself: the tile and the list count the same rows', async () => {
    const actor = await actorFor('sales-agent')

    const production = await agentProduction(
      client(),
      actor,
      ORGANIZATION,
      seededAgentUserId(),
    )
    const lines = await agentCommissions(
      client(),
      actor,
      ORGANIZATION,
      seededAgentUserId(),
    )

    // Two functions, one narrowing. A figure above a list that disagrees with
    // the list is the specific failure this assertion exists to catch.
    expect(production.commissionCount).toBe(lines?.length)
    expect(production.owedAgorot).toBe(
      lines!.reduce((sum, line) => sum + line.amountAgorot, 0),
    )
  })

  /**
   * ── The defect this test was written to catch, and a second one it found ──
   *
   * Everything above resolves the agent through `DemoActorSource`, which is
   * what the running demo does. Under it the agent's scope comes out as
   * `properties`, and the "4 of 7" narrowing above is therefore *by property*.
   *
   * A paying customer's request does not go through that wrapper. It resolves
   * through `SupabaseActorSource` alone, `loadScopeNarrowing` returns the
   * agent's stored reach, and the actor comes out as
   * `own_records` + an `inventory` override — which is the design `types.ts`
   * describes at length and the *only* shape that stops one agent reading
   * another's commissions inside a shared property.
   *
   * `scopeReaches` answers `own_records` by comparing `assignedToUserId` and
   * `createdByUserId` on the resource against the actor. A finance resource
   * carrying only an organization, a property and a family therefore reaches
   * **nothing** for such an actor — not somebody else's rows, which is right,
   * and not their own either, which is the entire screen. That is why
   * `ownedResource` puts the payee on the resource, and this test is the proof:
   * before that change it returned zero rows.
   */
  it('serves a production-shaped agent their own commissions, not zero', async () => {
    const persona = DEMO_PERSONAS.find((entry) => entry.id === 'sales-agent')!

    // No demo wrapper. This is the resolution a paying customer's request runs.
    const resolution = await resolveActor(
      new SupabaseActorSource(client()),
      persona.userId,
      ORGANIZATION,
    )
    if (!resolution.ok) throw new Error(resolution.reason)
    const actor = resolution.actor

    // The shape the design calls for, confirmed rather than assumed.
    expect(actor.scope.kind).toBe('own_records')
    expect(actor.scopeOverrides?.inventory?.kind).toBe('properties')

    const lines = await agentCommissions(
      client(),
      actor,
      ORGANIZATION,
      seededAgentUserId(),
    )

    expect(lines).not.toBeNull()
    expect(lines!.length).toBeGreaterThan(0)
    for (const line of lines!) {
      expect(Number.isInteger(line.amountAgorot)).toBe(true)
    }

    const production = await agentProduction(
      client(),
      actor,
      ORGANIZATION,
      seededAgentUserId(),
    )
    expect(production.commissionCount).toBe(lines!.length)
  })

  it('refuses a production-shaped agent another seller’s commissions', async () => {
    const persona = DEMO_PERSONAS.find((entry) => entry.id === 'sales-agent')!
    const resolution = await resolveActor(
      new SupabaseActorSource(client()),
      persona.userId,
      ORGANIZATION,
    )
    if (!resolution.ok) throw new Error(resolution.reason)

    // The other half of `own_records`, and the half that matters. Asking about
    // a *different* agent's commissions inside the very property this seller
    // reaches must still come back empty — which is the failure `types.ts`
    // warns about: "give an agent `properties` and they read every other
    // agent's bookings and commissions inside those properties".
    const someoneElse = DEMO_PERSONAS.find(
      (entry) => entry.id === 'reception',
    )!.userId

    expect(
      await agentCommissions(
        client(),
        resolution.actor,
        ORGANIZATION,
        someoneElse,
      ),
    ).toEqual([])
  })

  it('withholds the money rather than reporting zero', async () => {
    const actor = await actorFor('housekeeping')
    expect(holdsGrant(actor, 'commission.view')).toBe(false)

    const production = await agentProduction(
      client(),
      actor,
      ORGANIZATION,
      seededAgentUserId(),
    )

    // `null`, never 0. "This agent is owed ₪0" and "you may not see what this
    // agent is owed" are opposite statements about money.
    expect(production.owedAgorot).toBeNull()
    expect(production.unpaidAgorot).toBeNull()
    expect(
      await agentCommissions(
        client(),
        actor,
        ORGANIZATION,
        seededAgentUserId(),
      ),
    ).toBeNull()
  })
})

/* ============================================================ bookings == */

describe('the bookings an agent brought', () => {
  it('lists them for the owner, with the price', async () => {
    const actor = await actorFor('owner')
    const bookings = await agentBookings(
      client(),
      actor,
      ORGANIZATION,
      seededAgentUserId(),
    )

    expect(bookings).not.toBeNull()
    expect(bookings!.length).toBeGreaterThan(0)
    for (const booking of bookings!) {
      expect(booking.reference).toMatch(/^\S+$/)
      expect(booking.checkIn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isInteger(booking.totalAgorot)).toBe(true)
    }
  })

  it('withholds the price from a reader who may not see prices', async () => {
    const actor = await actorFor('sales-agent')

    // The agent rate is what they see; the stay's own total is not theirs.
    expect(holdsGrant(actor, 'booking.view')).toBe(true)
    expect(holdsGrant(actor, 'booking.view_price')).toBe(false)

    const bookings = await agentBookings(
      client(),
      actor,
      ORGANIZATION,
      seededAgentUserId(),
    )

    expect(bookings).not.toBeNull()
    for (const booking of bookings!) {
      // The key is absent, not zero — `Money` renders an absent amount as
      // "לא זמין לצפייה" and a zero as ₪0, and only one of those is true.
      expect('totalAgorot' in booking).toBe(false)
    }
  })

  it('returns null rather than an empty list without `booking.view`', async () => {
    const actor = await actorFor('housekeeping')
    expect(holdsGrant(actor, 'booking.view')).toBe(false)
    expect(
      await agentBookings(client(), actor, ORGANIZATION, seededAgentUserId()),
    ).toBeNull()
  })
})

/* =============================================================== audit == */

describe('the agent audit trail', () => {
  it('is empty on the demo dataset, and that is the honest answer', async () => {
    const actor = await actorFor('owner')
    const trail = await agentAuditTrail(
      client(),
      actor,
      ORGANIZATION,
      seededAgentUserId(),
    )

    // `audit_events` is present and empty in the dataset by design:
    // `dataset.ts` says an audit trail nobody performed is the one kind of
    // fiction this product must never ship. The screen renders "nothing has
    // happened yet" rather than a timeline of invented events.
    expect(trail).toEqual([])
    expect(seeded('audit_events')).toBe(0)
  })

  it('is null — not empty — for a reader with neither audit grant', async () => {
    const actor = await actorFor('housekeeping')
    expect(holdsGrant(actor, 'agent.audit.view')).toBe(false)
    expect(holdsGrant(actor, 'audit.view')).toBe(false)
    expect(
      await agentAuditTrail(client(), actor, ORGANIZATION, seededAgentUserId()),
    ).toBeNull()
  })
})

/* ============================================================ the lock == */

describe('the plan lock', () => {
  it('refuses an owner on Basic for the plan, never for the permission', async () => {
    const basicOwner = await actorFor('owner', 'basic')
    const proOwner = await actorFor('owner', 'pro')

    // The same person, the same role, the same grant — and two different
    // refusals. This is the distinction the section's gate exists to carry onto
    // the screen: `plan_does_not_include` reads as an upgrade, and a dashboard
    // banner saying "you lack a permission" would be false.
    const denied = authorize(basicOwner, 'agent.view')
    expect(denied.allowed).toBe(false)
    if (!denied.allowed) {
      expect(denied.reason).toBe('plan_does_not_include')
      expect(denied.entitlement).toBe('agent_network')
    }

    expect(authorize(proOwner, 'agent.view').allowed).toBe(true)
  })

  it('locks the whole agent surface on Basic, and only that surface', async () => {
    const basicOwner = await actorFor('owner', 'basic')

    for (const grant of [
      'agent.view',
      'agency.manage',
      'commission.view',
    ] as const) {
      const decision = authorize(basicOwner, grant)
      expect(decision.allowed).toBe(false)
      if (!decision.allowed)
        expect(decision.reason).toBe('plan_does_not_include')
    }

    // `quote.view` is deliberately *not* gated: `plans/entitlements.ts` is
    // explicit that a single-cabin owner on the cheapest package sending a
    // quote is the core product, and charging for it would gate the core
    // behind an add-on. The quotes screen is therefore the one in this section
    // a Basic organization reaches.
    expect(authorize(basicOwner, 'quote.view').allowed).toBe(true)
    expect(authorize(basicOwner, 'quote.create').allowed).toBe(true)
  })

  it('locks channels and pricing on their own entitlements, not on agent_network', async () => {
    const directOwner = await actorFor('owner', 'direct')

    const channels = authorize(directOwner, 'channel.manage')
    expect(channels.allowed).toBe(false)
    if (!channels.allowed) expect(channels.entitlement).toBe('channels')

    const pricing = authorize(directOwner, 'pricing.manage')
    expect(pricing.allowed).toBe(false)
    if (!pricing.allowed) expect(pricing.entitlement).toBe('dynamic_pricing')

    // And Direct *does* carry the agent network — it is included from Direct
    // upward and sold to Basic as an add-on.
    expect(authorize(directOwner, 'agent.view').allowed).toBe(true)
  })
})

/* ========================================================== the resource == */

describe('the authorization resource', () => {
  it('is the shape the domain’s own writes use', () => {
    // `settingsResource` in `agents/operations.ts` is private, so this asserts
    // the shape rather than the identity: family `team` and the agent named as
    // the assignee. Getting either wrong makes a read and a write disagree
    // about whose record this is.
    expect(agentResource(ORGANIZATION, 'user-1')).toEqual({
      organizationId: ORGANIZATION,
      assignedToUserId: 'user-1',
      family: 'team',
    })
  })
})
