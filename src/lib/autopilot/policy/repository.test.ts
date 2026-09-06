/**
 * Same limitation `fake-client.ts` states plainly: this cannot prove a column
 * name. It proves the mapping — that a row shaped like the database's becomes
 * the record the policy engine reads — and it proves the FILTERS, which is a
 * tenant isolation claim and one worth making without a database.
 */

import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient, hasFilter } from '../../persistence/fake-client'

import {
  InMemoryAutopilotPolicyRepository,
  SupabaseAutopilotPolicyRepository,
  bookingOverrideFromRow,
  policyFromRow,
  propertyLevelFromRow,
  safetyRuleFromRow,
  settingsFromRow,
} from './repository'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const PROPERTY = '22222222-2222-4222-8222-222222222222'
const BOOKING = '33333333-3333-4333-8333-333333333333'

describe('mapping a settings row', () => {
  it('reads every column the engine depends on', () => {
    const record = settingsFromRow({
      organization_id: ORG,
      level: 'assisted',
      run_mode: 'live',
      enabled: true,
      paused_until: '2026-09-06T18:00:00+00:00',
      paused_reason: 'בדיקה אחרי תקלה',
      lookahead_hours: 48,
    })

    expect(record.level).toBe('assisted')
    expect(record.runMode).toBe('live')
    // Normalised through `Date`, so `+00:00` and `Z` are the same instant AND
    // the same string — which is what the pause comparison in `rule()` needs.
    expect(record.pausedUntil).toBe('2026-09-06T18:00:00.000Z')
  })

  it('keeps a null pause null rather than inventing an instant', () => {
    const record = settingsFromRow({
      organization_id: ORG,
      level: 'off',
      run_mode: 'simulation',
      enabled: true,
      paused_until: null,
      paused_reason: null,
      lookahead_hours: 72,
    })

    expect(record.pausedUntil).toBeNull()
    expect(record.pausedReason).toBeNull()
  })

  it('refuses a level the vocabulary does not have', () => {
    expect(() =>
      settingsFromRow({
        organization_id: ORG,
        level: 'aggressive',
        run_mode: 'live',
        enabled: true,
        paused_until: null,
        paused_reason: null,
        lookahead_hours: 72,
      }),
    ).toThrow()
  })
})

describe('mapping the narrowings', () => {
  it('reads a property level', () => {
    const record = propertyLevelFromRow({
      property_id: PROPERTY,
      organization_id: ORG,
      level: 'advisory',
    })
    expect(record).toEqual({
      propertyId: PROPERTY,
      organizationId: ORG,
      level: 'advisory',
    })
  })

  it('reads a booking override', () => {
    const record = bookingOverrideFromRow({
      booking_id: BOOKING,
      organization_id: ORG,
      handling: 'high_attention',
    })
    expect(record.handling).toBe('high_attention')
  })
})

describe('mapping a matrix cell', () => {
  it('reads one the catalogue knows', () => {
    const record = policyFromRow({
      id: 'policy-1',
      organization_id: ORG,
      property_id: null,
      action_kind: 'task.create',
      disposition: 'auto',
    })

    expect(record).not.toBeNull()
    expect(record?.actionKind).toBe('task.create')
    expect(record?.disposition).toBe('auto')
  })

  it('drops one naming an action the catalogue no longer has', () => {
    // `action_kind` is text precisely so the catalogue can grow in TypeScript
    // without a migration, and the cost of that is a row that outlives its
    // action. Refusing to load the settings screen over one would turn a
    // tidy-up into an outage.
    const record = policyFromRow({
      id: 'policy-stale',
      organization_id: ORG,
      property_id: null,
      action_kind: 'lantern.light',
      disposition: 'auto',
    })

    expect(record).toBeNull()
  })
})

describe('mapping a platform rule', () => {
  it('reads the blanket kind', () => {
    const record = safetyRuleFromRow({
      id: 'rule-1',
      action_kind: null,
      max_safety_level: 'money_access_cancellation',
      max_disposition: 'ask_approval',
      reason: 'Money is never automatic.',
    })

    expect(record?.actionKind).toBeNull()
    expect(record?.maxDisposition).toBe('ask_approval')
  })

  it('reads one aimed at a single action', () => {
    const record = safetyRuleFromRow({
      id: 'rule-2',
      action_kind: 'payment.refund',
      max_safety_level: 'money_access_cancellation',
      max_disposition: 'suggest',
      reason: 'Refunds especially.',
    })

    expect(record?.actionKind).toBe('payment.refund')
  })

  it('drops one aimed at an action nothing dispatches', () => {
    const record = safetyRuleFromRow({
      id: 'rule-3',
      action_kind: 'lantern.light',
      max_safety_level: 'information',
      max_disposition: 'off',
      reason: 'Stale.',
    })

    expect(record).toBeNull()
  })
})

describe('the reads, and what they are scoped by', () => {
  it('scopes settings by organization', async () => {
    const fake = new FakeSupabaseClient({
      responses: { autopilot_settings: { data: null } },
    })
    const repository = new SupabaseAutopilotPolicyRepository(fake.asDb())

    expect(await repository.loadSettings(ORG)).toBeNull()
    expect(
      hasFilter(
        fake.queriesFor('autopilot_settings')[0],
        'eq',
        'organization_id',
        ORG,
      ),
    ).toBe(true)
  })

  it('scopes a property level by organization as well as by property', async () => {
    const fake = new FakeSupabaseClient({
      responses: {
        autopilot_property_settings: {
          data: {
            property_id: PROPERTY,
            organization_id: ORG,
            level: 'advisory',
          },
        },
      },
    })
    const repository = new SupabaseAutopilotPolicyRepository(fake.asDb())

    const record = await repository.loadPropertyLevel(ORG, PROPERTY)
    expect(record?.level).toBe('advisory')

    const query = fake.queriesFor('autopilot_property_settings')[0]
    expect(hasFilter(query, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(query, 'eq', 'property_id', PROPERTY)).toBe(true)
  })

  it('scopes a booking override by organization as well as by booking', async () => {
    const fake = new FakeSupabaseClient({
      responses: { autopilot_booking_overrides: { data: null } },
    })
    const repository = new SupabaseAutopilotPolicyRepository(fake.asDb())

    await repository.loadBookingOverride(ORG, BOOKING)
    const query = fake.queriesFor('autopilot_booking_overrides')[0]
    expect(hasFilter(query, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(query, 'eq', 'booking_id', BOOKING)).toBe(true)
  })

  it('reads only organization-wide cells when there is no property', async () => {
    const fake = new FakeSupabaseClient({
      responses: {
        autopilot_policies: {
          data: [
            {
              id: 'policy-1',
              organization_id: ORG,
              property_id: null,
              action_kind: 'task.create',
              disposition: 'auto',
            },
            {
              id: 'policy-stale',
              organization_id: ORG,
              property_id: null,
              action_kind: 'lantern.light',
              disposition: 'auto',
            },
          ],
        },
      },
    })
    const repository = new SupabaseAutopilotPolicyRepository(fake.asDb())

    const rows = await repository.listPolicies(ORG, null)
    expect(rows).toHaveLength(1)

    const query = fake.queriesFor('autopilot_policies')[0]
    expect(hasFilter(query, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(query, 'is', 'property_id', null)).toBe(true)
  })

  it('reads the organization s cells and the property s in ONE query', async () => {
    // A matrix assembled from two reads a second apart is a matrix nobody
    // configured: an organization-wide cell changed between them and the
    // result is a combination that was never on anybody's screen. So it is one
    // `or` and the assertion is on the literal filter string, because "two
    // reads" is exactly the regression a disposition-only assertion misses.
    const fake = new FakeSupabaseClient({
      responses: {
        autopilot_policies: {
          data: [
            {
              id: 'policy-org',
              organization_id: ORG,
              property_id: null,
              action_kind: 'task.create',
              disposition: 'auto',
            },
            {
              id: 'policy-property',
              organization_id: ORG,
              property_id: PROPERTY,
              action_kind: 'task.create',
              disposition: 'suggest',
            },
          ],
        },
      },
    })
    const repository = new SupabaseAutopilotPolicyRepository(fake.asDb())

    const rows = await repository.listPolicies(ORG, PROPERTY)
    expect(rows).toHaveLength(2)

    const queries = fake.queriesFor('autopilot_policies')
    expect(queries).toHaveLength(1)

    const query = queries[0]
    expect(hasFilter(query, 'eq', 'organization_id', ORG)).toBe(true)
    expect(
      hasFilter(
        query,
        'or',
        'or',
        `property_id.is.null,property_id.eq.${PROPERTY}`,
      ),
    ).toBe(true)
    // And NOT the no-property form, which would have dropped the property's
    // own cells while still returning a plausible-looking matrix.
    expect(hasFilter(query, 'is', 'property_id', null)).toBe(false)
  })

  it('refuses a property id that is not a uuid', async () => {
    // The one place a value is concatenated into a query rather than passed as
    // an operand, so it refuses rather than escapes.
    const fake = new FakeSupabaseClient({
      responses: { autopilot_policies: { data: [] } },
    })
    const repository = new SupabaseAutopilotPolicyRepository(fake.asDb())

    await expect(
      repository.listPolicies(ORG, 'null,disposition.eq.auto'),
    ).rejects.toThrow(/Not a property id/)

    // Loudly, and before anything reached the database: a smuggled clause must
    // never be one that merely returned the wrong rows.
    expect(fake.queriesFor('autopilot_policies')).toHaveLength(0)
  })

  it('does not scope the platform floor to a tenant', async () => {
    // `autopilot_safety_rules` has no organization_id. It is the ceiling ESTIA
    // sets and no tenant may raise, so a filter would be a lie about who owns
    // it.
    const fake = new FakeSupabaseClient({
      responses: {
        autopilot_safety_rules: {
          data: [
            {
              id: 'rule-1',
              action_kind: null,
              max_safety_level: 'business_impact',
              max_disposition: 'ask_approval',
              reason: 'Commercial decisions are prepared, never made.',
            },
          ],
        },
      },
    })
    const repository = new SupabaseAutopilotPolicyRepository(fake.asDb())

    const rules = await repository.listSafetyRules()
    expect(rules).toHaveLength(1)

    const query = fake.queriesFor('autopilot_safety_rules')[0]
    expect(query.filters).toEqual([])
  })

  it('throws what PostgREST returned rather than answering empty', async () => {
    const fake = new FakeSupabaseClient({
      responses: {
        autopilot_settings: {
          error: { code: '42501', message: 'permission denied' },
        },
      },
    })
    const repository = new SupabaseAutopilotPolicyRepository(fake.asDb())

    await expect(repository.loadSettings(ORG)).rejects.toMatchObject({
      code: '42501',
    })
  })
})

describe('the in-memory double', () => {
  function seeded(): InMemoryAutopilotPolicyRepository {
    const repository = new InMemoryAutopilotPolicyRepository()

    repository.settings.set(ORG, {
      organizationId: ORG,
      level: 'autopilot',
      runMode: 'live',
      enabled: true,
      pausedUntil: null,
      pausedReason: null,
      lookaheadHours: 72,
    })
    repository.propertyLevels.push({
      propertyId: PROPERTY,
      organizationId: ORG,
      level: 'assisted',
    })
    repository.bookingOverrides.push({
      bookingId: BOOKING,
      organizationId: ORG,
      handling: 'manual_only',
    })
    repository.policies.push(
      {
        id: 'policy-org',
        organizationId: ORG,
        propertyId: null,
        actionKind: 'task.create',
        disposition: 'auto',
      },
      {
        id: 'policy-property',
        organizationId: ORG,
        propertyId: PROPERTY,
        actionKind: 'task.create',
        disposition: 'suggest',
      },
    )

    return repository
  }

  it('answers for the organization that asked', async () => {
    const repository = seeded()

    expect(await repository.loadSettings(ORG)).not.toBeNull()
    expect(await repository.loadPropertyLevel(ORG, PROPERTY)).not.toBeNull()
    expect(await repository.loadBookingOverride(ORG, BOOKING)).not.toBeNull()
  })

  it('applies the tenant filter the real adapter and RLS both apply', async () => {
    // A double that skipped this would let a test pass for the wrong reason
    // and fail in production.
    const repository = seeded()

    expect(await repository.loadSettings(OTHER_ORG)).toBeNull()
    expect(await repository.loadPropertyLevel(OTHER_ORG, PROPERTY)).toBeNull()
    expect(await repository.loadBookingOverride(OTHER_ORG, BOOKING)).toBeNull()
    expect(await repository.listPolicies(OTHER_ORG, PROPERTY)).toEqual([])
  })

  it('returns the organization s cells and this property s, and no other s', async () => {
    const repository = seeded()

    expect(await repository.listPolicies(ORG, PROPERTY)).toHaveLength(2)
    expect(await repository.listPolicies(ORG, null)).toHaveLength(1)
  })
})
