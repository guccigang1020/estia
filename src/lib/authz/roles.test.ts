/**
 * Role expectations.
 *
 * A role is only a bundle of grants, so every guarantee about a role is a
 * statement about that bundle. These tests are written as the sentences the
 * specification makes — "a cleaner cannot see what a guest paid" — so that
 * somebody who cannot read the role table can still read the promise.
 */

import { describe, expect, it } from 'vitest'
import { authorize, can, type Actor } from './can'
import {
  FIELD_PERMISSIONS,
  PERMISSIONS,
  isPermission,
  type Grant,
} from './permissions'
import {
  OWNER_ONLY,
  SYSTEM_ROLES,
  grantsForRoles,
  grantsForSystemRole,
  type SystemRole,
} from './roles'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'

// ── Helpers ───────────────────────────────────────────────────────────────

const ORG = 'org-a'
const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

const ALL_GRANTS: readonly Grant[] = [...PERMISSIONS, ...FIELD_PERMISSIONS]
const NON_PLATFORM_PERMISSIONS = PERMISSIONS.filter(
  (p) => !p.startsWith('platform.'),
)
const PLATFORM_PERMISSIONS = PERMISSIONS.filter((p) =>
  p.startsWith('platform.'),
)

/** An actor wearing a role, on the richest plan, with organization-wide reach. */
function actorInRole(role: SystemRole, overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'user-1',
    organizationId: ORG,
    membershipStatus: 'active',
    grants: grantsForRoles([role]),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
    ...overrides,
  }
}

function holds(role: SystemRole, grant: Grant): boolean {
  return grantsForSystemRole(role).includes(grant)
}

const RESOURCE = { organizationId: ORG, propertyId: 'prop-1' }

// ── The sharpest privacy case: the cleaner ────────────────────────────────

describe('cleaner', () => {
  const cleaner = actorInRole('cleaner')

  it('denies a cleaner access to financial reports', () => {
    expect(authorize(cleaner, 'report.financial.view', RESOURCE)).toMatchObject(
      {
        reason: 'missing_permission',
      },
    )
  })

  it.each(['finance.view', 'payment.view', 'report.financial.view'] as const)(
    'denies a cleaner the finance grant "%s"',
    (grant) => {
      expect(can(cleaner, grant, RESOURCE)).toBe(false)
    },
  )

  it('denies a cleaner the export of guests', () => {
    expect(authorize(cleaner, 'guest.export', RESOURCE)).toMatchObject({
      reason: 'missing_permission',
      grant: 'guest.export',
    })
  })

  it('denies a cleaner the guest contact details, which their work does not need', () => {
    expect(can(cleaner, 'guest.view_contact', RESOURCE)).toBe(false)
  })

  it('denies a cleaner the price of a booking', () => {
    expect(can(cleaner, 'booking.view_price', RESOURCE)).toBe(false)
  })

  it('denies a cleaner every guest grant, including simply viewing a guest record', () => {
    const guestGrants = ALL_GRANTS.filter((g) => g.startsWith('guest.'))
    const held = guestGrants.filter((g) => can(cleaner, g, RESOURCE))

    expect(held, 'guest grants a cleaner should not hold').toEqual([])
  })

  it('denies a cleaner every finance grant in the catalogue', () => {
    const financeGrants = ALL_GRANTS.filter(
      (g) =>
        g.startsWith('finance.') ||
        g.startsWith('payment.') ||
        g.startsWith('invoice.') ||
        g.startsWith('deposit.') ||
        g.startsWith('report.financial') ||
        g.startsWith('owner'),
    )
    const held = financeGrants.filter((g) => can(cleaner, g, RESOURCE))

    expect(held, 'finance grants a cleaner should not hold').toEqual([])
  })

  it('allows a cleaner the task work they were hired for', () => {
    expect(can(cleaner, 'task.view', RESOURCE)).toBe(true)
    expect(can(cleaner, 'task.complete', RESOURCE)).toBe(true)
    expect(can(cleaner, 'incident.create', RESOURCE)).toBe(true)
  })
})

// ── Read-only finance: the accountant ─────────────────────────────────────

describe('accountant', () => {
  const accountant = actorInRole('accountant')

  it('denies an accountant the changing of booking dates', () => {
    expect(authorize(accountant, 'booking.update', RESOURCE)).toMatchObject({
      reason: 'missing_permission',
      grant: 'booking.update',
    })
  })

  it('denies an accountant the cancelling of a booking', () => {
    expect(authorize(accountant, 'booking.cancel', RESOURCE)).toMatchObject({
      reason: 'missing_permission',
      grant: 'booking.cancel',
    })
  })

  it('denies an accountant every operational write on a booking', () => {
    const writes: readonly Grant[] = [
      'booking.create',
      'booking.update',
      'booking.cancel',
      'booking.delete',
      'booking.change_status',
      'booking.override_price',
      'booking.override_availability',
      'booking.assign',
    ]
    const held = writes.filter((g) => can(accountant, g, RESOURCE))

    expect(held, 'booking writes an accountant should not hold').toEqual([])
  })

  it('allows an accountant to read and export the financial record', () => {
    expect(can(accountant, 'report.financial.view', RESOURCE)).toBe(true)
    expect(can(accountant, 'report.financial.export', RESOURCE)).toBe(true)
    expect(can(accountant, 'booking.view', RESOURCE)).toBe(true)
  })
})

// ── The front desk: reception ─────────────────────────────────────────────

describe('reception', () => {
  const reception = actorInRole('reception')

  it('denies reception the profitability of a booking', () => {
    expect(
      authorize(reception, 'booking.view_profitability', RESOURCE),
    ).toMatchObject({
      reason: 'missing_permission',
      grant: 'booking.view_profitability',
    })
  })

  it('denies reception the export of bookings', () => {
    expect(authorize(reception, 'booking.export', RESOURCE)).toMatchObject({
      reason: 'missing_permission',
      grant: 'booking.export',
    })
  })

  it('denies reception the export of guests', () => {
    expect(can(reception, 'guest.export', RESOURCE)).toBe(false)
  })

  it('denies reception the wider financial reporting', () => {
    expect(can(reception, 'finance.view', RESOURCE)).toBe(false)
    expect(can(reception, 'report.financial.view', RESOURCE)).toBe(false)
  })

  it('allows reception the guest contact and the price they need at the desk', () => {
    expect(can(reception, 'guest.view_contact', RESOURCE)).toBe(true)
    expect(can(reception, 'booking.view_price', RESOURCE)).toBe(true)
  })
})

// ── Marketing ─────────────────────────────────────────────────────────────

describe('marketing_editor', () => {
  const marketing = actorInRole('marketing_editor')

  it('denies a marketing editor any access to bookings', () => {
    const bookingGrants = ALL_GRANTS.filter((g) => g.startsWith('booking.'))
    const held = bookingGrants.filter((g) => can(marketing, g, RESOURCE))

    expect(held, 'booking grants a marketing editor should not hold').toEqual(
      [],
    )
  })

  it('denies a marketing editor any access to finance', () => {
    const financeGrants = ALL_GRANTS.filter(
      (g) =>
        g.startsWith('finance.') ||
        g.startsWith('payment.') ||
        g.startsWith('invoice.') ||
        g.startsWith('expense.') ||
        g.startsWith('deposit.') ||
        g.startsWith('report.financial'),
    )
    const held = financeGrants.filter((g) => can(marketing, g, RESOURCE))

    expect(held, 'finance grants a marketing editor should not hold').toEqual(
      [],
    )
  })

  it('denies a marketing editor any access to guests', () => {
    const guestGrants = ALL_GRANTS.filter((g) => g.startsWith('guest.'))
    const held = guestGrants.filter((g) => can(marketing, g, RESOURCE))

    expect(held, 'guest grants a marketing editor should not hold').toEqual([])
  })

  it("denies a marketing editor the publishing of the site, which is a manager's decision", () => {
    expect(can(marketing, 'site.publish', RESOURCE)).toBe(false)
    expect(can(marketing, 'site.rollback', RESOURCE)).toBe(false)
    expect(can(marketing, 'site.manage_domain', RESOURCE)).toBe(false)
  })

  it('allows a marketing editor to write and design the site', () => {
    expect(can(marketing, 'site.edit_content', RESOURCE)).toBe(true)
    expect(can(marketing, 'site.edit_design', RESOURCE)).toBe(true)
    expect(can(marketing, 'site.manage_seo', RESOURCE)).toBe(true)
  })
})

// ── External parties ──────────────────────────────────────────────────────

describe('property_owner', () => {
  it('denies a property owner any team management', () => {
    const owner = actorInRole('property_owner')
    const teamGrants: readonly Grant[] = [
      'user.view',
      'user.invite',
      'user.edit',
      'user.suspend',
      'user.remove',
      'role.create',
      'role.assign',
      'permission.edit',
      'team.manage',
    ]
    const held = teamGrants.filter((g) => can(owner, g, RESOURCE))

    expect(held, 'team grants a property owner should not hold').toEqual([])
  })

  it('denies a property owner a property that is not theirs', () => {
    const owner = actorInRole('property_owner', {
      scope: { kind: 'properties', propertyIds: ['prop-mine'] },
    })

    const decision = authorize(owner, 'property.view', {
      organizationId: ORG,
      propertyId: 'prop-someone-elses',
    })

    expect(decision).toEqual({
      allowed: false,
      reason: 'out_of_scope',
      grant: 'property.view',
    })
  })

  it('allows a property owner their own property', () => {
    const owner = actorInRole('property_owner', {
      scope: { kind: 'properties', propertyIds: ['prop-mine'] },
    })

    expect(
      authorize(owner, 'property.view', {
        organizationId: ORG,
        propertyId: 'prop-mine',
      }),
    ).toEqual({ allowed: true })
  })

  it('denies a property owner the organization-wide statement list that carries no property', () => {
    const owner = actorInRole('property_owner', {
      scope: { kind: 'properties', propertyIds: ['prop-mine'] },
    })

    expect(can(owner, 'owner_statement.view', { organizationId: ORG })).toBe(
      false,
    )
  })
})

describe('external_vendor', () => {
  it('holds only task grants and nothing else', () => {
    const grants = grantsForSystemRole('external_vendor')
    const nonTask = grants.filter((g) => !g.startsWith('task.'))

    expect(nonTask, 'non-task grants held by an external vendor').toEqual([])
    expect([...grants].sort()).toEqual(
      ['task.complete', 'task.update', 'task.view'].sort(),
    )
  })

  it('denies an external vendor every grant outside the task family', () => {
    const vendor = actorInRole('external_vendor')
    const held = ALL_GRANTS.filter(
      (g) => !g.startsWith('task.') && can(vendor, g, RESOURCE),
    )

    expect(held, 'grants an external vendor should not hold').toEqual([])
  })

  it('denies an external vendor a task that is not theirs, when scoped to their own records', () => {
    const vendor = actorInRole('external_vendor', {
      scope: { kind: 'own_records' },
    })

    expect(
      can(vendor, 'task.view', {
        organizationId: ORG,
        assignedToUserId: 'somebody-else',
      }),
    ).toBe(false)
    expect(
      can(vendor, 'task.view', {
        organizationId: ORG,
        assignedToUserId: 'user-1',
      }),
    ).toBe(true)
  })
})

// ── The senior roles ──────────────────────────────────────────────────────

describe('administrator', () => {
  const administrator = actorInRole('administrator')

  it.each(OWNER_ONLY)(
    'denies an administrator the owner-only grant "%s"',
    (grant) => {
      expect(authorize(administrator, grant, RESOURCE)).toMatchObject({
        reason: 'missing_permission',
        grant,
      })
    },
  )

  it('holds every organization grant except the four reserved to the owner', () => {
    const expected = [...NON_PLATFORM_PERMISSIONS, ...FIELD_PERMISSIONS].filter(
      (g) => !OWNER_ONLY.includes(g),
    )
    const actual = grantsForSystemRole('administrator')

    expect([...actual].sort()).toEqual([...expected].sort())
  })

  it('holds no missing grant from the organization catalogue outside the owner-only four', () => {
    const missing = [...NON_PLATFORM_PERMISSIONS, ...FIELD_PERMISSIONS].filter(
      (g) => !OWNER_ONLY.includes(g) && !can(administrator, g, RESOURCE),
    )

    expect(missing, 'organization grants an administrator is missing').toEqual(
      [],
    )
  })

  it('holds no platform grant', () => {
    const held = PLATFORM_PERMISSIONS.filter((g) => holds('administrator', g))

    expect(held, 'platform grants held by an administrator').toEqual([])
  })
})

describe('organization_owner', () => {
  const owner = actorInRole('organization_owner')

  it('holds every non-platform grant in the catalogue', () => {
    const missing = [...NON_PLATFORM_PERMISSIONS, ...FIELD_PERMISSIONS].filter(
      (g) => !can(owner, g, RESOURCE),
    )

    expect(missing, 'organization grants the owner is missing').toEqual([])
  })

  it('holds each of the four owner-only grants that an administrator does not', () => {
    for (const grant of OWNER_ONLY) {
      expect(can(owner, grant, RESOURCE), `owner should hold ${grant}`).toBe(
        true,
      )
    }
  })

  it('holds no platform grant, because ownership of a customer organization is not staff access', () => {
    const held = PLATFORM_PERMISSIONS.filter((g) =>
      holds('organization_owner', g),
    )

    expect(held, 'platform grants held by an organization owner').toEqual([])
  })

  it('is still denied a plan-gated feature the organization has not bought', () => {
    const onCorePlan = actorInRole('organization_owner', {
      entitlements: new Set<Entitlement>(['core']),
    })

    expect(authorize(onCorePlan, 'site.publish', RESOURCE)).toMatchObject({
      reason: 'plan_does_not_include',
      entitlement: 'website',
    })
  })
})

// ── Catalogue-wide invariants ─────────────────────────────────────────────

describe('no customer role holds a platform grant', () => {
  it.each(SYSTEM_ROLES)('grants no platform permission to "%s"', (role) => {
    const held = grantsForSystemRole(role).filter((g) =>
      g.startsWith('platform.'),
    )

    expect(held, `platform grants held by ${role}`).toEqual([])
  })

  it('grants no platform permission to any combination of system roles', () => {
    const everything = grantsForRoles(SYSTEM_ROLES)
    const held = [...everything].filter((g) => g.startsWith('platform.'))

    expect(
      held,
      'platform grants reachable by stacking every system role',
    ).toEqual([])
  })
})

describe('every role is built from the catalogue', () => {
  it.each(SYSTEM_ROLES)(
    'grants "%s" only strings that exist in the catalogue',
    (role) => {
      const known = new Set<string>(ALL_GRANTS)
      const unknown = grantsForSystemRole(role).filter((g) => !known.has(g))

      expect(unknown, `unrecognised grants in ${role}`).toEqual([])
    },
  )

  it('recognises every catalogue permission through isPermission()', () => {
    const unrecognised = PERMISSIONS.filter((p) => !isPermission(p))

    expect(unrecognised).toEqual([])
  })

  it('does not recognise a field permission as a permission, since the two lists are distinct', () => {
    expect(isPermission('booking.view_price')).toBe(false)
  })

  it('does not recognise an invented string as a permission', () => {
    expect(isPermission('booking.do_whatever')).toBe(false)
  })
})

describe('privacy by minimum necessity for operational roles', () => {
  const operationalRoles: readonly SystemRole[] = [
    'cleaner',
    'maintenance',
    'external_vendor',
    'housekeeping_supervisor',
  ]

  const forbidden: readonly Grant[] = [
    'guest.view_contact',
    'guest.view_document_id',
    'booking.view_price',
    'booking.view_deposit',
    'booking.view_profitability',
    'owner.view_commission',
    'guest.export',
    'finance.view',
    'payment.view',
    'report.financial.view',
  ]

  it.each(operationalRoles)(
    'withholds guest contact details and money from "%s"',
    (role) => {
      const held = forbidden.filter((g) => holds(role, g))

      expect(held, `sensitive grants held by ${role}`).toEqual([])
    },
  )
})

describe('grantsForRoles()', () => {
  it('returns the union of the grants held across several roles', () => {
    const union = grantsForRoles(['cleaner', 'accountant'])

    expect(union.has('task.complete')).toBe(true)
    expect(union.has('report.financial.view')).toBe(true)
  })

  it('returns nothing for a membership with no roles, denying by default', () => {
    expect(grantsForRoles([]).size).toBe(0)
  })

  it('does not duplicate a grant held by two of the roles', () => {
    const union = grantsForRoles(['cleaner', 'maintenance'])
    const shared = [...union].filter((g) => g === 'task.view')

    expect(shared).toEqual(['task.view'])
  })

  it('does not let a combination of roles reach an owner-only grant', () => {
    const union = grantsForRoles(
      SYSTEM_ROLES.filter(
        (r) => r !== 'organization_owner' && r !== 'administrator',
      ),
    )
    const held = OWNER_ONLY.filter((g) => union.has(g))

    expect(
      held,
      'owner-only grants reachable by stacking composed roles',
    ).toEqual([])
  })
})
