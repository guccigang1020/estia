/**
 * The asymmetry, decided rather than described.
 *
 * `requireIncidentAccess` is two calls to `routeAccess` and a redirect. The
 * redirect half needs a request, a cookie jar and the Next.js router and is not
 * testable here; the deciding half is `routeAccess`, which is a pure function
 * over a context and a grant and is the *same* call the guard makes. So this
 * file drives that function with the real actors the demo dataset resolves, and
 * asserts the two outcomes the screen branches on:
 *
 *   · a cleaner is refused `incident.view` and allowed `incident.create`
 *   · the handyman and the owner are allowed both
 *
 * If that ever stops being true — a role gains `incident.view`, or the
 * catalogue merges the two grants — this fails, and the "you may report but not
 * browse" screen becomes a screen nobody can reach rather than quietly becoming
 * wrong.
 */

import { describe, expect, it } from 'vitest'
import type { User } from '@supabase/supabase-js'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PLANS } from '@/lib/demo/dataset'
import { person } from '@/lib/demo/dataset-identity'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import { routeAccess } from '../../_lib/access'
import type { ShellContext } from '../../_lib/context'

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

/**
 * A ready shell context around a real actor.
 *
 * `routeAccess` reads two things: the status, and the actor. The rest of the
 * context is what the shell renders with and is not part of this decision, so
 * it is filled with the least that satisfies the type rather than with a
 * fabricated workspace that might be mistaken for a fixture.
 */
async function contextFor(key: string): Promise<ShellContext> {
  const entry = person(key)
  const workspace = {
    organizationId: ORGANIZATION,
    name: 'אחוזת הגליל',
    slug: 'ahuzat-hagalil',
  }

  return {
    status: 'ready',
    user: { id: entry.userId } as User,
    workspaces: [workspace],
    workspace,
    actor: await actorFor(key),
    membershipId: 'not-read-by-routeAccess',
    roles: [],
    properties: [],
    selectedPropertyId: 'all',
  }
}

describe('the cleaner', () => {
  it('may report a fault', async () => {
    const decision = routeAccess(
      await contextFor('housekeeping'),
      'incident.create',
    )
    expect(decision.outcome).toBe('allow')
  })

  it('may not browse the organization’s faults', async () => {
    // The register is a picture of what is wrong with every building, who
    // reported it, and by implication which units are unlettable this weekend.
    // A cleaner reporting a cracked shower screen needs none of it.
    const decision = routeAccess(
      await contextFor('housekeeping'),
      'incident.view',
    )

    expect(decision.outcome).toBe('denied')
    expect(decision.outcome === 'denied' && decision.reason).toBe(
      'missing_permission',
    )
  })
})

describe('the people who own the faults', () => {
  it('lets the handyman do both', async () => {
    const context = await contextFor('maintenance')
    expect(routeAccess(context, 'incident.view').outcome).toBe('allow')
    expect(routeAccess(context, 'incident.create').outcome).toBe('allow')
  })

  it('lets the owner do both', async () => {
    const context = await contextFor('owner')
    expect(routeAccess(context, 'incident.view').outcome).toBe('allow')
    expect(routeAccess(context, 'incident.create').outcome).toBe('allow')
  })
})

describe('somebody holding neither', () => {
  it('is refused the route entirely', async () => {
    // The external seller. `requireIncidentAccess` redirects them to the
    // dashboard with `incident.view` named — the grant they attempted by
    // opening the URL, which discloses nothing they did not already know.
    const context = await contextFor('sales-agent')

    expect(routeAccess(context, 'incident.view').outcome).toBe('denied')
    expect(routeAccess(context, 'incident.create').outcome).toBe('denied')
  })
})

describe('a signed-out request', () => {
  it('is sent to sign in rather than refused', async () => {
    expect(routeAccess(null, 'incident.create').outcome).toBe('sign_in')
  })
})
