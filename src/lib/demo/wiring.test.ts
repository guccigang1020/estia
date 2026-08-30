/**
 * The demo, end to end, minus the cookies and the rendering.
 *
 * The tests beside this one exercise the client against fixtures of their own,
 * which proves the query engine and proves nothing about the demo anybody will
 * actually open. This file runs the *real* dataset through the *real* adapter:
 * `SupabaseActorSource` is the same class the application uses, `resolveActor`
 * is the same resolution, and the only substitution is the one the demo makes
 * in production — rows from memory instead of over HTTP.
 *
 * What it is really asserting is that every persona in the switcher is seatable.
 * A persona whose membership, roles, scope or subscription is missing from the
 * dataset produces a shell that cannot render, and the failure would otherwise
 * surface as a stack trace on whichever screen somebody clicked first, long
 * after the dataset was written.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '../actor'
import { SupabaseActorSource } from '../persistence/actor'
import type { Db } from '../persistence/client'
import { createDemoClient } from './client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from './dataset'
import { DemoActorSource, resolvePersona, resolvePlan } from './session'

function db(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

describe('the demo dataset, through the ordinary adapter', () => {
  it('offers at least one persona and the plans the switcher needs', () => {
    expect(DEMO_PERSONAS.length).toBeGreaterThan(0)
    expect(DEMO_PLANS.map((plan) => plan.code)).toContain('pro')
    // The fallbacks resolve against the real catalogue, not a fixture.
    expect(resolvePersona(DEMO_PERSONAS, undefined)).toBe(DEMO_PERSONAS[0])
    expect(resolvePlan(DEMO_PLANS, undefined).code).toBe('pro')
  })

  it.each(DEMO_PERSONAS.map((persona) => [persona.id, persona] as const))(
    'seats the %s persona through membership → roles → scope',
    async (_id, persona) => {
      const resolution = await resolveActor(
        new SupabaseActorSource(db()),
        persona.userId,
        DEMO_DATASET.organizationId,
      )

      if (!resolution.ok) {
        throw new Error(
          `The '${persona.id}' persona cannot be seated: ${resolution.reason}. ` +
            `Every entry in DEMO_PERSONAS needs an active 'memberships' row, ` +
            `its 'membership_roles', a 'membership_scopes' row and a live ` +
            `subscription in DEMO_DATASET.`,
        )
      }

      expect(resolution.actor.userId).toBe(persona.userId)
      expect(resolution.actor.organizationId).toBe(DEMO_DATASET.organizationId)
    },
  )

  it('gives every persona the grants their role is defined to carry', async () => {
    // Not a fixed list — the point is that the grants are *derived*. An owner
    // holding more than a cleaner is the demo working; both holding the same
    // set would mean the roles never reached the engine.
    const sets = new Map<string, number>()

    for (const persona of DEMO_PERSONAS) {
      const resolution = await resolveActor(
        new SupabaseActorSource(db()),
        persona.userId,
        DEMO_DATASET.organizationId,
      )
      if (!resolution.ok) throw new Error(`unseatable: ${persona.id}`)
      sets.set(persona.id, resolution.actor.grants.size)
    }

    expect([...new Set(sets.values())].length).toBeGreaterThan(1)
  })

  it('changes what the organization is entitled to when the plan changes', async () => {
    // The second axis. The same persona, the same rows, a different package.
    const persona = DEMO_PERSONAS[0]
    const basic =
      DEMO_PLANS.find((plan) => plan.code !== 'pro') ?? DEMO_PLANS[0]
    const pro = resolvePlan(DEMO_PLANS, 'pro')

    const entitlementsOn = async (code: string) => {
      const plan = resolvePlan(DEMO_PLANS, code)
      const source = new DemoActorSource(new SupabaseActorSource(db()), plan)
      const resolution = await resolveActor(
        source,
        persona.userId,
        DEMO_DATASET.organizationId,
      )
      if (!resolution.ok) throw new Error(`unseatable: ${resolution.reason}`)
      return resolution.actor.entitlements
    }

    expect([...(await entitlementsOn(pro.code))].sort()).toEqual(
      [...new Set([...pro.entitlements, 'core'])].sort(),
    )

    if (basic.code !== pro.code) {
      expect((await entitlementsOn(basic.code)).size).toBeLessThan(
        (await entitlementsOn(pro.code)).size,
      )
    }
  })

  it('lists the workspaces the shell asks for, embed and all', async () => {
    // `loadWorkspaces` in `context.ts`, written out: the embed shape is the
    // thing being checked, because a missing relation here is a shell that
    // renders with no organization name.
    const { data, error } = await db()
      .from('memberships')
      .select('organization_id, organizations!inner(id, name, slug)')
      .eq('user_id', DEMO_PERSONAS[0].userId)
      .eq('status', 'active')

    expect(error).toBeNull()
    const rows = data as unknown as {
      organizations: { id: string; name: string; slug: string } | null
    }[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].organizations?.name).toBeTruthy()
  })
})
