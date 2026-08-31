/**
 * The other four adapters, and the mapping they all share.
 *
 * Same limitation as `booking.test.ts` and worth repeating: a fake client
 * cannot prove a column name. What it proves here is the set of decisions that
 * are *not* the query — the ones the in-memory reference implementations
 * encode and that a careless adapter would get subtly wrong.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '../actor/resolve'
import { can } from '../authz/can'
import { SupabaseActorSource } from './actor'
import { SupabaseAuditWriter } from './audit'
import { FakeSupabaseClient, hasFilter } from './fake-client'
import { SupabaseIdempotencyStore } from './idempotency'
import { RowShapeError, asAgorot, asTimestamp, definedOnly } from './mapping'

// ── ActorSource ───────────────────────────────────────────────────────────

describe('SupabaseActorSource', () => {
  it('returns null for a membership that does not exist', async () => {
    const client = new FakeSupabaseClient({
      responses: { memberships: { data: null } },
    })

    const membership = await new SupabaseActorSource(
      client.asDb(),
    ).loadMembership('user-1', 'org-1')

    // Absence is an answer `resolveActor` handles explicitly. An exception
    // would let it be handled by accident.
    expect(membership).toBeNull()
  })

  it('leaves a system role without a grants key', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        membership_roles: {
          data: [
            {
              roles: {
                code: 'organization_owner',
                is_system: true,
                is_platform: false,
                role_permissions: [{ permission_code: 'booking.view' }],
              },
            },
          ],
        },
      },
    })

    const [role] = await new SupabaseActorSource(client.asDb()).loadRoles('m-1')

    expect(role.kind).toBe('system')
    // Not `[]`. `source.ts` is explicit that a system role's grants are the
    // catalogue's answer in code, so a permission added next year reaches
    // every owner without a data migration. An empty array would read as
    // "this role grants nothing", which is the exact opposite.
    expect('grants' in role).toBe(false)
  })

  it('carries the grants of a custom role', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        membership_roles: {
          data: [
            {
              roles: {
                code: 'weekend_desk',
                is_system: false,
                is_platform: false,
                role_permissions: [
                  { permission_code: 'booking.view' },
                  { permission_code: 'booking.create' },
                ],
              },
            },
          ],
        },
      },
    })

    const [role] = await new SupabaseActorSource(client.asDb()).loadRoles('m-1')

    expect(role.kind).toBe('custom')
    expect(role.grants).toEqual(['booking.view', 'booking.create'])
  })

  it('returns an empty list rather than throwing for a membership with no roles', async () => {
    const client = new FakeSupabaseClient({
      responses: { membership_roles: { data: [] } },
    })

    expect(
      await new SupabaseActorSource(client.asDb()).loadRoles('m-1'),
    ).toEqual([])
  })

  it('carries all three scope arrays, flat, as the table stores them', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        membership_scopes: {
          data: {
            kind: 'properties',
            property_ids: ['prop-1', 'prop-2'],
            unit_ids: [],
            team_ids: [],
          },
        },
      },
    })

    const scope = await new SupabaseActorSource(client.asDb()).loadScope('m-1')

    // `resolve.ts` reads only the array belonging to `kind` and deliberately
    // does not rely on the check constraint having emptied the others.
    // Narrowing here would be this adapter taking that decision back.
    expect(scope).toEqual({
      kind: 'properties',
      propertyIds: ['prop-1', 'prop-2'],
      unitIds: [],
      teamIds: [],
    })
  })

  it('returns null when the membership has no scope row', async () => {
    const client = new FakeSupabaseClient({
      responses: { membership_scopes: { data: null } },
    })

    // Not "everything". A missing scope is nothing — see `resolve.ts`.
    expect(
      await new SupabaseActorSource(client.asDb()).loadScope('m-1'),
    ).toBeNull()
  })

  it('excludes a cancelled or soft-deleted subscription', async () => {
    const client = new FakeSupabaseClient({
      responses: { organization_subscriptions: { data: null } },
    })

    await new SupabaseActorSource(client.asDb()).loadPlan('org-1')

    const [read] = client.queriesFor('organization_subscriptions')
    expect(hasFilter(read, 'is', 'deleted_at', null)).toBe(true)
    expect(hasFilter(read, 'neq', 'status', 'cancelled')).toBe(true)
  })

  it('distinguishes an absent limit override from an unlimited one', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        organization_subscriptions: {
          data: {
            id: 'sub-1',
            organization_id: 'org-1',
            plan_id: 'plan-1',
            status: 'active',
            billing_interval: 'monthly',
            agreed_monthly_price_agorot: 64900,
            agreed_yearly_price_agorot: 649000,
            trial_ends_at: null,
            current_period_end: null,
            // Only `units` is overridden. `properties` is not mentioned.
            limit_overrides: { units: 25 },
            entitlement_grants: [],
            entitlement_revocations: [],
            plans: {
              id: 'plan-1',
              code: 'pro',
              name: 'Pro',
              description: 'x',
              monthly_price_agorot: 64900,
              yearly_price_agorot: 649000,
              limits: { properties: 5, units: 15, members: 10, storageGb: 50 },
              entitlements: ['core'],
              is_public: true,
              sort_order: 3,
            },
          },
        },
      },
    })

    const effective = await new SupabaseActorSource(client.asDb()).loadPlan(
      'org-1',
    )

    expect(effective?.subscription.limitOverrides).toEqual({ units: 25 })
    // The bug this guards: filling absent keys with `null` would turn "no
    // override on properties" into "unlimited properties" — a free upgrade
    // for every customer with any override at all.
    expect('properties' in (effective?.subscription.limitOverrides ?? {})).toBe(
      false,
    )
  })
})

// ── An agent's grants, as the whole resolution produces them ──────────────

/**
 * The defect: a settings screen that lied, in the direction that matters.
 *
 * An owner narrows an agent's calendar, price or guest-data level, the terms
 * row is written, and the agent's membership still resolves through the system
 * role their preset seeded on day one — because a system role is re-resolved
 * from the catalogue on every request. The narrowing changed what the agent
 * *screens* showed and did not change one grant, which is the wrong direction
 * for an authorization bug to point.
 *
 * Driven through `resolveActor` and `can()` rather than through `loadRoles`,
 * because the claim is not "the adapter returns a different array". The claim
 * is that the agent cannot do the thing the owner just took away, on the very
 * next request, with no re-invite and nothing to invalidate.
 */
describe('an agent resolves with a live projection of their stored access', () => {
  const PLAN = {
    id: 'sub-1',
    organization_id: 'org-1',
    plan_id: 'plan-1',
    status: 'active',
    billing_interval: 'monthly',
    agreed_monthly_price_agorot: 0,
    agreed_yearly_price_agorot: 0,
    trial_ends_at: null,
    current_period_end: null,
    limit_overrides: {},
    entitlement_grants: [],
    entitlement_revocations: [],
    plans: {
      id: 'plan-1',
      code: 'pro',
      name: 'Pro',
      description: 'x',
      monthly_price_agorot: 0,
      yearly_price_agorot: 0,
      limits: { properties: null, units: null, members: null, storageGb: null },
      // The agent grants are gated on `agent_network` and the approval path
      // on `approvals`, so the plan has to carry both or an assertion below
      // would be false for a reason that has nothing to do with the ladders.
      entitlements: ['core', 'agent_network', 'approvals'],
      is_public: true,
      sort_order: 1,
    },
  }

  /** A membership holding the seeded `sales_agent` role, plus stored terms. */
  function sourceFor(access: Record<string, unknown> | null) {
    const client = new FakeSupabaseClient({
      responses: {
        memberships: {
          data: {
            id: 'm-1',
            user_id: 'user-1',
            organization_id: 'org-1',
            status: 'active',
          },
        },
        organization_subscriptions: { data: PLAN },
        membership_roles: {
          data: [
            {
              roles: {
                code: 'sales_agent',
                is_system: true,
                is_platform: false,
                role_permissions: [],
              },
            },
          ],
        },
        // `all_organization`, which is what `attachExistingUser` writes for an
        // agent whose terms say `all_properties`. What that grant is spent on
        // is `loadScopeNarrowing`'s question and is asked separately below;
        // these assertions are about grants and nothing else.
        membership_scopes: {
          data: {
            kind: 'all_organization',
            property_ids: [],
            unit_ids: [],
            team_ids: [],
          },
        },
        agent_organization_settings: { data: access },
      },
    })
    return new SupabaseActorSource(client.asDb())
  }

  const SALES_ROW = {
    access_calendar: 'availability_booking',
    access_price: 'agent',
    access_guest_data: 'none',
    access_amendments: [],
    access_cancellation_kind: 'never',
    access_cancellation_hours: null,
    access_payment_link: false,
    // The reach columns are on the same row and are read by the same
    // resolution — `loadScopeNarrowing` asks for them by name — so a fixture
    // without them is a row the mapping refuses at the border.
    inventory_kind: 'all_properties',
    inventory_property_ids: [],
    inventory_unit_ids: [],
  }

  async function actorFor(access: Record<string, unknown> | null) {
    const resolution = await resolveActor(sourceFor(access), 'user-1', 'org-1')
    if (!resolution.ok)
      throw new Error(`expected an actor: ${resolution.reason}`)
    return resolution.actor
  }

  /**
   * A record this agent created.
   *
   * Their own, and deliberately so. An agent's default scope is `own_records`
   * — that is what the narrowing asks for and what the clamp grants — so a
   * resource belonging to nobody would be refused on scope and every assertion
   * below would pass or fail for a reason that has nothing to do with the
   * ladders being tested.
   */
  const RESOURCE = { organizationId: 'org-1', createdByUserId: 'user-1' }

  it('resolves the preset position when nothing has been edited', async () => {
    const actor = await actorFor(SALES_ROW)

    expect(can(actor, 'availability.view', RESOURCE)).toBe(true)
    expect(can(actor, 'booking.create', RESOURCE)).toBe(true)
    expect(can(actor, 'rate.view_agent', RESOURCE)).toBe(true)
  })

  it('honours a narrowing the owner made, with no re-invite', async () => {
    // The same membership, the same seeded role, one edited row: this agent
    // has been dropped to leads only. Before this wiring existed every one of
    // these was `true`, because the role answered and the row did not.
    const actor = await actorFor({
      ...SALES_ROW,
      access_calendar: 'none',
      access_price: 'none',
    })

    expect(can(actor, 'availability.view', RESOURCE)).toBe(false)
    expect(can(actor, 'booking.create', RESOURCE)).toBe(false)
    expect(can(actor, 'rate.view_agent', RESOURCE)).toBe(false)
    expect(can(actor, 'rate.view_public', RESOURCE)).toBe(false)
  })

  it('honours a widening too, so the screen is not merely a ratchet', async () => {
    const actor = await actorFor({
      ...SALES_ROW,
      access_price: 'net',
      access_guest_data: 'phone',
      access_payment_link: true,
    })

    expect(can(actor, 'rate.view_net', RESOURCE)).toBe(true)
    expect(can(actor, 'guest.view_phone', RESOURCE)).toBe(true)
    expect(can(actor, 'payment.request_link', RESOURCE)).toBe(true)
  })

  it('keeps the preset rights the ladders cannot express', async () => {
    // `lead.update` and `approval.request` are on the seeded role and on no
    // rung of any ladder, so no screen can take them away — and a projection
    // that replaced the role outright would have, silently uninstalling the
    // discount-approval path the moment this landed.
    const actor = await actorFor({
      ...SALES_ROW,
      access_calendar: 'none',
      access_price: 'none',
    })

    expect(can(actor, 'lead.update', RESOURCE)).toBe(true)
    expect(can(actor, 'approval.request', RESOURCE)).toBe(true)
    expect(can(actor, 'commission.view', RESOURCE)).toBe(true)
  })

  it('leaves the seeded role alone when no terms row exists', async () => {
    // Reachable: `attachExistingUser` writes the membership and its role
    // before the terms. Reading absence as "narrowed to nothing" would lock an
    // agent out over a row that was never written.
    const actor = await actorFor(null)

    expect(can(actor, 'booking.create', RESOURCE)).toBe(true)
  })

  it('costs a non-agent membership no extra query at all', async () => {
    // The second read is made only when a preset code is actually on the
    // membership. The fake throws on an unseeded table, so seeding no
    // `agent_organization_settings` response is itself the assertion.
    const client = new FakeSupabaseClient({
      responses: {
        membership_roles: {
          data: [
            {
              roles: {
                code: 'general_manager',
                is_system: true,
                is_platform: false,
                role_permissions: [],
              },
            },
          ],
        },
      },
    })

    const roles = await new SupabaseActorSource(client.asDb()).loadRoles('m-1')

    expect(roles).toEqual([{ code: 'general_manager', kind: 'system' }])
    expect(client.queriesFor('agent_organization_settings')).toHaveLength(0)
  })
})

// ── IdempotencyStore ──────────────────────────────────────────────────────

describe('SupabaseIdempotencyStore', () => {
  const scope = { organizationId: 'org-1', operation: 'booking.create' }

  it('reserves with a single insert-on-conflict-do-nothing', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        idempotency_keys: { data: [{ organization_id: 'org-1' }] },
      },
    })

    const result = await new SupabaseIdempotencyStore(client.asDb()).begin(
      scope,
      'retry-1',
      'fp-a',
    )

    expect(result.status).toBe('reserved')

    const [write] = client.queriesFor('idempotency_keys')
    expect(write.verb).toBe('upsert')
    expect(write.options).toEqual({
      onConflict: 'organization_id,operation,key',
      // `DO NOTHING`, not `DO UPDATE`. Overwriting would hand the key to the
      // second caller and let both proceed, which is the failure the table
      // exists to prevent.
      ignoreDuplicates: true,
    })
    // Exactly one statement decided the reservation. A select-then-insert
    // would show two queries here, and would reopen the race.
    expect(client.queriesFor('idempotency_keys')).toHaveLength(1)
  })

  it('reports a completed key with a matching fingerprint as a replay', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        idempotency_keys: [
          { data: [] },
          {
            data: {
              organization_id: 'org-1',
              operation: 'booking.create',
              key: 'retry-1',
              fingerprint: 'fp-a',
              result: { bookingId: 'bk-1' },
              created_at: '2026-08-27T10:00:00Z',
              completed_at: '2026-08-27T10:00:02Z',
            },
          },
        ],
      },
    })

    const result = await new SupabaseIdempotencyStore(client.asDb()).begin(
      scope,
      'retry-1',
      'fp-a',
    )

    expect(result.status).toBe('replayed')
    expect(result.status === 'replayed' ? result.record.result : null).toEqual({
      bookingId: 'bk-1',
    })
  })

  it('reports a different request under the same key as a mismatch, not a replay', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        idempotency_keys: [
          { data: [] },
          {
            data: {
              organization_id: 'org-1',
              operation: 'booking.create',
              key: 'retry-1',
              fingerprint: 'fp-a',
              result: { bookingId: 'bk-1' },
              created_at: '2026-08-27T10:00:00Z',
              completed_at: '2026-08-27T10:00:02Z',
            },
          },
        ],
      },
    })

    const result = await new SupabaseIdempotencyStore(client.asDb()).begin(
      scope,
      'retry-1',
      'fp-DIFFERENT',
    )

    // Checked before completion, matching the in-memory reference: a caller
    // who reused "retry-1" for a new booking must be refused, not handed the
    // previous booking's result.
    expect(result.status).toBe('mismatch')
  })

  it('reports an uncompleted key as in flight', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        idempotency_keys: [
          { data: [] },
          {
            data: {
              organization_id: 'org-1',
              operation: 'booking.create',
              key: 'retry-1',
              fingerprint: 'fp-a',
              result: null,
              created_at: '2026-08-27T10:00:00Z',
              completed_at: null,
            },
          },
        ],
      },
    })

    expect(
      (
        await new SupabaseIdempotencyStore(client.asDb()).begin(
          scope,
          'retry-1',
          'fp-a',
        )
      ).status,
    ).toBe('in_flight')
  })

  it('scopes every operation by organization and operation, never by key alone', async () => {
    const client = new FakeSupabaseClient({
      responses: { idempotency_keys: { data: null } },
    })

    await new SupabaseIdempotencyStore(client.asDb()).abandon(scope, 'retry-1')

    const [remove] = client.queriesFor('idempotency_keys')
    // Two customers choosing the same client-generated key must not be able to
    // read or clear each other's reservations. This is a tenant isolation rule
    // wearing a different hat.
    expect(hasFilter(remove, 'eq', 'organization_id', 'org-1')).toBe(true)
    expect(hasFilter(remove, 'eq', 'operation', 'booking.create')).toBe(true)
    expect(hasFilter(remove, 'eq', 'key', 'retry-1')).toBe(true)
  })
})

// ── AuditWriter ───────────────────────────────────────────────────────────

describe('SupabaseAuditWriter', () => {
  const record = {
    organizationId: 'org-1',
    actorUserId: 'user-1',
    actorType: 'user' as const,
    actorLabel: 'דנה לוי',
    onBehalfOfUserId: null,
    action: 'booking.create',
    resourceType: 'booking',
    resourceId: 'bk-1',
    propertyId: 'prop-1',
    before: null,
    after: { status: 'confirmed' },
    summary: 'דנה יצרה את הזמנה B8892',
    reason: null,
    occurredAt: new Date('2026-08-27T10:00:00Z'),
    ip: null,
    userAgent: null,
    requestId: 'corr-1',
  }

  it('writes the record as columns', async () => {
    const client = new FakeSupabaseClient({
      responses: { audit_events: { data: null } },
    })

    await new SupabaseAuditWriter(client.asDb()).write(record)

    const payload = client.queriesFor('audit_events')[0].payload as Record<
      string,
      unknown
    >
    expect(payload.organization_id).toBe('org-1')
    expect(payload.request_id).toBe('corr-1')
    expect(payload.occurred_at).toBe('2026-08-27T10:00:00.000Z')
  })

  it('rethrows a failed write rather than logging and continuing', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        audit_events: { error: { code: '42501', message: 'denied' } },
      },
    })

    // The service pipeline treats an audit failure as a failure of the whole
    // operation on purpose: a committed change with no audit row is an
    // untraceable change. A writer that swallowed this would silently cancel
    // that decision.
    await expect(
      new SupabaseAuditWriter(client.asDb()).write(record),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

// ── Mapping ───────────────────────────────────────────────────────────────

describe('the row/domain border', () => {
  it('names the column when a value is the wrong shape', () => {
    // The failure this replaces: a renamed column becoming `undefined` three
    // layers into the domain and surfacing as a blank guest name on an email.
    expect(() => asAgorot({ total_agorot: null }, 'total_agorot')).toThrow(
      RowShapeError,
    )
    expect(() => asAgorot({ total_agorot: null }, 'total_agorot')).toThrow(
      /total_agorot/,
    )
  })

  it('refuses money that is not an integer', () => {
    // Money that has become a float is money that will be wrong by a
    // hundredth of a shekel a few thousand rows later.
    expect(() => asAgorot({ amount: 150.5 }, 'amount')).toThrow(/integer/)
  })

  it('normalises a Postgres timestamp so string comparison works', () => {
    // Postgres renders `+00:00`; `toISOString()` renders `Z`. As strings those
    // are not equal, and a hold's liveness is exactly such a comparison.
    expect(
      asTimestamp({ expires_at: '2026-08-27 10:00:00+00' }, 'expires_at'),
    ).toBe('2026-08-27T10:00:00.000Z')
  })

  it('drops undefined keys so a patch does not blank a column', () => {
    // On an update, a present key means "set this"; `check_in: undefined`
    // reaching PostgREST is how an arrival date gets erased.
    expect(definedOnly({ status: 'cancelled', check_in: undefined })).toEqual({
      status: 'cancelled',
    })
  })
})
