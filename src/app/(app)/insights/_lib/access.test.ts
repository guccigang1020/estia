/**
 * Who gets through the insights gate, decided against the real people.
 *
 * `requireAnyInsightGrant` is `decideInsightAccess` plus a redirect. The
 * redirect half needs a request, a cookie jar and the Next.js router and is
 * not testable here; the deciding half is pure, and this file drives it with
 * the actors the demo dataset actually resolves — real roles, real grants, a
 * real plan — rather than with hand-built grant sets that could quietly stop
 * matching the roles the product ships.
 *
 * Three claims:
 *
 *   1. The accountant gets in on `report.financial.view` and the general
 *      manager gets in on `automation.view`. Neither holds the other's grant,
 *      which is the entire reason this gate takes a list.
 *   2. A general manager on a package without `automation` is **locked, not
 *      redirected** — they hold the permission, and telling them otherwise
 *      sends them to an administrator who cannot help.
 *   3. The menu's declaration and this gate's list are the same list. A
 *      sidebar entry pointing at a route that refuses is the failure that had
 *      `reports` and `audit` pulled from the menu once already.
 */

import { describe, expect, it } from 'vitest'
import type { User } from '@supabase/supabase-js'

import { MENU } from '@/components/nav/menu'
import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET } from '@/lib/demo/dataset'
import { person } from '@/lib/demo/dataset-identity'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SEED_PLANS } from '@/lib/plans/catalog'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import type { ShellContext } from '../../_lib/context'
import { INSIGHT_GRANTS, decideInsightAccess } from './access'

const ORGANIZATION = DEMO_DATASET.organizationId

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

/**
 * The packages come from `SEED_PLANS`, not from `DEMO_PLANS`.
 *
 * The demo switcher deliberately offers only Basic, Direct and Pro — see the
 * note beside `DEMO_PLANS` — so `management`, the only package carrying the
 * `automation` entitlement, cannot be selected there at all. That is a fact
 * about the demo, not about the product, and a gate test that could not
 * express "this customer bought automation" would be testing the showroom.
 */
async function actorFor(key: string, planCode: string): Promise<Actor> {
  const seed = SEED_PLANS.find((entry) => entry.code === planCode)
  if (!seed) throw new Error(`No plan '${planCode}' in the catalogue`)

  const resolution = await resolveActor(
    new DemoActorSource(new SupabaseActorSource(client()), {
      code: seed.code,
      label: seed.name,
      entitlements: seed.entitlements,
    }),
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
 * `routeAccess` reads two things: the status and the actor. The rest is what
 * the shell renders with and is not part of this decision, so it is filled
 * with the least that satisfies the type rather than with a fabricated
 * workspace somebody might mistake for a fixture.
 */
async function contextFor(
  key: string,
  planCode = 'management',
): Promise<ShellContext> {
  const workspace = {
    organizationId: ORGANIZATION,
    name: 'אחוזת הגליל',
    slug: 'ahuzat-hagalil',
  }

  return {
    status: 'ready',
    user: { id: person(key).userId } as User,
    workspaces: [workspace],
    workspace,
    actor: await actorFor(key, planCode),
    membershipId: 'not-read-by-routeAccess',
    roles: [],
    properties: [],
    selectedPropertyId: 'all',
  }
}

describe('the two audiences this screen exists for', () => {
  it('admits the accountant, who holds financial reporting and no automation', async () => {
    const context = await contextFor('accountant')
    const actor = context.status === 'ready' ? context.actor : null

    expect(actor?.grants.has('report.financial.view')).toBe(true)
    expect(actor?.grants.has('automation.view')).toBe(false)
    expect(decideInsightAccess(context).outcome).toBe('allow')
  })

  it('admits the general manager, who holds automation and no money grant', async () => {
    const context = await contextFor('general-manager')
    const actor = context.status === 'ready' ? context.actor : null

    expect(actor?.grants.has('automation.view')).toBe(true)
    expect(actor?.grants.has('report.financial.view')).toBe(false)
    expect(actor?.grants.has('finance.view')).toBe(false)
    expect(decideInsightAccess(context).outcome).toBe('allow')
  })

  it('admits the owner', async () => {
    expect(decideInsightAccess(await contextFor('owner')).outcome).toBe('allow')
  })
})

describe('a package that does not include automation', () => {
  it('locks the general manager rather than redirecting them', async () => {
    // Pro carries every grant this person holds and not the `automation`
    // entitlement. Their only door into this screen is `automation.view`.
    const access = decideInsightAccess(
      await contextFor('general-manager', 'pro'),
    )

    expect(access.outcome).toBe('locked')
    expect(access.outcome === 'locked' && access.entitlement).toBe('automation')
    expect(access.outcome === 'locked' && access.grant).toBe('automation.view')
  })

  it('still admits the accountant on the same package', async () => {
    // `report.financial.view` carries no entitlement — it is core product —
    // so the package changes nothing for them. An allow anywhere wins.
    expect(
      decideInsightAccess(await contextFor('accountant', 'pro')).outcome,
    ).toBe('allow')
  })
})

describe('somebody holding neither door', () => {
  it('refuses reception outright', async () => {
    const access = decideInsightAccess(await contextFor('reception'))
    expect(access.outcome).toBe('denied')
  })

  it('refuses the cleaner outright', async () => {
    const access = decideInsightAccess(await contextFor('housekeeping'))
    expect(access.outcome).toBe('denied')
  })

  it('refuses a signed-out request before asking about any grant', () => {
    expect(decideInsightAccess(null).outcome).toBe('sign_in')
  })
})

describe('the menu and the gate say the same thing', () => {
  it('declares the same grants the route admits', () => {
    const item = MENU.flatMap((group) => group.items).find(
      (entry) => entry.id === 'insights',
    )

    expect(item).toBeDefined()
    expect(item?.requires.kind).toBe('grant')

    const declared =
      item?.requires.kind === 'grant' ? [...item.requires.anyOf].sort() : []
    expect(declared).toEqual([...INSIGHT_GRANTS].sort())
  })

  /**
   * The menu is the coordinator's file and this worker does not write it.
   *
   * So the assertion is conditional rather than a demand: while the item is
   * still `planned` the screen exists and is simply unreachable from the
   * sidebar, and the moment somebody marks it `ready` this pins the two
   * properties that must be true of it — the href, and `offersUpgrade`, which
   * is a claim about a specific page and is honoured here by the plan lock in
   * `page.tsx` rather than by a redirect.
   */
  it('would point at this route, and claim the upgrade offer, once linked', () => {
    const item = MENU.flatMap((group) => group.items).find(
      (entry) => entry.id === 'insights',
    )

    expect(item).toBeDefined()
    if (item?.destination.status !== 'ready') return

    expect(item.destination.href).toBe('/insights')
    expect(item.destination.offersUpgrade).toBe(true)
  })
})
