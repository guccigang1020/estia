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
  SENSITIVE_ACTIONS,
  isPermission,
  type Grant,
} from './permissions'
import {
  CALENDAR_LEVELS,
  GUEST_DATA_LEVELS,
  OWNER_ONLY,
  PRICE_LEVELS,
  SYSTEM_ROLES,
  grantsForCalendarLevel,
  grantsForGuestDataLevel,
  grantsForPriceLevel,
  grantsForRoles,
  grantsForSystemRole,
  type CalendarLevel,
  type GuestDataLevel,
  type PriceLevel,
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
    expect(can(cleaner, 'guest.view_phone', RESOURCE)).toBe(false)
    expect(can(cleaner, 'guest.view_email', RESOURCE)).toBe(false)
  })

  it("denies a cleaner even the guest's name, which is not covered by the contact fields", () => {
    expect(can(cleaner, 'guest.view_name', RESOURCE)).toBe(false)
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
    expect(can(reception, 'guest.view_name', RESOURCE)).toBe(true)
    expect(can(reception, 'guest.view_phone', RESOURCE)).toBe(true)
    expect(can(reception, 'guest.view_email', RESOURCE)).toBe(true)
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

// ── The agent network ─────────────────────────────────────────────────────

/**
 * External sellers are members of the organization with a narrow role and a
 * narrow scope. Everything below is a statement about that narrowness, because
 * the whole risk of an agent network is that an outsider is handed the inside
 * of the business by accident.
 */

const AGENT_ROLES: readonly SystemRole[] = [
  'referral_agent',
  'sales_agent',
  'senior_agent',
  'agency_manager',
]

/** A booking somebody else in the network sold. */
const ANOTHER_AGENTS_RECORD = {
  organizationId: ORG,
  createdByUserId: 'agent-2',
  assignedToUserId: 'agent-2',
}

/** A booking this agent sold. */
const OWN_RECORD = {
  organizationId: ORG,
  createdByUserId: 'user-1',
  assignedToUserId: 'user-1',
}

describe('referral_agent', () => {
  const referral = actorInRole('referral_agent')

  it('denies a referral agent sight of availability, which is the entire point of the preset', () => {
    expect(authorize(referral, 'availability.view', RESOURCE)).toMatchObject({
      reason: 'missing_permission',
      grant: 'availability.view',
    })
  })

  it('denies a referral agent the creating of a hold', () => {
    expect(authorize(referral, 'hold.create', RESOURCE)).toMatchObject({
      reason: 'missing_permission',
      grant: 'hold.create',
    })
  })

  it('denies a referral agent the creating of a booking', () => {
    expect(authorize(referral, 'booking.create', RESOURCE)).toMatchObject({
      reason: 'missing_permission',
      grant: 'booking.create',
    })
  })

  it('denies a referral agent every rate, the public one included', () => {
    expect(can(referral, 'rate.view_public', RESOURCE)).toBe(false)
    expect(can(referral, 'rate.view_agent', RESOURCE)).toBe(false)
    expect(can(referral, 'rate.view_net', RESOURCE)).toBe(false)
  })

  it('denies a referral agent every calendar, hold, quote and booking grant in the catalogue', () => {
    const calendarGrants = ALL_GRANTS.filter(
      (g) =>
        g.startsWith('availability.') ||
        g.startsWith('hold.') ||
        g.startsWith('quote.') ||
        g.startsWith('booking.') ||
        g.startsWith('rate.'),
    )
    const held = calendarGrants.filter((g) => can(referral, g, RESOURCE))

    expect(held, 'calendar grants a referral agent should not hold').toEqual([])
  })

  it('allows a referral agent the lead they were recruited to bring, and their own pay', () => {
    expect(can(referral, 'lead.create', RESOURCE)).toBe(true)
    expect(can(referral, 'lead.view', RESOURCE)).toBe(true)
    expect(can(referral, 'commission.view', RESOURCE)).toBe(true)
    expect(can(referral, 'agent_statement.view', RESOURCE)).toBe(true)
  })

  it('holds those five grants and nothing else at all', () => {
    expect([...grantsForSystemRole('referral_agent')].sort()).toEqual(
      [
        'lead.view',
        'lead.create',
        'commission.view',
        'agent_statement.view',
        // Even the narrowest agent can ask. A cap that refuses outright ends
        // the conversation; one that raises an approval keeps the sale here.
        'approval.request',
      ].sort(),
    )
  })
})

describe('sales_agent', () => {
  const sales = actorInRole('sales_agent')

  it('allows a sales agent to see that a date is taken', () => {
    expect(authorize(sales, 'availability.view', RESOURCE)).toEqual({
      allowed: true,
    })
  })

  it("denies a sales agent the guest's name, while still letting them enter a guest of their own", () => {
    expect(can(sales, 'guest.view_name', RESOURCE)).toBe(false)
    expect(can(sales, 'guest.create', RESOURCE)).toBe(true)
  })

  it('denies a sales agent the amount the guest paid', () => {
    expect(authorize(sales, 'booking.view_price', RESOURCE)).toMatchObject({
      reason: 'missing_permission',
      grant: 'booking.view_price',
    })
  })

  it('denies a sales agent the source the booking came through', () => {
    expect(authorize(sales, 'booking.view_source', RESOURCE)).toMatchObject({
      reason: 'missing_permission',
      grant: 'booking.view_source',
    })
  })

  it('allows a sales agent the agent rate and denies them the net rate', () => {
    expect(can(sales, 'rate.view_public', RESOURCE)).toBe(true)
    expect(can(sales, 'rate.view_agent', RESOURCE)).toBe(true)
    expect(can(sales, 'rate.view_net', RESOURCE)).toBe(false)
  })

  it('allows a sales agent to quote, hold and book, which is the job', () => {
    expect(can(sales, 'quote.create', RESOURCE)).toBe(true)
    expect(can(sales, 'quote.send', RESOURCE)).toBe(true)
    expect(can(sales, 'hold.create', RESOURCE)).toBe(true)
    expect(can(sales, 'hold.release', RESOURCE)).toBe(true)
    expect(can(sales, 'booking.create', RESOURCE)).toBe(true)
  })

  it('denies a sales agent the amending of a booking, which belongs to the senior preset', () => {
    expect(can(sales, 'booking.amend_dates', RESOURCE)).toBe(false)
    expect(can(sales, 'booking.amend_price', RESOURCE)).toBe(false)
    expect(can(sales, 'booking.amend_guest_count', RESOURCE)).toBe(false)
    expect(can(sales, 'booking.amend_extras', RESOURCE)).toBe(false)
    expect(can(sales, 'booking.cancel', RESOURCE)).toBe(false)
    expect(can(sales, 'booking.update', RESOURCE)).toBe(false)
  })

  it("denies a sales agent the correcting of a guest's details after the booking exists, which is its own right", () => {
    expect(can(sales, 'guest.create', RESOURCE)).toBe(true)
    expect(can(sales, 'guest.update', RESOURCE)).toBe(false)
  })

  it('denies a sales agent the requesting of a payment link', () => {
    expect(can(sales, 'payment.request_link', RESOURCE)).toBe(false)
  })

  it("denies a sales agent another agent's booking when scoped to their own records", () => {
    const scoped = actorInRole('sales_agent', {
      scope: { kind: 'own_records' },
    })

    expect(authorize(scoped, 'booking.view', ANOTHER_AGENTS_RECORD)).toEqual({
      allowed: false,
      reason: 'out_of_scope',
      grant: 'booking.view',
    })
  })

  it("denies a sales agent another agent's commission when scoped to their own records", () => {
    const scoped = actorInRole('sales_agent', {
      scope: { kind: 'own_records' },
    })

    expect(
      authorize(scoped, 'commission.view', ANOTHER_AGENTS_RECORD),
    ).toMatchObject({ reason: 'out_of_scope' })
    expect(
      authorize(scoped, 'agent_statement.view', ANOTHER_AGENTS_RECORD),
    ).toMatchObject({ reason: 'out_of_scope' })
  })

  it('allows the same agent their own booking and their own commission, so the denial is about ownership and not about the grant', () => {
    const scoped = actorInRole('sales_agent', {
      scope: { kind: 'own_records' },
    })

    expect(authorize(scoped, 'booking.view', OWN_RECORD)).toEqual({
      allowed: true,
    })
    expect(authorize(scoped, 'commission.view', OWN_RECORD)).toEqual({
      allowed: true,
    })
  })

  it('denies an own-records agent the organization-wide commission list that belongs to nobody', () => {
    const scoped = actorInRole('sales_agent', {
      scope: { kind: 'own_records' },
    })

    expect(can(scoped, 'commission.view', { organizationId: ORG })).toBe(false)
  })
})

describe('senior_agent', () => {
  const senior = actorInRole('senior_agent')

  it('allows a senior agent the amendments a sales agent is refused', () => {
    expect(can(senior, 'guest.update', RESOURCE)).toBe(true)
    expect(can(senior, 'booking.amend_dates', RESOURCE)).toBe(true)
    expect(can(senior, 'booking.amend_guest_count', RESOURCE)).toBe(true)
    expect(can(senior, 'booking.amend_extras', RESOURCE)).toBe(true)
    expect(can(senior, 'booking.amend_price', RESOURCE)).toBe(true)
    expect(can(senior, 'booking.cancel', RESOURCE)).toBe(true)
  })

  it('allows a senior agent a payment link and the coarse payment status', () => {
    expect(can(senior, 'payment.request_link', RESOURCE)).toBe(true)
    expect(can(senior, 'booking.view_payment_status', RESOURCE)).toBe(true)
  })

  it('denies a senior agent the payment record behind that status', () => {
    expect(can(senior, 'payment.view', RESOURCE)).toBe(false)
    expect(can(senior, 'payment.create', RESOURCE)).toBe(false)
    expect(can(senior, 'booking.view_deposit', RESOURCE)).toBe(false)
    expect(can(senior, 'booking.view_price', RESOURCE)).toBe(false)
  })

  it('denies a senior agent the net rate, which is the agency preset and above', () => {
    expect(can(senior, 'rate.view_net', RESOURCE)).toBe(false)
  })

  it('denies a senior agent the deleting of a booking, however senior the name sounds', () => {
    expect(can(senior, 'booking.delete', RESOURCE)).toBe(false)
  })
})

describe('agency_manager', () => {
  const agency = actorInRole('agency_manager')

  it('allows an agency manager the net rate that no other agent preset holds', () => {
    expect(can(agency, 'rate.view_net', RESOURCE)).toBe(true)

    const others = AGENT_ROLES.filter((r) => r !== 'agency_manager')
    const leaked = others.filter((r) => holds(r, 'rate.view_net'))

    expect(
      leaked,
      'agent presets other than the agency holding the net rate',
    ).toEqual([])
  })

  it('allows an agency manager to see and invite the agents beneath them', () => {
    expect(can(agency, 'agent.view', RESOURCE)).toBe(true)
    expect(can(agency, 'agent.invite', RESOURCE)).toBe(true)
    expect(can(agency, 'lead.assign', RESOURCE)).toBe(true)
    expect(can(agency, 'report.agent.view', RESOURCE)).toBe(true)
  })

  it('allows an agency manager to read the agreement they are paid under', () => {
    expect(can(agency, 'agent_agreement.view', RESOURCE)).toBe(true)
  })

  it('denies an agency manager the writing of the commission rule they are paid by', () => {
    expect(authorize(agency, 'agent_agreement.manage', RESOURCE)).toMatchObject(
      {
        reason: 'missing_permission',
        grant: 'agent_agreement.manage',
      },
    )
  })

  it('denies an agency manager the approving and the paying of their own commission', () => {
    expect(can(agency, 'commission.approve', RESOURCE)).toBe(false)
    expect(can(agency, 'commission.payout', RESOURCE)).toBe(false)
    expect(can(agency, 'agent_statement.issue', RESOURCE)).toBe(false)
  })

  it('denies an agency manager the approving of the bookings their own agents make', () => {
    expect(can(agency, 'agent_booking.approve', RESOURCE)).toBe(false)
  })

  it("denies an agency manager the setting of an agent's inventory scope, which is the blast radius", () => {
    expect(can(agency, 'agent.scope.manage', RESOURCE)).toBe(false)
    expect(can(agency, 'agent.manage', RESOURCE)).toBe(false)
    expect(can(agency, 'agency.manage', RESOURCE)).toBe(false)
    expect(can(agency, 'agent_limits.manage', RESOURCE)).toBe(false)
  })

  it('denies an agency manager the agent audit trail', () => {
    expect(can(agency, 'agent.audit.view', RESOURCE)).toBe(false)
  })

  it("denies an agency manager the guest's email, so the business keeps its own channel to the guest", () => {
    expect(can(agency, 'guest.view_name', RESOURCE)).toBe(true)
    expect(can(agency, 'guest.view_phone', RESOURCE)).toBe(true)
    expect(can(agency, 'guest.view_email', RESOURCE)).toBe(false)
  })
})

describe('no agent preset reaches the rest of the business', () => {
  const financeGrants = ALL_GRANTS.filter(
    (g) =>
      g.startsWith('finance.') ||
      g.startsWith('payment.view') ||
      g.startsWith('payment.capture') ||
      g.startsWith('payment.refund') ||
      g.startsWith('payment.void') ||
      g.startsWith('invoice.') ||
      g.startsWith('expense.') ||
      g.startsWith('deposit.') ||
      g.startsWith('report.financial') ||
      g.startsWith('owner'),
  )

  const operationsGrants = ALL_GRANTS.filter(
    (g) =>
      g.startsWith('task.') ||
      g.startsWith('checklist.') ||
      g.startsWith('inventory.') ||
      g.startsWith('incident.'),
  )

  const teamGrants = ALL_GRANTS.filter(
    (g) =>
      g.startsWith('user.') ||
      g.startsWith('role.') ||
      g.startsWith('permission.') ||
      g.startsWith('team.'),
  )

  const propertyGrants = ALL_GRANTS.filter(
    (g) =>
      g.startsWith('property.') ||
      g.startsWith('unit.') ||
      g.startsWith('organization.') ||
      g.startsWith('pricing.') ||
      g.startsWith('channel.') ||
      g.startsWith('site.') ||
      g.startsWith('integration.') ||
      g.startsWith('automation.'),
  )

  it.each(AGENT_ROLES)('denies "%s" every finance grant', (role) => {
    const held = financeGrants.filter((g) => holds(role, g))

    expect(held, `finance grants held by ${role}`).toEqual([])
  })

  it.each(AGENT_ROLES)(
    'denies "%s" every operations and housekeeping grant',
    (role) => {
      const held = operationsGrants.filter((g) => holds(role, g))

      expect(held, `operations grants held by ${role}`).toEqual([])
    },
  )

  it.each(AGENT_ROLES)('denies "%s" every team and access grant', (role) => {
    const held = teamGrants.filter((g) => holds(role, g))

    expect(held, `team grants held by ${role}`).toEqual([])
  })

  it.each(AGENT_ROLES)(
    'denies "%s" every property, organization and channel setting',
    (role) => {
      const held = propertyGrants.filter((g) => holds(role, g))

      expect(held, `settings grants held by ${role}`).toEqual([])
    },
  )

  it.each(AGENT_ROLES)('denies "%s" every platform grant', (role) => {
    const held = PLATFORM_PERMISSIONS.filter((g) => holds(role, g))

    expect(held, `platform grants held by ${role}`).toEqual([])
  })

  it('grants no platform permission to every agent preset stacked together', () => {
    const everything = grantsForRoles(AGENT_ROLES)
    const held = [...everything].filter((g) => g.startsWith('platform.'))

    expect(
      held,
      'platform grants reachable by stacking the agent presets',
    ).toEqual([])
  })

  it.each(AGENT_ROLES)(
    'denies "%s" the guest documents, the guest list and the export of either',
    (role) => {
      expect(holds(role, 'guest.view_document_id')).toBe(false)
      expect(holds(role, 'guest.view')).toBe(false)
      expect(holds(role, 'guest.export')).toBe(false)
      expect(holds(role, 'booking.export')).toBe(false)
    },
  )

  it.each(AGENT_ROLES)('denies "%s" the deleting of any record', (role) => {
    const deletions = ALL_GRANTS.filter((g) => g.endsWith('.delete'))
    const held = deletions.filter((g) => holds(role, g))

    expect(held, `deletions held by ${role}`).toEqual([])
  })

  it.each(AGENT_ROLES)(
    'denies "%s" the profitability of a booking and the internal notes on it',
    (role) => {
      expect(holds(role, 'booking.view_profitability')).toBe(false)
      expect(holds(role, 'booking.note.internal')).toBe(false)
    },
  )

  it.each(AGENT_ROLES)(
    'denies "%s" the audit log of the organization',
    (role) => {
      expect(holds(role, 'audit.view')).toBe(false)
      expect(holds(role, 'agent.audit.view')).toBe(false)
    },
  )
})

describe('the ladders make an incoherent grant unrepresentable', () => {
  it('never yields the net rate without the agent rate and the public rate', () => {
    for (const level of PRICE_LEVELS) {
      const grants = grantsForPriceLevel(level)
      if (!grants.includes('rate.view_net')) continue

      expect(grants, `price level ${level}`).toContain('rate.view_agent')
      expect(grants, `price level ${level}`).toContain('rate.view_public')
    }
  })

  it('never yields the agent rate without the public rate', () => {
    for (const level of PRICE_LEVELS) {
      const grants = grantsForPriceLevel(level)
      if (!grants.includes('rate.view_agent')) continue

      expect(grants, `price level ${level}`).toContain('rate.view_public')
    }
  })

  it('never yields booking creation without sight of availability', () => {
    for (const level of CALENDAR_LEVELS) {
      const grants = grantsForCalendarLevel(level)
      if (!grants.includes('booking.create')) continue

      expect(grants, `calendar level ${level}`).toContain('availability.view')
    }
  })

  it('never yields the guest email without the phone and the name', () => {
    for (const level of GUEST_DATA_LEVELS) {
      const grants = grantsForGuestDataLevel(level)
      if (!grants.includes('guest.view_email')) continue

      expect(grants, `guest level ${level}`).toContain('guest.view_phone')
      expect(grants, `guest level ${level}`).toContain('guest.view_name')
    }
  })

  it('grants nothing at all on the "none" rung of each ladder', () => {
    expect(grantsForCalendarLevel('none')).toEqual([])
    expect(grantsForPriceLevel('none')).toEqual([])
    expect(grantsForGuestDataLevel('none')).toEqual([])
  })

  it('grows monotonically, so a higher rung never takes a grant away', () => {
    const ladders = [
      { levels: CALENDAR_LEVELS, resolve: grantsForCalendarLevel },
      { levels: PRICE_LEVELS, resolve: grantsForPriceLevel },
      { levels: GUEST_DATA_LEVELS, resolve: grantsForGuestDataLevel },
    ] as const

    for (const ladder of ladders) {
      for (let i = 1; i < ladder.levels.length; i += 1) {
        const lower = ladder.resolve(ladder.levels[i - 1] as never)
        const higher = ladder.resolve(ladder.levels[i] as never)
        const lost = lower.filter((g) => !higher.includes(g))

        expect(lost, `grants lost climbing to ${ladder.levels[i]}`).toEqual([])
      }
    }
  })

  it('grants nothing for a level that is not on the ladder, denying by default', () => {
    expect(grantsForPriceLevel('platinum' as PriceLevel)).toEqual([])
    expect(grantsForCalendarLevel('everything' as CalendarLevel)).toEqual([])
    expect(grantsForGuestDataLevel('all' as GuestDataLevel)).toEqual([])
  })

  it('yields only grants that exist in the catalogue', () => {
    const known = new Set<string>(ALL_GRANTS)
    const produced = [
      ...grantsForCalendarLevel('availability_booking'),
      ...grantsForPriceLevel('net_commission'),
      ...grantsForGuestDataLevel('email'),
    ]

    expect(produced.filter((g) => !known.has(g))).toEqual([])
  })
})

describe('the business side of the agent network', () => {
  it('lets a general manager run the network end to end', () => {
    const gm = actorInRole('general_manager')

    expect(can(gm, 'agent.manage', RESOURCE)).toBe(true)
    expect(can(gm, 'agent.invite', RESOURCE)).toBe(true)
    expect(can(gm, 'agent.scope.manage', RESOURCE)).toBe(true)
    expect(can(gm, 'agency.manage', RESOURCE)).toBe(true)
    expect(can(gm, 'agent_agreement.manage', RESOURCE)).toBe(true)
    expect(can(gm, 'agent_booking.approve', RESOURCE)).toBe(true)
    expect(can(gm, 'agent.audit.view', RESOURCE)).toBe(true)
  })

  it('denies a general manager the releasing of the money whose rate they set', () => {
    const gm = actorInRole('general_manager')

    expect(can(gm, 'commission.approve', RESOURCE)).toBe(false)
    expect(can(gm, 'commission.payout', RESOURCE)).toBe(false)
  })

  it('lets a finance manager approve and pay a commission', () => {
    const finance = actorInRole('finance_manager')

    expect(can(finance, 'commission.approve', RESOURCE)).toBe(true)
    expect(can(finance, 'commission.payout', RESOURCE)).toBe(true)
    expect(can(finance, 'agent_statement.issue', RESOURCE)).toBe(true)
  })

  it('denies a finance manager the writing of the rule they pay against, so no one person owns both ends', () => {
    const finance = actorInRole('finance_manager')

    expect(can(finance, 'agent_agreement.view', RESOURCE)).toBe(true)
    expect(can(finance, 'agent_agreement.manage', RESOURCE)).toBe(false)
    expect(can(finance, 'agent.scope.manage', RESOURCE)).toBe(false)
  })

  it('lets a revenue manager set the ceilings an agent discounts within', () => {
    const revenue = actorInRole('revenue_manager')

    expect(can(revenue, 'agent_limits.manage', RESOURCE)).toBe(true)
    expect(can(revenue, 'rate.view_net', RESOURCE)).toBe(true)
    expect(can(revenue, 'agent_agreement.manage', RESOURCE)).toBe(false)
  })

  it('leaves an accountant reading the network and approving none of it', () => {
    const accountant = actorInRole('accountant')

    expect(can(accountant, 'commission.view', RESOURCE)).toBe(true)
    expect(can(accountant, 'agent_statement.view', RESOURCE)).toBe(true)
    expect(can(accountant, 'commission.approve', RESOURCE)).toBe(false)
    expect(can(accountant, 'commission.payout', RESOURCE)).toBe(false)
  })

  const untouchedRoles: readonly SystemRole[] = [
    'cleaner',
    'maintenance',
    'external_vendor',
    'housekeeping_supervisor',
    'marketing_editor',
    'property_owner',
  ]

  it.each(untouchedRoles)(
    'gives "%s" no part of the agent network whatsoever',
    (role) => {
      const agentGrants = ALL_GRANTS.filter(
        (g) =>
          g.startsWith('agent') ||
          g.startsWith('agency.') ||
          g.startsWith('commission.') ||
          g.startsWith('rate.') ||
          g === 'report.agent.view',
      )
      const held = agentGrants.filter((g) => holds(role, g))

      expect(held, `agent-network grants held by ${role}`).toEqual([])
    },
  )
})

describe('the money in the agent network demands a reason or a re-authentication', () => {
  const mustBeSensitive: readonly Grant[] = [
    'agent_agreement.manage',
    'agent_limits.manage',
    'commission.approve',
    'commission.payout',
    'agent.scope.manage',
  ]

  it.each(mustBeSensitive)('treats "%s" as a sensitive action', (grant) => {
    expect(SENSITIVE_ACTIONS.has(grant)).toBe(true)
  })

  it('does not make the everyday selling actions sensitive, which would make the flag meaningless', () => {
    const everyday: readonly Grant[] = [
      'quote.create',
      'hold.create',
      'lead.create',
      'availability.view',
      'commission.view',
    ]
    const overreach = everyday.filter((g) => SENSITIVE_ACTIONS.has(g))

    expect(overreach, 'everyday actions wrongly marked sensitive').toEqual([])
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

  /**
   * The derivation is what keeps this number right, so the number is pinned:
   * if a permission is added and this figure is not updated deliberately, the
   * change was not thought about. 127 non-platform permissions plus 13 field
   * permissions, less the four reserved to the owner.
   */
  it('holds exactly 137 grants', () => {
    expect(grantsForSystemRole('administrator')).toHaveLength(137)
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

  it('holds exactly 141 grants — every non-platform permission and every field permission', () => {
    expect(grantsForSystemRole('organization_owner')).toHaveLength(141)
  })

  it('holds the agent network, because running the sellers is the owner’s business', () => {
    expect(can(owner, 'agent.manage', RESOURCE)).toBe(true)
    expect(can(owner, 'agent_agreement.manage', RESOURCE)).toBe(true)
    expect(can(owner, 'commission.payout', RESOURCE)).toBe(true)
    expect(can(owner, 'rate.view_net', RESOURCE)).toBe(true)
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
    'guest.view_name',
    'guest.view_phone',
    'guest.view_email',
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
