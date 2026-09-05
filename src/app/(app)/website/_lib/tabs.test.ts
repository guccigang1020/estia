/**
 * A LOCKED PLAN MUST SEE AN UPGRADE OFFER, NOT A PERMISSION ERROR.
 *
 * ── Why this is tested here rather than driven through a browser ─────────
 *
 * The demo carries one organization on one plan, so there is no persona in it
 * whose package lacks `website` — the lock branch cannot be reached by
 * clicking. What CAN be proven, and is what actually matters, is that the
 * branch the gate keys on is the one the authorization engine produces:
 * an owner who HOLDS `site.view` and whose organization has not bought
 * `website` is refused with `plan_does_not_include` and never with
 * `missing_permission`.
 *
 * That distinction is the whole reason `requireSiteGrant` exists instead of
 * `requireGrant`. If `authorize()` ever returned `missing_permission` here, the
 * gate would redirect to the dashboard saying the owner lacks a permission they
 * actually hold — sending them to an administrator who cannot help, who then
 * tells them the product is broken.
 *
 * `routeAccess` is exercised directly rather than `requireSiteGrant`, because
 * the latter calls `redirect()` and `shellContext()` and testing it would be
 * testing Next.js. The decision it branches on is here.
 */

import { describe, expect, it } from 'vitest'

import { routeAccess } from '../../_lib/access'
import type { ShellContext } from '../../_lib/context'
import type { Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import {
  ENTITLEMENT_FOR_GRANT,
  type Entitlement,
} from '@/lib/plans/entitlements'

import { studioTabs } from './tabs'

const ORG = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'

const EVERY_SITE_GRANT: readonly Grant[] = [
  'site.view',
  'site.edit_content',
  'site.edit_design',
  'site.manage_seo',
  'site.manage_domain',
  'site.publish',
  'site.rollback',
  'site.ai_generate',
]

function actorWith(
  grants: readonly Grant[],
  entitlements: readonly Entitlement[],
): Actor {
  return {
    userId: USER,
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set<Entitlement>(entitlements),
  }
}

function contextFor(actor: Actor): ShellContext {
  return {
    status: 'ready',
    user: { id: USER } as ShellContext & { id: string } extends never
      ? never
      : never,
    workspaces: [],
    workspace: { organizationId: ORG, name: 'אחוזת הגליל', slug: 'galilee' },
    actor,
    membershipId: 'membership-1',
    roles: [],
    properties: [],
    selectedPropertyId: 'all',
  } as unknown as ShellContext
}

describe('the entitlement map this module is built on', () => {
  it('meters generation separately from the website itself', () => {
    // The reason `ai_content` is a separate entitlement: a customer can hold a
    // website without paying for generation, and every other screen keeps
    // working. If these ever collapsed into one, the studio would lock
    // entirely for somebody who only declined the AI package.
    expect(ENTITLEMENT_FOR_GRANT['site.view']).toBe('website')
    expect(ENTITLEMENT_FOR_GRANT['site.publish']).toBe('website')
    expect(ENTITLEMENT_FOR_GRANT['site.ai_generate']).toBe('ai_content')
    expect(ENTITLEMENT_FOR_GRANT['site.manage_domain']).toBe('custom_domain')
  })
})

describe('an owner whose plan does not include the website', () => {
  // Holds every site grant. Has bought nothing.
  const actor = actorWith(EVERY_SITE_GRANT, [])

  it('is refused for the PLAN, never for a permission they hold', () => {
    const decision = routeAccess(contextFor(actor), 'site.view')

    expect(decision.outcome).toBe('denied')
    if (decision.outcome !== 'denied') return
    // The branch `requireSiteGrant` turns into `SiteLock` rather than a
    // redirect. `missing_permission` here would be the bug this whole gate
    // exists to prevent.
    expect(decision.reason).toBe('plan_does_not_include')
  })

  it('is refused the same way on every screen in the module', () => {
    for (const grant of EVERY_SITE_GRANT) {
      const decision = routeAccess(contextFor(actor), grant)
      expect(decision.outcome).toBe('denied')
      if (decision.outcome !== 'denied') continue
      expect(decision.reason).toBe('plan_does_not_include')
    }
  })
})

describe('a customer with a website but no generation package', () => {
  const actor = actorWith(EVERY_SITE_GRANT, ['website', 'custom_domain'])

  it('reaches every studio screen', () => {
    for (const grant of EVERY_SITE_GRANT.filter(
      (grant) => grant !== 'site.ai_generate',
    )) {
      expect(routeAccess(contextFor(actor), grant).outcome).toBe('allow')
    }
  })

  it('is locked out of generation ALONE, and for the plan', () => {
    const decision = routeAccess(contextFor(actor), 'site.ai_generate')

    expect(decision.outcome).toBe('denied')
    if (decision.outcome !== 'denied') return
    expect(decision.reason).toBe('plan_does_not_include')
  })
})

describe('somebody who genuinely lacks the right', () => {
  it('is refused for the PERMISSION, which is a different sentence', () => {
    // A cleaner with the website package. The gate redirects rather than
    // offering an upgrade, because upgrading their employer's plan would not
    // give a cleaner the right to publish a website.
    const cleaner = actorWith([], ['website'])
    const decision = routeAccess(contextFor(cleaner), 'site.view')

    expect(decision.outcome).toBe('denied')
    if (decision.outcome !== 'denied') return
    expect(decision.reason).toBe('missing_permission')
  })
})

describe('the studio tabs', () => {
  it('offers a copywriter content but not design, SEO or domain', () => {
    const copywriter = actorWith(
      ['site.view', 'site.edit_content'],
      ['website'],
    )
    const tabs = new Map(
      studioTabs(copywriter).map((tab) => [tab.href, tab.available]),
    )

    expect(tabs.get('/website/content')).toBe(true)
    expect(tabs.get('/website/preview')).toBe(true)
    expect(tabs.get('/website/design')).toBe(false)
    expect(tabs.get('/website/seo')).toBe(false)
    expect(tabs.get('/website/domain')).toBe(false)
  })

  it('gates the enquiries tab on `booking.view`, not on a site grant', () => {
    // The most important authorization decision in the module after the claims
    // constraint: an enquiry carries a name and a telephone number, and a
    // copywriter has no business reading it. 0042 gates the rows the same way,
    // so the tab and the policy agree.
    const copywriter = actorWith(
      ['site.view', 'site.edit_content'],
      ['website'],
    )
    const receptionist = actorWith(['site.view', 'booking.view'], ['website'])

    const tabOf = (actor: Actor) =>
      studioTabs(actor).find((tab) => tab.href === '/website/requests')
        ?.available

    expect(tabOf(copywriter)).toBe(false)
    expect(tabOf(receptionist)).toBe(true)
  })

  it('always offers the overview, which needs nothing beyond reaching it', () => {
    const anybody = actorWith(['site.view'], ['website'])
    expect(studioTabs(anybody)[0]).toMatchObject({
      href: '/website',
      available: true,
    })
  })
})
