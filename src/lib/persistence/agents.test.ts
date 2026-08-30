/**
 * The agent mapping, and the two stores that have nowhere to write.
 *
 * The interesting assertions here are the ones about *scope*: an agent reading
 * or extending a hold must be confined to their own, and a store with no table
 * must fail loudly rather than answer `null`.
 */

import { describe, expect, it } from 'vitest'

import { SupabaseAgentRepository } from './agents'
import { FakeSupabaseClient, hasFilter } from './fake-client'
import type { Commission } from '../agents/commission'
import type { AgentHoldLedgerEntry } from '../agents/holds'
import type {
  AgentInvitation,
  AgentOrganizationSettings,
} from '../agents/types'

const HOLD_ROW = {
  id: 'hold-1',
  organization_id: 'org-a',
  held_by_user_id: 'agent-1',
  created_at: '2026-05-01T09:00:00+00:00',
  extension_count: 2,
}

/** The three ladders as 0019 stores them: enum columns, not jsonb. */
const LADDER_ROW = {
  access_calendar: 'availability_price',
  access_price: 'agent',
  access_guest_data: 'none',
  access_amendments: [],
  access_cancellation_kind: 'never',
  access_cancellation_hours: null,
  access_payment_link: false,
  inventory_kind: 'properties',
  inventory_property_ids: ['prop-a'],
  inventory_unit_ids: [],
}

const SETTINGS_ROW = {
  id: 'terms-1',
  organization_id: 'org-a',
  agent_user_id: 'agent-1',
  membership_id: 'mem-1',
  ...LADDER_ROW,
  discount_max_percent: 7.5,
  discount_max_agorot: null,
  hold_max_concurrent: 3,
  hold_max_per_day: 10,
  hold_max_extensions: 1,
  hold_default_minutes: 30,
  hold_max_minutes: 120,
  reputation_score: 0,
  agency_id: null,
  internal_note: null,
  created_at: '2026-05-01T09:00:00+00:00',
  updated_at: '2026-05-01T09:00:00+00:00',
  version: 4,
  memberships: { status: 'active' },
}

const INVITATION_ROW = {
  id: 'inv-1',
  organization_id: 'org-a',
  phone_e164: '+972501234567',
  display_name: 'רונית',
  email: null,
  invited_by_user_id: 'owner-1',
  ...LADDER_ROW,
  status: 'pending',
  created_at: '2026-05-01T09:00:00+00:00',
  expires_at: '2026-05-15T09:00:00+00:00',
  accepted_at: null,
}

const COMMISSION_ROW = {
  id: 'c-1',
  organization_id: 'org-a',
  property_id: 'prop-a',
  booking_id: 'book-1',
  agent_user_id: 'agent-1',
  agency_id: null,
  rule_id: null,
  rule_version: null,
  status: 'estimated',
  base: 'stay_total',
  basis_agorot: 950000,
  rate_bps: 1000,
  amount_agorot: 95000,
  currency: 'ILS',
  explanation: 'עשרה אחוזים מסך השהות',
  eligibility: [],
  created_at: '2026-05-01T09:00:00+00:00',
  eligible_at: null,
  approved_at: null,
  approved_by: null,
  paid_at: null,
  payout_reference: null,
  cancelled_at: null,
  cancellation_reason: null,
  version: 3,
}

function entry(
  overrides: Partial<AgentHoldLedgerEntry> = {},
): AgentHoldLedgerEntry {
  return {
    holdId: 'hold-1',
    organizationId: 'org-a',
    agentUserId: 'agent-1',
    createdAt: '2026-05-01T09:00:00.000Z',
    extensionCount: 0,
    ...overrides,
  }
}

function settings(
  overrides: Partial<AgentOrganizationSettings> = {},
): AgentOrganizationSettings {
  return {
    organizationId: 'org-a',
    agentUserId: 'agent-1',
    membershipId: 'mem-1',
    status: 'active',
    access: {
      calendar: 'availability_price',
      price: 'agent',
      guestData: 'none',
    },
    inventory: { kind: 'properties', propertyIds: ['prop-a'] },
    discountCap: { maxPercent: 7.5, maxAgorot: null },
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
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-05-01T09:00:00.000Z',
    version: 4,
    ...overrides,
  }
}

function invitation(overrides: Partial<AgentInvitation> = {}): AgentInvitation {
  return {
    id: 'inv-1',
    organizationId: 'org-a',
    phoneE164: '+972501234567',
    displayName: 'רונית',
    email: null,
    invitedByUserId: 'owner-1',
    access: {
      calendar: 'availability_price',
      price: 'agent',
      guestData: 'none',
    },
    inventory: { kind: 'properties', propertyIds: ['prop-a'] },
    status: 'pending',
    createdAt: '2026-05-01T09:00:00.000Z',
    expiresAt: '2026-05-15T09:00:00.000Z',
    acceptedAt: null,
    ...overrides,
  }
}

function commission(overrides: Partial<Commission> = {}): Commission {
  return {
    id: 'c-1',
    organizationId: 'org-a',
    propertyId: 'prop-a',
    bookingId: 'book-1',
    agentUserId: 'agent-1',
    agencyId: null,
    ruleId: null,
    ruleVersion: null,
    status: 'estimated',
    base: 'stay_total',
    basisAgorot: 950000,
    rateBps: 1000,
    amountAgorot: 95000,
    currency: 'ILS',
    explanation: 'עשרה אחוזים מסך השהות',
    eligibility: { conditions: [] },
    createdAt: '2026-05-01T09:00:00.000Z',
    eligibleAt: null,
    approvedAt: null,
    approvedByUserId: null,
    paidAt: null,
    payoutReference: null,
    cancelledAt: null,
    cancellationReason: null,
    version: 3,
    ...overrides,
  }
}

describe('the hold ledger is public.holds', () => {
  it('reads it from holds, scoped to the agent, without a second table', async () => {
    // 0015 folded the ledger into `holds.extension_count` precisely to delete
    // the parallel table. A second one would be a second answer to "how many
    // times has this been extended".
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [HOLD_ROW] } },
    })

    const ledger = await new SupabaseAgentRepository(
      client.asDb(),
    ).loadHoldLedger('org-a', 'agent-1')

    expect(ledger).toEqual([
      {
        holdId: 'hold-1',
        organizationId: 'org-a',
        agentUserId: 'agent-1',
        createdAt: '2026-05-01T09:00:00.000Z',
        extensionCount: 2,
      },
    ])

    const read = client.queriesFor('holds')[0]
    expect(hasFilter(read, 'eq', 'held_by_user_id', 'agent-1')).toBe(true)
    expect(hasFilter(read, 'eq', 'organization_id', 'org-a')).toBe(true)
  })

  it('does not filter released or expired holds out of the ledger', async () => {
    // Deliberate, and the port says why: liveness is decided in the domain
    // against the clock, and the daily cap counts holds *started* today — a
    // hold released an hour later still happened. A `released_at is null`
    // filter here would let an agent reset their own allowance by releasing.
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [] } },
    })

    await new SupabaseAgentRepository(client.asDb()).loadHoldLedger(
      'org-a',
      'agent-1',
    )

    const read = client.queriesFor('holds')[0]
    expect(hasFilter(read, 'is', 'released_at')).toBe(false)
    expect(hasFilter(read, 'gt', 'expires_at')).toBe(false)
  })

  it('names the agent when claiming a hold, so one cannot adopt another’s', async () => {
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [{ ...HOLD_ROW, extension_count: 0 }] } },
    })

    await new SupabaseAgentRepository(client.asDb()).insertLedgerEntry(
      entry(),
      undefined,
    )

    const write = client.queriesFor('holds')[0]
    expect(hasFilter(write, 'eq', 'held_by_user_id', 'agent-1')).toBe(true)
  })

  it('records an extension conditionally on the count it was granted against', async () => {
    // `recordExtension` increments in memory, so the stored row is one behind
    // — the same shape as an optimistic version. Without the predicate two
    // extensions in the same second both read the old count, both pass the
    // cap in the domain and both write, and the cap becomes advisory.
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [{ ...HOLD_ROW, extension_count: 3 }] } },
    })

    await new SupabaseAgentRepository(client.asDb()).saveLedgerEntry(
      entry({ extensionCount: 3 }),
      undefined,
    )

    const write = client.queriesFor('holds')[0]
    expect(hasFilter(write, 'eq', 'extension_count', 2)).toBe(true)
  })

  it('conflicts rather than silently doing nothing when the count moved', async () => {
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [] } },
    })

    await expect(
      new SupabaseAgentRepository(client.asDb()).saveLedgerEntry(
        entry({ extensionCount: 3 }),
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('reports a hold that is not this agent’s as not found', async () => {
    // `NotFoundError` and not an authorization refusal: telling an agent that
    // a hold exists but is somebody else's is information they did not have.
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [] } },
    })

    await expect(
      new SupabaseAgentRepository(client.asDb()).insertLedgerEntry(
        entry(),
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('finding the person behind a telephone number', () => {
  it('asks the security-definer function, not user_profiles', async () => {
    // The question is global — "does this person exist in ESTIA" — and
    // `user_profiles_select` cannot answer it: it scopes a reader to people
    // they share an organization with, and the whole point is somebody they
    // do not. A direct read here would answer "no such user" for a stranger,
    // which sends identity.ts down `invite_new_user` and creates a second
    // identity for a person who already has one.
    const client = new FakeSupabaseClient({
      responses: {
        'rpc:find_user_id_by_phone': { data: 'user-9' },
        user_profiles: { data: { full_name: 'רונית' } },
      },
    })

    const found = await new SupabaseAgentRepository(
      client.asDb(),
    ).findUserByPhone('+972501234567')

    expect(found).toEqual({ userId: 'user-9', displayName: 'רונית' })

    const rpc = client.queriesFor('rpc:find_user_id_by_phone')[0]
    expect(rpc.payload).toEqual({ phone_e164: '+972501234567' })
  })

  it('answers null without reading a profile when nobody holds the number', async () => {
    // A null from the function is "nobody holds it" *or* "you may not ask",
    // and it deliberately makes those look alike. Either way there is no id
    // to look a name up by, and asking anyway would be a wasted round trip
    // against a row that cannot exist.
    const client = new FakeSupabaseClient({
      responses: { 'rpc:find_user_id_by_phone': { data: null } },
    })

    const found = await new SupabaseAgentRepository(
      client.asDb(),
    ).findUserByPhone('+972501234567')

    expect(found).toBeNull()
    expect(client.queriesFor('user_profiles')).toHaveLength(0)
  })

  it('reports a stranger with no visible name rather than no user at all', async () => {
    // `full_name` is behind RLS and comes back empty for somebody this caller
    // shares no organization with. `displayName: null` means "nothing to
    // prefill"; the identity answer was already made by the function above.
    const client = new FakeSupabaseClient({
      responses: {
        'rpc:find_user_id_by_phone': { data: 'user-9' },
        user_profiles: { data: null },
      },
    })

    const found = await new SupabaseAgentRepository(
      client.asDb(),
    ).findUserByPhone('+972501234567')

    expect(found).toEqual({ userId: 'user-9', displayName: null })
  })
})

describe('the agent invitation', () => {
  it('reads agent_invitations by the generated E.164 column', async () => {
    const client = new FakeSupabaseClient({
      responses: { agent_invitations: { data: INVITATION_ROW } },
    })

    const invitation = await new SupabaseAgentRepository(
      client.asDb(),
    ).findPendingInvitation('org-a', '+972501234567')

    expect(invitation).toMatchObject({
      id: 'inv-1',
      phoneE164: '+972501234567',
      access: { calendar: 'availability_price', price: 'agent' },
      inventory: { kind: 'properties', propertyIds: ['prop-a'] },
      status: 'pending',
    })

    const read = client.queriesFor('agent_invitations')[0]
    expect(hasFilter(read, 'eq', 'phone_e164', '+972501234567')).toBe(true)
    expect(hasFilter(read, 'eq', 'organization_id', 'org-a')).toBe(true)
    expect(hasFilter(read, 'eq', 'status', 'pending')).toBe(true)
  })

  it('does not filter on the expiry, because the domain decides liveness', async () => {
    // `isInvitationOpen` tests the clock. A `expires_at > now()` predicate
    // here would make a lapsed invitation look absent, and a second live
    // credential would be issued for a number that already has one.
    const client = new FakeSupabaseClient({
      responses: { agent_invitations: { data: null } },
    })

    await new SupabaseAgentRepository(client.asDb()).findPendingInvitation(
      'org-a',
      '+972501234567',
    )

    const read = client.queriesFor('agent_invitations')[0]
    expect(hasFilter(read, 'gt', 'expires_at')).toBe(false)
  })

  it('writes the free-text phone and never the generated column', async () => {
    // `phone_e164` is `generated always`, so writing it is an error rather
    // than a redundancy — and writing only `phone` is what guarantees no path
    // can store a number the normaliser never saw.
    const client = new FakeSupabaseClient({
      responses: { agent_invitations: { data: INVITATION_ROW } },
    })

    await new SupabaseAgentRepository(client.asDb()).insertInvitation(
      invitation(),
      undefined,
    )

    const write = client.queriesFor('agent_invitations')[0]
    const payload = write.payload as Record<string, unknown>
    expect(payload.phone).toBe('+972501234567')
    expect(payload).not.toHaveProperty('phone_e164')
    // The pair `agent_invitations_expires_after_creation` compares.
    expect(payload.created_at).toBe('2026-05-01T09:00:00.000Z')
  })
})

describe('the agent settings row, and the status that is not on it', () => {
  it('reads the status from the embedded membership', async () => {
    // 0019 keeps the status on `memberships` and names it through a composite
    // foreign key. A copy on this row would be a second answer to "is this
    // agent suspended", and the two would disagree the first time somebody
    // was suspended through ordinary user management.
    const client = new FakeSupabaseClient({
      responses: { agent_organization_settings: { data: SETTINGS_ROW } },
    })

    const settings = await new SupabaseAgentRepository(
      client.asDb(),
    ).loadSettings('org-a', 'agent-1')

    expect(settings).toMatchObject({
      organizationId: 'org-a',
      agentUserId: 'agent-1',
      membershipId: 'mem-1',
      status: 'active',
      access: { calendar: 'availability_price', price: 'agent' },
      inventory: { kind: 'properties', propertyIds: ['prop-a'] },
      discountCap: { maxPercent: 7.5, maxAgorot: null },
      holdLimits: { maxConcurrent: 3, maxExtensions: 1 },
      version: 4,
    })

    const read = client.queriesFor('agent_organization_settings')[0]
    expect(read.columns).toContain('memberships(status)')
  })

  it('refuses a row whose membership did not come back, rather than assuming active', async () => {
    // Guessing `active` here would report a suspended agent as a working one,
    // on the record that governs whether they may sell at all.
    const client = new FakeSupabaseClient({
      responses: {
        agent_organization_settings: {
          data: { ...SETTINGS_ROW, memberships: null },
        },
      },
    })

    await expect(
      new SupabaseAgentRepository(client.asDb()).loadSettings(
        'org-a',
        'agent-1',
      ),
    ).rejects.toThrow(/memberships/)
  })

  it('reads a numeric discount cap as a number, not as the string it arrives as', async () => {
    // `discount_max_percent` is `numeric(6,3)` and PostgREST sends it as
    // `"7.500"`. discounts.ts compares it against an epsilon, and a string
    // there is a comparison that is wrong rather than one that fails.
    const client = new FakeSupabaseClient({
      responses: {
        agent_organization_settings: {
          data: { ...SETTINGS_ROW, discount_max_percent: '7.500' },
        },
      },
    })

    const settings = await new SupabaseAgentRepository(
      client.asDb(),
    ).loadSettings('org-a', 'agent-1')

    expect(settings?.discountCap.maxPercent).toBe(7.5)
  })

  it('locks on the version the caller read, and never sends version', async () => {
    // The domain pre-increments — `changeAgentStatus` returns `version + 1` —
    // and `tg_touch_row` increments the stored value again. Locking on
    // `settings.version` would match nothing and conflict on every save.
    const client = new FakeSupabaseClient({
      responses: { agent_organization_settings: { data: [SETTINGS_ROW] } },
    })

    await new SupabaseAgentRepository(client.asDb()).saveSettings(
      settings({ version: 5 }),
      4,
      undefined,
    )

    const write = client.queriesFor('agent_organization_settings')[0]
    expect(hasFilter(write, 'eq', 'version', 4)).toBe(true)
    expect(write.payload).not.toHaveProperty('version')
  })

  it('leaves the membership alone when the status did not move', async () => {
    // `memberships_update` demands `user.edit`, which an owner holding only
    // `agent.manage` does not have. An unconditional write would refuse every
    // ordinary edit of the ladders for a status nobody was changing.
    const client = new FakeSupabaseClient({
      responses: { agent_organization_settings: { data: [SETTINGS_ROW] } },
    })

    await new SupabaseAgentRepository(client.asDb()).saveSettings(
      settings(),
      4,
      undefined,
    )

    expect(client.queriesFor('memberships')).toHaveLength(0)
  })

  it('writes the status to the membership when it did move', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        agent_organization_settings: { data: [SETTINGS_ROW] },
        'memberships:update': { data: [{ status: 'suspended' }] },
      },
    })

    const saved = await new SupabaseAgentRepository(client.asDb()).saveSettings(
      settings({ status: 'suspended' }),
      4,
      undefined,
    )

    expect(saved.status).toBe('suspended')
    const write = client.queriesFor('memberships')[0]
    expect(write.verb).toBe('update')
    expect(hasFilter(write, 'eq', 'user_id', 'agent-1')).toBe(true)
  })

  it('fails loudly when the membership write matched nothing', async () => {
    // Most likely a caller with `agent.manage` and without `user.edit`.
    // Reporting the requested status anyway would tell an owner they had
    // suspended an agent who is still selling.
    const client = new FakeSupabaseClient({
      responses: {
        agent_organization_settings: { data: [SETTINGS_ROW] },
        'memberships:update': { data: [] },
      },
    })

    await expect(
      new SupabaseAgentRepository(client.asDb()).saveSettings(
        settings({ status: 'suspended' }),
        4,
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('clears the booking-only columns when an agent is demoted', async () => {
    // A patch that only wrote the fields the new variant carries would leave
    // the amendments and the payment link behind — for
    // `agent_organization_settings_booking_rights_coherent` to refuse, or for
    // a later promotion to silently restore rights nobody re-granted.
    const client = new FakeSupabaseClient({
      responses: { agent_organization_settings: { data: [SETTINGS_ROW] } },
    })

    await new SupabaseAgentRepository(client.asDb()).saveSettings(
      settings({
        access: { calendar: 'availability', price: 'none', guestData: 'none' },
      }),
      4,
      undefined,
    )

    const payload = client.queriesFor('agent_organization_settings')[0]
      .payload as Record<string, unknown>
    expect(payload.access_amendments).toEqual([])
    expect(payload.access_payment_link).toBe(false)
    expect(payload.access_cancellation_kind).toBe('never')
    expect(payload.access_cancellation_hours).toBeNull()
  })

  it('keeps the stored ladders when an existing agent is re-admitted', async () => {
    // `addAgent` passes preset defaults down this path for both the
    // attach and reactivate branches. Writing them would silently reset a
    // negotiated discount cap to zero on somebody being reinstated.
    const client = new FakeSupabaseClient({
      responses: {
        memberships: {
          data: { id: 'mem-1', user_id: 'agent-1', status: 'active' },
        },
        roles: { data: { id: 'role-sales' } },
        membership_roles: { data: { role_id: 'role-sales' } },
        agent_organization_settings: { data: SETTINGS_ROW },
      },
    })

    const attached = await new SupabaseAgentRepository(
      client.asDb(),
    ).attachExistingUser(
      {
        organizationId: 'org-a',
        userId: 'agent-1',
        preset: 'sales',
        settings: settings({ discountCap: { maxPercent: 0, maxAgorot: null } }),
      },
      undefined,
    )

    expect(attached.discountCap.maxPercent).toBe(7.5)
    const writes = client
      .queriesFor('agent_organization_settings')
      .filter((query) => query.verb === 'insert')
    expect(writes).toHaveLength(0)
  })

  it('assigns the role the preset names, in the same act as the membership', async () => {
    // The gap this closes: `membership_roles` is where grants come from, and a
    // membership created without a row there resolves with none at all. The
    // agent signs in, every screen is empty, and nothing in the record says
    // why.
    const client = new FakeSupabaseClient({
      responses: {
        // No membership yet, then the one this creates.
        'memberships:select': { data: null },
        'memberships:insert': { data: { id: 'mem-9' } },
        roles: { data: { id: 'role-senior' } },
        // Not held yet, so the insert has to happen.
        'membership_roles:select': { data: null },
        'membership_roles:insert': { data: null },
        'agent_organization_settings:select': { data: null },
        'agent_organization_settings:insert': { data: SETTINGS_ROW },
      },
    })

    await new SupabaseAgentRepository(client.asDb()).attachExistingUser(
      {
        organizationId: 'org-a',
        userId: 'agent-1',
        preset: 'senior',
        settings: settings(),
      },
      undefined,
    )

    const lookup = client.queriesFor('roles')[0]
    expect(hasFilter(lookup, 'eq', 'code', 'senior_agent')).toBe(true)
    // A *global* role. A per-organization row with the same code would be a
    // customer's own role wearing a system name.
    expect(hasFilter(lookup, 'is', 'organization_id', null)).toBe(true)

    const write = client
      .queriesFor('membership_roles')
      .find((query) => query.verb === 'insert')
    expect(write?.payload).toEqual({
      membership_id: 'mem-9',
      organization_id: 'org-a',
      role_id: 'role-senior',
    })
  })

  it('refuses the whole attach when the preset names no role that exists', async () => {
    // Returning settings here would report success for an agent who holds
    // nothing. An unmigrated catalogue is a schema problem and says so.
    const client = new FakeSupabaseClient({
      responses: {
        'memberships:select': { data: null },
        'memberships:insert': { data: { id: 'mem-9' } },
        roles: { data: null },
      },
    })

    await expect(
      new SupabaseAgentRepository(client.asDb()).attachExistingUser(
        {
          organizationId: 'org-a',
          userId: 'agent-1',
          preset: 'sales',
          settings: settings(),
        },
        undefined,
      ),
    ).rejects.toThrow(/sales_agent/)

    expect(client.queriesFor('agent_organization_settings')).toHaveLength(0)
  })
})

describe('the commission base enum, now that 0018 widened it', () => {
  it('writes stay_total instead of refusing it', async () => {
    // The guard that used to refuse this described a real difference between
    // the enum and COMMISSION_BASES. 0018 removed the difference, and a copy
    // of the enum kept here to "be safe" would only be a second list to
    // drift from.
    const client = new FakeSupabaseClient({
      responses: { commissions: { data: [COMMISSION_ROW] } },
    })

    const saved = await new SupabaseAgentRepository(
      client.asDb(),
    ).saveCommission(commission(), 2, undefined)

    expect(saved.base).toBe('stay_total')
    const write = client.queriesFor('commissions')[0]
    expect((write.payload as Record<string, unknown>).base).toBe('stay_total')
  })

  it('still refuses a stored base the domain has no meaning for', async () => {
    // The read-side guard is what catches the next divergence, at the border,
    // naming the value — on the record that decides what a person is paid.
    const client = new FakeSupabaseClient({
      responses: {
        commissions: { data: { ...COMMISSION_ROW, base: 'whole_booking' } },
      },
    })

    await expect(
      new SupabaseAgentRepository(client.asDb()).loadCommission('org-a', 'c-1'),
    ).rejects.toThrow(/base/)
  })
})
