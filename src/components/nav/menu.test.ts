/**
 * The menu is derived, and this is where that claim is checked.
 *
 * Every case below builds an `Actor` the same way the application does — a set
 * of grants, a plan, a membership status — and asserts what the navigation
 * comes out as. Nothing here reaches for a role name to decide an outcome,
 * because the production code does not either.
 *
 * Where a persona is described by an explicit grant set rather than by a
 * system role, that is deliberate: the role catalogue is being extended by
 * another engineer, and a test that pinned itself to today's contents of
 * `sales_agent` would fail for a reason that has nothing to do with the menu.
 * The one role used by name is `organization_owner`, whose grants are computed
 * from the whole catalogue and therefore stay correct as the catalogue grows.
 */

import { describe, expect, it } from 'vitest'

import type { Actor, MembershipStatus } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { grantsForSystemRole } from '@/lib/authz/roles'
import { ENTITLEMENTS, type Entitlement } from '@/lib/plans/entitlements'

import {
  MENU,
  QUICK_CREATE,
  buildMenu,
  buildQuickCreate,
  primaryDestinations,
} from './menu'

// ── Fixtures ──────────────────────────────────────────────────────────────

function actor(options: {
  grants: readonly Grant[]
  entitlements?: readonly Entitlement[]
  status?: MembershipStatus
}): Actor {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    membershipStatus: options.status ?? 'active',
    grants: new Set(options.grants),
    scope: { kind: 'all_organization' },
    // Everything, unless a test is specifically about the plan. Otherwise a
    // permission assertion could pass or fail for a billing reason.
    entitlements: new Set(options.entitlements ?? ENTITLEMENTS),
  }
}

/** Flatten to `section/item` ids, which is what the assertions read best. */
function visible(menu: ReturnType<typeof buildMenu>): string[] {
  return menu.flatMap((section) =>
    section.items.map((item) => `${section.id}/${item.id}`),
  )
}

function sectionIds(menu: ReturnType<typeof buildMenu>): string[] {
  return menu.map((section) => section.id)
}

/**
 * A cleaner, stated as grants. This is the sharpest privacy case in the
 * product: task-first, mobile, and never shown money or guest contact.
 */
const CLEANER: readonly Grant[] = [
  'task.view',
  'task.update',
  'task.complete',
  'incident.create',
]

/**
 * An external seller. Sees whether a date can still be sold and their own
 * commercial trail, and nothing about the business behind it.
 */
const AGENT: readonly Grant[] = [
  'availability.view',
  'quote.view',
  'quote.create',
  'agent_statement.view',
  'commission.view',
]

// ── Structure ─────────────────────────────────────────────────────────────

describe('the menu definition', () => {
  it('gives every item a requirement, with no empty grant list', () => {
    for (const section of MENU) {
      expect(section.items.length).toBeGreaterThan(0)

      for (const item of section.items) {
        expect(item.requires).toBeDefined()

        if (item.requires.kind === 'grant') {
          expect(item.requires.anyOf.length).toBeGreaterThan(0)
        } else {
          expect(item.requires.kind).toBe('membership')
        }
      }
    }
  })

  it('uses the membership escape hatch for one item only', () => {
    const membershipItems = MENU.flatMap((section) =>
      section.items
        .filter((item) => item.requires.kind === 'membership')
        .map((item) => item.id),
    )

    // If this grows, it is worth a conversation rather than a passing test:
    // "any active member" is the weakest requirement the product can state.
    expect(membershipItems).toEqual(['dashboard'])
  })

  it('never gives an unbuilt route a link', () => {
    for (const section of MENU) {
      for (const item of section.items) {
        if (item.destination.status === 'planned') {
          expect(item.destination).not.toHaveProperty('href')
        } else {
          expect(item.destination.href.startsWith('/')).toBe(true)
        }
      }
    }
  })
})

// ── Derivation ────────────────────────────────────────────────────────────

describe('buildMenu', () => {
  it('shows a cleaner their work and nothing else', () => {
    const menu = buildMenu(actor({ grants: CLEANER }))
    const ids = visible(menu)

    expect(ids).toContain('operations/tasks')
    expect(ids).toContain('operations/housekeeping')
    // A cleaner reports a fault without being allowed to browse the
    // organization's faults — the entry is how they reach the form.
    expect(ids).toContain('operations/incidents')

    // The whole point of the privacy model.
    expect(sectionIds(menu)).not.toContain('finance')
    expect(sectionIds(menu)).not.toContain('management')
    expect(sectionIds(menu)).not.toContain('settings')
    expect(ids).not.toContain('bookings/bookings')
    expect(ids).not.toContain('bookings/guests')
    expect(ids).not.toContain('operations/inventory')
  })

  it('shows an external seller availability without the bookings behind it', () => {
    const ids = visible(buildMenu(actor({ grants: AGENT })))

    expect(ids).toContain('bookings/availability')
    expect(ids).toContain('bookings/calendar')
    expect(ids).toContain('distribution/quotes')
    expect(ids).toContain('finance/commissions')

    // `availability.view` is free/busy. It is never a route to the booking.
    expect(ids).not.toContain('bookings/bookings')
    expect(ids).not.toContain('bookings/guests')
    expect(ids).not.toContain('finance/payments')
    expect(ids).not.toContain('finance/reconciliation')
    expect(ids).not.toContain('management/team')
  })

  it('shows an organization owner every section', () => {
    const menu = buildMenu(
      actor({ grants: [...grantsForSystemRole('organization_owner')] }),
    )

    expect(sectionIds(menu)).toEqual([
      'main',
      'bookings',
      'distribution',
      'operations',
      'finance',
      'ai',
      'management',
      'settings',
    ])

    // Owner of an organization on the full plan: nothing is withheld and
    // nothing is offered as an upsell.
    for (const section of menu) {
      for (const item of section.items) {
        expect(item.state).not.toBe('locked')
      }
    }

    // Every item in the catalogue reaches an owner on a full plan. If this
    // fails, an item was declared with a grant no role can ever hold.
    const total = MENU.reduce((sum, section) => sum + section.items.length, 0)
    expect(visible(menu)).toHaveLength(total)
  })

  it('denies by default: no grants leaves only the membership item', () => {
    const menu = buildMenu(actor({ grants: [] }))

    expect(visible(menu)).toEqual(['main/dashboard'])
  })

  it('produces nothing at all for a membership that is not active', () => {
    for (const status of [
      'invited',
      'pending',
      'suspended',
      'removed',
    ] as const) {
      const menu = buildMenu(
        actor({
          grants: [...grantsForSystemRole('organization_owner')],
          status,
        }),
      )

      expect(menu).toEqual([])
    }
  })
})

// ── The plan, as distinct from the permission ─────────────────────────────

describe('buildMenu and the plan', () => {
  it('offers an upgrade where the right is held but the feature is not bought', () => {
    const menu = buildMenu(
      actor({
        grants: ['task.view', 'inventory.view', 'booking.view'],
        // `core` only: operations is not included in this package.
        entitlements: ['core'],
      }),
    )

    const operations = menu.find((section) => section.id === 'operations')
    const tasks = operations?.items.find((item) => item.id === 'tasks')

    expect(tasks?.state).toBe('locked')
    expect(tasks?.entitlement).toBe('operations')
    // Locked is visible but never navigable.
    expect(tasks?.href).toBeNull()

    // The booking list is core, so it is unaffected by the same plan. It is
    // now built, so this reads `available` rather than `planned` — what the
    // assertion is really about is that the operations lock did not reach it.
    const bookings = menu.find((section) => section.id === 'bookings')
    expect(bookings?.items.find((item) => item.id === 'bookings')?.state).toBe(
      'available',
    )
  })

  it('links a locked item whose route renders the offer', () => {
    const menu = buildMenu(
      actor({
        grants: ['agent.view'],
        // No "agents" entitlement: the distribution network is not bought.
        entitlements: ['core'],
      }),
    )

    const distribution = menu.find((section) => section.id === 'distribution')
    const agents = distribution?.items.find((item) => item.id === 'agents')

    expect(agents?.state).toBe('locked')
    // Linked, unlike the tasks entry above, because `/agents` renders a
    // `PlanLock` on this exact branch instead of redirecting. A padlock the
    // customer cannot press is a padlock on the only screen that asks them to
    // pay.
    expect(agents?.href).toBe('/agents')
  })

  it('hides rather than upsells when the permission is missing too', () => {
    const menu = buildMenu(
      actor({ grants: ['booking.view'], entitlements: ['core'] }),
    )

    // No task grant at all: there is nothing to upgrade into, so the entry is
    // absent rather than dangled.
    expect(sectionIds(menu)).not.toContain('operations')
  })
})

// ── What the resolved menu promises the UI ────────────────────────────────

describe('the resolved menu', () => {
  it('gives an href only to items whose route exists', () => {
    const menu = buildMenu(
      actor({ grants: [...grantsForSystemRole('organization_owner')] }),
    )

    for (const section of menu) {
      for (const item of section.items) {
        if (item.state === 'available') {
          expect(item.href).toBeTruthy()
        } else {
          expect(item.href).toBeNull()
        }
      }
    }
  })

  it('builds the mobile bar only from destinations that exist', () => {
    const destinations = primaryDestinations(
      buildMenu(
        actor({ grants: [...grantsForSystemRole('organization_owner')] }),
      ),
    )

    // Today exactly one route is built. The assertion is on the property that
    // matters — every tab leads somewhere real — not on the count.
    for (const destination of destinations) {
      expect(destination.href.startsWith('/')).toBe(true)
    }
    expect(destinations.map((d) => d.href)).toContain('/dashboard')
  })

  it('gives a cleaner no dead tabs on the mobile bar', () => {
    const destinations = primaryDestinations(
      buildMenu(actor({ grants: CLEANER })),
    )

    expect(destinations.every((d) => d.href.length > 0)).toBe(true)
  })
})

// ── Quick create ──────────────────────────────────────────────────────────

describe('buildQuickCreate', () => {
  it('declares a requirement on every entry', () => {
    for (const item of QUICK_CREATE) {
      expect(item.requires.kind).toBe('grant')
      if (item.requires.kind === 'grant') {
        expect(item.requires.anyOf.length).toBeGreaterThan(0)
      }
    }
  })

  it('offers a cleaner the one thing they may create', () => {
    const ids = buildQuickCreate(actor({ grants: CLEANER })).map((i) => i.id)

    // Reporting a fault is the whole of a cleaner's creative authority.
    expect(ids).toEqual(['new-incident'])
  })

  it('offers an external seller a quote and nothing operational', () => {
    const ids = buildQuickCreate(actor({ grants: AGENT })).map((i) => i.id)

    expect(ids).toContain('new-quote')
    expect(ids).not.toContain('new-booking')
    expect(ids).not.toContain('new-task')
    expect(ids).not.toContain('invite-member')
  })

  it('offers an owner everything, and nobody nothing by default', () => {
    const owner = buildQuickCreate(
      actor({ grants: [...grantsForSystemRole('organization_owner')] }),
    )

    expect(owner).toHaveLength(QUICK_CREATE.length)
    expect(buildQuickCreate(actor({ grants: [] }))).toEqual([])
  })
})
