/**
 * The Supabase mapping for the agency write path.
 *
 * What this proves is the half a domain test cannot: that the two privileged
 * steps really are database function calls and not table writes, that the
 * tenant filter is on the query the caller sends rather than only in a comment,
 * and — the one that matters most — that **a write matching no row is treated
 * as a failure**. Row level security turns a refusal into an empty result set,
 * so `update(...)` against a row the policy will not show reports `error: null`
 * and changes nothing. Without these tests, "נשמר" over an unchanged record is
 * the behaviour that ships.
 *
 * It cannot prove a column name is right; that is what the live integration
 * test is for. See the header of `fake-client.ts`.
 */

import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient, hasFilter } from '@/lib/persistence/fake-client'

import { SupabaseAgencyStore } from './store'

const ORG = 'org-a'
const AGENCY = '11111111-1111-4111-8111-111111111111'
const NO_TX = undefined

const CONTACT = {
  name: 'סוכנות הצפון',
  taxId: '515151515',
  contactPhone: '04-8000000',
  contactEmail: 'office@north.example',
  addressLine1: 'הגליל 1',
  city: 'צפת',
  country: 'IL',
  note: null,
}

describe('createAgency', () => {
  it('calls the database function and never inserts into agencies', async () => {
    const client = new FakeSupabaseClient({
      responses: { 'rpc:create_agency': { data: AGENCY } },
    })
    const store = new SupabaseAgencyStore(client.asDb())

    const created = await store.createAgency(
      {
        organizationId: ORG,
        contact: CONTACT,
        terms: {
          rule: { kind: 'percentage', percent: 10 },
          base: 'stay_total',
          activeFrom: '2026-09-07',
          paymentTermsDays: 30,
        },
      },
      NO_TX,
    )

    expect(created.id).toBe(AGENCY)
    // The agency and its first agreement have to appear together: at the
    // instant of the INSERT the caller is neither a member of the agency nor a
    // party to an agreement with it, so `agencies_select` refuses the row —
    // and Postgres applies SELECT policies to `INSERT … RETURNING`.
    expect(client.queriesFor('agencies')).toHaveLength(0)
    expect(client.queriesFor('agency_agreements')).toHaveLength(0)

    const call = client.queriesFor('rpc:create_agency')[0]
    expect(call.payload).toMatchObject({
      p_organization_id: ORG,
      p_name: 'סוכנות הצפון',
      p_base: 'stay_total',
    })
  })

  it('refuses an answer that is not an id', async () => {
    const client = new FakeSupabaseClient({
      responses: { 'rpc:create_agency': { data: null } },
    })
    const store = new SupabaseAgencyStore(client.asDb())

    await expect(
      store.createAgency(
        {
          organizationId: ORG,
          contact: CONTACT,
          terms: {
            rule: { kind: 'none' },
            base: 'stay_total',
            activeFrom: '2026-09-07',
            paymentTermsDays: 30,
          },
        },
        NO_TX,
      ),
    ).rejects.toThrow(/matched no row/)
  })
})

describe('loadAgency', () => {
  it('reads the agreement first, and never reads agencies without one', async () => {
    const client = new FakeSupabaseClient({
      responses: { agency_agreements: { data: [] } },
    })
    const store = new SupabaseAgencyStore(client.asDb())

    // `agencies` has no organization_id and cannot have one, so the agreement
    // is the tenant confinement. An agency this business never signed with must
    // be indistinguishable from an id that does not exist.
    expect(await store.loadAgency(ORG, AGENCY)).toBeNull()
    expect(client.queriesFor('agencies')).toHaveLength(0)

    const read = client.queriesFor('agency_agreements')[0]
    expect(hasFilter(read, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(read, 'eq', 'agency_id', AGENCY)).toBe(true)
  })

  it('reports an agency with an active manager as claimed', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        agency_agreements: {
          data: [
            {
              id: 'agreement-1',
              agency_id: AGENCY,
              status: 'active',
              rule: { kind: 'none' },
              base: 'stay_total',
              active_from: '2026-01-01',
              active_until: null,
              payment_terms_days: 30,
              version: 5,
            },
          ],
        },
        agencies: {
          data: {
            id: AGENCY,
            name: 'סוכנות הצפון',
            tax_id: null,
            contact_phone: null,
            contact_phone_e164: null,
            contact_email: null,
            address_line1: null,
            city: null,
            country: 'IL',
            note: null,
            status: 'active',
            deactivation_reason: null,
            version: 3,
          },
        },
        agency_memberships: { data: [{ user_id: 'someone' }] },
      },
    })
    const store = new SupabaseAgencyStore(client.asDb())

    const agency = await store.loadAgency(ORG, AGENCY)
    // `agencies_update` refuses a business editing a record the agency itself
    // manages. Getting this wrong means an UPDATE matching zero rows, which
    // succeeds.
    expect(agency?.unclaimed).toBe(false)
    expect(agency?.liveAgreements).toBe(1)
  })
})

describe('saveContact', () => {
  it('refuses when the update reached no row', async () => {
    const client = new FakeSupabaseClient({
      responses: { 'agencies:update': { data: [] } },
    })
    const store = new SupabaseAgencyStore(client.asDb())

    // Either the policy refused or the version moved. Both mean the same thing
    // to the person: reload and look again — and both would otherwise be
    // reported as a successful save.
    await expect(
      store.saveContact({ agencyId: AGENCY, contact: CONTACT }, 3, NO_TX),
    ).rejects.toThrow(/matched no row/)
  })

  it('locks on the version and never writes the generated phone key', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        'agencies:update': { data: [{ id: AGENCY, version: 4 }] },
      },
    })
    const store = new SupabaseAgencyStore(client.asDb())

    const saved = await store.saveContact(
      { agencyId: AGENCY, contact: CONTACT },
      3,
      NO_TX,
    )

    expect(saved.version).toBe(4)
    const write = client.queriesFor('agencies')[0]
    expect(hasFilter(write, 'eq', 'version', 3)).toBe(true)
    // Generated column. A write path that could set it is a write path that can
    // store two spellings of one number.
    expect(write.payload).not.toHaveProperty('contact_phone_e164')
    expect(write.payload).toMatchObject({ contact_phone: '04-8000000' })
  })
})

describe('saveTerms', () => {
  const request = {
    organizationId: ORG,
    agencyId: AGENCY,
    agreementId: 'agreement-1',
    existingRuleId: null,
    rule: { kind: 'percentage' as const, percent: 8 },
    base: 'stay_total' as const,
    eligibility: ['stay_completed'] as const,
    activeFrom: '2026-09-07',
    activeUntil: null,
    paymentTermsDays: 30,
    note: null,
  }

  it('writes the document and the rule the resolver reads', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        'agency_agreements:update': { data: [{ id: 'agreement-1' }] },
        'agent_commission_rules:insert': { data: [{ id: 'rule-1' }] },
      },
    })
    const store = new SupabaseAgencyStore(client.asDb())

    const written = await store.saveTerms(request, 5, NO_TX)

    expect(written).toEqual({ agreementId: 'agreement-1', ruleId: 'rule-1' })

    // `selectCommissionRule` never reads the agreement's rule. Writing only the
    // document would render 8% beside an agency still earning 10%.
    const rule = client.queriesFor('agent_commission_rules')[0]
    expect(rule.verb).toBe('insert')
    expect(rule.payload).toMatchObject({
      agency_id: AGENCY,
      agent_user_id: null,
      eligibility_conditions: ['stay_completed'],
    })
    // NULL means "any"; an empty array would mean "no property at all", i.e. a
    // rule that pays nobody. The scope columns are absent, never `[]`.
    expect(rule.payload).not.toHaveProperty('property_ids')
  })

  it('does not touch the commission rule when the agreement write reached nothing', async () => {
    const client = new FakeSupabaseClient({
      responses: { 'agency_agreements:update': { data: [] } },
    })
    const store = new SupabaseAgencyStore(client.asDb())

    await expect(store.saveTerms(request, 5, NO_TX)).rejects.toThrow(
      /matched no row/,
    )
    expect(client.queriesFor('agent_commission_rules')).toHaveLength(0)
  })
})

describe('deactivate', () => {
  it('calls the database function and maps what it says it did', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        'rpc:deactivate_agency': {
          data: { agreements_ended: 2, entity_marked_inactive: false },
        },
      },
    })
    const store = new SupabaseAgencyStore(client.asDb())

    const result = await store.deactivate(
      { agencyId: AGENCY, organizationId: ORG, reason: 'עברו למתחרה' },
      NO_TX,
    )

    // `agencies.status` is global and `agency_agreements.status` is
    // per-organization; whether the entity may be marked inactive depends on
    // another organization's agreements, which this client cannot see and must
    // not guess.
    expect(result).toEqual({
      agreementsEnded: 2,
      entityMarkedInactive: false,
    })
    expect(client.queriesFor('agencies')).toHaveLength(0)
    expect(client.queriesFor('commissions')).toHaveLength(0)
    expect(client.queriesFor('bookings')).toHaveLength(0)
  })
})
