/**
 * The other four adapters, and the mapping they all share.
 *
 * Same limitation as `booking.test.ts` and worth repeating: a fake client
 * cannot prove a column name. What it proves here is the set of decisions that
 * are *not* the query — the ones the in-memory reference implementations
 * encode and that a careless adapter would get subtly wrong.
 */

import { describe, expect, it } from 'vitest'

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
