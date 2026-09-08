import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient } from '../persistence/fake-client'

import { priceWithRateCard, type StayPriceInput } from './stay'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROPERTY = '22222222-2222-4222-8222-222222222222'
const UNIT = '33333333-3333-4333-8333-333333333333'

function input(overrides: Partial<StayPriceInput> = {}): StayPriceInput {
  return {
    organizationId: ORG,
    propertyId: PROPERTY,
    unitId: UNIT,
    unitGroupId: null,
    range: { checkIn: '2026-07-01', checkOut: '2026-07-04' },
    guests: 2,
    eventType: null,
    source: 'direct_manual',
    grants: new Set<string>(),
    effectiveOn: '2026-06-01',
    baseUnitNightlyAgorot: 50_000,
    unitStandardGuests: 2,
    unitMinNights: 1,
    propertyMinNights: 1,
    ...overrides,
  }
}

/** A rate plan row as `rate_plans` stores it. */
function planRow(over: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    organization_id: ORG,
    property_id: PROPERTY,
    code: 'standard',
    name: 'רגיל',
    kind: 'flexible',
    channel_scope: null,
    requires_grant: null,
    derivation: null,
    min_nights: null,
    max_nights: null,
    advance_days_min: null,
    advance_days_max: null,
    cancellation_policy: {},
    floor_agorot: null,
    ceiling_agorot: null,
    priority: 10,
    is_active: true,
    effective_from: '2026-01-01',
    effective_to: null,
    version: 1,
    ...over,
  }
}

describe('priceWithRateCard — when there is no rate card', () => {
  it('falls back after ONE read when the organization has no plans', async () => {
    // The ordinary state of a guesthouse on its first day. Refusing to quote
    // would make the product unusable before it is configured — and the cost
    // of the whole feature for such a business must be one query, not four.
    const client = new FakeSupabaseClient({
      responses: { rate_plans: { data: [] } },
    })

    const priced = await priceWithRateCard(client.asDb(), input())

    expect(priced.status).toBe('no_rate_card')
    expect(client.queries).toHaveLength(1)
    expect(client.queries[0]?.table).toBe('rate_plans')
  })

  it('falls back when the table is not in this database at all', async () => {
    // `null` from the repository is a deployment fact, not a pricing decision.
    const client = new FakeSupabaseClient({
      responses: {
        rate_plans: {
          error: { code: '42P01', message: 'relation does not exist' },
        },
      },
    })

    await expect(priceWithRateCard(client.asDb(), input())).resolves.toEqual({
      status: 'no_rate_card',
    })
  })

  it('falls back when plans exist but none is eligible for this stay', async () => {
    // `no_rate_plan` from `selectRatePlan` — a rate card that does not cover
    // these dates is not a broken rate card.
    const client = new FakeSupabaseClient({
      responses: {
        rate_plans: { data: [planRow({ min_nights: 14 })] },
      },
    })

    const priced = await priceWithRateCard(client.asDb(), input())

    expect(priced.status).toBe('no_rate_card')
    // Still one read: the plan was rejected in memory, so nothing else loaded.
    expect(client.queries).toHaveLength(1)
  })
})

describe('priceWithRateCard — when a rate card resolves', () => {
  it('reads the rules of the plan it selected, and prices the stay', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        rate_plans: { data: [planRow()] },
        rate_rules: { data: [] },
        rate_calendar: { data: [] },
        rate_modifiers: { data: [] },
      },
    })

    const priced = await priceWithRateCard(client.asDb(), input())

    expect(priced.status).toBe('resolved')
    const tables = client.queries.map((q) => q.table)
    expect(tables).toContain('rate_rules')
    expect(tables).toContain('rate_calendar')
    expect(tables).toContain('rate_modifiers')
  })

  it('loads the rules of the DERIVED source plan, not the selected one', async () => {
    // The step most likely to be dropped as redundant, and the one whose
    // absence is silent: a derived plan takes its PARENT's rules, so reading
    // the child's would find none and every night would fall through to the
    // base rate — a wrong price that looks like a working rate card.
    const client = new FakeSupabaseClient({
      responses: {
        rate_plans: {
          data: [
            planRow({
              id: 'child',
              code: 'child',
              priority: 50,
              derivation: {
                from_rate_plan_id: 'parent',
                adjust: { kind: 'percent', value: -1000 },
              },
            }),
            planRow({ id: 'parent', code: 'parent', priority: 1 }),
          ],
        },
        rate_rules: { data: [] },
        rate_calendar: { data: [] },
        rate_modifiers: { data: [] },
      },
    })

    await priceWithRateCard(client.asDb(), input())

    const ruleQuery = client.queries.find((q) => q.table === 'rate_rules')
    const planFilter = ruleQuery?.filters.find(
      (f) => f.column === 'rate_plan_id',
    )
    expect(planFilter?.value).toBe('parent')
  })

  it('asks the calendar for the nights of this stay and this unit', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        rate_plans: { data: [planRow()] },
        rate_rules: { data: [] },
        rate_calendar: { data: [] },
        rate_modifiers: { data: [] },
      },
    })

    await priceWithRateCard(client.asDb(), input())

    const calendar = client.queries.find((q) => q.table === 'rate_calendar')
    const columns = calendar?.filters.map((f) => `${f.op}:${f.column}`) ?? []
    expect(columns).toContain('eq:unit_id')
    expect(columns).toContain('gte:date')
    expect(columns).toContain('lt:date')
  })
})

describe('priceWithRateCard — when a rate card is broken', () => {
  it('refuses rather than quoting around a derivation cycle', async () => {
    // The distinction this whole file exists for. A rate card that EXISTS and
    // did not resolve must not be replaced with a plausible base rate: that
    // hands the guest a number the business never set, and nobody finds out.
    const client = new FakeSupabaseClient({
      responses: {
        rate_plans: {
          data: [
            planRow({
              id: 'a',
              code: 'a',
              priority: 50,
              derivation: {
                from_rate_plan_id: 'b',
                adjust: { kind: 'percent', value: -1000 },
              },
            }),
            planRow({
              id: 'b',
              code: 'b',
              priority: 1,
              derivation: {
                from_rate_plan_id: 'a',
                adjust: { kind: 'percent', value: -1000 },
              },
            }),
          ],
        },
      },
    })

    const priced = await priceWithRateCard(client.asDb(), input())

    expect(priced.status).toBe('refused')
    if (priced.status === 'refused') {
      expect(priced.refusal.code).not.toBe('no_rate_plan')
    }
  })

  it('refuses a reversed date range instead of pricing it', async () => {
    const client = new FakeSupabaseClient({
      responses: { rate_plans: { data: [planRow()] } },
    })

    const priced = await priceWithRateCard(
      client.asDb(),
      input({ range: { checkIn: '2026-07-04', checkOut: '2026-07-01' } }),
    )

    expect(priced.status).toBe('refused')
  })
})
