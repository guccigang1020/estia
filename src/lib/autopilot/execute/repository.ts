/**
 * Reading and writing `autopilot_actions`.
 *
 * A port and two implementations — one over PostgREST, one in memory for the
 * tests — for the same reason `notifications/repository.ts` has two: the
 * executor must be exercisable without a database, and the row shape must be
 * mapped in exactly one place.
 *
 * ── The insert is expected to collide, and that is the guarantee ──────────
 *
 * `autopilot_actions_idempotent` is `unique (organization_id,
 * idempotency_key)`. A redelivered webhook produces a second insert of the same
 * key, the database refuses it, and this adapter reports `created: false` with
 * the row that was already there rather than throwing a 23505 at a caller who
 * would have to know the constraint's name to interpret it.
 *
 * That refusal IS the one-action-per-event guarantee. It is not a handler
 * remembering to look first, and it holds across processes, across
 * redeliveries, and across the two Node instances behind a load balancer that
 * an in-memory set would not.
 *
 * ── Every CHECK in 0046 is also a check here ─────────────────────────────
 *
 * A row with `suppressed` and no reason, or `failed` and no code, is refused by
 * the database. Refusing it here as well is not belt and braces: the database
 * would refuse it at the end of the write, by which time the guest has already
 * been messaged and the only record of it is the exception in the log. The
 * check runs before the write, and it runs identically for both
 * implementations, so the in-memory double cannot let a test pass on a row the
 * real table would reject.
 */

import { AppError } from '../../errors'
import {
  asDateOrNull,
  asNumber,
  asString,
  asStringOrNull,
  clientFor,
  recordWrite,
  toRow,
  toRows,
  type Db,
  type Row,
} from '../../persistence'
import type { TransactionHandle } from '../../service'
import type {
  ActionSafetyLevel,
  AutopilotActionOutcome,
  AutopilotConfidence,
  AutopilotDisposition,
  AutopilotRunMode,
  AutopilotSuppressionReason,
} from '../../contracts/states'
import {
  ACTION_SAFETY_LEVELS,
  AUTOPILOT_ACTION_OUTCOMES,
  AUTOPILOT_CONFIDENCE_LEVELS,
  AUTOPILOT_DISPOSITIONS,
  AUTOPILOT_RUN_MODES,
} from '../../contracts/states'
import { isDomainEvent, type DomainEventName } from '../../contracts/events'
import { isAutopilotActionKind, type AutopilotActionKind } from '../actions'
import type { Evidence, PlannedAction } from '../types'

/* ------------------------------------------------------------- the row --- */

export interface AutopilotActionRow {
  id: string
  organizationId: string
  propertyId: string | null
  exceptionId: string | null
  actionKind: AutopilotActionKind
  safetyLevel: ActionSafetyLevel
  disposition: Exclude<AutopilotDisposition, 'off'>
  runMode: AutopilotRunMode
  outcome: AutopilotActionOutcome
  confidence: AutopilotConfidence
  reason: string
  triggerEvent: string | null
  evidence: readonly Evidence[]
  command: string | null
  commandInput: Readonly<Record<string, unknown>>
  result: Readonly<Record<string, unknown>>
  suppressedReason: AutopilotSuppressionReason | null
  errorCode: string | null
  errorDetail: string | null
  /** The number of the last attempt made. See `dispatch.ts`. */
  attempt: number
  idempotencyKey: string
  correlationId: string | null
  requestedBy: string | null
  approvedBy: string | null
  approvedAt: Date | null
  scheduledFor: Date | null
  executedAt: Date | null
  undoneAt: Date | null
  undoneBy: string | null
  createdAt: Date
}

/** What a planned action becomes on its way into the table. */
export interface AutopilotActionDraft {
  planned: PlannedAction
  outcome: AutopilotActionOutcome
  exceptionId?: string | null
  requestedBy?: string | null
  result?: Readonly<Record<string, unknown>>
  suppressedReason?: AutopilotSuppressionReason | null
  errorCode?: string | null
  errorDetail?: string | null
  createdAt: Date
}

/**
 * A change to one recorded action.
 *
 * Every field is optional and `undefined` means "leave it alone", which is why
 * the nullable ones are typed `T | null` rather than `T | undefined`: clearing
 * `approved_by` and not mentioning it must not be the same instruction.
 */
export interface AutopilotActionPatch {
  outcome?: AutopilotActionOutcome
  result?: Readonly<Record<string, unknown>>
  suppressedReason?: AutopilotSuppressionReason | null
  errorCode?: string | null
  errorDetail?: string | null
  attempt?: number
  approvedBy?: string | null
  approvedAt?: Date | null
  executedAt?: Date | null
  undoneAt?: Date | null
  undoneBy?: string | null
}

export interface AutopilotActionRepository {
  /**
   * Write the action, or discover that this event has already produced one.
   *
   * `created: false` is the unique constraint holding — the ordinary outcome of
   * a redelivery, and not a failure.
   */
  insert(
    draft: AutopilotActionDraft,
    tx?: TransactionHandle,
  ): Promise<{ record: AutopilotActionRow; created: boolean }>

  update(
    row: AutopilotActionRow,
    patch: AutopilotActionPatch,
    tx?: TransactionHandle,
  ): Promise<AutopilotActionRow>

  findById(
    organizationId: string,
    id: string,
  ): Promise<AutopilotActionRow | null>

  findByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<AutopilotActionRow | null>

  /** Everything that failed and has not been dealt with, oldest first. */
  listFailed(
    organizationId: string,
    options?: { limit?: number },
  ): Promise<readonly AutopilotActionRow[]>
}

/* -------------------------------------------------------- the invariants -- */

/**
 * The row is not writable as described.
 *
 * A 500 rather than a 4xx, and loud: a `failed` with no error code is a defect
 * in the code that produced it, not something a person did — and it is the
 * shape of row that makes an activity screen say "Autopilot did nothing" with
 * no reason attached, which is the fastest way to lose a customer's trust in
 * it.
 */
export class AutopilotActionInvalidError extends AppError {
  constructor(problem: string) {
    super({
      code: 'autopilot_action_invalid',
      status: 500,
      message: `Refusing to record an Autopilot action: ${problem}`,
      userMessage:
        'אירעה תקלה במערכת ולכן הפעולה לא נרשמה. נסה שוב בעוד מספר רגעים.',
      retryable: false,
      dataOutcome: 'not_saved',
    })
  }
}

const EXECUTED_OUTCOMES: readonly AutopilotActionOutcome[] = [
  'executed',
  'executed_unaudited',
]

/** What a simulated run is allowed to have recorded. Mirrors the CHECK. */
const SIMULATION_OUTCOMES: readonly AutopilotActionOutcome[] = [
  'simulated',
  'suppressed',
  'cancelled',
  'planned',
]

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0
}

/** Every CHECK in 0046 §10, evaluated before the write rather than after it. */
export function assertActionConsistent(row: AutopilotActionRow): void {
  if (isBlank(row.reason)) {
    throw new AutopilotActionInvalidError('the reason is blank')
  }
  if (isBlank(row.idempotencyKey)) {
    throw new AutopilotActionInvalidError('the idempotency key is blank')
  }
  if (row.attempt < 1) {
    throw new AutopilotActionInvalidError(`attempt is ${row.attempt}`)
  }
  if (row.outcome === 'suppressed' && isBlank(row.suppressedReason)) {
    throw new AutopilotActionInvalidError(
      'the outcome is suppressed and no suppression reason was given',
    )
  }
  if (row.outcome === 'failed' && isBlank(row.errorCode)) {
    throw new AutopilotActionInvalidError(
      'the outcome is failed and no error code was given',
    )
  }
  if (EXECUTED_OUTCOMES.includes(row.outcome) && row.executedAt === null) {
    throw new AutopilotActionInvalidError(
      `the outcome is ${row.outcome} and there is no execution time`,
    )
  }
  if ((row.approvedBy === null) !== (row.approvedAt === null)) {
    throw new AutopilotActionInvalidError(
      'approved_by and approved_at must move together',
    )
  }
  if ((row.undoneBy === null) !== (row.undoneAt === null)) {
    throw new AutopilotActionInvalidError(
      'undone_by and undone_at must move together',
    )
  }
  if (
    row.runMode === 'simulation' &&
    !SIMULATION_OUTCOMES.includes(row.outcome)
  ) {
    throw new AutopilotActionInvalidError(
      `a simulated run may not record ${row.outcome}`,
    )
  }
  if (row.runMode === 'live' && row.outcome === 'simulated') {
    throw new AutopilotActionInvalidError(
      'a live run may not be filed as a simulation',
    )
  }
}

/** The row a draft describes, before anybody has stored it. */
export function rowFromDraft(
  draft: AutopilotActionDraft,
  id: string,
): AutopilotActionRow {
  const { planned } = draft

  const row: AutopilotActionRow = {
    id,
    organizationId: planned.organizationId,
    propertyId: planned.propertyId,
    exceptionId: draft.exceptionId ?? null,
    actionKind: planned.kind,
    safetyLevel: planned.safetyLevel,
    disposition: planned.disposition,
    runMode: planned.runMode,
    outcome: draft.outcome,
    confidence: planned.confidence,
    reason: planned.reason,
    triggerEvent: planned.triggerEvent,
    evidence: planned.evidence,
    command: planned.command,
    commandInput: planned.commandInput,
    result: draft.result ?? {},
    suppressedReason: draft.suppressedReason ?? null,
    errorCode: draft.errorCode ?? null,
    errorDetail: draft.errorDetail ?? null,
    attempt: 1,
    idempotencyKey: planned.idempotencyKey,
    correlationId: planned.correlationId,
    requestedBy: draft.requestedBy ?? null,
    approvedBy: null,
    approvedAt: null,
    scheduledFor:
      planned.scheduledFor === null ? null : new Date(planned.scheduledFor),
    executedAt: null,
    undoneAt: null,
    undoneBy: null,
    createdAt: draft.createdAt,
  }

  assertActionConsistent(row)
  return row
}

/** `undefined` leaves a field alone; `null` clears it. */
export function applyPatch(
  row: AutopilotActionRow,
  patch: AutopilotActionPatch,
): AutopilotActionRow {
  const merged: AutopilotActionRow = {
    ...row,
    outcome: patch.outcome ?? row.outcome,
    result: patch.result ?? row.result,
    suppressedReason:
      patch.suppressedReason === undefined
        ? row.suppressedReason
        : patch.suppressedReason,
    errorCode: patch.errorCode === undefined ? row.errorCode : patch.errorCode,
    errorDetail:
      patch.errorDetail === undefined ? row.errorDetail : patch.errorDetail,
    attempt: patch.attempt ?? row.attempt,
    approvedBy:
      patch.approvedBy === undefined ? row.approvedBy : patch.approvedBy,
    approvedAt:
      patch.approvedAt === undefined ? row.approvedAt : patch.approvedAt,
    executedAt:
      patch.executedAt === undefined ? row.executedAt : patch.executedAt,
    undoneAt: patch.undoneAt === undefined ? row.undoneAt : patch.undoneAt,
    undoneBy: patch.undoneBy === undefined ? row.undoneBy : patch.undoneBy,
  }

  assertActionConsistent(merged)
  return merged
}

/* ----------------------------------------------------------- the mapping -- */

const ACTION_COLUMNS =
  'id, organization_id, property_id, exception_id, action_kind, safety_level, ' +
  'disposition, run_mode, outcome, confidence, reason, trigger_event, ' +
  'evidence, command, command_input, result, suppressed_reason, error_code, ' +
  'error_detail, attempt, idempotency_key, correlation_id, requested_by, ' +
  'approved_by, approved_at, scheduled_for, executed_at, undone_at, ' +
  'undone_by, created_at'

function asMember<T extends string>(
  row: Row,
  column: string,
  known: readonly string[],
  what: string,
): T {
  const value = asString(row, column)
  if (!known.includes(value)) {
    throw new Error(`Unknown ${what} in ${column}: ${value}`)
  }
  return value as T
}

function asActionKind(row: Row): AutopilotActionKind {
  const value = asString(row, 'action_kind')
  if (!isAutopilotActionKind(value)) {
    // A kind outside the catalogue came from somewhere that bypassed the
    // planner. Rendering it would put a name in front of a person that no
    // screen can act on, and dispatching it would be worse.
    throw new Error(`Not an Autopilot action kind: ${value}`)
  }
  return value
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Evidence, filtered rather than validated.
 *
 * An entry missing its key or its source is dropped: the screen showing one
 * fewer fact is a much smaller failure than an activity log that will not
 * load, and the facts that survive still carry where they came from.
 */
export function evidenceFromJson(value: unknown): readonly Evidence[] {
  if (!Array.isArray(value)) return []

  const evidence: Evidence[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (typeof record.key !== 'string' || typeof record.source !== 'string') {
      continue
    }
    evidence.push({
      key: record.key,
      label: typeof record.label === 'string' ? record.label : record.key,
      value:
        typeof record.value === 'string' ||
        typeof record.value === 'number' ||
        typeof record.value === 'boolean'
          ? record.value
          : null,
      source: record.source,
      ...(typeof record.sourceId === 'string'
        ? { sourceId: record.sourceId }
        : {}),
      ...(typeof record.observedAt === 'string'
        ? { observedAt: record.observedAt }
        : {}),
    })
  }
  return evidence
}

export function actionFromRow(row: Row): AutopilotActionRow {
  const suppressed = asStringOrNull(row, 'suppressed_reason')

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    exceptionId: asStringOrNull(row, 'exception_id'),
    actionKind: asActionKind(row),
    safetyLevel: asMember<ActionSafetyLevel>(
      row,
      'safety_level',
      ACTION_SAFETY_LEVELS,
      'safety level',
    ),
    disposition: asMember<Exclude<AutopilotDisposition, 'off'>>(
      row,
      'disposition',
      AUTOPILOT_DISPOSITIONS.filter((entry) => entry !== 'off'),
      'disposition',
    ),
    runMode: asMember<AutopilotRunMode>(
      row,
      'run_mode',
      AUTOPILOT_RUN_MODES,
      'run mode',
    ),
    outcome: asMember<AutopilotActionOutcome>(
      row,
      'outcome',
      AUTOPILOT_ACTION_OUTCOMES,
      'action outcome',
    ),
    confidence: asMember<AutopilotConfidence>(
      row,
      'confidence',
      AUTOPILOT_CONFIDENCE_LEVELS,
      'confidence',
    ),
    reason: asString(row, 'reason'),
    triggerEvent: asStringOrNull(row, 'trigger_event'),
    evidence: evidenceFromJson(row.evidence),
    command: asStringOrNull(row, 'command'),
    commandInput: asRecord(row.command_input),
    result: asRecord(row.result),
    // Text with no enum behind it, so an unrecognised value is dropped rather
    // than thrown on — the same call `notifications` makes for the same column.
    suppressedReason: suppressed as AutopilotSuppressionReason | null,
    errorCode: asStringOrNull(row, 'error_code'),
    errorDetail: asStringOrNull(row, 'error_detail'),
    attempt: asNumber(row, 'attempt'),
    idempotencyKey: asString(row, 'idempotency_key'),
    correlationId: asStringOrNull(row, 'correlation_id'),
    requestedBy: asStringOrNull(row, 'requested_by'),
    approvedBy: asStringOrNull(row, 'approved_by'),
    approvedAt: asDateOrNull(row, 'approved_at'),
    scheduledFor: asDateOrNull(row, 'scheduled_for'),
    executedAt: asDateOrNull(row, 'executed_at'),
    undoneAt: asDateOrNull(row, 'undone_at'),
    undoneBy: asStringOrNull(row, 'undone_by'),
    createdAt: asDateOrNull(row, 'created_at') ?? new Date(0),
  }
}

/**
 * The row, read back as the plan it was.
 *
 * Approval and retry both act on a stored row rather than on the object the
 * decision engine produced, so this is how a command handler is handed the
 * same `PlannedAction` a live dispatch would have handed it — including the
 * reason and the evidence composed at planning time, which are stored and
 * never re-derived.
 */
export function plannedFromRow(row: AutopilotActionRow): PlannedAction {
  return {
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    kind: row.actionKind,
    safetyLevel: row.safetyLevel,
    disposition: row.disposition,
    runMode: row.runMode,
    confidence: row.confidence,
    reason: row.reason,
    // Text in the column, a member of the frozen catalogue in the type. A name
    // that is no longer in the catalogue reads as "no trigger" rather than
    // failing the row: the action still happened and still has to be shown.
    triggerEvent: isDomainEvent(row.triggerEvent ?? '')
      ? (row.triggerEvent as DomainEventName)
      : null,
    evidence: row.evidence,
    command: row.command,
    commandInput: row.commandInput,
    idempotencyKey: row.idempotencyKey,
    correlationId: row.correlationId,
    exceptionDedupeKey: null,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
  }
}

/* ---------------------------------------------------------- the adapter -- */

/** PostgREST's code for a unique violation. The idempotency constraint, working. */
const UNIQUE_VIOLATION = '23505'

export class SupabaseAutopilotActionRepository implements AutopilotActionRepository {
  constructor(private readonly db: Db) {}

  async insert(
    draft: AutopilotActionDraft,
    tx?: TransactionHandle,
  ): Promise<{ record: AutopilotActionRow; created: boolean }> {
    // Validated against the same invariants the table enforces, before the
    // write rather than after it.
    rowFromDraft(draft, 'pending')

    const db = clientFor(tx, this.db)
    const { planned } = draft

    const { data, error } = await db
      .from('autopilot_actions')
      .insert({
        organization_id: planned.organizationId,
        property_id: planned.propertyId,
        exception_id: draft.exceptionId ?? null,
        action_kind: planned.kind,
        safety_level: planned.safetyLevel,
        disposition: planned.disposition,
        run_mode: planned.runMode,
        outcome: draft.outcome,
        confidence: planned.confidence,
        reason: planned.reason,
        trigger_event: planned.triggerEvent,
        evidence: planned.evidence,
        command: planned.command,
        command_input: planned.commandInput,
        result: draft.result ?? {},
        suppressed_reason: draft.suppressedReason ?? null,
        error_code: draft.errorCode ?? null,
        error_detail: draft.errorDetail ?? null,
        idempotency_key: planned.idempotencyKey,
        correlation_id: planned.correlationId,
        requested_by: draft.requestedBy ?? null,
        scheduled_for: planned.scheduledFor,
        created_at: draft.createdAt.toISOString(),
      })
      .select(ACTION_COLUMNS)
      .single()

    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        const existing = await this.findByIdempotencyKey(
          planned.organizationId,
          planned.idempotencyKey,
        )
        // The constraint held: this event has already produced its action.
        if (existing) return { record: existing, created: false }
      }
      throw error
    }

    if (tx) recordWrite(tx, 'autopilot_actions.insert')
    return { record: actionFromRow(toRow(data)), created: true }
  }

  async update(
    row: AutopilotActionRow,
    patch: AutopilotActionPatch,
    tx?: TransactionHandle,
  ): Promise<AutopilotActionRow> {
    const merged = applyPatch(row, patch)
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('autopilot_actions')
      .update({
        outcome: merged.outcome,
        result: merged.result,
        suppressed_reason: merged.suppressedReason,
        error_code: merged.errorCode,
        error_detail: merged.errorDetail,
        attempt: merged.attempt,
        approved_by: merged.approvedBy,
        approved_at: merged.approvedAt?.toISOString() ?? null,
        executed_at: merged.executedAt?.toISOString() ?? null,
        undone_at: merged.undoneAt?.toISOString() ?? null,
        undone_by: merged.undoneBy,
      })
      .eq('organization_id', row.organizationId)
      .eq('id', row.id)
      .select(ACTION_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'autopilot_actions.update')
    return actionFromRow(toRow(data))
  }

  async findById(
    organizationId: string,
    id: string,
  ): Promise<AutopilotActionRow | null> {
    const { data, error } = await this.db
      .from('autopilot_actions')
      .select(ACTION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    return data ? actionFromRow(toRow(data)) : null
  }

  async findByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<AutopilotActionRow | null> {
    const { data, error } = await this.db
      .from('autopilot_actions')
      .select(ACTION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle()

    if (error) throw error
    return data ? actionFromRow(toRow(data)) : null
  }

  async listFailed(
    organizationId: string,
    options: { limit?: number } = {},
  ): Promise<readonly AutopilotActionRow[]> {
    const { data, error } = await this.db
      .from('autopilot_actions')
      .select(ACTION_COLUMNS)
      .eq('organization_id', organizationId)
      .in('outcome', ['failed', 'retrying'])
      .order('created_at', { ascending: true })
      .limit(options.limit ?? 50)

    if (error) throw error
    return toRows(data).map(actionFromRow)
  }
}

/* --------------------------------------------------------- in memory ----- */

/**
 * The double the executor's tests run against.
 *
 * It implements the unique constraint faithfully — the same key twice returns
 * `created: false` — because that is the behaviour this module's most important
 * test asserts, and a double that quietly allowed the duplicate would let that
 * test pass for the wrong reason.
 */
export class InMemoryAutopilotActionRepository implements AutopilotActionRepository {
  readonly rows: AutopilotActionRow[] = []

  private sequence = 0

  async insert(
    draft: AutopilotActionDraft,
  ): Promise<{ record: AutopilotActionRow; created: boolean }> {
    const existing = await this.findByIdempotencyKey(
      draft.planned.organizationId,
      draft.planned.idempotencyKey,
    )
    if (existing) return { record: existing, created: false }

    this.sequence += 1
    const record = rowFromDraft(draft, `autopilot-action-${this.sequence}`)
    this.rows.push(record)
    return { record, created: true }
  }

  async update(
    row: AutopilotActionRow,
    patch: AutopilotActionPatch,
  ): Promise<AutopilotActionRow> {
    const merged = applyPatch(row, patch)
    const index = this.rows.findIndex(
      (entry) =>
        entry.id === row.id && entry.organizationId === row.organizationId,
    )
    if (index < 0) {
      throw new AutopilotActionInvalidError(`no action ${row.id} to update`)
    }
    this.rows[index] = merged
    return merged
  }

  async findById(
    organizationId: string,
    id: string,
  ): Promise<AutopilotActionRow | null> {
    return (
      this.rows.find(
        (row) => row.organizationId === organizationId && row.id === id,
      ) ?? null
    )
  }

  async findByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<AutopilotActionRow | null> {
    return (
      this.rows.find(
        (row) =>
          row.organizationId === organizationId &&
          row.idempotencyKey === idempotencyKey,
      ) ?? null
    )
  }

  async listFailed(
    organizationId: string,
    options: { limit?: number } = {},
  ): Promise<readonly AutopilotActionRow[]> {
    return this.rows
      .filter(
        (row) =>
          row.organizationId === organizationId &&
          (row.outcome === 'failed' || row.outcome === 'retrying'),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, options.limit ?? 50)
  }
}
