/**
 * EXECUTION CONTEXT — SERVER ONLY. The seven tables an incident case needs.
 *
 * ══ THE TABLES DO NOT EXIST YET ════════════════════════════════════════════
 *
 * This file is written against a schema that has been *proposed* and not yet
 * applied. Agents in this repository do not write migrations — the coordinator
 * does — and the proposal is stated in full in this module's report:
 *
 *   `incident_cases`, `incident_case_questions`, `incident_evidence`,
 *   `incident_cost_lines`, `incident_liability_decisions`,
 *   `incident_inspections`, `incident_inspection_items`.
 *
 * Writing the adapter first is deliberate rather than premature, for the
 * reason `channels/repository.ts` gives: every column name below is a claim
 * about the schema, and a claim written as code is one the typecheck and the
 * in-memory double can be held against. A claim written as a paragraph in a
 * document drifts within the week.
 *
 * ── "Not provisioned" is a state, not an error ────────────────────────────
 *
 * Postgres answers `42P01` for an unknown relation and PostgREST answers
 * `PGRST205` when the table is not in its schema cache at all. Both mean the
 * migration has not run. `readProvisioned` — the shared helper in
 * `src/lib/fiscal/provisioning.ts`, imported rather than re-implemented so
 * there is one copy of the two SQLSTATEs — turns exactly those two into
 * `{ state: 'not_provisioned' }` and rethrows everything else untouched.
 *
 * That last half is the important one. An RLS refusal, a wrong column and a
 * dropped connection are all *not* this, and swallowing them would turn a real
 * fault into a screen saying "the feature is not built" — the single most
 * misleading sentence these pages could produce.
 *
 * ── Why the port exists ───────────────────────────────────────────────────
 *
 * Everything else in this module — the workflow, the liability rules, the
 * inspection comparison — is a pure function over plain data, tested without a
 * database, a client or a secret. That is only true while nothing above it
 * reaches for PostgREST. And `src/lib/persistence/**` belongs to another
 * owner, so the adapter lives beside the module that reads it, exactly as
 * `payments/repository.ts` and `channels/repository.ts` do.
 *
 * Every read filters by `organization_id` in the query as well as relying on
 * row level security. The policy is the enforcement; the filter is what stops
 * a mistake in this file becoming a cross-tenant read the first time somebody
 * runs it as `service_role`.
 */

import { readProvisioned, type Provisioned } from '../fiscal/provisioning'
import {
  asAgorot,
  asDate,
  asDateOrNull,
  asEnum,
  asNumber,
  asNumberOrNull,
  asString,
  asStringArray,
  asStringOrNull,
  clientFor,
  recordWrite,
  toRow,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import type { TransactionHandle } from '../service'

import {
  EVIDENCE_KINDS,
  EVIDENCE_SOURCES,
  type CaseEvidence,
  type CaseEvidenceDraft,
} from './evidence'
import {
  COST_LINE_KINDS,
  LIABILITY_BASES,
  LIABILITY_OUTCOMES,
  type CaseCostLine,
  type CaseCostLineDraft,
  type LiabilityDecision,
  type LiabilityDecisionDraft,
} from './liability'
import {
  INSPECTION_CONDITIONS,
  INSPECTION_STAGES,
  type InspectionItem,
  type InspectionRecord,
  type InspectionRecordDraft,
} from './inspection'
import {
  INCIDENT_CASE_STATUSES,
  INCIDENT_CASE_TYPES,
  INCIDENT_ORIGINS,
  QUESTION_AUDIENCES,
  type CaseQuestion,
  type CaseQuestionDraft,
  type IncidentCase,
  type IncidentCaseDraft,
  type IncidentCaseStatus,
} from './types'

/* -------------------------------------------------------------- tables --- */

/**
 * What a migration would create, named exactly.
 *
 * Exported because the screens print these in `DomainGap` rather than
 * paraphrasing them: an engineer closing the gap needs the identifiers and a
 * buyer judging how far from done it is needs the count.
 */
export const INCIDENT_TABLES = [
  'incident_cases',
  'incident_case_questions',
  'incident_evidence',
  'incident_cost_lines',
  'incident_liability_decisions',
  'incident_inspections',
  'incident_inspection_items',
] as const

/* ---------------------------------------------------------------- port --- */

/** Everything one case is made of, read together so the parts agree. */
export interface CaseFile {
  incident: IncidentCase
  questions: readonly CaseQuestion[]
  evidence: readonly CaseEvidence[]
  costLines: readonly CaseCostLine[]
  /** Newest first. Superseded decisions are kept, never deleted. */
  decisions: readonly LiabilityDecision[]
  inspections: readonly InspectionRecord[]
}

export interface CaseQuery {
  propertyId?: string | null
  statuses?: readonly IncidentCaseStatus[]
  bookingId?: string | null
  limit?: number
}

export interface IncidentRepository {
  listCases(
    organizationId: string,
    query?: CaseQuery,
  ): Promise<readonly IncidentCase[]>

  countCases(organizationId: string, query?: CaseQuery): Promise<number>

  loadCase(organizationId: string, caseId: string): Promise<CaseFile | null>

  insertCase(
    draft: IncidentCaseDraft,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<IncidentCase>

  /**
   * Move a case to a new status.
   *
   * The workflow rule is checked above this line, in `workflow.ts`, and again
   * by the CHECK constraint the migration carries. This writes; it does not
   * decide.
   */
  setStatus(
    organizationId: string,
    caseId: string,
    status: IncidentCaseStatus,
    actorUserId: string | null,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<IncidentCase>

  insertEvidence(
    draft: CaseEvidenceDraft,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<CaseEvidence>

  insertQuestion(
    organizationId: string,
    draft: CaseQuestionDraft,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<CaseQuestion>

  answerQuestion(
    organizationId: string,
    questionId: string,
    answer: string,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<CaseQuestion>

  insertCostLine(
    draft: CaseCostLineDraft,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<CaseCostLine>

  /**
   * Record a decision. Never an update.
   *
   * A revised decision is a new row naming the one it supersedes, because the
   * first question in a dispute six months later is what was decided at the
   * time and by whom — and an `update` deletes exactly that.
   */
  insertLiabilityDecision(
    draft: LiabilityDecisionDraft,
    tx?: TransactionHandle,
  ): Promise<LiabilityDecision>

  insertInspection(
    draft: InspectionRecordDraft,
    tx?: TransactionHandle,
  ): Promise<InspectionRecord>

  listInspections(
    organizationId: string,
    query: { bookingId?: string | null; unitId?: string | null },
  ): Promise<readonly InspectionRecord[]>
}

/* ------------------------------------------------------------- columns --- */

const CASE_COLUMNS =
  'id, organization_id, property_id, unit_id, booking_id, task_id, ' +
  'case_type, origin, status, title, description, occurred_at, opened_at, ' +
  'opened_by, resolved_at, closed_at, closed_by, version'

const QUESTION_COLUMNS =
  'id, organization_id, case_id, audience, question, asked_at, asked_by, ' +
  'answered_at, answer'

const EVIDENCE_COLUMNS =
  'id, organization_id, case_id, kind, media_ref, content_type, byte_size, ' +
  'statement, captured_at, recorded_at, source, recorded_by, note'

const COST_COLUMNS =
  'id, organization_id, case_id, kind, description, amount_agorot, ' +
  'incurred_on, evidence_id, recorded_by, recorded_at'

const DECISION_COLUMNS =
  'id, organization_id, case_id, outcome, decided_by, decided_at, basis, ' +
  'rationale, assessed_total_agorot, guest_charge_agorot, ' +
  'owner_charge_agorot, business_absorbed_agorot, supporting_evidence_ids, ' +
  'supersedes_decision_id'

const INSPECTION_COLUMNS =
  'id, organization_id, property_id, unit_id, booking_id, case_id, stage, ' +
  'performed_by, performed_at, notes'

const INSPECTION_ITEM_COLUMNS =
  'id, organization_id, inspection_id, item_key, label, condition, ' +
  'quantity, evidence_ids, note, sort_order'

/* ------------------------------------------------------------- mapping --- */

export function caseFromRow(row: Row): IncidentCase {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    unitId: asStringOrNull(row, 'unit_id'),
    bookingId: asStringOrNull(row, 'booking_id'),
    taskId: asStringOrNull(row, 'task_id'),
    caseType: asEnum(row, 'case_type', INCIDENT_CASE_TYPES),
    origin: asEnum(row, 'origin', INCIDENT_ORIGINS),
    status: asEnum(row, 'status', INCIDENT_CASE_STATUSES),
    title: asString(row, 'title'),
    description: asStringOrNull(row, 'description'),
    occurredAt: asDateOrNull(row, 'occurred_at'),
    openedAt: asDate(row, 'opened_at'),
    openedByUserId: asStringOrNull(row, 'opened_by'),
    resolvedAt: asDateOrNull(row, 'resolved_at'),
    closedAt: asDateOrNull(row, 'closed_at'),
    closedByUserId: asStringOrNull(row, 'closed_by'),
    version: asNumber(row, 'version'),
  }
}

export function questionFromRow(row: Row): CaseQuestion {
  return {
    id: asString(row, 'id'),
    caseId: asString(row, 'case_id'),
    audience: asEnum(row, 'audience', QUESTION_AUDIENCES),
    question: asString(row, 'question'),
    askedAt: asDate(row, 'asked_at'),
    askedByUserId: asStringOrNull(row, 'asked_by'),
    answeredAt: asDateOrNull(row, 'answered_at'),
    answer: asStringOrNull(row, 'answer'),
  }
}

export function evidenceFromRow(row: Row): CaseEvidence {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    caseId: asString(row, 'case_id'),
    kind: asEnum(row, 'kind', EVIDENCE_KINDS),
    // A reference. The bytes are in the object store and never in this row —
    // there is no `data` column in the proposal for exactly this reason.
    mediaRef: asStringOrNull(row, 'media_ref'),
    contentType: asStringOrNull(row, 'content_type'),
    byteSize: asNumberOrNull(row, 'byte_size'),
    statement: asStringOrNull(row, 'statement'),
    capturedAt: asDateOrNull(row, 'captured_at'),
    recordedAt: asDate(row, 'recorded_at'),
    source: asEnum(row, 'source', EVIDENCE_SOURCES),
    recordedByUserId: asStringOrNull(row, 'recorded_by'),
    note: asStringOrNull(row, 'note'),
  }
}

export function costLineFromRow(row: Row): CaseCostLine {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    caseId: asString(row, 'case_id'),
    kind: asEnum(row, 'kind', COST_LINE_KINDS),
    description: asString(row, 'description'),
    // `bigint` in the proposal, read as a number. Agorot, integer, never a
    // float: a shekel value has no representation anywhere in this module.
    amountAgorot: asAgorot(row, 'amount_agorot'),
    incurredOn: asStringOrNull(row, 'incurred_on'),
    evidenceId: asStringOrNull(row, 'evidence_id'),
    recordedByUserId: asStringOrNull(row, 'recorded_by'),
    recordedAt: asDate(row, 'recorded_at'),
  }
}

export function decisionFromRow(row: Row): LiabilityDecision {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    caseId: asString(row, 'case_id'),
    outcome: asEnum(row, 'outcome', LIABILITY_OUTCOMES),
    // `not null` in the proposal. A decision without a decider cannot be
    // written, cannot be read back, and does not typecheck — three floors
    // under one rule.
    decidedByUserId: asString(row, 'decided_by'),
    decidedAt: asDate(row, 'decided_at'),
    basis: asEnum(row, 'basis', LIABILITY_BASES),
    rationale: asString(row, 'rationale'),
    assessedTotalAgorot: asAgorot(row, 'assessed_total_agorot'),
    guestChargeAgorot: asAgorot(row, 'guest_charge_agorot'),
    ownerChargeAgorot: asAgorot(row, 'owner_charge_agorot'),
    businessAbsorbedAgorot: asAgorot(row, 'business_absorbed_agorot'),
    supportingEvidenceIds: asStringArray(row, 'supporting_evidence_ids'),
    supersedesDecisionId: asStringOrNull(row, 'supersedes_decision_id'),
  }
}

function inspectionItemFromRow(row: Row): InspectionItem {
  return {
    key: asString(row, 'item_key'),
    label: asString(row, 'label'),
    condition: asEnum(row, 'condition', INSPECTION_CONDITIONS),
    quantity: asNumberOrNull(row, 'quantity'),
    evidenceIds: asStringArray(row, 'evidence_ids'),
    note: asStringOrNull(row, 'note'),
  }
}

export function inspectionFromRow(
  row: Row,
  items: readonly InspectionItem[],
): InspectionRecord {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    unitId: asString(row, 'unit_id'),
    bookingId: asStringOrNull(row, 'booking_id'),
    caseId: asStringOrNull(row, 'case_id'),
    stage: asEnum(row, 'stage', INSPECTION_STAGES),
    performedByUserId: asStringOrNull(row, 'performed_by'),
    performedAt: asDate(row, 'performed_at'),
    notes: asStringOrNull(row, 'notes'),
    items,
  }
}

/* ------------------------------------------------------------- adapter --- */

/** The ceiling on a register read. Longer than this is a report, not a queue. */
export const CASE_PAGE_SIZE = 100

export class SupabaseIncidentRepository implements IncidentRepository {
  constructor(private readonly db: Db) {}

  async listCases(
    organizationId: string,
    query: CaseQuery = {},
  ): Promise<readonly IncidentCase[]> {
    let builder = this.db
      .from('incident_cases')
      .select(CASE_COLUMNS)
      .eq('organization_id', organizationId)

    if (query.propertyId) {
      builder = builder.eq('property_id', query.propertyId)
    }
    if (query.bookingId) builder = builder.eq('booking_id', query.bookingId)
    if (query.statuses && query.statuses.length > 0) {
      builder = builder.in('status', [...query.statuses])
    }

    // Oldest first among the unsettled: a case that has been waiting eleven
    // days is the one somebody has to work, and a newest-first register buries
    // it under this morning's.
    const { data, error } = await builder
      .order('opened_at', { ascending: true })
      .limit(Math.min(query.limit ?? CASE_PAGE_SIZE, CASE_PAGE_SIZE))

    if (error) throw error
    return toRows(data).map(caseFromRow)
  }

  async countCases(
    organizationId: string,
    query: CaseQuery = {},
  ): Promise<number> {
    let builder = this.db
      .from('incident_cases')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)

    if (query.propertyId) {
      builder = builder.eq('property_id', query.propertyId)
    }
    if (query.statuses && query.statuses.length > 0) {
      builder = builder.in('status', [...query.statuses])
    }

    const { count, error } = await builder
    if (error) throw error
    return count ?? 0
  }

  async loadCase(
    organizationId: string,
    caseId: string,
  ): Promise<CaseFile | null> {
    const { data, error } = await this.db
      .from('incident_cases')
      .select(CASE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', caseId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const incident = caseFromRow(toRow(data))

    const [questions, evidence, costLines, decisions, inspections] =
      await Promise.all([
        this.readQuestions(organizationId, caseId),
        this.readEvidence(organizationId, caseId),
        this.readCostLines(organizationId, caseId),
        this.readDecisions(organizationId, caseId),
        this.listInspections(organizationId, { bookingId: incident.bookingId }),
      ])

    return { incident, questions, evidence, costLines, decisions, inspections }
  }

  private async readQuestions(
    organizationId: string,
    caseId: string,
  ): Promise<readonly CaseQuestion[]> {
    const { data, error } = await this.db
      .from('incident_case_questions')
      .select(QUESTION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('case_id', caseId)
      .order('asked_at', { ascending: true })

    if (error) throw error
    return toRows(data).map(questionFromRow)
  }

  private async readEvidence(
    organizationId: string,
    caseId: string,
  ): Promise<readonly CaseEvidence[]> {
    const { data, error } = await this.db
      .from('incident_evidence')
      .select(EVIDENCE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('case_id', caseId)
      .order('recorded_at', { ascending: true })

    if (error) throw error
    return toRows(data).map(evidenceFromRow)
  }

  private async readCostLines(
    organizationId: string,
    caseId: string,
  ): Promise<readonly CaseCostLine[]> {
    const { data, error } = await this.db
      .from('incident_cost_lines')
      .select(COST_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('case_id', caseId)
      .order('recorded_at', { ascending: true })

    if (error) throw error
    return toRows(data).map(costLineFromRow)
  }

  private async readDecisions(
    organizationId: string,
    caseId: string,
  ): Promise<readonly LiabilityDecision[]> {
    const { data, error } = await this.db
      .from('incident_liability_decisions')
      .select(DECISION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('case_id', caseId)
      .order('decided_at', { ascending: false })

    if (error) throw error
    return toRows(data).map(decisionFromRow)
  }

  async insertCase(
    draft: IncidentCaseDraft,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<IncidentCase> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('incident_cases')
      .insert({
        organization_id: draft.organizationId,
        property_id: draft.propertyId,
        unit_id: draft.unitId,
        booking_id: draft.bookingId,
        task_id: draft.taskId,
        case_type: draft.caseType,
        origin: draft.origin,
        // Born `open` and never anything else. A case created directly in
        // `resolved` would be a decision with no decider, which is the one
        // thing this module exists to prevent.
        status: 'open',
        title: draft.title,
        description: draft.description,
        occurred_at: draft.occurredAt?.toISOString() ?? null,
        opened_at: at.toISOString(),
        opened_by: draft.openedByUserId,
      })
      .select(CASE_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'incident_cases.insert')
    return caseFromRow(toRow(data))
  }

  async setStatus(
    organizationId: string,
    caseId: string,
    status: IncidentCaseStatus,
    actorUserId: string | null,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<IncidentCase> {
    const db = clientFor(tx, this.db)

    // `resolved_at` and `closed_at` are stamped here rather than left to a
    // trigger, because the proposal's trigger stamps them too and the two must
    // agree; writing them explicitly is what makes a disagreement visible in a
    // test rather than in a dispute.
    const patch: Record<string, unknown> = { status }
    if (status === 'resolved') patch.resolved_at = at.toISOString()
    if (status === 'closed') {
      patch.closed_at = at.toISOString()
      patch.closed_by = actorUserId
    }

    const { data, error } = await db
      .from('incident_cases')
      .update(patch)
      .eq('organization_id', organizationId)
      .eq('id', caseId)
      .select(CASE_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'incident_cases.status')
    return caseFromRow(toRow(data))
  }

  async insertEvidence(
    draft: CaseEvidenceDraft,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<CaseEvidence> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('incident_evidence')
      .insert({
        organization_id: draft.organizationId,
        case_id: draft.caseId,
        kind: draft.kind,
        media_ref: draft.mediaRef,
        content_type: draft.contentType,
        byte_size: draft.byteSize,
        statement: draft.statement,
        captured_at: draft.capturedAt?.toISOString() ?? null,
        recorded_at: at.toISOString(),
        source: draft.source,
        recorded_by: draft.recordedByUserId,
        note: draft.note,
      })
      .select(EVIDENCE_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'incident_evidence.insert')
    return evidenceFromRow(toRow(data))
  }

  async insertQuestion(
    organizationId: string,
    draft: CaseQuestionDraft,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<CaseQuestion> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('incident_case_questions')
      .insert({
        organization_id: organizationId,
        case_id: draft.caseId,
        audience: draft.audience,
        question: draft.question,
        asked_at: at.toISOString(),
        asked_by: draft.askedByUserId,
      })
      .select(QUESTION_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'incident_case_questions.insert')
    return questionFromRow(toRow(data))
  }

  async answerQuestion(
    organizationId: string,
    questionId: string,
    answer: string,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<CaseQuestion> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('incident_case_questions')
      .update({ answer, answered_at: at.toISOString() })
      .eq('organization_id', organizationId)
      .eq('id', questionId)
      .select(QUESTION_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'incident_case_questions.answer')
    return questionFromRow(toRow(data))
  }

  async insertCostLine(
    draft: CaseCostLineDraft,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<CaseCostLine> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('incident_cost_lines')
      .insert({
        organization_id: draft.organizationId,
        case_id: draft.caseId,
        kind: draft.kind,
        description: draft.description,
        amount_agorot: draft.amountAgorot,
        incurred_on: draft.incurredOn,
        evidence_id: draft.evidenceId,
        recorded_by: draft.recordedByUserId,
        recorded_at: at.toISOString(),
      })
      .select(COST_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'incident_cost_lines.insert')
    return costLineFromRow(toRow(data))
  }

  async insertLiabilityDecision(
    draft: LiabilityDecisionDraft,
    tx?: TransactionHandle,
  ): Promise<LiabilityDecision> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('incident_liability_decisions')
      .insert({
        organization_id: draft.organizationId,
        case_id: draft.caseId,
        outcome: draft.outcome,
        decided_by: draft.decidedByUserId,
        decided_at: draft.decidedAt.toISOString(),
        basis: draft.basis,
        rationale: draft.rationale,
        assessed_total_agorot: draft.assessedTotalAgorot,
        guest_charge_agorot: draft.guestChargeAgorot,
        owner_charge_agorot: draft.ownerChargeAgorot,
        business_absorbed_agorot: draft.businessAbsorbedAgorot,
        supporting_evidence_ids: [...draft.supportingEvidenceIds],
        supersedes_decision_id: draft.supersedesDecisionId,
      })
      .select(DECISION_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'incident_liability_decisions.insert')
    return decisionFromRow(toRow(data))
  }

  async insertInspection(
    draft: InspectionRecordDraft,
    tx?: TransactionHandle,
  ): Promise<InspectionRecord> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('incident_inspections')
      .insert({
        organization_id: draft.organizationId,
        property_id: draft.propertyId,
        unit_id: draft.unitId,
        booking_id: draft.bookingId,
        case_id: draft.caseId,
        stage: draft.stage,
        performed_by: draft.performedByUserId,
        performed_at: draft.performedAt.toISOString(),
        notes: draft.notes,
      })
      .select(INSPECTION_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'incident_inspections.insert')

    const inspectionRow = toRow(data)
    const inspectionId = asString(inspectionRow, 'id')

    if (draft.items.length === 0) {
      return inspectionFromRow(inspectionRow, [])
    }

    const { data: itemData, error: itemError } = await db
      .from('incident_inspection_items')
      .insert(
        draft.items.map((item, index) => ({
          organization_id: draft.organizationId,
          inspection_id: inspectionId,
          item_key: item.key,
          label: item.label,
          condition: item.condition,
          quantity: item.quantity,
          evidence_ids: [...item.evidenceIds],
          note: item.note,
          sort_order: index,
        })),
      )
      .select(INSPECTION_ITEM_COLUMNS)

    if (itemError) throw itemError
    if (tx) recordWrite(tx, 'incident_inspection_items.insert')

    return inspectionFromRow(
      inspectionRow,
      toRows(itemData).map(inspectionItemFromRow),
    )
  }

  async listInspections(
    organizationId: string,
    query: { bookingId?: string | null; unitId?: string | null },
  ): Promise<readonly InspectionRecord[]> {
    if (!query.bookingId && !query.unitId) return []

    let builder = this.db
      .from('incident_inspections')
      .select(INSPECTION_COLUMNS)
      .eq('organization_id', organizationId)

    if (query.bookingId) builder = builder.eq('booking_id', query.bookingId)
    if (query.unitId) builder = builder.eq('unit_id', query.unitId)

    const { data, error } = await builder.order('performed_at', {
      ascending: true,
    })
    if (error) throw error

    const rows = toRows(data)
    if (rows.length === 0) return []

    const ids = rows.map((row) => asString(row, 'id'))
    const { data: itemData, error: itemError } = await this.db
      .from('incident_inspection_items')
      .select(INSPECTION_ITEM_COLUMNS)
      .eq('organization_id', organizationId)
      .in('inspection_id', ids)
      .order('sort_order', { ascending: true })

    if (itemError) throw itemError

    const byInspection = new Map<string, InspectionItem[]>()
    for (const row of toRows(itemData)) {
      const key = asString(row, 'inspection_id')
      const bucket = byInspection.get(key) ?? []
      bucket.push(inspectionItemFromRow(row))
      byInspection.set(key, bucket)
    }

    return rows.map((row) =>
      inspectionFromRow(row, byInspection.get(asString(row, 'id')) ?? []),
    )
  }
}

/* -------------------------------------------------------- provisioning --- */

/**
 * Run a read, and turn "the migration has not run" into a state.
 *
 * The one wrapper the screens call. Everything that is not `42P01` or
 * `PGRST205` is rethrown untouched — see the header for why that half matters
 * more than this one.
 */
export async function readIncidents<T>(
  read: () => Promise<T>,
): Promise<Provisioned<T>> {
  return readProvisioned(INCIDENT_TABLES, read)
}

export type { Provisioned }

/* ------------------------------------------------------------- in memory -- */
/** Readable hex tags, so an id in a failed assertion says where it came from. */
const ID_TAGS = {
  case: 'ca5e',
  evidence: 'e71d',
  question: '9e57',
  cost: 'c057',
  decision: 'dec1',
  inspection: '1457',
} as const

/**
 * The double, maintained beside the thing it doubles.
 *
 * The same argument `InMemoryPaymentPolicyRepository` and
 * `InMemoryChannelRepository` make: a double that ships in a `__tests__`
 * folder drifts from the port within a month, and the drift shows up as a
 * green suite over a broken adapter. This one implements the same interface,
 * so a method added to `IncidentRepository` breaks it at compile time.
 *
 * It is not a database. There is no row level security here, no tenant
 * isolation beyond the explicit `organizationId` comparisons, and no
 * constraint. What it is good for is the domain: that the workflow refuses a
 * closure, that a decision demands a decider, that a case reads back the way
 * it was written.
 */
export class InMemoryIncidentRepository implements IncidentRepository {
  readonly cases: IncidentCase[] = []
  readonly questions: CaseQuestion[] = []
  readonly evidence: CaseEvidence[] = []
  readonly costLines: CaseCostLine[] = []
  readonly decisions: LiabilityDecision[] = []
  readonly inspections: InspectionRecord[] = []

  private sequence = 0

  /**
   * A real UUID, because the operations validate their inputs as UUIDs.
   *
   * A double that hands back `case-1` is a double whose output cannot be fed
   * back into the operation that produced it, and a test written around that
   * limitation proves less than it appears to. The leading tag is readable hex
   * so a failing assertion still says which table the id came from.
   */
  private nextId(prefix: keyof typeof ID_TAGS): string {
    this.sequence += 1
    const tail = String(this.sequence).padStart(12, '0')
    return `${ID_TAGS[prefix]}0000-0000-4000-8000-${tail}`
  }

  async listCases(
    organizationId: string,
    query: CaseQuery = {},
  ): Promise<readonly IncidentCase[]> {
    return this.cases
      .filter((row) => row.organizationId === organizationId)
      .filter((row) => !query.propertyId || row.propertyId === query.propertyId)
      .filter((row) => !query.bookingId || row.bookingId === query.bookingId)
      .filter(
        (row) =>
          !query.statuses ||
          query.statuses.length === 0 ||
          query.statuses.includes(row.status),
      )
      .sort((left, right) => left.openedAt.getTime() - right.openedAt.getTime())
      .slice(0, Math.min(query.limit ?? CASE_PAGE_SIZE, CASE_PAGE_SIZE))
  }

  async countCases(
    organizationId: string,
    query: CaseQuery = {},
  ): Promise<number> {
    return (
      await this.listCases(organizationId, { ...query, limit: undefined })
    ).length
  }

  async loadCase(
    organizationId: string,
    caseId: string,
  ): Promise<CaseFile | null> {
    const incident = this.cases.find(
      (row) => row.id === caseId && row.organizationId === organizationId,
    )
    if (!incident) return null

    return {
      incident,
      questions: this.questions.filter((row) => row.caseId === caseId),
      evidence: this.evidence.filter((row) => row.caseId === caseId),
      costLines: this.costLines.filter((row) => row.caseId === caseId),
      decisions: [
        ...this.decisions.filter((row) => row.caseId === caseId),
      ].sort(
        (left, right) => right.decidedAt.getTime() - left.decidedAt.getTime(),
      ),
      inspections: this.inspections.filter(
        (row) =>
          row.caseId === caseId ||
          (incident.bookingId !== null && row.bookingId === incident.bookingId),
      ),
    }
  }

  async insertCase(draft: IncidentCaseDraft, at: Date): Promise<IncidentCase> {
    const row: IncidentCase = {
      id: this.nextId('case'),
      organizationId: draft.organizationId,
      propertyId: draft.propertyId,
      unitId: draft.unitId,
      bookingId: draft.bookingId,
      taskId: draft.taskId,
      caseType: draft.caseType,
      origin: draft.origin,
      status: 'open',
      title: draft.title,
      description: draft.description,
      occurredAt: draft.occurredAt,
      openedAt: at,
      openedByUserId: draft.openedByUserId,
      resolvedAt: null,
      closedAt: null,
      closedByUserId: null,
      version: 1,
    }
    this.cases.push(row)
    return row
  }

  async setStatus(
    organizationId: string,
    caseId: string,
    status: IncidentCaseStatus,
    actorUserId: string | null,
    at: Date,
  ): Promise<IncidentCase> {
    const index = this.cases.findIndex(
      (row) => row.id === caseId && row.organizationId === organizationId,
    )
    const current = this.cases[index]
    if (index < 0 || !current) throw new Error(`No case ${caseId}`)

    const updated: IncidentCase = {
      ...current,
      status,
      resolvedAt: status === 'resolved' ? at : current.resolvedAt,
      closedAt: status === 'closed' ? at : current.closedAt,
      closedByUserId:
        status === 'closed' ? actorUserId : current.closedByUserId,
      version: current.version + 1,
    }
    this.cases[index] = updated
    return updated
  }

  async insertEvidence(
    draft: CaseEvidenceDraft,
    at: Date,
  ): Promise<CaseEvidence> {
    const row: CaseEvidence = {
      id: this.nextId('evidence'),
      organizationId: draft.organizationId,
      caseId: draft.caseId,
      kind: draft.kind,
      mediaRef: draft.mediaRef,
      contentType: draft.contentType,
      byteSize: draft.byteSize,
      statement: draft.statement,
      capturedAt: draft.capturedAt,
      recordedAt: at,
      source: draft.source,
      recordedByUserId: draft.recordedByUserId,
      note: draft.note,
    }
    this.evidence.push(row)
    return row
  }

  async insertQuestion(
    _organizationId: string,
    draft: CaseQuestionDraft,
    at: Date,
  ): Promise<CaseQuestion> {
    const row: CaseQuestion = {
      id: this.nextId('question'),
      caseId: draft.caseId,
      audience: draft.audience,
      question: draft.question,
      askedAt: at,
      askedByUserId: draft.askedByUserId,
      answeredAt: null,
      answer: null,
    }
    this.questions.push(row)
    return row
  }

  async answerQuestion(
    _organizationId: string,
    questionId: string,
    answer: string,
    at: Date,
  ): Promise<CaseQuestion> {
    const index = this.questions.findIndex((row) => row.id === questionId)
    const current = this.questions[index]
    if (index < 0 || !current) throw new Error(`No question ${questionId}`)

    const updated: CaseQuestion = { ...current, answer, answeredAt: at }
    this.questions[index] = updated
    return updated
  }

  async insertCostLine(
    draft: CaseCostLineDraft,
    at: Date,
  ): Promise<CaseCostLine> {
    const row: CaseCostLine = {
      id: this.nextId('cost'),
      organizationId: draft.organizationId,
      caseId: draft.caseId,
      kind: draft.kind,
      description: draft.description,
      amountAgorot: draft.amountAgorot,
      incurredOn: draft.incurredOn,
      evidenceId: draft.evidenceId,
      recordedByUserId: draft.recordedByUserId,
      recordedAt: at,
    }
    this.costLines.push(row)
    return row
  }

  async insertLiabilityDecision(
    draft: LiabilityDecisionDraft,
  ): Promise<LiabilityDecision> {
    const row: LiabilityDecision = { id: this.nextId('decision'), ...draft }
    this.decisions.push(row)
    return row
  }

  async insertInspection(
    draft: InspectionRecordDraft,
  ): Promise<InspectionRecord> {
    const row: InspectionRecord = { id: this.nextId('inspection'), ...draft }
    this.inspections.push(row)
    return row
  }

  async listInspections(
    organizationId: string,
    query: { bookingId?: string | null; unitId?: string | null },
  ): Promise<readonly InspectionRecord[]> {
    return this.inspections
      .filter((row) => row.organizationId === organizationId)
      .filter((row) => !query.bookingId || row.bookingId === query.bookingId)
      .filter((row) => !query.unitId || row.unitId === query.unitId)
      .sort(
        (left, right) =>
          left.performedAt.getTime() - right.performedAt.getTime(),
      )
  }
}
