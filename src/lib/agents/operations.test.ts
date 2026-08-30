/**
 * The agent operations, through the real service pipeline.
 *
 * These tests exercise `defineOperation` end to end — authorization, then
 * validation, then the rule, then the transaction, then the audit event — so
 * what is proved is that the *operation* refuses, not that a domain function
 * called on its own would have.
 *
 * The distinction matters: a domain guard that nothing calls is not a guard.
 */

import { describe, expect, it } from 'vitest'
import { defineAgentOperations } from './operations'
import type { AgentRepository } from './repository'
import {
  AGENT_PRESETS,
  AGENT_PRESET_ROLE,
  grantsForAgentAccess,
  type AgentAccess,
} from './access'
import { grantsForAssignments } from '../actor/resolve'
import { grantsForSystemRole } from '../authz/roles'
import type { AgentOrganizationSettings } from './types'
import type { Commission } from './commission'
import { createCommission } from './commission'
import type { DiscountApproval } from './discounts'
import type { AgentInvitation } from './types'
import type { AgentHoldLedgerEntry } from './holds'
import { AuthorizationError, type Actor, type Scope } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import { InMemoryEventBus, RecordingTransactionRunner } from '../service'
import type { AuditRecord, AuditWriter } from '../audit/pipeline'
import { BusinessRuleError, ValidationError } from '../errors'

const NOW = new Date('2026-09-01T10:00:00.000Z')
const ORG = 'org-a'
const AGENT = 'agent-1'
const OWNER = 'owner-1'
const PROPERTY = 'property-1'

// ── A repository that remembers ───────────────────────────────────────────

interface RepoState {
  settings: Map<string, AgentOrganizationSettings>
  users: Map<string, { userId: string; displayName: string | null }>
  memberships: Map<
    string,
    { membershipId: string; userId: string; status: 'active' | 'removed' }
  >
  /** membership id → the role codes it holds. This is `membership_roles`. */
  membershipRoles: Map<string, string[]>
  invitations: AgentInvitation[]
  ledger: AgentHoldLedgerEntry[]
  approvals: Map<string, DiscountApproval>
  commissions: Map<string, Commission>
}

function makeRepo(seed: Partial<RepoState> = {}) {
  const state: RepoState = {
    settings: seed.settings ?? new Map(),
    users: seed.users ?? new Map(),
    memberships: seed.memberships ?? new Map(),
    membershipRoles: seed.membershipRoles ?? new Map(),
    invitations: seed.invitations ?? [],
    ledger: seed.ledger ?? [],
    approvals: seed.approvals ?? new Map(),
    commissions: seed.commissions ?? new Map(),
  }

  const repo: AgentRepository = {
    async findUserByPhone(phone) {
      return state.users.get(phone) ?? null
    },
    async findMembership(organizationId, userId) {
      const found = state.memberships.get(`${organizationId}:${userId}`)
      return found ? { ...found, userId } : null
    },
    async findPendingInvitation(organizationId, phone) {
      return (
        state.invitations.find(
          (i) =>
            i.organizationId === organizationId &&
            i.phoneE164 === phone &&
            i.status === 'pending',
        ) ?? null
      )
    },
    async loadSettings(organizationId, agentUserId) {
      return state.settings.get(`${organizationId}:${agentUserId}`) ?? null
    },
    async saveSettings(settings) {
      state.settings.set(
        `${settings.organizationId}:${settings.agentUserId}`,
        settings,
      )
      return settings
    },
    async insertInvitation(invitation) {
      state.invitations.push(invitation)
      return invitation
    },
    // Models the contract the adapter is held to, not just the settings row:
    // a membership, and a role on it, in the same act. A double that wrote
    // only the terms would let the defect this file now guards against pass.
    async attachExistingUser({ organizationId, userId, preset, settings }) {
      const key = `${organizationId}:${userId}`
      const existing = state.memberships.get(key)
      const membershipId = existing?.membershipId ?? `membership-for-${userId}`
      state.memberships.set(key, { membershipId, userId, status: 'active' })

      const held = state.membershipRoles.get(membershipId) ?? []
      const code = AGENT_PRESET_ROLE[preset]
      if (!held.includes(code)) held.push(code)
      state.membershipRoles.set(membershipId, held)

      const stored = { ...settings, membershipId }
      state.settings.set(key, stored)
      return stored
    },
    async loadHoldLedger(organizationId, agentUserId) {
      return state.ledger.filter(
        (e) =>
          e.organizationId === organizationId && e.agentUserId === agentUserId,
      )
    },
    async insertLedgerEntry(entry) {
      state.ledger.push(entry)
      return entry
    },
    async saveLedgerEntry(entry) {
      const index = state.ledger.findIndex((e) => e.holdId === entry.holdId)
      if (index >= 0) state.ledger[index] = entry
      return entry
    },
    async loadCommission(organizationId, commissionId) {
      const found = state.commissions.get(commissionId)
      return found && found.organizationId === organizationId ? found : null
    },
    async loadCommissionRules() {
      return []
    },
    async saveCommission(commission) {
      state.commissions.set(commission.id, commission)
      return commission
    },
    async loadApproval(organizationId, approvalId) {
      const found = state.approvals.get(approvalId)
      return found && found.organizationId === organizationId ? found : null
    },
    async insertApproval(approval) {
      state.approvals.set(approval.id, approval)
      return approval
    },
    async saveApproval(approval) {
      state.approvals.set(approval.id, approval)
      return approval
    },
  }

  return { repo, state }
}

// ── Actors and services ───────────────────────────────────────────────────

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

function actorWith(grants: Iterable<Grant>, over: Partial<Actor> = {}): Actor {
  return {
    userId: OWNER,
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
    ...over,
  }
}

function agentActor(
  preset: AgentAccess = AGENT_PRESETS.sales,
  over: Partial<Actor> = {},
): Actor {
  return actorWith(grantsForAgentAccess(preset), {
    userId: AGENT,
    scope: { kind: 'own_records' },
    scopeOverrides: {
      inventory: { kind: 'properties', propertyIds: [PROPERTY] } as Scope,
    },
    ...over,
  })
}

/**
 * The owner, who holds the agent grants *and* the membership grants.
 *
 * The second half is not padding. `memberships_insert` is policed by
 * `user.invite`, `memberships_update` by `user.edit` and
 * `membership_roles_insert` by `role.assign` — none of which `agent.invite` or
 * `agent.manage` implies. An actor missing them is a real case with its own
 * tests below; this one is the actor for whom the happy path is happy.
 */
const ownerActor = () =>
  actorWith([
    'agent.invite',
    'agent.manage',
    'agent.scope.manage',
    'approval.decide',
    'commission.approve',
    'user.invite',
    'user.edit',
    'role.assign',
  ])

function makeServices() {
  const audit: AuditRecord[] = []
  const writer: AuditWriter = {
    async write(record) {
      audit.push(record)
    },
  }
  const events = new InMemoryEventBus()
  return {
    audit,
    events,
    services: {
      audit: writer,
      events,
      transactions: new RecordingTransactionRunner(),
    },
  }
}

function context(actor: Actor, reason?: string) {
  return {
    actor,
    auditActor: {
      type: 'user' as const,
      userId: actor.userId,
      label: actor.userId === OWNER ? 'בעל העסק' : 'הסוכן',
    },
    correlationId: 'correlation-1',
    now: NOW,
    ...(reason === undefined ? {} : { reason }),
  }
}

function settings(
  over: Partial<AgentOrganizationSettings> = {},
): AgentOrganizationSettings {
  return {
    organizationId: ORG,
    agentUserId: AGENT,
    membershipId: 'membership-1',
    status: 'active',
    access: AGENT_PRESETS.sales,
    inventory: { kind: 'properties', propertyIds: [PROPERTY] },
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

// ── agent.invite ──────────────────────────────────────────────────────────

describe('agent.invite', () => {
  it('creates a pending invitation for an unknown number', async () => {
    const { repo, state } = makeRepo()
    const ops = defineAgentOperations(repo)
    const { services, audit } = makeServices()

    const outcome = await ops.invite.run({
      request: { input: { phone: '050-1234567', invitationId: 'invite-1' } },
      context: context(ownerActor()),
      services,
    })

    expect(outcome.data.plan.branch).toBe('invite_new_user')
    expect(state.invitations).toHaveLength(1)
    expect(state.invitations[0].phoneE164).toBe('+972501234567')
    expect(audit[0].summary).toContain('050-123-4567')
  })

  it('creates a membership and never a second user for a known number', async () => {
    const { repo, state } = makeRepo({
      users: new Map([
        ['+972501234567', { userId: 'user-7', displayName: 'דוד' }],
      ]),
    })
    const ops = defineAgentOperations(repo)
    const { services, audit } = makeServices()

    const outcome = await ops.invite.run({
      request: { input: { phone: '0501234567', invitationId: 'invite-1' } },
      context: context(ownerActor()),
      services,
    })

    expect(outcome.data.plan.branch).toBe('attach_existing_user')
    // No invitation was sent, and a membership exists.
    expect(state.invitations).toHaveLength(0)
    expect(state.settings.get(`${ORG}:user-7`)).toBeDefined()
    expect(audit[0].summary).toContain('לא נוצר משתמש חדש')
  })

  it('does not add an active agent twice, and does not treat it as an error', async () => {
    const { repo, state } = makeRepo({
      users: new Map([
        ['+972501234567', { userId: 'user-7', displayName: 'דוד' }],
      ]),
      memberships: new Map([
        [
          `${ORG}:user-7`,
          { membershipId: 'm-1', userId: 'user-7', status: 'active' },
        ],
      ]),
    })
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    const outcome = await ops.invite.run({
      request: { input: { phone: '0501234567', invitationId: 'invite-1' } },
      context: context(ownerActor()),
      services,
    })

    expect(outcome.data.plan.branch).toBe('already_an_agent')
    expect(state.invitations).toHaveLength(0)
    // No event, because nothing happened.
    expect(outcome.events).toHaveLength(0)
  })

  it('adds an agent who resolves with a non-empty grant set', async () => {
    // The regression for the defect that made this whole path a trap: the
    // membership was created, the flow reported success, and the person
    // resolved with *no grants at all* — they signed in, every screen was
    // empty, and nothing in the record explained why.
    //
    // The chain proved here is the real one end to end: the operation threads
    // the chosen preset down to the store, the store puts the role the preset
    // names on the membership, and `grantsForAssignments` — the same function
    // `resolveActor` uses to build every actor in the product — turns that
    // into the grant set the agent acts with.
    const { repo, state } = makeRepo({
      users: new Map([
        ['+972501234567', { userId: 'user-7', displayName: 'דוד' }],
      ]),
    })
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    await ops.invite.run({
      request: {
        input: {
          phone: '0501234567',
          invitationId: 'invite-1',
          preset: 'senior',
        },
      },
      context: context(ownerActor()),
      services,
    })

    const membership = state.memberships.get(`${ORG}:user-7`)
    expect(membership).toBeDefined()

    const codes = state.membershipRoles.get(
      membership?.membershipId as string,
    ) as string[]
    expect(codes).toEqual(['senior_agent'])

    const grants = grantsForAssignments(
      codes.map((code) => ({ code, kind: 'system' as const })),
    )
    expect(grants.size).toBeGreaterThan(0)
    // Not merely non-empty: the grants are the ones the chosen preset means.
    expect(grants.has('availability.view')).toBe(true)
    expect(grants.has('booking.create')).toBe(true)
  })

  it('refuses an actor who cannot write the membership, naming the grant', async () => {
    // `agent.invite` opens the operation and does not open `memberships`.
    // Letting this through reached the adapter, which reported a
    // `NotFoundError` about a membership that plainly existed — or, on the
    // role, added an agent who could do nothing.
    const { repo, state } = makeRepo({
      users: new Map([
        ['+972501234567', { userId: 'user-7', displayName: 'דוד' }],
      ]),
    })
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    const withoutRoleAssign = actorWith([
      'agent.invite',
      'user.invite',
      // and deliberately neither `role.assign` nor `agent.membership.manage`
    ])

    await expect(
      ops.invite.run({
        request: { input: { phone: '0501234567', invitationId: 'invite-1' } },
        context: context(withoutRoleAssign),
        services,
      }),
      // The agent-specific grant is the one named, because it is the one
      // somebody running the agent screen should be given. `role.assign`
      // still satisfies the check — see the general manager test below.
    ).rejects.toMatchObject({ grant: 'agent.membership.manage' })

    // Nothing was written. An agent half-added is the outcome being refused.
    expect(state.settings.size).toBe(0)
    expect(state.memberships.size).toBe(0)
  })

  it('refuses somebody without agent.invite before reading anything', async () => {
    const { repo, state } = makeRepo()
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    await expect(
      ops.invite.run({
        request: { input: { phone: '050-1234567', invitationId: 'invite-1' } },
        context: context(agentActor()),
        services,
      }),
    ).rejects.toThrow(AuthorizationError)

    expect(state.invitations).toHaveLength(0)
  })

  it('refuses an unusable number with the field named', async () => {
    const { repo } = makeRepo()
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    await expect(
      ops.invite.run({
        request: { input: { phone: '03-1234567', invitationId: 'invite-1' } },
        context: context(ownerActor()),
        services,
      }),
    ).rejects.toThrow(ValidationError)
  })
})

// ── agent.access.update ───────────────────────────────────────────────────

describe('agent.access.update', () => {
  function setup() {
    const { repo, state } = makeRepo({
      settings: new Map([[`${ORG}:${AGENT}`, settings()]]),
    })
    return { ops: defineAgentOperations(repo), state }
  }

  it('moves an agent down the ladder and audits before and after', async () => {
    const { ops, state } = setup()
    const { services, audit } = makeServices()

    await ops.updateAccess.run({
      request: {
        input: {
          agentUserId: AGENT,
          access: {
            calendar: 'availability',
            price: 'none',
            guestData: 'none',
          },
        },
        expectedVersion: 1,
      },
      context: context(ownerActor(), 'צמצום הרשאות לאחר בדיקה'),
      services,
    })

    expect(state.settings.get(`${ORG}:${AGENT}`)?.access.calendar).toBe(
      'availability',
    )
    // Human-readable, with the change in it — never "agent_permissions updated".
    expect(audit[0].summary).toContain('availability_booking')
    expect(audit[0].summary).toContain('availability')
    // Only the fields that actually moved. The audit pipeline reduces the
    // before/after pair to the difference, so `guestData` — 'none' on both
    // sides — is absent rather than recorded as an unchanged value.
    expect(audit[0].before).toEqual({
      calendar: 'availability_booking',
      price: 'agent',
    })
    expect(audit[0].after).toEqual({
      calendar: 'availability',
      price: 'none',
    })
  })

  it('refuses an incoherent combination arriving from outside', async () => {
    // The one path the compiler cannot reach.
    const { ops } = setup()
    const { services } = makeServices()

    await expect(
      ops.updateAccess.run({
        request: {
          input: {
            agentUserId: AGENT,
            access: { calendar: 'none', price: 'net', guestData: 'none' },
          },
          expectedVersion: 1,
        },
        context: context(ownerActor(), 'ניסיון'),
        services,
      }),
    ).rejects.toThrow(BusinessRuleError)
  })

  it('demands a stated reason, because widening reach is sensitive', async () => {
    // `agent.scope.manage` is in SENSITIVE_ACTIONS, so the pipeline requires
    // one without this operation asking.
    const { ops } = setup()
    const { services } = makeServices()

    await expect(
      ops.updateAccess.run({
        request: {
          input: {
            agentUserId: AGENT,
            access: {
              calendar: 'availability',
              price: 'none',
              guestData: 'none',
            },
          },
          expectedVersion: 1,
        },
        context: context(ownerActor()),
        services,
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('refuses a stale version rather than losing the other edit', async () => {
    const { ops } = setup()
    const { services } = makeServices()

    await expect(
      ops.updateAccess.run({
        request: {
          input: {
            agentUserId: AGENT,
            access: {
              calendar: 'availability',
              price: 'none',
              guestData: 'none',
            },
          },
          expectedVersion: 99,
        },
        context: context(ownerActor(), 'סיבה'),
        services,
      }),
    ).rejects.toThrow()
  })

  it('refuses an agent trying to widen their own ladder', async () => {
    const { ops } = setup()
    const { services } = makeServices()

    await expect(
      ops.updateAccess.run({
        request: {
          input: {
            agentUserId: AGENT,
            access: {
              calendar: 'availability_booking',
              price: 'net',
              guestData: 'email',
              amendments: [],
              cancellation: { kind: 'never' },
              paymentLink: true,
            },
          },
          expectedVersion: 1,
        },
        context: context(agentActor(), 'אני רוצה יותר'),
        services,
      }),
    ).rejects.toThrow(AuthorizationError)
  })
})

// ── agent.set_status ──────────────────────────────────────────────────────

describe('agent.set_status', () => {
  it('suspends an agent and records what survived', async () => {
    const { repo, state } = makeRepo({
      settings: new Map([[`${ORG}:${AGENT}`, settings()]]),
    })
    const ops = defineAgentOperations(repo)
    const { services, audit } = makeServices()

    const outcome = await ops.setStatus.run({
      request: {
        input: { agentUserId: AGENT, status: 'suspended', displayName: 'דוד' },
        expectedVersion: 1,
      },
      context: context(ownerActor(), 'חשד לפעילות חריגה'),
      services,
    })

    expect(outcome.data.settings.status).toBe('suspended')
    expect(state.settings.get(`${ORG}:${AGENT}`)?.status).toBe('suspended')
    expect(audit[0].summary).toContain('הושעה')
    expect(audit[0].summary).toContain('נשמרו')
    expect(outcome.events[0].name).toBe('agent.suspended')
  })

  it('refuses an illegal status change', async () => {
    const { repo } = makeRepo({
      settings: new Map([[`${ORG}:${AGENT}`, settings({ status: 'removed' })]]),
    })
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    await expect(
      ops.setStatus.run({
        request: {
          input: { agentUserId: AGENT, status: 'suspended' },
          expectedVersion: 1,
        },
        context: context(ownerActor(), 'סיבה'),
        services,
      }),
    ).rejects.toThrow(BusinessRuleError)
  })

  it('refuses an agent suspending anybody', async () => {
    const { repo } = makeRepo({
      settings: new Map([[`${ORG}:${AGENT}`, settings()]]),
    })
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    await expect(
      ops.setStatus.run({
        request: {
          input: { agentUserId: AGENT, status: 'active' },
          expectedVersion: 1,
        },
        context: context(agentActor(), 'סיבה'),
        services,
      }),
    ).rejects.toThrow(AuthorizationError)
  })

  it('refuses agent.manage alone, before writing anything', async () => {
    // The status lives on the membership, and `memberships_update` is policed
    // by `user.edit` — or, since 0025, by `agent.membership.manage`. Without
    // this the terms row was updated, the membership matched zero rows, and
    // the caller was told the *membership* did not exist — a suspension that
    // silently did not take effect, which is the exact failure the button
    // exists to prevent.
    const { repo, state } = makeRepo({
      settings: new Map([[`${ORG}:${AGENT}`, settings()]]),
    })
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    await expect(
      ops.setStatus.run({
        request: {
          input: { agentUserId: AGENT, status: 'suspended' },
          expectedVersion: 1,
        },
        context: context(actorWith(['agent.manage']), 'סיבה'),
        services,
      }),
    ).rejects.toMatchObject({ grant: 'agent.membership.manage' })

    expect(state.settings.get(`${ORG}:${AGENT}`)?.status).toBe('active')
  })

  it('still accepts an actor holding the organization-wide user.edit', async () => {
    // `agent.membership.manage` is an addition, never a substitution. An
    // administrator holds `user.edit` and no agent-specific grant, and their
    // path must be exactly the one it was.
    const { repo, state } = makeRepo({
      settings: new Map([[`${ORG}:${AGENT}`, settings()]]),
    })
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    await ops.setStatus.run({
      request: {
        input: { agentUserId: AGENT, status: 'suspended' },
        expectedVersion: 1,
      },
      context: context(actorWith(['agent.manage', 'user.edit']), 'סיבה'),
      services,
    })

    expect(state.settings.get(`${ORG}:${AGENT}`)?.status).toBe('suspended')
  })
})

// ── The role that owns the agent network ──────────────────────────────────

/**
 * A general manager, using the feature the role catalogue says they own.
 *
 * The defect these guard was not subtle once you looked at the grants: the
 * catalogue gives `general_manager` `agent.view/invite/manage/scope.manage`
 * and describes them as the owner of the network — and both *adding* an agent
 * and *suspending* one write `memberships` and `membership_roles`, which are
 * policed by `user.edit` and `role.assign`. The GM holds neither. So the two
 * acts at the centre of the feature were owner-and-administrator-only, while
 * every screen and every comment said otherwise.
 *
 * Driven through `run()` rather than by asserting on the grant set, because
 * "the GM holds a permission" is not the claim. The claim is that the
 * operation completes and the rows move.
 */
describe('general_manager, the role the catalogue says owns the agent network', () => {
  const gm = () => actorWith(grantsForSystemRole('general_manager'))

  it('is still refused the organization-wide team grants, which is the point', () => {
    // Adding `user.edit` to this role would have been the easy fix and the
    // wrong one: `memberships_update` guards *every* membership, so it would
    // let whoever runs the sellers change an administrator's membership.
    const grants = new Set<Grant>(grantsForSystemRole('general_manager'))

    expect(grants.has('user.edit')).toBe(false)
    expect(grants.has('role.assign')).toBe(false)
    expect(grants.has('agent.membership.manage')).toBe(true)
  })

  it('adds an agent — membership, role and terms — without user.edit or role.assign', async () => {
    const { repo, state } = makeRepo({
      users: new Map([
        ['+972501234567', { userId: 'user-7', displayName: 'דוד' }],
      ]),
    })
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    const outcome = await ops.invite.run({
      request: { input: { phone: '0501234567', invitationId: 'invite-1' } },
      context: context(gm()),
      services,
    })

    expect(outcome.data.plan.branch).toBe('attach_existing_user')
    expect(state.memberships.get(`${ORG}:user-7`)?.status).toBe('active')
    // And the role, without which the agent signs in to empty screens.
    expect(state.membershipRoles.get('membership-for-user-7')).toEqual([
      'sales_agent',
    ])
  })

  it('suspends an agent, which is the button that has to work the moment it is pressed', async () => {
    const { repo, state } = makeRepo({
      settings: new Map([[`${ORG}:${AGENT}`, settings()]]),
    })
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    await ops.setStatus.run({
      request: {
        input: { agentUserId: AGENT, status: 'suspended' },
        expectedVersion: 1,
      },
      context: context(gm(), 'חשד לשימוש לרעה'),
      services,
    })

    expect(state.settings.get(`${ORG}:${AGENT}`)?.status).toBe('suspended')
  })

  it('reinstates a removed agent, which is the reactivate branch', async () => {
    const { repo, state } = makeRepo({
      users: new Map([
        ['+972501234567', { userId: 'user-7', displayName: 'דוד' }],
      ]),
      memberships: new Map([
        [
          `${ORG}:user-7`,
          { membershipId: 'm-7', userId: 'user-7', status: 'removed' },
        ],
      ]),
    })
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    const outcome = await ops.invite.run({
      request: { input: { phone: '0501234567', invitationId: 'invite-2' } },
      context: context(gm()),
      services,
    })

    // The branch that needed `user.edit` specifically, because it updates a
    // membership rather than inserting one.
    expect(outcome.data.plan.branch).toBe('reactivate_membership')
    expect(state.memberships.get(`${ORG}:user-7`)?.status).toBe('active')
  })
})

// ── agent_hold.create ─────────────────────────────────────────────────────

describe('agent_hold.create', () => {
  const holdInput = {
    unitId: 'unit-1',
    propertyId: PROPERTY,
    checkIn: '2026-09-12',
    checkOut: '2026-09-15',
    holdId: 'hold-1',
    liveHoldCount: 0,
  }

  function setup(
    over: Partial<AgentOrganizationSettings> = {},
    ledger: AgentHoldLedgerEntry[] = [],
  ) {
    const { repo, state } = makeRepo({
      settings: new Map([[`${ORG}:${AGENT}`, settings(over)]]),
      ledger,
    })
    return { ops: defineAgentOperations(repo), state }
  }

  it('records a hold for an agent within their limits', async () => {
    const { ops, state } = setup()
    const { services } = makeServices()

    await ops.createHold.run({
      request: { input: holdInput },
      context: context(agentActor()),
      services,
    })

    expect(state.ledger).toHaveLength(1)
    expect(state.ledger[0].extensionCount).toBe(0)
  })

  it('refuses an agent at their concurrent limit, writing nothing', async () => {
    const { ops, state } = setup()
    const { services } = makeServices()

    await expect(
      ops.createHold.run({
        request: { input: { ...holdInput, liveHoldCount: 3 } },
        context: context(agentActor()),
        services,
      }),
    ).rejects.toThrow(BusinessRuleError)

    expect(state.ledger).toHaveLength(0)
  })

  it('refuses an agent at their daily limit', async () => {
    const today = Array.from({ length: 10 }, (_unused, index) => ({
      holdId: `old-${index}`,
      organizationId: ORG,
      agentUserId: AGENT,
      createdAt: '2026-09-01T06:00:00.000Z',
      extensionCount: 0,
    }))
    const { ops, state } = setup({}, today)
    const { services } = makeServices()

    await expect(
      ops.createHold.run({
        request: { input: holdInput },
        context: context(agentActor()),
        services,
      }),
    ).rejects.toThrow(BusinessRuleError)

    expect(state.ledger).toHaveLength(10)
  })

  it('refuses a unit outside the agent’s properties', async () => {
    const { ops } = setup()
    const { services } = makeServices()

    await expect(
      ops.createHold.run({
        request: {
          input: { ...holdInput, unitId: 'unit-9', propertyId: 'property-9' },
        },
        context: context(agentActor()),
        services,
      }),
    ).rejects.toThrow()
  })

  it('refuses a referral agent, who holds no hold.create at all', async () => {
    const { ops } = setup()
    const { services } = makeServices()

    await expect(
      ops.createHold.run({
        request: { input: holdInput },
        context: context(agentActor(AGENT_PRESETS.referral)),
        services,
      }),
    ).rejects.toThrow(AuthorizationError)
  })

  it('refuses an agent with no settings rather than assuming no limits', async () => {
    const { repo } = makeRepo()
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    await expect(
      ops.createHold.run({
        request: { input: holdInput },
        context: context(agentActor()),
        services,
      }),
    ).rejects.toThrow(BusinessRuleError)
  })

  it('gives a proven agent the wider allowance their record earned', async () => {
    const { ops, state } = setup({ reputationScore: 60 })
    const { services } = makeServices()

    // Four live holds refuses a new agent and passes a proven one.
    await ops.createHold.run({
      request: { input: { ...holdInput, liveHoldCount: 4 } },
      context: context(agentActor()),
      services,
    })
    expect(state.ledger).toHaveLength(1)
  })
})

// ── agent_hold.extend ─────────────────────────────────────────────────────

describe('agent_hold.extend', () => {
  function setup(extensionCount: number) {
    const { repo, state } = makeRepo({
      settings: new Map([[`${ORG}:${AGENT}`, settings()]]),
      ledger: [
        {
          holdId: 'hold-1',
          organizationId: ORG,
          agentUserId: AGENT,
          createdAt: '2026-09-01T09:00:00.000Z',
          extensionCount,
        },
      ],
    })
    return { ops: defineAgentOperations(repo), state }
  }

  it('counts a renewal', async () => {
    const { ops, state } = setup(0)
    const { services } = makeServices()

    await ops.extendHold.run({
      request: { input: { holdId: 'hold-1' } },
      context: context(agentActor()),
      services,
    })
    expect(state.ledger[0].extensionCount).toBe(1)
  })

  it('refuses a hold that has used its renewals', async () => {
    const { ops, state } = setup(1)
    const { services } = makeServices()

    await expect(
      ops.extendHold.run({
        request: { input: { holdId: 'hold-1' } },
        context: context(agentActor()),
        services,
      }),
    ).rejects.toThrow(BusinessRuleError)
    expect(state.ledger[0].extensionCount).toBe(1)
  })

  it('refuses a hold that is not theirs', async () => {
    const { ops } = setup(0)
    const { services } = makeServices()

    await expect(
      ops.extendHold.run({
        request: { input: { holdId: 'somebody-elses' } },
        context: context(agentActor()),
        services,
      }),
    ).rejects.toThrow(BusinessRuleError)
  })
})

// ── agent_discount.apply ──────────────────────────────────────────────────

describe('agent_discount.apply', () => {
  const discountInput = {
    bookingId: 'booking-1',
    bookingReference: 'BK-1043',
    currentTotalAgorot: 640_000,
    discountAgorot: 20_000,
    commissionBaseAgorot: 640_000,
    approvalId: 'approval-1',
  }

  function setup() {
    const { repo, state } = makeRepo({
      settings: new Map([[`${ORG}:${AGENT}`, settings()]]),
    })
    return { ops: defineAgentOperations(repo), state }
  }

  it('applies a discount inside the cap without raising anything', async () => {
    const { ops, state } = setup()
    const { services, audit } = makeServices()

    const outcome = await ops.applyDiscount.run({
      request: { input: discountInput },
      context: context(agentActor(AGENT_PRESETS.senior)),
      services,
    })

    expect(outcome.data.decision.outcome).toBe('within_cap')
    expect(state.approvals.size).toBe(0)
    expect(audit[0].summary).toContain('בתוך התקרה')
  })

  it('raises an approval over the cap rather than refusing', async () => {
    // The decision that keeps the deal inside the product.
    const { ops, state } = setup()
    const { services, audit } = makeServices()

    const outcome = await ops.applyDiscount.run({
      request: {
        input: {
          ...discountInput,
          discountAgorot: 76_800,
          reason: 'הלקוח מזמין שלוש יחידות',
        },
      },
      context: context(agentActor(AGENT_PRESETS.senior)),
      services,
    })

    expect(outcome.data.decision.outcome).toBe('requires_approval')
    expect(state.approvals.size).toBe(1)
    expect(outcome.events[0].name).toBe('approval.requested')
    expect(audit[0].summary).toContain('BK-1043')
  })

  it('refuses a sales agent, who may not touch the price at all', async () => {
    // The cap and the permission are different questions: the permission
    // decides whether they may change a price, the cap how far.
    const { ops } = setup()
    const { services } = makeServices()

    await expect(
      ops.applyDiscount.run({
        request: { input: discountInput },
        context: context(agentActor(AGENT_PRESETS.sales)),
        services,
      }),
    ).rejects.toThrow(AuthorizationError)
  })
})

// ── agent_discount.decide ─────────────────────────────────────────────────

describe('agent_discount.decide', () => {
  async function raise() {
    const { repo, state } = makeRepo({
      settings: new Map([[`${ORG}:${AGENT}`, settings()]]),
    })
    const ops = defineAgentOperations(repo)
    const { services } = makeServices()

    await ops.applyDiscount.run({
      request: {
        input: {
          bookingId: 'booking-1',
          bookingReference: 'BK-1043',
          currentTotalAgorot: 640_000,
          discountAgorot: 76_800,
          commissionBaseAgorot: 640_000,
          approvalId: 'approval-1',
          reason: 'הלקוח מזמין שלוש יחידות',
        },
      },
      context: context(agentActor(AGENT_PRESETS.senior)),
      services,
    })
    return { ops, state }
  }

  it('lets the owner approve it', async () => {
    const { ops, state } = await raise()
    const { services, audit } = makeServices()

    await ops.decideDiscount.run({
      request: { input: { approvalId: 'approval-1', approved: true } },
      context: context(ownerActor()),
      services,
    })

    expect(state.approvals.get('approval-1')?.status).toBe('approved')
    expect(audit[0].summary).toContain('אושרה')
  })

  it('refuses the agent approving their own request', async () => {
    // A cap the requester can lift is not a cap.
    const { ops } = await raise()
    const { services } = makeServices()

    await expect(
      ops.decideDiscount.run({
        request: { input: { approvalId: 'approval-1', approved: true } },
        context: context(
          agentActor(AGENT_PRESETS.senior, {
            grants: new Set<Grant>(['approval.decide']),
          }),
        ),
        services,
      }),
    ).rejects.toThrow(BusinessRuleError)
  })

  it('refuses an approval belonging to another organization', async () => {
    const { ops } = await raise()
    const { services } = makeServices()

    await expect(
      ops.decideDiscount.run({
        request: { input: { approvalId: 'approval-1', approved: true } },
        context: context(
          actorWith(['approval.decide'], { organizationId: 'org-b' }),
        ),
        services,
      }),
    ).rejects.toThrow()
  })
})

// ── commission.approve ────────────────────────────────────────────────────

describe('commission.approve', () => {
  function eligibleCommission(): Commission {
    const created = createCommission({
      id: 'commission-1',
      organizationId: ORG,
      propertyId: PROPERTY,
      bookingId: 'booking-1',
      agentUserId: AGENT,
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
      rule: null,
      now: NOW,
    })
    return {
      ...created,
      status: 'eligible',
      eligibleAt: NOW.toISOString(),
      amountAgorot: 36_000,
      version: 3,
    }
  }

  function setup() {
    const { repo, state } = makeRepo({
      commissions: new Map([['commission-1', eligibleCommission()]]),
    })
    return { ops: defineAgentOperations(repo), state }
  }

  it('approves it and records who signed', async () => {
    const { ops, state } = setup()
    const { services, audit } = makeServices()

    await ops.approveCommission.run({
      request: { input: { commissionId: 'commission-1' }, expectedVersion: 3 },
      context: context(ownerActor(), 'אושר לתשלום'),
      services,
    })

    const saved = state.commissions.get('commission-1')
    expect(saved?.status).toBe('approved')
    expect(saved?.approvedByUserId).toBe(OWNER)
    expect(audit[0].summary).toContain('אושרה לתשלום')
  })

  it('demands a stated reason, because releasing money is sensitive', async () => {
    const { ops } = setup()
    const { services } = makeServices()

    await expect(
      ops.approveCommission.run({
        request: {
          input: { commissionId: 'commission-1' },
          expectedVersion: 3,
        },
        context: context(ownerActor()),
        services,
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('refuses an agent approving their own commission', async () => {
    const { ops } = setup()
    const { services } = makeServices()

    await expect(
      ops.approveCommission.run({
        request: {
          input: { commissionId: 'commission-1' },
          expectedVersion: 3,
        },
        context: context(agentActor(), 'אני רוצה את הכסף'),
        services,
      }),
    ).rejects.toThrow(AuthorizationError)
  })

  it('refuses a commission in another organization', async () => {
    const { ops } = setup()
    const { services } = makeServices()

    await expect(
      ops.approveCommission.run({
        request: {
          input: { commissionId: 'commission-1' },
          expectedVersion: 3,
        },
        context: context(
          actorWith(['commission.approve'], { organizationId: 'org-b' }),
          'סיבה',
        ),
        services,
      }),
    ).rejects.toThrow()
  })
})
