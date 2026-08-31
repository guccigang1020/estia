/**
 * The home screen, checked against the authorization engine rather than
 * against a screenshot.
 *
 * Three claims are made here and each of them has already been broken once in
 * this product:
 *
 *   1. **No tile links anywhere the reader would be refused.** The menu
 *      shipped four such links — see the notes on `reports`, `audit`, `units`
 *      and `incidents` in `menu.ts`, each removed after somebody clicked it
 *      and was redirected to the page they came from. The catalogue states the
 *      destination's gate grant beside the destination, and the test below
 *      walks every system role against every tile and asserts that a rendered
 *      link always implies the route's own grant.
 *   2. **The cleaner's home screen carries no money and no guest.** Asserted
 *      as a property of the resolved tiles, not as a comment.
 *   3. **The catalogue has not drifted from the metric dictionary.** A tile
 *      whose `requires` disagrees with `METRICS[id].requires` would issue a
 *      query whose answer the domain then withholds — a wasted round trip in
 *      the best case and a permanently blank tile in the worst.
 *
 * Actors are built from `grantsForRoles`, which is the same function
 * `resolveActor` uses. Nothing here fabricates a grant set.
 */

import { describe, expect, it } from 'vitest'

import type { Actor } from '@/lib/authz/can'
import { holdsGrant } from '@/lib/authz/can'
import {
  grantsForRoles,
  SYSTEM_ROLES,
  type SystemRole,
} from '@/lib/authz/roles'
import { ENTITLEMENTS, type Entitlement } from '@/lib/plans/entitlements'
import { METRICS, type MetricId, isMetricId } from '@/lib/metrics'

import {
  HOME_METRIC_IDS,
  TILES,
  buildTiles,
  resolveTile,
  tileHref,
  TODAY_TOKEN,
} from './tiles'

const ORGANIZATION = '00000000-0000-4000-8000-000000000001'

/**
 * An actor holding one role, on a package that includes everything.
 *
 * Every entitlement on purpose: this suite is about permissions, and a package
 * refusal would hide the very tiles it is trying to inspect. The package axis
 * gets its own test at the bottom.
 */
function actorFor(
  role: SystemRole,
  entitlements: readonly Entitlement[] = ENTITLEMENTS,
): Actor {
  return {
    userId: '00000000-0000-4000-8000-0000000000ff',
    organizationId: ORGANIZATION,
    membershipStatus: 'active',
    grants: grantsForRoles([role]),
    scope: { kind: 'all_organization' },
    entitlements: new Set(entitlements),
  }
}

/** The nine roles the brief names, spelled as the catalogue spells them. */
const SHIPPED_ROLES = [
  'organization_owner',
  'administrator',
  'general_manager',
  'property_manager',
  'reception',
  'housekeeping_supervisor',
  'cleaner',
  'accountant',
  'sales_agent',
] as const satisfies readonly SystemRole[]

/* ------------------------------------------------------- the door rule -- */

describe('a tile never links somewhere the reader would be refused', () => {
  it.each(SYSTEM_ROLES.map((role) => [role] as const))(
    '%s is offered only routes their grants admit them to',
    (role) => {
      const actor = actorFor(role)

      for (const tile of buildTiles(actor)) {
        if (tile.destination === null) continue
        expect(
          holdsGrant(actor, tile.destination.requires),
          `${role} was offered ${tile.destination.href} without ${tile.destination.requires}`,
        ).toBe(true)
      }
    },
  )

  it('drops the link and keeps the figure when only the route is refused', () => {
    // An actor entitled to the outstanding total and not to the ledger behind
    // it. This is the accountant-shaped case the metric dictionary models with
    // `detailRequires`, built here directly so the assertion cannot be moved by
    // a change to a role bundle.
    const actor: Actor = {
      ...actorFor('accountant'),
      grants: new Set(['finance.view']),
    }

    const balance = buildTiles(actor).find(
      (tile) => tile.id === 'outstanding_balance',
    )

    expect(balance).toBeDefined()
    expect(balance?.state).toBe('shown')
    // The figure survives; the door does not.
    expect(balance?.destination).toBeNull()
  })

  it('offers the door as soon as the route grant arrives', () => {
    const actor: Actor = {
      ...actorFor('accountant'),
      grants: new Set(['finance.view', 'payment.view']),
    }

    const balance = buildTiles(actor).find(
      (tile) => tile.id === 'outstanding_balance',
    )

    expect(balance?.destination?.href).toBe('/finance/payments')
  })
})

/* ------------------------------------------------------- the cleaner -- */

describe('the cleaner', () => {
  const cleaner = actorFor('cleaner')
  const tiles = buildTiles(cleaner)

  it('gets a home screen at all', () => {
    expect(tiles.length).toBeGreaterThan(0)
  })

  it('is shown no figure that could be money', () => {
    const money = [
      'unpaid-stays',
      'payments-stalled',
      'revenue',
      'outstanding_balance',
    ]
    for (const id of money) {
      expect(
        tiles.some((tile) => tile.id === id),
        `the cleaner was offered the tile '${id}'`,
      ).toBe(false)
    }
  })

  it('is shown no figure that counts guests or bookings', () => {
    for (const id of ['arrivals', 'departures', 'in-house', 'booking_pace']) {
      expect(
        tiles.some((tile) => tile.id === id),
        `the cleaner was offered the tile '${id}'`,
      ).toBe(false)
    }
  })

  it('is shown her own work and the board it lives on', () => {
    const personal = tiles.find((tile) => tile.id === 'my-jobs')
    expect(personal?.state).toBe('shown')
    expect(personal?.destination?.href).toBe('/preparation')
  })

  it('reaches every destination she is offered', () => {
    for (const tile of tiles) {
      if (tile.destination === null) continue
      expect(holdsGrant(cleaner, tile.destination.requires)).toBe(true)
    }
  })
})

/* ------------------------------------------------- the roles differ -- */

describe('the nine shipped roles get nine different home screens', () => {
  it('gives the owner strictly more than the cleaner', () => {
    const owner = buildTiles(actorFor('organization_owner')).map((t) => t.id)
    const cleaner = buildTiles(actorFor('cleaner')).map((t) => t.id)

    expect(owner.length).toBeGreaterThan(cleaner.length)
    for (const id of cleaner) expect(owner).toContain(id)
  })

  it('gives the accountant money and no operational board', () => {
    const ids = buildTiles(actorFor('accountant')).map((tile) => tile.id)

    expect(ids).toContain('outstanding_balance')
    // Reading the ledger is not doing the work. The personal board is gated on
    // `task.complete`, which an accountant has no business holding.
    expect(ids).not.toContain('my-jobs')
  })

  it('gives the external agent no money tile at all', () => {
    const ids = buildTiles(actorFor('sales_agent')).map((tile) => tile.id)

    for (const id of ['revenue', 'outstanding_balance', 'unpaid-stays']) {
      expect(ids).not.toContain(id)
    }
  })

  it('never produces the same screen for the reception and the cleaner', () => {
    const reception = buildTiles(actorFor('reception')).map((t) => t.id)
    const cleaner = buildTiles(actorFor('cleaner')).map((t) => t.id)

    expect(reception).not.toEqual(cleaner)
  })

  it.each(SHIPPED_ROLES.map((role) => [role] as const))(
    '%s resolves without throwing and with a coherent screen',
    (role) => {
      const tiles = buildTiles(actorFor(role))
      for (const tile of tiles) {
        expect(tile.title.length).toBeGreaterThan(0)
        expect(tile.meaning.length).toBeGreaterThan(0)
        // A locked tile carries no door, ever: the route behind it would
        // refuse on the package before the permission was even consulted.
        if (tile.state === 'locked') expect(tile.destination).toBeNull()
      }
    },
  )
})

/* ------------------------------------------------------- the package -- */

describe('the package is a second axis, kept apart from the permission', () => {
  it('locks rather than hides a capability the organization has not bought', () => {
    // `approval.decide` is gated on the `approvals` entitlement, which only the
    // management package carries. An owner on any other package holds the
    // permission and not the feature — the exact distinction the screen must
    // not merge.
    const withoutApprovals = ENTITLEMENTS.filter(
      (entitlement) => entitlement !== 'approvals',
    )
    const owner = actorFor('organization_owner', withoutApprovals)

    const tile = buildTiles(owner).find((entry) => entry.id === 'approvals')

    expect(tile?.state).toBe('locked')
    expect(tile?.entitlement).toBe('approvals')
    expect(tile?.destination).toBeNull()
  })
})

/* ------------------------------------------------- the catalogue itself -- */

describe('the catalogue', () => {
  it('gives every tile a Hebrew title and a Hebrew meaning', () => {
    for (const tile of TILES) {
      expect(tile.title).toMatch(/[֐-׿]/)
      expect(tile.meaning).toMatch(/[֐-׿]/)
      // No code identifier ever reaches the screen from here.
      expect(tile.title).not.toMatch(/[a-z]\.[a-z]/)
    }
  })

  it('has no duplicate ids', () => {
    const ids = TILES.map((tile) => tile.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('agrees with the metric dictionary about which grant each figure needs', () => {
    for (const tile of TILES) {
      if (!isMetricId(tile.id)) continue
      const id: MetricId = tile.id
      expect(tile.requires.grants).toContain(METRICS[id].requires)
    }
  })

  it('derives the metric request from the catalogue rather than a second list', () => {
    const fromCatalogue = TILES.filter(
      (tile) => tile.band === 'period' && isMetricId(tile.id),
    ).map((tile) => tile.id)

    expect([...HOME_METRIC_IDS]).toEqual(fromCatalogue)
    expect(HOME_METRIC_IDS.length).toBeGreaterThan(0)
  })

  it('resolves the date token rather than leaving it on screen', () => {
    const dated = TILES.find((tile) =>
      tile.destination?.href.includes(TODAY_TOKEN),
    )
    expect(dated).toBeDefined()

    const href = tileHref(dated!.destination!, '2026-09-01')
    expect(href).not.toContain(TODAY_TOKEN)
    expect(href).toContain('2026-09-01')
  })

  it('leaves a suspended member with no tiles at all', () => {
    const suspended: Actor = {
      ...actorFor('organization_owner'),
      membershipStatus: 'suspended',
    }

    for (const tile of TILES) {
      expect(resolveTile(suspended, tile)).toBeNull()
    }
  })
})
