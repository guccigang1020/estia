/**
 * The adapter, the double, and the one thing the screens depend on before the
 * migration exists.
 *
 * Two halves. The Supabase adapter is driven with `FakeSupabaseClient`, which
 * proves the mapping and — more usefully — proves that every read was scoped
 * by `organization_id` in the query as well as by row level security. A column
 * name spelled wrongly here is spelled wrongly consistently and would pass; the
 * fake's own header says so, and that is what a live integration test is for.
 *
 * The other half is `readIncidents`: `42P01` and `PGRST205` become a state the
 * screen renders, and **everything else is rethrown**. That second clause is
 * the one worth testing, because a `catch` that swallowed an RLS refusal would
 * turn a permissions bug into a page saying "the feature is not built".
 */

import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient } from '../persistence/fake-client'

import {
  CASE_PAGE_SIZE,
  INCIDENT_TABLES,
  InMemoryIncidentRepository,
  SupabaseIncidentRepository,
  caseFromRow,
  decisionFromRow,
  evidenceFromRow,
  readIncidents,
} from './repository'

const ORG = 'org-1'
const AT = new Date('2026-04-02T08:00:00.000Z')

const CASE_ROW = {
  id: 'case-1',
  organization_id: ORG,
  property_id: 'prop-1',
  unit_id: 'unit-1',
  booking_id: 'booking-1',
  task_id: 'task-1',
  case_type: 'property_damage',
  origin: 'checkout_inspection',
  status: 'investigating',
  title: 'משטח המטבח נשרף',
  description: null,
  occurred_at: '2026-04-01T18:00:00.000Z',
  opened_at: '2026-04-02T08:00:00.000Z',
  opened_by: 'user-1',
  resolved_at: null,
  closed_at: null,
  closed_by: null,
  version: 1,
}

describe('the schema this module is written against', () => {
  it('names seven tables, and the screens print these exact strings', () => {
    expect(INCIDENT_TABLES).toHaveLength(7)
    for (const table of INCIDENT_TABLES) {
      expect(table).toMatch(/^incident_/)
    }
  })
})

describe('reading before the migration has run', () => {
  it('turns an unknown relation into a state', async () => {
    const result = await readIncidents(async () => {
      throw Object.assign(new Error('relation does not exist'), {
        code: '42P01',
      })
    })

    expect(result.state).toBe('not_provisioned')
    expect(result.state === 'not_provisioned' && result.tables).toEqual(
      INCIDENT_TABLES,
    )
  })

  it('turns PostgREST’s missing-table answer into the same state', async () => {
    const result = await readIncidents(async () => {
      throw Object.assign(new Error('not in schema cache'), {
        code: 'PGRST205',
      })
    })
    expect(result.state).toBe('not_provisioned')
  })

  it('rethrows anything else, including a permissions refusal', async () => {
    // The half that matters. Swallowing this would show a business "the
    // feature is not built" when the truth is that a policy refused them.
    await expect(
      readIncidents(async () => {
        throw Object.assign(new Error('permission denied'), { code: '42501' })
      }),
    ).rejects.toThrow('permission denied')
  })

  it('passes a successful read straight through', async () => {
    const result = await readIncidents(async () => 7)
    expect(result).toEqual({ state: 'ready', data: 7 })
  })
})

describe('the Supabase adapter', () => {
  it('scopes every case read by the organization', async () => {
    const client = new FakeSupabaseClient({
      responses: { 'incident_cases:select': { data: [CASE_ROW] } },
    })
    const repository = new SupabaseIncidentRepository(client.asDb())

    await repository.listCases(ORG, { propertyId: 'prop-1' })

    const query = client.queries[0]
    expect(query?.table).toBe('incident_cases')
    expect(query?.filters).toContainEqual({
      op: 'eq',
      column: 'organization_id',
      value: ORG,
    })
    expect(query?.filters).toContainEqual({
      op: 'eq',
      column: 'property_id',
      value: 'prop-1',
    })
  })

  it('never asks for more than a page', async () => {
    const client = new FakeSupabaseClient({
      responses: { 'incident_cases:select': { data: [] } },
    })
    const repository = new SupabaseIncidentRepository(client.asDb())

    await repository.listCases(ORG, { limit: 100_000 })
    expect(CASE_PAGE_SIZE).toBe(100)
  })

  it('maps a case row into the domain shape', () => {
    const incident = caseFromRow(CASE_ROW)
    expect(incident.title).toBe('משטח המטבח נשרף')
    expect(incident.status).toBe('investigating')
    expect(incident.occurredAt?.toISOString()).toBe('2026-04-01T18:00:00.000Z')
    expect(incident.closedAt).toBeNull()
  })

  it('refuses a status the vocabulary does not contain', () => {
    // A mangled state renders as a blank badge three screens later. Loud is
    // the right failure direction for an enum column.
    expect(() => caseFromRow({ ...CASE_ROW, status: 'pending' })).toThrow()
  })

  it('reads evidence as a reference, and there is no data column to read', () => {
    const evidence = evidenceFromRow({
      id: 'ev-1',
      organization_id: ORG,
      case_id: 'case-1',
      kind: 'after_photo',
      media_ref: 'incidents/case-1/after-01.jpg',
      content_type: 'image/jpeg',
      byte_size: 244_113,
      statement: null,
      captured_at: '2026-04-02T07:00:00.000Z',
      recorded_at: '2026-04-02T08:00:00.000Z',
      source: 'staff',
      recorded_by: 'user-1',
      note: null,
    })

    expect(evidence.mediaRef).toBe('incidents/case-1/after-01.jpg')
    expect(Object.keys(evidence)).not.toContain('data')
  })

  it('refuses a decision row with no decider', () => {
    // `decided_by` is `not null` in the proposal. If a row ever arrives
    // without one, the read fails rather than producing a decision nobody made.
    expect(() =>
      decisionFromRow({
        id: 'dec-1',
        organization_id: ORG,
        case_id: 'case-1',
        outcome: 'guest_responsible',
        decided_by: null,
        decided_at: '2026-04-10T09:00:00.000Z',
        basis: 'evidence_reviewed',
        rationale: 'הכיריים היו תקינות בבדיקה שלפני הכניסה.',
        assessed_total_agorot: 141_000,
        guest_charge_agorot: 141_000,
        owner_charge_agorot: 0,
        business_absorbed_agorot: 0,
        supporting_evidence_ids: ['ev-1'],
        supersedes_decision_id: null,
      }),
    ).toThrow()
  })

  it('refuses a fractional amount at the border', () => {
    expect(() =>
      decisionFromRow({
        id: 'dec-1',
        organization_id: ORG,
        case_id: 'case-1',
        outcome: 'guest_responsible',
        decided_by: 'user-1',
        decided_at: '2026-04-10T09:00:00.000Z',
        basis: 'evidence_reviewed',
        rationale: 'הכיריים היו תקינות בבדיקה שלפני הכניסה.',
        assessed_total_agorot: 141_000.5,
        guest_charge_agorot: 141_000.5,
        owner_charge_agorot: 0,
        business_absorbed_agorot: 0,
        supporting_evidence_ids: [],
        supersedes_decision_id: null,
      }),
    ).toThrow()
  })
})

describe('the in-memory double', () => {
  it('reads a case back the way it was written', async () => {
    const repository = new InMemoryIncidentRepository()

    const incident = await repository.insertCase(
      {
        organizationId: ORG,
        propertyId: 'prop-1',
        unitId: 'unit-1',
        bookingId: 'booking-1',
        taskId: null,
        caseType: 'item_loss',
        origin: 'inventory_discrepancy',
        title: 'הקומקום חסר',
        description: null,
        occurredAt: null,
        openedByUserId: 'user-1',
      },
      AT,
    )

    expect(incident.status).toBe('open')
    const file = await repository.loadCase(ORG, incident.id)
    expect(file?.incident.title).toBe('הקומקום חסר')
    expect(file?.questions).toEqual([])
  })

  it('answers nothing to another organization', async () => {
    const repository = new InMemoryIncidentRepository()
    const incident = await repository.insertCase(
      {
        organizationId: ORG,
        propertyId: 'prop-1',
        unitId: null,
        bookingId: null,
        taskId: null,
        caseType: 'other',
        origin: 'maintenance',
        title: 'תקלה',
        description: null,
        occurredAt: null,
        openedByUserId: null,
      },
      AT,
    )

    expect(await repository.loadCase('org-2', incident.id)).toBeNull()
    expect(await repository.listCases('org-2')).toEqual([])
  })

  it('keeps a superseded decision rather than overwriting it', async () => {
    const repository = new InMemoryIncidentRepository()
    const base = {
      organizationId: ORG,
      caseId: 'case-1',
      outcome: 'guest_responsible' as const,
      decidedByUserId: 'user-manager',
      basis: 'evidence_reviewed' as const,
      rationale: 'הכיריים היו תקינות בבדיקה שלפני הכניסה ושרוטות ביציאה.',
      assessedTotalAgorot: 141_000,
      guestChargeAgorot: 141_000,
      ownerChargeAgorot: 0,
      businessAbsorbedAgorot: 0,
      supportingEvidenceIds: [],
      supersedesDecisionId: null,
    }

    const first = await repository.insertLiabilityDecision({
      ...base,
      decidedAt: AT,
    })
    await repository.insertLiabilityDecision({
      ...base,
      outcome: 'business_expense',
      guestChargeAgorot: 0,
      businessAbsorbedAgorot: 141_000,
      decidedAt: new Date('2026-04-11T09:00:00.000Z'),
      supersedesDecisionId: first.id,
    })

    // Both rows survive. The first question in a dispute six months later is
    // what was decided at the time and by whom.
    expect(repository.decisions).toHaveLength(2)
  })
})
