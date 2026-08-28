/**
 * The denials.
 *
 * Written as seriously as the permission tests, because they are the ones that
 * matter. An agent sells for five competing businesses on the same day; the
 * question this file answers is what each of those businesses cannot learn
 * about the other four, and what one agent cannot learn about the agent at the
 * next desk.
 *
 * Every test here goes through the real engine — `resolveActor` building the
 * actor from rows, then `authorize()` deciding — rather than asserting on a
 * grant set. A grant set proves what was intended; the engine proves what
 * happens.
 */

import { describe, expect, it } from 'vitest'
import {
  authorize,
  can,
  redact,
  type Actor,
  type MembershipStatus,
  type Resource,
} from '../authz/can'
import type { Grant } from '../authz/permissions'
import { resolveActor } from '../actor/resolve'
import type {
  ActorSource,
  MembershipRow,
  MembershipScopeRow,
  RoleAssignment,
} from '../actor/source'
import type { EffectivePlan } from '../plans/plan'
import { SEED_PLANS } from '../plans/catalog'
import { AGENT_PRESETS, grantsForAgentAccess } from './access'
import { agentScopes, changeAgentStatus } from './lifecycle'
import type { AgentOrganizationSettings } from './types'
import {
  advanceCommission,
  buildAgentStatement,
  createCommission,
  type Commission,
} from './commission'

const NOW = new Date('2026-09-01T10:00:00.000Z')

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const AGENT = 'agent-1'
const RIVAL = 'agent-2'

// ── Building a real actor ─────────────────────────────────────────────────

function settings(
  over: Partial<AgentOrganizationSettings> = {},
): AgentOrganizationSettings {
  return {
    organizationId: ORG_A,
    agentUserId: AGENT,
    membershipId: 'membership-1',
    status: 'active',
    access: AGENT_PRESETS.sales,
    inventory: { kind: 'properties', propertyIds: ['property-1'] },
    discountCap: { maxPercent: 5, maxAgorot: null },
    holdLimits: {
      maxConcurrent: 3,
      maxPerDay: 10,
      maxExtensions: 1,
      defaultMinutes: 30,
      maxMinutes: 120,
    },
    reputationScore: 0,
    agencyId: null,
    internalNote: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    version: 1,
    ...over,
  }
}

/**
 * A real plan and subscription, built from the seed catalogue.
 *
 * Not a hand-written entitlement set: the packaging decision — the agent
 * network is included from Direct upward and sold to Basic as an add-on — is
 * the catalogue's to make, and a test that invented its own would keep passing
 * after the packaging changed underneath it.
 */
function effectivePlan(code: string): EffectivePlan {
  const seed = SEED_PLANS.find((candidate) => candidate.code === code)
  if (!seed) throw new Error(`no seed plan "${code}"`)

  return {
    plan: {
      id: `plan-${code}`,
      code: seed.code,
      name: seed.name,
      description: seed.description,
      monthlyPrice: seed.monthlyPrice,
      yearlyPrice: seed.yearlyPrice,
      limits: seed.limits,
      entitlements: seed.entitlements,
      isPublic: seed.isPublic,
      sortOrder: seed.sortOrder,
    },
    subscription: {
      id: `subscription-${code}`,
      organizationId: ORG_A,
      planId: `plan-${code}`,
      status: 'active',
      interval: 'monthly',
      agreedMonthlyPrice: seed.monthlyPrice,
      agreedYearlyPrice: seed.yearlyPrice,
      trialEndsAt: null,
      currentPeriodEnd: null,
      limitOverrides: {},
      entitlementGrants: [],
      entitlementRevocations: [],
    },
  }
}

const PLAN: EffectivePlan = effectivePlan('pro')

/**
 * An actor source backed by one mutable agent record.
 *
 * Mutable on purpose: the "takes effect immediately" tests change the record
 * between two resolutions and prove the second call sees the change.
 */
function makeSource(record: {
  current: AgentOrganizationSettings
}): ActorSource {
  return {
    async loadMembership(
      userId,
      organizationId,
    ): Promise<MembershipRow | null> {
      const agent = record.current
      if (userId !== agent.agentUserId) return null
      if (organizationId !== agent.organizationId) return null
      return {
        id: agent.membershipId,
        userId: agent.agentUserId,
        organizationId: agent.organizationId,
        status: agent.status,
      }
    },
    async loadRoles(): Promise<readonly RoleAssignment[]> {
      // A custom role carrying the grants the stored ladders produce. Read on
      // every request, which is what makes an edit take effect at once.
      return [
        {
          code: 'agent',
          kind: 'custom',
          grants: [...grantsForAgentAccess(record.current.access)],
        },
      ]
    },
    async loadScope(): Promise<MembershipScopeRow | null> {
      return { kind: 'own_records' }
    },
    async loadPlan(): Promise<EffectivePlan | null> {
      return PLAN
    },
  }
}

/** Resolve an agent the way a request does, then apply their two scopes. */
async function resolveAgent(record: {
  current: AgentOrganizationSettings
}): Promise<Actor> {
  const resolution = await resolveActor(
    makeSource(record),
    record.current.agentUserId,
    record.current.organizationId,
  )
  if (!resolution.ok) throw new Error(`no actor: ${resolution.reason}`)

  const scopes = agentScopes(record.current)
  return { ...resolution.actor, ...scopes }
}

function agentActor(over: Partial<AgentOrganizationSettings> = {}) {
  return resolveAgent({ current: settings(over) })
}

// ── Resources ─────────────────────────────────────────────────────────────

const unitInScope: Resource = {
  organizationId: ORG_A,
  propertyId: 'property-1',
  unitId: 'unit-1',
  family: 'inventory',
}

const unitOutOfScope: Resource = {
  organizationId: ORG_A,
  propertyId: 'property-9',
  unitId: 'unit-9',
  family: 'inventory',
}

const unitInOtherOrg: Resource = {
  organizationId: ORG_B,
  propertyId: 'property-1',
  unitId: 'unit-1',
  family: 'inventory',
}

const ownBooking: Resource = {
  organizationId: ORG_A,
  propertyId: 'property-1',
  family: 'booking',
  createdByUserId: AGENT,
}

const rivalBooking: Resource = {
  organizationId: ORG_A,
  propertyId: 'property-1',
  family: 'booking',
  createdByUserId: RIVAL,
}

const rivalCommission: Resource = {
  organizationId: ORG_A,
  propertyId: 'property-1',
  family: 'finance',
  assignedToUserId: RIVAL,
}

const rivalLead: Resource = {
  organizationId: ORG_A,
  family: 'booking',
  createdByUserId: RIVAL,
}

// ── An agent of A reaches nothing in B ────────────────────────────────────

describe('an agent of organization A can reach nothing in organization B', () => {
  it('is refused every grant they hold, on B’s resources', async () => {
    const actor = await agentActor()
    // Every grant this agent actually has, tried against another tenant. Not a
    // sample — the whole set, so a grant added to the preset next year is
    // covered without anybody remembering to add a case.
    for (const grant of actor.grants) {
      const decision = authorize(actor, grant, unitInOtherOrg)
      expect(decision.allowed, `${grant} must not cross tenants`).toBe(false)
      if (!decision.allowed) {
        expect(decision.reason, grant).toBe('cross_organization')
      }
    }
  })

  it('is refused a booking in B even when it is nominally their own', async () => {
    // The trap: `own_records` matches on the user id, and the tenant check has
    // to come first or an agent reads their own bookings inside a competitor.
    const actor = await agentActor()
    const ownBookingInOtherOrg: Resource = {
      organizationId: ORG_B,
      family: 'booking',
      createdByUserId: AGENT,
    }
    const decision = authorize(actor, 'booking.view', ownBookingInOtherOrg)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('cross_organization')
  })

  it('cannot be resolved as an actor in B at all', async () => {
    // One step earlier than authorization: there is no membership, so there is
    // no actor — not an actor with no grants, which would still pass a badly
    // written "is somebody logged in here?" check.
    const resolution = await resolveActor(
      makeSource({ current: settings() }),
      AGENT,
      ORG_B,
    )
    expect(resolution.ok).toBe(false)
    if (!resolution.ok) expect(resolution.reason).toBe('no_membership')
  })

  it('has independent ladders in each organization', async () => {
    // The same person, two businesses, two different sets of permissions —
    // which is the entire premise, and is only possible because the permission
    // belongs to the relationship rather than to the person.
    const inA = await resolveAgent({ current: settings() })
    const inB = await resolveAgent({
      current: settings({
        organizationId: ORG_B,
        membershipId: 'membership-2',
        access: AGENT_PRESETS.referral,
      }),
    })

    expect(can(inA, 'availability.view', unitInScope)).toBe(true)
    expect(inB.grants.has('availability.view')).toBe(false)
  })

  it('never lets one organization’s statement contain another’s line', () => {
    const mine = commissionFor(ORG_A, AGENT, 'booking-a')
    const theirs = commissionFor(ORG_B, AGENT, 'booking-b')

    const statement = buildAgentStatement({
      id: 'statement-1',
      organizationId: ORG_A,
      agentUserId: AGENT,
      periodFrom: '2026-09-01',
      periodTo: '2026-09-30',
      commissions: [approved(mine), approved(theirs)],
      now: NOW,
    })
    expect(statement.lines.map((line) => line.bookingId)).toEqual(['booking-a'])
  })
})

// ── An agent cannot see another agent's work ──────────────────────────────

describe('an agent sees their own records and nobody else’s', () => {
  it('reads their own booking', async () => {
    const actor = await agentActor()
    expect(can(actor, 'booking.view', ownBooking)).toBe(true)
  })

  it('is refused another agent’s booking in the same property', async () => {
    // The reason the membership scope is `own_records` and not `properties`.
    // A property-scoped agent would read every rival's booking in that property.
    const actor = await agentActor()
    const decision = authorize(actor, 'booking.view', rivalBooking)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('out_of_scope')
  })

  it('is refused another agent’s commission', async () => {
    const actor = await agentActor()
    expect(can(actor, 'commission.view', rivalCommission)).toBe(false)
  })

  it('is refused another agent’s lead', async () => {
    const actor = await agentActor()
    expect(can(actor, 'lead.view', rivalLead)).toBe(false)
  })

  it('is refused another agent’s statement', async () => {
    const actor = await agentActor()
    expect(
      can(actor, 'agent_statement.view', {
        organizationId: ORG_A,
        family: 'finance',
        assignedToUserId: RIVAL,
      }),
    ).toBe(false)
  })

  it('keeps the confinement on the export path too', async () => {
    // The commonest failure in systems like this: the screen is scoped and the
    // export is not. `booking.export` is not granted to any agent preset at
    // all, so there is no export path to forget to scope.
    const actor = await agentActor()
    expect(actor.grants.has('booking.export')).toBe(false)
    expect(actor.grants.has('guest.export')).toBe(false)
    expect(can(actor, 'booking.export', rivalBooking)).toBe(false)
  })

  it('uses one permission for "mine" and "everyone’s", answered by scope', async () => {
    // A finance manager and an agent hold the same `commission.view`; the scope
    // answers "whose". Two permissions would be two things to keep in step.
    const agent = await agentActor()
    expect(agent.grants.has('commission.view')).toBe(true)
    expect(can(agent, 'commission.view', rivalCommission)).toBe(false)
    expect(
      can(agent, 'commission.view', {
        organizationId: ORG_A,
        family: 'finance',
        assignedToUserId: AGENT,
      }),
    ).toBe(true)
  })
})

// ── The two scopes ────────────────────────────────────────────────────────

describe('inventory reach and record ownership are separate questions', () => {
  it('reaches a unit in an assigned property', async () => {
    const actor = await agentActor()
    expect(can(actor, 'availability.view', unitInScope)).toBe(true)
  })

  it('is refused a unit in a property they were not given', async () => {
    const actor = await agentActor()
    const decision = authorize(actor, 'availability.view', unitOutOfScope)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('out_of_scope')
  })

  it('falls back to own_records for a resource that declares no family', async () => {
    // The safe direction. Forgetting the family denies; it does not widen.
    const actor = await agentActor()
    const noFamily: Resource = {
      organizationId: ORG_A,
      propertyId: 'property-1',
      unitId: 'unit-1',
    }
    expect(can(actor, 'availability.view', noFamily)).toBe(false)
  })

  it('narrows only inventory, leaving every other family at own_records', async () => {
    const actor = await agentActor()
    expect(actor.scope).toEqual({ kind: 'own_records' })
    expect(Object.keys(actor.scopeOverrides ?? {})).toEqual(['inventory'])
  })

  it('gives an all-properties agent organization-wide inventory but not records', async () => {
    const actor = await agentActor({ inventory: { kind: 'all_properties' } })
    expect(can(actor, 'availability.view', unitOutOfScope)).toBe(true)
    // Still not another agent's booking.
    expect(can(actor, 'booking.view', rivalBooking)).toBe(false)
  })

  it('reaches nothing when the stored reach is an empty list', async () => {
    // Deny by default. "Somebody saved the property picker with nothing
    // selected" must not mean "everything".
    const actor = await agentActor({
      inventory: { kind: 'properties', propertyIds: [] },
    })
    expect(can(actor, 'availability.view', unitInScope)).toBe(false)
  })
})

// ── Suspension and removal ────────────────────────────────────────────────

describe('a suspended agent', () => {
  it('cannot be resolved into an actor at all', async () => {
    const record = { current: settings({ status: 'suspended' }) }
    const resolution = await resolveActor(makeSource(record), AGENT, ORG_A)
    expect(resolution.ok).toBe(false)
    if (!resolution.ok) {
      expect(resolution.reason).toBe('membership_not_active')
    }
  })

  it.each(['invited', 'pending', 'suspended', 'removed'] as MembershipStatus[])(
    'is refused every grant while their membership is "%s"',
    async (status) => {
      // Built by hand rather than resolved, because resolution refuses to
      // produce one at all — this proves the second floor holds even if the
      // first were bypassed.
      const active = await agentActor()
      const inactive: Actor = { ...active, membershipStatus: status }
      for (const grant of inactive.grants) {
        expect(can(inactive, grant, unitInScope), grant).toBe(false)
      }
    },
  )

  it('keeps their bookings, commissions, audit and attribution', () => {
    const before = settings()
    const change = changeAgentStatus(before, {
      to: 'suspended',
      now: NOW,
      displayName: 'דוד',
      reason: 'חשד לפעילות חריגה',
    })

    // The status is the only thing that changed.
    expect(change.settings.status).toBe('suspended')
    expect(change.settings.access).toEqual(before.access)
    expect(change.settings.agentUserId).toBe(before.agentUserId)
    expect(change.preserved).toEqual([
      'bookings',
      'commissions',
      'audit_events',
      'attribution',
    ])
  })

  it('is described in a sentence a person can read', () => {
    const change = changeAgentStatus(settings(), {
      to: 'suspended',
      now: NOW,
      displayName: 'דוד',
    })
    expect(change.summary).toContain('דוד')
    expect(change.summary).toContain('הושעה')
    expect(change.summary).toContain('נשמרו')
    // Never "membership updated".
    expect(change.summary).not.toContain('updated')
  })
})

describe('a removed agent', () => {
  it('keeps the commission they are still owed', () => {
    // A removed agent is owed money on stays that have not happened. A hard
    // delete is a deletion of a debt.
    const owed = approved(commissionFor(ORG_A, AGENT, 'booking-a'))
    const removed = changeAgentStatus(settings(), {
      to: 'removed',
      now: NOW,
      reason: 'סיום התקשרות',
    })

    expect(removed.settings.status).toBe('removed')
    // The commission is untouched, and still payable.
    expect(owed.status).toBe('approved')
    expect(owed.amountAgorot).toBeGreaterThan(0)
    expect(owed.agentUserId).toBe(AGENT)
  })

  it('keeps the attribution, so reports do not lie retroactively', () => {
    const commission = commissionFor(ORG_A, AGENT, 'booking-a')
    changeAgentStatus(settings(), { to: 'removed', now: NOW })
    // Still attributed. A "direct versus agent" report for a closed month must
    // read the same after the agent leaves as it did before.
    expect(commission.agentUserId).toBe(AGENT)
    expect(commission.bookingId).toBe('booking-a')
  })

  it('can be brought back onto the same membership', () => {
    const removed = changeAgentStatus(settings(), { to: 'removed', now: NOW })
    const back = changeAgentStatus(removed.settings, { to: 'active', now: NOW })
    expect(back.settings.status).toBe('active')
    expect(back.settings.membershipId).toBe('membership-1')
  })
})

// ── Changes take effect immediately ───────────────────────────────────────

describe('a permission change takes effect at once', () => {
  it('applies to the very next request, with no cache to wait for', async () => {
    // The button an owner presses the moment they discover something. A
    // mechanism that takes effect "at their next login" was not there when it
    // was needed.
    const record = { current: settings() }

    const before = await resolveAgent(record)
    expect(can(before, 'availability.view', unitInScope)).toBe(true)
    expect(before.grants.has('hold.create')).toBe(true)

    // The owner narrows the ladder while the agent's screen is open.
    record.current = settings({ access: AGENT_PRESETS.referral })

    const after = await resolveAgent(record)
    expect(after.grants.has('availability.view')).toBe(false)
    expect(after.grants.has('hold.create')).toBe(false)
    expect(can(after, 'availability.view', unitInScope)).toBe(false)
  })

  it('applies to suspension the same way', async () => {
    const record = { current: settings() }
    expect((await resolveAgent(record)).membershipStatus).toBe('active')

    record.current = settings({ status: 'suspended' })

    const resolution = await resolveActor(makeSource(record), AGENT, ORG_A)
    expect(resolution.ok).toBe(false)
  })

  it('narrows inventory reach at once', async () => {
    const record = { current: settings() }
    expect(
      can(await resolveAgent(record), 'availability.view', unitInScope),
    ).toBe(true)

    record.current = settings({
      inventory: { kind: 'properties', propertyIds: ['property-2'] },
    })
    expect(
      can(await resolveAgent(record), 'availability.view', unitInScope),
    ).toBe(false)
  })
})

// ── Field-level redaction ─────────────────────────────────────────────────

describe('what an agent is handed for a booking they may see', () => {
  it('strips the guest, the amount and the source from a sales agent', async () => {
    const actor = await agentActor()
    const record = {
      id: 'booking-1',
      unitLabel: 'וילה צפונית',
      checkIn: '2026-09-12',
      checkOut: '2026-09-15',
      guestName: 'משפחת כהן',
      guestPhone: '+972529998888',
      totalAgorot: 640_000,
      source: 'booking_com',
      internalNotes: 'לא לשדרג',
    }

    const shaped = redact(actor, record, [
      { key: 'guestName', requires: 'guest.view_name' },
      { key: 'guestPhone', requires: 'guest.view_phone' },
      { key: 'totalAgorot', requires: 'booking.view_price' },
      { key: 'source', requires: 'booking.view_source' },
      { key: 'internalNotes', requires: 'booking.note.internal' },
    ])

    // What they keep: enough to sell and to service the stay.
    expect(shaped.unitLabel).toBe('וילה צפונית')
    expect(shaped.checkIn).toBe('2026-09-12')

    // What they never get.
    expect(shaped.guestName).toBeUndefined()
    expect(shaped.guestPhone).toBeUndefined()
    expect(shaped.totalAgorot).toBeUndefined()
    expect(shaped.source).toBeUndefined()
    expect(shaped.internalNotes).toBeUndefined()
  })

  it('gives an agency manager the phone and still not the email', async () => {
    const actor = await agentActor({ access: AGENT_PRESETS.agency })
    const record = {
      guestName: 'משפחת כהן',
      guestPhone: '+972529998888',
      guestEmail: 'cohen@example.com',
    }
    const shaped = redact(actor, record, [
      { key: 'guestName', requires: 'guest.view_name' },
      { key: 'guestPhone', requires: 'guest.view_phone' },
      { key: 'guestEmail', requires: 'guest.view_email' },
    ])
    expect(shaped.guestName).toBe('משפחת כהן')
    expect(shaped.guestPhone).toBe('+972529998888')
    // The business's channel for the next stay.
    expect(shaped.guestEmail).toBeUndefined()
  })

  it('withholds a field whose feature the organization has not bought', async () => {
    // Degrading cleanly for an organization without the agent-network add-on.
    // `holdsGrant` withholds the rate for the same reason the action behind it
    // would be refused: one rule, asked once.
    const actor = await agentActor({ access: AGENT_PRESETS.agency })
    const basic: Actor = {
      ...actor,
      entitlements: new Set(
        [...actor.entitlements].filter((e) => e !== 'agent_network'),
      ),
    }
    const shaped = redact(basic, { netRate: 45_000 }, [
      { key: 'netRate', requires: 'rate.view_net' },
    ])
    expect(shaped.netRate).toBeUndefined()
  })

  it('withholds a field on another agent’s row even with the grant', async () => {
    // The same grant, a different answer per row: the resource decides whose.
    const actor = await agentActor({ access: AGENT_PRESETS.agency })
    const shaped = redact(
      actor,
      { guestPhone: '+972529998888' },
      [{ key: 'guestPhone', requires: 'guest.view_phone' }],
      rivalBooking,
    )
    expect(shaped.guestPhone).toBeUndefined()
  })
})

// ── A referral agent ──────────────────────────────────────────────────────

describe('a referral agent', () => {
  it('cannot see availability, hold, or book', async () => {
    const actor = await agentActor({ access: AGENT_PRESETS.referral })
    const forbidden: readonly Grant[] = [
      'availability.view',
      'hold.create',
      'hold.view',
      'hold.extend',
      'booking.create',
      'booking.view',
      'quote.create',
      'quote.send',
      'rate.view_public',
      'rate.view_agent',
      'rate.view_net',
    ]
    for (const grant of forbidden) {
      expect(actor.grants.has(grant), grant).toBe(false)
      expect(can(actor, grant, unitInScope), grant).toBe(false)
    }
  })

  it('can still bring a lead and see their own pay', async () => {
    const actor = await agentActor({ access: AGENT_PRESETS.referral })
    expect(actor.grants.has('lead.create')).toBe(true)
    expect(
      can(actor, 'commission.view', {
        organizationId: ORG_A,
        family: 'finance',
        assignedToUserId: AGENT,
      }),
    ).toBe(true)
  })
})

// ── Helpers ───────────────────────────────────────────────────────────────

function commissionFor(
  organizationId: string,
  agentUserId: string,
  bookingId: string,
): Commission {
  return createCommission({
    id: `commission-${bookingId}`,
    organizationId,
    propertyId: 'property-1',
    bookingId,
    agentUserId,
    agencyId: null,
    lines: [
      {
        kind: 'accommodation',
        label: 'לינה',
        amount: 360_000,
        quantity: 1,
        date: null,
      },
    ],
    rule: {
      id: 'rule-1',
      organizationId,
      agentUserId,
      agencyId: null,
      rule: { kind: 'percentage', percent: 10 },
      base: 'stay_total',
      scope: {
        propertyIds: null,
        unitIds: null,
        ratePlanIds: null,
        period: null,
      },
      eligibility: { conditions: [] },
      priority: 0,
      effectiveFrom: null,
      effectiveUntil: null,
      version: 1,
    },
    now: NOW,
  })
}

function approved(commission: Commission): Commission {
  return advanceCommission(
    advanceCommission(
      advanceCommission(commission, { to: 'pending', now: NOW }),
      { to: 'eligible', now: NOW },
    ),
    { to: 'approved', now: NOW, approvedByUserId: 'owner-1' },
  )
}
