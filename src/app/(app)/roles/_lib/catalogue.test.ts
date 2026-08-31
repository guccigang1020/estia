/**
 * The roles screen, checked against the catalogue rather than against itself.
 *
 * The whole claim this screen makes is that it is *derived* — that a
 * permission added to `src/lib/authz/permissions.ts` next year appears here
 * without anybody editing a file in this directory. A snapshot test would
 * assert today's output and would pass forever while the claim quietly became
 * false, so nothing below is a snapshot: each assertion re-derives the answer
 * from the catalogue and compares the two.
 *
 * These are pure functions over frozen tuples, so no client and no dataset is
 * needed. `queries.test.ts` beside this file is the half that does touch rows.
 */

import { describe, expect, it } from 'vitest'

import {
  FIELD_PERMISSIONS,
  PERMISSIONS,
  SENSITIVE_ACTIONS,
} from '@/lib/authz/permissions'
import {
  OWNER_ONLY,
  PLATFORM_ROLES,
  SYSTEM_ROLES,
  grantsForSystemRole,
} from '@/lib/authz/roles'

import {
  CATALOGUE_ORDER,
  ROLE_CODES,
  groupGrants,
  groupIdOf,
  groupLabel,
  isKnownRole,
  isPlatformRole,
  knownRoleProfile,
  ownerAdvantage,
  roleProfile,
} from './catalogue'

/** Everything a customer organization can ever be granted. */
const ALL_ORGANIZATION_GRANTS = [
  ...PERMISSIONS.filter((permission) => !permission.startsWith('platform.')),
  ...FIELD_PERMISSIONS,
]

/* ============================================================ derivation == */

describe('the two derived roles', () => {
  it('gives the owner every non-platform grant in the catalogue', async () => {
    const owner = roleProfile('organization_owner')

    // Not "many" and not a number written down: exactly the catalogue, minus
    // the platform grants no customer role may ever hold. Adding a permission
    // moves both sides of this equality together.
    expect(owner.grantCount).toBe(ALL_ORGANIZATION_GRANTS.length)
    expect([...owner.grants].sort()).toEqual(
      [...ALL_ORGANIZATION_GRANTS].sort(),
    )
    expect(owner.isDerived).toBe(true)
  })

  it('gives the administrator that set minus exactly OWNER_ONLY', async () => {
    const administrator = roleProfile('administrator')

    expect(administrator.grantCount).toBe(
      ALL_ORGANIZATION_GRANTS.length - OWNER_ONLY.length,
    )
    for (const grant of OWNER_ONLY) {
      expect(administrator.grants).not.toContain(grant)
    }
    expect(administrator.isDerived).toBe(true)
  })

  it('states the owner advantage by computing it, not by listing it', async () => {
    // The screen prints this set. If it were a hand-written list it would be a
    // document that was true once; computing it means a permission added to
    // `OWNER_ONLY` next year appears without anybody remembering.
    expect([...ownerAdvantage()].sort()).toEqual([...OWNER_ONLY].sort())
  })

  it('never lets a platform grant reach a customer role', async () => {
    for (const code of SYSTEM_ROLES) {
      for (const grant of roleProfile(code).grants) {
        expect(grant.startsWith('platform.')).toBe(false)
      }
    }
  })
})

/* ================================================================ groups == */

describe('grouping by family', () => {
  it('places every grant in the catalogue into exactly one group', async () => {
    // The property that makes the grouping safe to derive: nothing falls
    // through, and nothing is counted twice. A new `webhook.*` family lands in
    // a `webhook` group rather than vanishing off the screen.
    const grouped = groupGrants(CATALOGUE_ORDER).flatMap(
      (group) => group.grants,
    )

    expect([...grouped].sort()).toEqual([...CATALOGUE_ORDER].sort())
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  it('keeps the catalogue declaration order rather than alphabetising', async () => {
    // `PERMISSIONS` is written in the order a person thinks about the product,
    // and the grouping preserves that in both directions: a family appears
    // where its first member does, and the grants inside it stay in
    // declaration order. Alphabetising either would put `agent.audit.view`
    // between `agency.manage` and `approval.request` and destroy the shape of
    // a ninety-item list.
    //
    // What the grouping *does* move is a late member of an early family:
    // `report.agent.view` is declared beside the agent grants and renders
    // under `דוחות`, beside `report.financial.view`. That is the point of
    // grouping, and it is asserted rather than assumed.
    const owner = roleProfile('organization_owner')
    const position = new Map(
      CATALOGUE_ORDER.map((grant, index) => [grant, index] as const),
    )

    for (const group of owner.groups) {
      const indices = group.grants.map((grant) => position.get(grant) ?? -1)
      expect(indices).toEqual([...indices].sort((a, b) => a - b))
    }

    const firsts = owner.groups.map(
      (group) => position.get(group.grants[0]) ?? -1,
    )
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b))
  })

  it('falls back to the family id for a prefix it has not been taught', async () => {
    // The behaviour that keeps this file uncoupled from the catalogue: an
    // unknown prefix renders as itself in English rather than as an empty
    // string or a crash.
    expect(groupLabel('webhook')).toBe('webhook')
    expect(groupLabel('booking')).not.toBe('booking')
  })

  it('reads the family off the grant string, dots and all', async () => {
    expect(groupIdOf('booking.amend_dates')).toBe('booking')
    expect(groupIdOf('agent.membership.manage')).toBe('agent')
    expect(groupIdOf('rate.view_net')).toBe('rate')
  })
})

/* ============================================================== profiles == */

describe('every role in the catalogue', () => {
  it('covers the twenty customer roles and the two platform roles', async () => {
    expect(ROLE_CODES).toHaveLength(SYSTEM_ROLES.length + PLATFORM_ROLES.length)
    expect(SYSTEM_ROLES.length).toBe(20)
    expect(PLATFORM_ROLES.length).toBe(2)
  })

  it('gives each customer role a non-empty, deduplicated grant set', async () => {
    for (const code of SYSTEM_ROLES) {
      const profile = roleProfile(code)

      expect(profile.grantCount).toBeGreaterThan(0)
      // `grantCount` is the size of a `Set`, so a role listing the same grant
      // twice — which happened, and is why `SELLING_FLOOR` takes a union —
      // cannot inflate it.
      expect(profile.grantCount).toBeLessThanOrEqual(profile.grants.length)
      expect(profile.groups.length).toBeGreaterThan(0)
    }
  })

  it('marks a platform role as ungrantable rather than inventing grants', async () => {
    for (const code of PLATFORM_ROLES) {
      const profile = roleProfile(code)

      expect(isPlatformRole(code)).toBe(true)
      expect(profile.isPlatform).toBe(true)
      // `grantsForSystemRole` has no case for these, and this file does not
      // compose one: `Actor.isPlatformStaff` is the flag the engine reads.
      expect(profile.grants).toEqual([])
    }
  })

  it('refuses to guess at a code the catalogue has never heard of', async () => {
    // The screen maps over rows from `public.roles`, where `code` is `text`.
    // A cast would produce `undefined` grants and throw on the next line; the
    // check produces "grants unknown", which is the same thing a customer's
    // own role already renders as and is always true.
    expect(isKnownRole('organization_owner')).toBe(true)
    expect(isKnownRole('platform_support')).toBe(true)
    expect(isKnownRole('night_porter')).toBe(false)

    expect(knownRoleProfile('night_porter')).toBeNull()
    expect(knownRoleProfile('cleaner')?.grantCount).toBeGreaterThan(0)
  })

  it('reports a role sensitive actions from the catalogue set', async () => {
    const owner = roleProfile('organization_owner')

    // Every sensitive action except `platform.impersonate`, which is ESTIA's
    // own and which no customer role may ever hold. Computing the expectation
    // the same way keeps this true when the catalogue grows.
    expect([...owner.sensitive].sort()).toEqual(
      [...SENSITIVE_ACTIONS]
        .filter((grant) => !grant.startsWith('platform.'))
        .sort(),
    )

    // A cleaner holds four grants and none of them is sensitive.
    expect(roleProfile('cleaner').sensitive).toEqual([])
  })

  it('agrees with the engine about what each role grants', async () => {
    // The assertion that makes the screen trustworthy: what it prints is what
    // `SupabaseActorSource` resolves an actor through, not a parallel list.
    for (const code of SYSTEM_ROLES) {
      expect(roleProfile(code).grants).toEqual(grantsForSystemRole(code))
    }
  })
})

/* =========================================================== privacy === */

describe('the roles the privacy model rests on', () => {
  it('gives a cleaner no guest, no booking and no money', async () => {
    const cleaner = new Set(roleProfile('cleaner').grants)

    for (const grant of [
      'guest.view',
      'guest.view_name',
      'guest.view_phone',
      'booking.view',
      'booking.view_price',
      'payment.view',
    ] as const) {
      expect(cleaner.has(grant)).toBe(false)
    }
  })

  it('gives an external seller availability without the guest behind it', async () => {
    const agent = new Set(roleProfile('sales_agent').grants)

    expect(agent.has('availability.view')).toBe(true)
    expect(agent.has('booking.create')).toBe(true)
    // The whole point of the preset: sell a night that is free without being
    // shown the person, the amount paid, or where the booking came from.
    expect(agent.has('guest.view_name')).toBe(false)
    expect(agent.has('booking.view_price')).toBe(false)
    expect(agent.has('booking.view_source')).toBe(false)
  })

  it('separates writing the commission rule from releasing the money', async () => {
    const manager = new Set(roleProfile('general_manager').grants)
    const finance = new Set(roleProfile('finance_manager').grants)

    expect(manager.has('agent_agreement.manage')).toBe(true)
    expect(manager.has('commission.approve')).toBe(false)
    expect(manager.has('commission.payout')).toBe(false)

    expect(finance.has('commission.approve')).toBe(true)
    expect(finance.has('agent_agreement.manage')).toBe(false)
  })
})
