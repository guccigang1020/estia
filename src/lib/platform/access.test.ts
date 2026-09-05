import { describe, expect, it } from 'vitest'

import { grantsForSystemRole } from '@/lib/authz/roles'
import type { Grant } from '@/lib/authz/permissions'

import { mayUse, platformAccess } from './access'
import {
  PLATFORM_GRANTS,
  platformActorLabel,
  platformGrants,
  type PlatformSession,
} from './staff'

/**
 * The console's refusals, proven rather than asserted in a comment.
 *
 * The claims that matter here are negative ones — "a customer cannot reach
 * this" — and a negative claim about access is the kind that looks obviously
 * true in a code review and is obviously false in production. So each of them
 * is a test with the actual grant sets the product ships.
 */

function session(grants: readonly string[]): PlatformSession {
  return {
    staffId: 'staff-1',
    userId: 'user-1',
    role: 'platform_super_admin',
    roleName: 'מנהל-על ESTIA',
    grants: platformGrants(grants),
    displayName: 'דנה כהן',
  }
}

describe('platformAccess', () => {
  it('refuses a signed-out visitor before anything else is considered', () => {
    expect(platformAccess(null, false, null)).toEqual({ outcome: 'sign_in' })

    // Even holding a session object. Signed out wins, because the session
    // could only have come from a request that is no longer authenticated.
    expect(platformAccess(session([...PLATFORM_GRANTS]), false, null)).toEqual({
      outcome: 'sign_in',
    })
  })

  it('answers a signed-in non-staff caller with not_staff, never with denied', () => {
    // The distinction is the whole point: `denied` would confirm that the
    // route exists and that there is something behind it to be refused from.
    expect(platformAccess(null, true, 'platform.organization.view')).toEqual({
      outcome: 'not_staff',
    })
    expect(platformAccess(null, true, null)).toEqual({ outcome: 'not_staff' })
  })

  it('admits staff to a route that requires nothing beyond being staff', () => {
    const staff = session(['platform.organization.view'])
    expect(platformAccess(staff, true, null)).toEqual({
      outcome: 'allow',
      session: staff,
    })
  })

  it('refuses a support role the grants only a super admin holds', () => {
    // This is the shipped split: 0002 and 0012 give platform_support exactly
    // `platform.organization.view` and platform_super_admin every platform.*.
    const support = session(['platform.organization.view'])

    expect(platformAccess(support, true, 'platform.organization.view')).toEqual(
      { outcome: 'allow', session: support },
    )
    expect(
      platformAccess(support, true, 'platform.organization.manage'),
    ).toEqual({ outcome: 'denied', grant: 'platform.organization.manage' })
    expect(platformAccess(support, true, 'platform.impersonate')).toEqual({
      outcome: 'denied',
      grant: 'platform.impersonate',
    })
  })

  it('admits a super admin to every platform grant in the catalogue', () => {
    const admin = session([...PLATFORM_GRANTS])
    for (const grant of PLATFORM_GRANTS) {
      expect(platformAccess(admin, true, grant).outcome).toBe('allow')
    }
  })
})

describe('the grant sets are disjoint', () => {
  /**
   * The property the whole console rests on, checked against the real role
   * definitions rather than against a fixture. If a `platform.*` code ever
   * appeared in a customer role, an organization owner would start satisfying
   * the console's own guard.
   */
  it('gives no customer role a platform grant', () => {
    const roles = [
      'organization_owner',
      'administrator',
      'general_manager',
      'property_manager',
      'agency_manager',
    ] as const

    for (const role of roles) {
      const held = grantsForSystemRole(role)
      const platform = held.filter((grant: Grant) =>
        grant.startsWith('platform.'),
      )
      expect(platform, `${role} holds ${platform.join(', ')}`).toEqual([])
    }
  })

  it('narrows a roster row that somehow carried a customer permission', () => {
    // Three database refusals stand in front of this. It is still checked,
    // because "impossible" plus "unchecked" is how an empty grant set becomes
    // a full one somewhere else.
    const smuggled = platformGrants([
      'platform.organization.view',
      'booking.delete',
      'payment.refund',
      'guest.view_email',
    ])

    expect([...smuggled]).toEqual(['platform.organization.view'])
  })

  it('produces an empty grant set from an empty role', () => {
    const orphan = session([])
    expect(orphan.grants.size).toBe(0)
    expect(platformAccess(orphan, true, 'platform.organization.view')).toEqual({
      outcome: 'denied',
      grant: 'platform.organization.view',
    })
  })
})

describe('mayUse', () => {
  it('agrees with platformAccess on every platform grant', () => {
    const support = session(['platform.organization.view'])

    for (const grant of PLATFORM_GRANTS) {
      const allowed = platformAccess(support, true, grant).outcome === 'allow'
      expect(mayUse(support, grant)).toBe(allowed)
    }
  })
})

describe('platformActorLabel', () => {
  it('names ESTIA first, so the row cannot be mistaken for a colleague', () => {
    expect(platformActorLabel(session([]))).toBe('ESTIA · דנה כהן')
  })

  it('falls back to the role name rather than inventing one', () => {
    const anonymous: PlatformSession = {
      ...session([]),
      displayName: null,
    }
    expect(platformActorLabel(anonymous)).toBe('ESTIA · מנהל-על ESTIA')
  })
})
