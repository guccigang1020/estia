/**
 * EXECUTION CONTEXT — SERVER ONLY. Where a migration is kept between steps.
 *
 * ── Why a migration is rows and not component state ───────────────────────
 *
 * A three-year import is not one request. The file is uploaded on Tuesday, the
 * mapping argued about with whoever ran the old system, the dry run read by the
 * owner's accountant, the conflicts settled over two evenings, and only then is
 * anything written. Every one of those steps has to survive closing a laptop.
 *
 * ── The idempotency guarantee lives in the database, not here ─────────────
 *
 * `import_records` carries a unique index on
 * `(organization_id, entity, record_key)`. That index — not the application's
 * ledger check, and not the service pipeline's idempotency key — is what makes
 * "the same file twice creates nothing the second time" true under
 * concurrency. Two administrators importing the same export from two laptops at
 * the same second both pass the ledger check; exactly one wins the index, and
 * the loser's write is a conflict rather than a duplicate booking. Application
 * code cannot fake that, which is the same argument
 * `src/lib/service/idempotency.ts` makes about its own store.
 *
 * ── Nothing here decides anything ─────────────────────────────────────────
 *
 * Mapping only. The reasoning is above this line — in `dryrun.ts`, `apply.ts`
 * and `dedupe.ts` — and is tested without a database. What is here is column
 * names, and column names are where the uninteresting mistakes live, which is
 * why they are in one file per table rather than spread across the screens.
 */

import type { Db } from '../persistence/client'
import {
  asNumber,
  asString,
  asStringOrNull,
  toRow,
  toRows,
} from '../persistence/mapping'
import type { LedgerEntry } from './idempotency'
import {
  CONFLICT_DECISIONS,
  CONFLICT_KINDS,
  IMPORT_ENTITIES,
  IMPORT_FIELDS,
  IMPORT_SESSION_STATUSES,
  RECORD_OUTCOMES,
  SOURCE_FORMATS,
  type Conflict,
  type ConflictDecision,
  type FieldMapping,
  type ImportEntity,
  type ImportSession,
  type ImportSessionStatus,
  type RecordOutcome,
  type SavedMapping,
  type SourceFormat,
} from './types'

/* ------------------------------------------------------------ the tables -- */

const SESSIONS = 'import_sessions'
const RECORDS = 'import_records'
const CONFLICTS = 'import_conflicts'
const MAPPINGS = 'import_field_mappings'

const SESSION_COLUMNS =
  'id, organization_id, status, entity, source_format, file_name, ' +
  'file_hash, row_count, mappings, created_at, created_by, updated_at, ' +
  'completed_at'

/* ------------------------------------------------------------- the port -- */

export type MigrationRepository = {
  createSession(draft: SessionDraft): Promise<ImportSession>
  loadSession(
    organizationId: string,
    sessionId: string,
  ): Promise<ImportSession | null>
  listSessions(
    organizationId: string,
    limit?: number,
  ): Promise<readonly ImportSession[]>
  updateSession(
    organizationId: string,
    sessionId: string,
    patch: SessionPatch,
  ): Promise<void>

  /** Every record this organization has imported, for the idempotency check. */
  loadLedger(
    organizationId: string,
    entity: ImportEntity,
  ): Promise<readonly LedgerEntry[]>
  /** Upserted, so a resumed run rewrites its own rows without duplicating. */
  recordImported(
    organizationId: string,
    entries: readonly ImportedRecordRow[],
  ): Promise<void>

  loadConflicts(
    organizationId: string,
    sessionId: string,
  ): Promise<readonly Conflict[]>
  saveConflicts(
    organizationId: string,
    sessionId: string,
    conflicts: readonly Conflict[],
  ): Promise<void>
  decideConflict(
    organizationId: string,
    conflictId: string,
    decision: ConflictDecision,
    decidedByUserId: string,
  ): Promise<void>

  listMappings(
    organizationId: string,
    entity?: ImportEntity,
  ): Promise<readonly SavedMapping[]>
  saveMapping(mapping: SavedMapping): Promise<void>
}

export type SessionDraft = {
  organizationId: string
  entity: ImportEntity
  sourceFormat: SourceFormat
  fileName: string
  fileHash: string
  rowCount: number
  mappings: readonly FieldMapping[]
  createdByUserId: string
}

export type SessionPatch = {
  status?: ImportSessionStatus
  mappings?: readonly FieldMapping[]
  rowCount?: number
  completedAt?: string | null
}

/** One row of the ledger, as it is written after a record lands. */
export type ImportedRecordRow = LedgerEntry & {
  outcome: RecordOutcome
  message: string | null
}

/* ------------------------------------------------------------ the adapter -- */

/**
 * The Supabase implementation.
 *
 * Takes the client rather than constructing one, exactly as every adapter in
 * `src/lib/persistence` does and for the same reason: every query then runs as
 * the signed-in person under row level security, which is the floor beneath
 * `assertCan`, and a unit test can hand it a fake without a project or a secret.
 */
export class SupabaseMigrationRepository implements MigrationRepository {
  constructor(private readonly db: Db) {}

  async createSession(draft: SessionDraft): Promise<ImportSession> {
    const { data, error } = await this.db
      .from(SESSIONS)
      .insert({
        organization_id: draft.organizationId,
        status: 'draft',
        entity: draft.entity,
        source_format: draft.sourceFormat,
        file_name: draft.fileName,
        file_hash: draft.fileHash,
        row_count: draft.rowCount,
        mappings: draft.mappings,
        created_by: draft.createdByUserId,
        updated_by: draft.createdByUserId,
      })
      .select(SESSION_COLUMNS)
      .single()

    if (error) throw error
    if (!data) {
      throw new Error(
        'import_sessions insert returned no row; the select policy refused it',
      )
    }
    return toSession(toRow(data))
  }

  async loadSession(
    organizationId: string,
    sessionId: string,
  ): Promise<ImportSession | null> {
    const { data, error } = await this.db
      .from(SESSIONS)
      .select(SESSION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', sessionId)
      .maybeSingle()

    if (error) throw error
    return data ? toSession(toRow(data)) : null
  }

  async listSessions(
    organizationId: string,
    limit = 20,
  ): Promise<readonly ImportSession[]> {
    const { data, error } = await this.db
      .from(SESSIONS)
      .select(SESSION_COLUMNS)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    return toRows(data).map(toSession)
  }

  async updateSession(
    organizationId: string,
    sessionId: string,
    patch: SessionPatch,
  ): Promise<void> {
    const row: Record<string, unknown> = {}
    if (patch.status !== undefined) row.status = patch.status
    if (patch.mappings !== undefined) row.mappings = patch.mappings
    if (patch.rowCount !== undefined) row.row_count = patch.rowCount
    if (patch.completedAt !== undefined) row.completed_at = patch.completedAt
    if (Object.keys(row).length === 0) return

    const { error } = await this.db
      .from(SESSIONS)
      .update(row)
      .eq('organization_id', organizationId)
      .eq('id', sessionId)

    if (error) throw error
  }

  /**
   * The ledger for one entity.
   *
   * Scoped by organization *and* by entity, because the identity of a record is
   * only unique within its kind: a source that numbers its guests and its
   * bookings from 1 would otherwise have booking 7 recognised as guest 7 and
   * silently skipped.
   */
  async loadLedger(
    organizationId: string,
    entity: ImportEntity,
  ): Promise<readonly LedgerEntry[]> {
    const { data, error } = await this.db
      .from(RECORDS)
      .select(
        'entity, record_key, content_hash, estia_id, session_id, row_number',
      )
      .eq('organization_id', organizationId)
      .eq('entity', entity)

    if (error) throw error

    return toRows(data)
      .filter((row) => asStringOrNull(row, 'estia_id') !== null)
      .map((row) => ({
        entity: asEntity(row, 'entity'),
        recordKey: asString(row, 'record_key'),
        contentHash: asString(row, 'content_hash'),
        estiaId: asString(row, 'estia_id'),
        sessionId: asString(row, 'session_id'),
        rowNumber: asNumber(row, 'row_number'),
      }))
  }

  /**
   * Write what landed.
   *
   * `upsert` on `(organization_id, entity, record_key)` rather than `insert`,
   * because a resumed run legitimately rewrites the rows of the batch that was
   * in flight when it stopped. An `insert` would fail the whole resume on the
   * unique index — the index that exists to make the resume safe.
   */
  async recordImported(
    organizationId: string,
    entries: readonly ImportedRecordRow[],
  ): Promise<void> {
    if (entries.length === 0) return

    const { error } = await this.db.from(RECORDS).upsert(
      entries.map((entry) => ({
        organization_id: organizationId,
        session_id: entry.sessionId,
        entity: entry.entity,
        record_key: entry.recordKey,
        content_hash: entry.contentHash,
        estia_id: entry.estiaId,
        row_number: entry.rowNumber,
        outcome: entry.outcome,
        message: entry.message,
      })),
      { onConflict: 'organization_id,entity,record_key' },
    )

    if (error) throw error
  }

  async loadConflicts(
    organizationId: string,
    sessionId: string,
  ): Promise<readonly Conflict[]> {
    const { data, error } = await this.db
      .from(CONFLICTS)
      .select(
        'conflict_id, kind, row_number, entity, side_left, side_right, ' +
          'question, decision',
      )
      .eq('organization_id', organizationId)
      .eq('session_id', sessionId)
      .order('row_number', { ascending: true })

    if (error) throw error

    return toRows(data).map((row) => ({
      id: asString(row, 'conflict_id'),
      kind: asConflictKind(row),
      rowNumber: asNumber(row, 'row_number'),
      entity: asEntity(row, 'entity'),
      left: asSide(row.side_left),
      right: asSide(row.side_right),
      question: asString(row, 'question'),
      decision: asDecision(row),
    }))
  }

  async saveConflicts(
    organizationId: string,
    sessionId: string,
    conflicts: readonly Conflict[],
  ): Promise<void> {
    if (conflicts.length === 0) return

    const { error } = await this.db.from(CONFLICTS).upsert(
      conflicts.map((conflict) => ({
        organization_id: organizationId,
        session_id: sessionId,
        conflict_id: conflict.id,
        kind: conflict.kind,
        row_number: conflict.rowNumber,
        entity: conflict.entity,
        side_left: conflict.left,
        side_right: conflict.right,
        question: conflict.question,
        decision: conflict.decision,
      })),
      { onConflict: 'session_id,conflict_id' },
    )

    if (error) throw error
  }

  /**
   * One decision, with the person who made it.
   *
   * `decided_by` and `decided_at` are written here and never defaulted. A
   * decision to import a booking over an existing one is the kind of thing
   * somebody is asked about a year later, and "the import did it" is not an
   * answer.
   */
  async decideConflict(
    organizationId: string,
    conflictId: string,
    decision: ConflictDecision,
    decidedByUserId: string,
  ): Promise<void> {
    const { error } = await this.db
      .from(CONFLICTS)
      .update({
        decision,
        decided_by: decidedByUserId,
        decided_at: new Date().toISOString(),
      })
      .eq('organization_id', organizationId)
      .eq('conflict_id', conflictId)

    if (error) throw error
  }

  async listMappings(
    organizationId: string,
    entity?: ImportEntity,
  ): Promise<readonly SavedMapping[]> {
    let query = this.db
      .from(MAPPINGS)
      .select('id, organization_id, name, entity, source_format, ' +
        'signature, mappings')
      .eq('organization_id', organizationId)

    if (entity !== undefined) query = query.eq('entity', entity)

    const { data, error } = await query
    if (error) throw error

    return toRows(data).map((row) => ({
      id: asString(row, 'id'),
      organizationId: asString(row, 'organization_id'),
      name: asString(row, 'name'),
      entity: asEntity(row, 'entity'),
      sourceFormat: asFormat(row),
      signature: asString(row, 'signature'),
      mappings: asMappings(row.mappings),
    }))
  }

  async saveMapping(mapping: SavedMapping): Promise<void> {
    const { error } = await this.db.from(MAPPINGS).upsert(
      {
        organization_id: mapping.organizationId,
        name: mapping.name,
        entity: mapping.entity,
        source_format: mapping.sourceFormat,
        signature: mapping.signature,
        mappings: mapping.mappings,
      },
      { onConflict: 'organization_id,entity,signature' },
    )

    if (error) throw error
  }
}

/* --------------------------------------------------------------- mapping -- */

function toSession(row: Readonly<Record<string, unknown>>): ImportSession {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    status: asStatus(row),
    entity: asEntity(row, 'entity'),
    sourceFormat: asFormat(row),
    fileName: asString(row, 'file_name'),
    fileHash: asString(row, 'file_hash'),
    rowCount: asNumber(row, 'row_count'),
    mappings: asMappings(row.mappings),
    createdAt: asString(row, 'created_at'),
    createdByUserId: asString(row, 'created_by'),
    updatedAt: asString(row, 'updated_at'),
    completedAt: asStringOrNull(row, 'completed_at'),
  }
}

/**
 * A stored value, narrowed against the closed vocabulary it claims to be in.
 *
 * Written out rather than cast. A value the database holds that this build does
 * not know is a deployment mismatch — a migration ahead of the code — and it
 * has to fail loudly here rather than travel into a screen as a string that
 * every `switch` silently ignores.
 */
function narrow<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  if (typeof value === 'string') {
    const found = allowed.find((candidate) => candidate === value)
    if (found !== undefined) return found
  }
  throw new Error(`Unknown ${what} from the database: ${String(value)}`)
}

function asEntity(
  row: Readonly<Record<string, unknown>>,
  key: string,
): ImportEntity {
  return narrow(row[key], IMPORT_ENTITIES, 'import entity')
}

function asStatus(row: Readonly<Record<string, unknown>>): ImportSessionStatus {
  return narrow(row.status, IMPORT_SESSION_STATUSES, 'import session status')
}

function asFormat(row: Readonly<Record<string, unknown>>): SourceFormat {
  return narrow(row.source_format, SOURCE_FORMATS, 'source format')
}

function asConflictKind(
  row: Readonly<Record<string, unknown>>,
): Conflict['kind'] {
  return narrow(row.kind, CONFLICT_KINDS, 'conflict kind')
}

function asDecision(row: Readonly<Record<string, unknown>>): ConflictDecision {
  return narrow(row.decision, CONFLICT_DECISIONS, 'conflict decision')
}

/** A stored side of a conflict. Refused rather than half-read. */
function asSide(value: unknown): Conflict['left'] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('A conflict side came back from the database as a non-object')
  }
  const row = value as Record<string, unknown>
  return {
    origin: row.origin === 'estia' ? 'estia' : 'import',
    reference: asString(row, 'reference'),
    label: asString(row, 'label'),
    detail: asString(row, 'detail'),
  }
}

/**
 * The stored mapping array.
 *
 * A malformed entry is dropped rather than throwing. The mapping is a
 * convenience — the screen re-suggests from the header when it is missing — and
 * refusing to open a session because one saved row is odd would lock somebody
 * out of a migration they are halfway through.
 */
function asMappings(value: unknown): readonly FieldMapping[] {
  if (!Array.isArray(value)) return []

  const mappings: FieldMapping[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    if (typeof row.column !== 'string') continue
    mappings.push({
      column: row.column,
      field: typeof row.field === 'string' ? asField(row.field) : null,
    })
  }
  return mappings
}

function asField(value: string): FieldMapping['field'] {
  return IMPORT_FIELDS.find((candidate) => candidate === value) ?? null
}

/** Is this a stored outcome this build understands? For a report reader. */
export function isRecordOutcome(value: string): value is RecordOutcome {
  return RECORD_OUTCOMES.some((candidate) => candidate === value)
}
