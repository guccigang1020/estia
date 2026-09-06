/**
 * The read side: three floors, and the two states a missing migration can be
 * in.
 *
 * The floors that are testable without a database are the second and the
 * fourth: the per-row `can()` check that narrows what the query returned, and
 * the field gating that decides whether money is on the page at all. The first
 * is `requireGrant`, which needs a request and a router; the third is row level
 * security, which needs Postgres. Both are asserted elsewhere and neither is
 * simulated here — a fake that pretended to be RLS would be a test that proves
 * the fake.
 *
 * `actorFor` builds from the real role catalogue, so "a maintenance handyman
 * sees the case and not its cost" is a statement about the product rather than
 * about a hand-picked grant set.
 */

import { describe, expect, it } from 'vitest'

import { actorFor, ORG, PROPERTY } from '@/lib/finance/testing'
import { FakeSupabaseClient } from '@/lib/persistence/fake-client'
import type { Db } from '@/lib/persistence'

import { CASE_TABLES, loadCaseDetail, loadCaseRegister } from './queries'

const OTHER_PROPERTY = '66666666-6666-4666-8666-666666666666'
const CASE_ID = '77777777-7777-4777-8777-777777777777'
const NOW = new Date('2026-04-20T09:00:00.000Z')

function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_ID,
    organization_id: ORG,
    property_id: PROPERTY,
    unit_id: null,
    booking_id: null,
    task_id: null,
    case_type: 'property_damage',
    origin: 'checkout_inspection',
    status: 'investigating',
    title: 'משטח המטבח נשרף',
    description: null,
    occurred_at: null,
    opened_at: '2026-04-10T08:00:00.000Z',
    opened_by: 'user-1',
    resolved_at: null,
    closed_at: null,
    closed_by: null,
    version: 1,
    ...overrides,
  }
}

function costRow() {
  return {
    id: 'cost-1',
    organization_id: ORG,
    case_id: CASE_ID,
    kind: 'actual_repair',
    description: 'החלפת משטח עבודה',
    amount_agorot: 141_000,
    incurred_on: '2026-04-15',
    evidence_id: null,
    recorded_by: 'user-1',
    recorded_at: '2026-04-15T10:00:00.000Z',
  }
}

function detailClient(): FakeSupabaseClient {
  return new FakeSupabaseClient({
    responses: {
      'incident_cases:select': { data: caseRow() },
      'incident_case_questions:select': { data: [] },
      'incident_evidence:select': { data: [] },
      'incident_cost_lines:select': { data: [costRow()] },
      'incident_liability_decisions:select': { data: [] },
      'incident_inspections:select': { data: [] },
    },
  })
}

describe('before the migration runs', () => {
  it('reports the tables rather than an empty register', async () => {
    // An empty list would tell a business the capability works and that they
    // have never had a damage case. That is the opposite of what is true.
    const client = new FakeSupabaseClient({
      responses: {
        incident_cases: {
          error: { code: '42P01', message: 'relation does not exist' },
        },
      },
    })

    const result = await loadCaseRegister({
      db: client.asDb() as Db,
      actor: actorFor('operations_manager'),
      organizationId: ORG,
      propertyId: null,
      now: NOW,
    })

    expect(result.state).toBe('not_provisioned')
    expect(result.state === 'not_provisioned' && result.tables).toEqual(
      CASE_TABLES,
    )
  })

  it('does not swallow a permissions refusal as "not built"', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        incident_cases: {
          error: { code: '42501', message: 'permission denied' },
        },
      },
    })

    await expect(
      loadCaseRegister({
        db: client.asDb() as Db,
        actor: actorFor('operations_manager'),
        organizationId: ORG,
        propertyId: null,
        now: NOW,
      }),
    ).rejects.toThrow('permission denied')
  })
})

describe('the register', () => {
  it('scopes the query by organization and re-checks every row', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        'incident_cases:select': [
          {
            data: [
              caseRow(),
              caseRow({ id: 'other', property_id: OTHER_PROPERTY }),
            ],
          },
          { data: [] },
        ],
      },
    })

    // Scoped to one property. The second row names another one, and the query
    // returning it at all would be a bug — which is exactly why the row is
    // checked again rather than trusted.
    const result = await loadCaseRegister({
      db: client.asDb() as Db,
      actor: actorFor('property_manager', {
        scope: { kind: 'properties', propertyIds: [PROPERTY] },
      }),
      organizationId: ORG,
      propertyId: null,
      now: NOW,
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return

    expect(result.data.rows).toHaveLength(1)
    expect(result.data.rows[0]?.id).toBe(CASE_ID)

    const query = client.queriesFor('incident_cases')[0]
    expect(query?.filters).toContainEqual({
      op: 'eq',
      column: 'organization_id',
      value: ORG,
    })
  })

  it('carries no money at all', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        'incident_cases:select': [{ data: [caseRow()] }, { data: [] }],
      },
    })

    const result = await loadCaseRegister({
      db: client.asDb() as Db,
      actor: actorFor('operations_manager'),
      organizationId: ORG,
      propertyId: null,
      now: NOW,
    })

    if (result.state !== 'ready') throw new Error('expected ready')
    const row = result.data.rows[0]
    for (const key of Object.keys(row ?? {})) {
      expect(key).not.toMatch(/agorot|amount|cost|price/i)
    }
  })

  it('counts the wait in whole days from the property-local day', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        'incident_cases:select': [{ data: [caseRow()] }, { data: [] }],
      },
    })

    const result = await loadCaseRegister({
      db: client.asDb() as Db,
      actor: actorFor('operations_manager'),
      organizationId: ORG,
      propertyId: null,
      now: NOW,
    })

    if (result.state !== 'ready') throw new Error('expected ready')
    expect(result.data.rows[0]?.ageDays).toBe(10)
    expect(result.data.rows[0]?.openedOn).toBe('2026-04-10')
    // `investigating` is nobody waiting on anybody outside the business.
    expect(result.data.rows[0]?.waiting).toBe(false)
  })
})

describe('one case', () => {
  it('shows the money to somebody who may read expenses', async () => {
    const result = await loadCaseDetail({
      db: detailClient().asDb() as Db,
      actor: actorFor('operations_manager'),
      organizationId: ORG,
      caseId: CASE_ID,
    })

    if (result.state !== 'ready' || result.data === null) {
      throw new Error('expected a case')
    }
    expect(result.data.money?.assessedAgorot).toBe(141_000)
    expect(result.data.file.costLines).toHaveLength(1)
  })

  it('withholds it from the handyman, who may work the case', async () => {
    // `maintenance` holds `incident.view` and `incident.update` and no expense
    // grant at all. He sees the case and never what it cost.
    const result = await loadCaseDetail({
      db: detailClient().asDb() as Db,
      actor: actorFor('maintenance'),
      organizationId: ORG,
      caseId: CASE_ID,
    })

    if (result.state !== 'ready' || result.data === null) {
      throw new Error('expected a case')
    }
    expect(result.data.money).toBeNull()
    // Withheld rather than zeroed: the lines are absent, so no panel can print
    // ₪0 and read as "this case cost nothing".
    expect(result.data.file.costLines).toEqual([])
    expect(result.data.mayWork).toBe(true)
    expect(result.data.mayDecide).toBe(false)
  })

  it('reports a case outside the reader’s scope as absent, not refused', async () => {
    // "You may not see case 4131" confirms that case 4131 exists.
    const result = await loadCaseDetail({
      db: detailClient().asDb() as Db,
      actor: actorFor('property_manager', {
        scope: { kind: 'properties', propertyIds: [OTHER_PROPERTY] },
      }),
      organizationId: ORG,
      caseId: CASE_ID,
    })

    expect(result.state === 'ready' && result.data).toBeNull()
  })

  it('never claims to know the held deposit', async () => {
    // The figure lives in the payments module and there is no read for it
    // here. Reporting 0 would tell somebody deciding a ₪1,410 case that there
    // is nothing to apply it against.
    const result = await loadCaseDetail({
      db: detailClient().asDb() as Db,
      actor: actorFor('operations_manager'),
      organizationId: ORG,
      caseId: CASE_ID,
    })

    if (result.state !== 'ready' || result.data === null) {
      throw new Error('expected a case')
    }
    expect(result.data.depositHeldAgorot).toBeNull()
  })

  it('refuses to close a case whose money nobody decided', async () => {
    const result = await loadCaseDetail({
      db: detailClient().asDb() as Db,
      actor: actorFor('operations_manager'),
      organizationId: ORG,
      caseId: CASE_ID,
    })

    if (result.state !== 'ready' || result.data === null) {
      throw new Error('expected a case')
    }
    expect(result.data.available).not.toContain('closed')
    expect(result.data.facts.recordedCostAgorot).toBe(141_000)
    expect(result.data.facts.hasLiabilityDecision).toBe(false)
  })
})
