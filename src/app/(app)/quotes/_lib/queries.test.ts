/**
 * The quotes read, walked over the demo dataset.
 *
 * The screen's premise is that there is no `quotes` table and what a quote
 * leaves behind is a hold and, sometimes, a discount approval. This file drives
 * both reads over `createDemoClient(DEMO_DATASET)` — 3 holds, one of them
 * `agent_quote` placed by the external seller, one released, and 3 approvals of
 * which exactly one is a discount request raised by that seller above their cap.
 *
 * ── The one thing it is careful about ─────────────────────────────────────
 *
 * The outcome of an offer is derived from four columns and the clock, so every
 * assertion passes an explicit `now`. Comparing against `Date.now()` would make
 * this file race the dataset it reads: `HOLD_ROWS` computes a live hold's
 * expiry as "n minutes from module load", so a test that took 45 minutes to
 * reach the assertion would report a different outcome than one that took a
 * second.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import {
  countQuotes,
  listDiscountRequests,
  listQuotes,
  quoteOutcome,
  quoteTally,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

/** Now, resolved once for the file. See the header. */
const NOW = new Date()

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
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

async function argsFor(personaId: string) {
  return {
    db: client(),
    actor: await actorFor(personaId),
    organizationId: ORGANIZATION,
    propertyId: null,
    outcome: null,
    now: NOW,
  }
}

function seeded(table: string): number {
  return DEMO_DATASET.tables[table]?.length ?? 0
}

/* ============================================================== the list == */

describe('the offers list', () => {
  it('serves the owner every hold, resolved into a readable offer', async () => {
    const quotes = await listQuotes(await argsFor('owner'))

    expect(quotes).toHaveLength(seeded('holds'))
    expect(quotes.length).toBe(3)

    for (const quote of quotes) {
      // Every column the screen prints, present and of the right kind.
      expect(quote.checkIn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(quote.checkOut).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(quote.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      // A unit code rather than a uuid, and a person's name rather than one.
      expect(typeof quote.unitLabel).toBe('string')
      expect(typeof quote.issuedByName).toBe('string')
    }
  })

  it('knows which offer the external seller made, and calls it a quote', async () => {
    const quotes = await listQuotes(await argsFor('owner'))
    const agentQuotes = quotes.filter((quote) => quote.reason === 'agent_quote')

    // `agent_quote` is a member of `HOLD_REASONS` and is exactly what a quote's
    // hold is. Calling it `staff_manual` would make every report about agent
    // activity wrong.
    expect(agentQuotes).toHaveLength(1)
    const agent = DEMO_PERSONAS.find((entry) => entry.id === 'sales-agent')!
    expect(agentQuotes[0].issuedByUserId).toBe(agent.userId)
  })

  it('derives the outcome from what actually happened, in one place', async () => {
    const quotes = await listQuotes(await argsFor('owner'))
    const tally = quoteTally(quotes)

    // The dataset seeds two live holds and one released. Nothing was converted
    // into a booking, so `won` is genuinely zero — and the screen shows zero
    // rather than hiding the column.
    expect(tally.released).toBe(1)
    expect(tally.won).toBe(0)
    expect(tally.open + tally.expired).toBe(2)

    // The tally is over exactly the rows on screen, so it cannot disagree with
    // them.
    expect(tally.open + tally.won + tally.released + tally.expired).toBe(
      quotes.length,
    )

    const released = quotes.find((quote) => quote.outcome === 'released')
    expect(released?.releasedAt).not.toBeNull()
  })

  it('lets a conversion beat an expiry, because the first thing that happened wins', () => {
    const past = new Date(NOW.getTime() - 60_000).toISOString()

    // A hold that became a booking is `won` even though its expiry has since
    // passed. Order is the rule, and it is asserted rather than assumed.
    expect(
      quoteOutcome(
        {
          converted_to_booking_id: 'b1',
          released_at: past,
          expires_at: past,
        },
        NOW,
      ),
    ).toBe('won')

    // A released hold is `released` even though it also expired.
    expect(
      quoteOutcome(
        { converted_to_booking_id: null, released_at: past, expires_at: past },
        NOW,
      ),
    ).toBe('released')

    expect(
      quoteOutcome(
        { converted_to_booking_id: null, released_at: null, expires_at: past },
        NOW,
      ),
    ).toBe('expired')

    expect(
      quoteOutcome(
        {
          converted_to_booking_id: null,
          released_at: null,
          expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
        },
        NOW,
      ),
    ).toBe('open')
  })

  it('filters by outcome without writing the rule a second time', async () => {
    const base = await argsFor('owner')

    const released = await listQuotes({ ...base, outcome: 'released' })
    const won = await listQuotes({ ...base, outcome: 'won' })

    expect(released).toHaveLength(1)
    expect(released.every((quote) => quote.outcome === 'released')).toBe(true)

    // `won` is a real outcome and the filter must be able to ask for it even
    // where the dataset seeds none.
    expect(won).toEqual([])
  })

  it('narrows the external seller, by scope and not by a filter', async () => {
    const owner = await listQuotes(await argsFor('owner'))
    const agent = await listQuotes(await argsFor('sales-agent'))

    expect(holdsGrant(await actorFor('sales-agent'), 'hold.view')).toBe(true)

    // Fewer rows, and the narrowing is `can()` with `family: 'booking'` — there
    // is no agent-shaped filter anywhere in `listQuotes` to remove.
    expect(agent.length).toBeLessThan(owner.length)
    expect(agent.length).toBeGreaterThan(0)
  })

  /**
   * ── A defect this test found, and where it lives ──────────────────────────
   *
   * Under `DemoActorSource` the external seller resolves with
   * `scope: { kind: 'properties' }` and **no** `scopeOverrides`, so the
   * narrowing above is by property: they see the desk's offers in אחוזת
   * רימונים as well as their own.
   *
   * That is not what the design says and not what production does.
   * `DemoActorSource` implements `ActorSource` and forwards `loadMembership`,
   * `loadRoles`, `loadScope` and `loadPlan` — and not `loadScopeNarrowing`,
   * which is optional on the interface and therefore compiles fine while being
   * silently absent. `resolveActor` calls `source.loadScopeNarrowing?.(…)`,
   * gets `undefined`, and the agent keeps the raw membership scope.
   *
   * The consequence is exactly the failure `agents/types.ts` warns about: "give
   * an agent `properties` and they read every *other* agent's bookings and
   * commissions inside those properties". Nothing leaks in the seeded data
   * because there is one agent — but the demo is demonstrating a weaker model
   * than the product has, on the screens whose whole subject is that model.
   *
   * The two tests below pin both halves so the fix is verifiable: the wrapper
   * drops the narrowing, and the production path does not.
   */
  it('DEFECT: the demo wrapper drops the agent’s per-family scope narrowing', async () => {
    const seller = DEMO_PERSONAS.find((entry) => entry.id === 'sales-agent')!

    const wrapped = await actorFor('sales-agent')
    expect(wrapped.scope.kind).toBe('properties')
    expect(wrapped.scopeOverrides).toBeUndefined()

    // The one-line fix is a forwarding method on `DemoActorSource` in
    // `src/lib/demo/session.ts`. Until it lands, the seller sees offers they
    // did not place, and this asserts that rather than hiding it.
    const quotes = await listQuotes(await argsFor('sales-agent'))
    expect(quotes.some((quote) => quote.issuedByUserId !== seller.userId)).toBe(
      true,
    )
  })

  it('confines a production-shaped seller to the offers they placed', async () => {
    const seller = DEMO_PERSONAS.find((entry) => entry.id === 'sales-agent')!

    // No demo wrapper. This is the resolution a paying customer's request runs,
    // and `loadScopeNarrowing` gives the agent `own_records` plus an
    // `inventory` override.
    const resolution = await resolveActor(
      new SupabaseActorSource(client()),
      seller.userId,
      ORGANIZATION,
    )
    if (!resolution.ok) throw new Error(resolution.reason)
    expect(resolution.actor.scope.kind).toBe('own_records')

    const quotes = await listQuotes({
      db: client(),
      actor: resolution.actor,
      organizationId: ORGANIZATION,
      propertyId: null,
      outcome: null,
      now: NOW,
    })

    // Their own, and only their own. `createdByUserId: held_by_user_id` on the
    // resource is what makes `own_records` reach the row they placed — without
    // it this list would be empty, which is the same class of bug the
    // commissions read carried.
    expect(quotes.length).toBeGreaterThan(0)
    expect(
      quotes.every((quote) => quote.issuedByUserId === seller.userId),
    ).toBe(true)
  })

  it('shows a cleaner nothing at all', async () => {
    const actor = await actorFor('housekeeping')
    expect(holdsGrant(actor, 'hold.view')).toBe(false)
    expect(await listQuotes(await argsFor('housekeeping'))).toEqual([])
  })

  it('counts every hold for the empty-state decision', async () => {
    expect(await countQuotes(client(), ORGANIZATION, null)).toBe(
      seeded('holds'),
    )
  })
})

/* ========================================================= the discount == */

describe('the discount requests', () => {
  it('returns null — not an empty list — without either approval grant', async () => {
    const actor = await actorFor('owner')

    // A real finding about the demo, asserted rather than assumed:
    // `approval.request` and `approval.decide` are both gated on the
    // `approvals` entitlement, which only the `management` package carries and
    // which the demo does not offer. So *no* demo persona can read the
    // approvals table, and the screen must say "not visible to you" rather than
    // "nobody has asked for a discount" — the dataset seeds one, and reporting
    // none would be a lie the reader cannot detect.
    expect(holdsGrant(actor, 'approval.request')).toBe(false)
    expect(holdsGrant(actor, 'approval.decide')).toBe(false)

    expect(
      await listDiscountRequests({
        db: client(),
        actor,
        organizationId: ORGANIZATION,
        propertyId: null,
      }),
    ).toBeNull()
  })

  it('reads the request when the plan includes approvals', async () => {
    // The same owner, on a package that carries the entitlement. Built by
    // granting it on the resolved actor rather than by inventing a fourth demo
    // plan, so nothing about the person changes except the one feature.
    const owner = await actorFor('owner')
    const withApprovals: Actor = {
      ...owner,
      entitlements: new Set([...owner.entitlements, 'approvals' as const]),
    }

    expect(holdsGrant(withApprovals, 'approval.request')).toBe(true)

    const requests = await listDiscountRequests({
      db: client(),
      actor: withApprovals,
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    expect(requests).not.toBeNull()
    // One of the three seeded approvals is a discount; the expense and the
    // refund are somebody else's screen.
    expect(requests).toHaveLength(1)

    const [request] = requests!
    expect(request.status).toBe('approved')
    // The two figures a decider needs: what was asked for, and the ceiling it
    // exceeded. Both stored, neither recomputed.
    expect(request.requestedBps).toBe(1200)
    expect(request.limitBps).toBe(800)
    expect(request.reason.length).toBeGreaterThan(0)
    expect(typeof request.requestedByName).toBe('string')
    expect(typeof request.decidedByName).toBe('string')

    // The seller who asked is the external agent, and the cap they exceeded is
    // the one on their own terms row — 8%, stored as the `numeric` "8.000".
    const seller = DEMO_PERSONAS.find((entry) => entry.id === 'sales-agent')!
    expect(request.requestedByUserId).toBe(seller.userId)
    expect(request.limitBps! / 100).toBe(
      Number(
        DEMO_DATASET.tables['agent_organization_settings']![0]
          .discount_max_percent,
      ),
    )
  })
})
