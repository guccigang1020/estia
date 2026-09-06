/**
 * Persistence for the owner portal.
 *
 * ══ THE TABLES DO NOT EXIST YET, AND THAT IS A STATE, NOT AN ERROR ═════════
 *
 * Zero owner tables exist in this database. The migration is the coordinator's
 * to write, and this file is written against the schema this module's report
 * proposes: `property_owners`, `property_ownerships`, `owner_statements`,
 * `owner_statement_lines`, `owner_payouts` — plus the **existing** `approvals`
 * table, which owner requests use rather than duplicate.
 *
 * Writing the adapter first is deliberate. Every column name below is a claim
 * about the schema, and a claim written as code is one `tsc` and the in-memory
 * double can be held against; the same claim written as a paragraph drifts
 * within a week. `src/lib/channels/repository.ts` made this argument first and
 * this follows it exactly.
 *
 * ── `not provisioned` is derived, never hard-coded ────────────────────────
 *
 * `isNotProvisioned` recognises the two codes the two layers use — Postgres
 * raises `42P01` for an unknown relation, PostgREST answers `PGRST205` when the
 * table is not in its schema cache at all — and **everything else is
 * rethrown**. Swallowing every error would turn a broken RLS policy into a
 * screen that says "not installed", which is the single most misleading
 * sentence these pages could produce: it is a claim about the product rather
 * than about the deployment, and it goes away by itself the moment the
 * migration runs, with no change to this file and none to the screens.
 *
 * ── Why the port exists ───────────────────────────────────────────────────
 *
 * `statement.ts`, `visibility.ts` and `approvals.ts` are pure functions over
 * plain data, and they are tested without a database, a client or a secret.
 * That is only true while nothing above them reaches for PostgREST. The
 * operations take this interface; the application binds the Supabase
 * implementation and the tests bind the in-memory one, and neither knows.
 *
 * Every write takes the transaction handle the service pipeline opened. Not
 * politeness: the row, its audit event and the idempotency completion have to
 * commit together, and a write that quietly used its own client would break
 * that without failing anything.
 *
 * ── Not exported from `index.ts` ──────────────────────────────────────────
 *
 * This module reaches `@/lib/persistence`, which reaches the `postgres` driver,
 * which cannot be bundled for the browser. `scripts/client-bundle.mjs` exists
 * because that exact import took the whole application down three times in one
 * day. So the barrel exports everything in this module except this file, and a
 * screen that needs an adapter imports it by path.
 */

import { APPROVAL_STATUSES, type ApprovalStatus } from '../contracts/states'
import {
  asEnum,
  asIsoDate,
  asIsoDateOrNull,
  asNumber,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  clientFor,
  recordWrite,
  toRow,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import type { TransactionHandle } from '../service'
import {
  OWNER_APPROVAL_KINDS,
  OWNER_APPROVAL_SUBJECT_TYPE,
  OWNER_APPROVAL_TYPE,
  type OwnerApproval,
  type OwnerApprovalKind,
} from './approvals'
import {
  OWNER_PAYOUT_DIRECTIONS,
  OWNER_PAYOUT_METHODS,
  OWNER_STATEMENT_STATUSES,
  OWNER_STATUSES,
  type OwnerPayout,
  type OwnerStatement,
  type PropertyOwner,
  type PropertyOwnership,
} from './types'

/* ------------------------------------------------------- not provisioned -- */

/**
 * Is this the database saying the owner portal was never installed?
 *
 * Two codes and no more. Anything else — a policy refusal, a constraint, a
 * network failure — is a real failure and belongs to the caller.
 */
export function isNotProvisioned(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === '42P01' || code === 'PGRST205'
}

/**
 * Run a read, or report that there is nowhere to read from.
 *
 * A discriminated result rather than an empty array, because "no owners" and
 * "no owners table" are opposite situations that look identical on screen. The
 * first is an empty state inviting somebody to add an owner; the second is a
 * gap the screen names.
 */
export type Provisioned<T> = { ok: true; value: T } | { ok: false }

export async function orNotProvisioned<T>(
  read: () => Promise<T>,
): Promise<Provisioned<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    if (isNotProvisioned(error)) return { ok: false }
    throw error
  }
}

/* ------------------------------------------------------------------ port -- */

export interface OwnerQuery {
  ownerId?: string
  propertyId?: string
}

export interface OwnerRepository {
  listOwners(organizationId: string): Promise<readonly PropertyOwner[]>

  loadOwner(
    organizationId: string,
    ownerId: string,
  ): Promise<PropertyOwner | null>

  insertOwner(
    owner: PropertyOwner,
    tx: TransactionHandle,
  ): Promise<PropertyOwner>

  /** Every share, filtered by owner or by property. Never across tenants. */
  listOwnerships(
    organizationId: string,
    query?: OwnerQuery,
  ): Promise<readonly PropertyOwnership[]>

  insertOwnership(
    ownership: PropertyOwnership,
    tx: TransactionHandle,
  ): Promise<PropertyOwnership>

  listStatements(
    organizationId: string,
    query?: OwnerQuery,
  ): Promise<readonly OwnerStatement[]>

  loadStatement(
    organizationId: string,
    statementId: string,
  ): Promise<OwnerStatement | null>

  /**
   * Write the issued document.
   *
   * Insert only. There is no `updateStatement` on this port and there will not
   * be one: an issued statement is frozen, and the absence of the method is
   * what makes that true of every caller rather than of the ones that
   * remembered.
   */
  insertStatement(
    statement: OwnerStatement,
    tx: TransactionHandle,
  ): Promise<OwnerStatement>

  listPayouts(
    organizationId: string,
    query?: OwnerQuery,
  ): Promise<readonly OwnerPayout[]>

  insertPayout(payout: OwnerPayout, tx: TransactionHandle): Promise<OwnerPayout>

  /** Owner requests, read out of the shared `approvals` table. */
  listOwnerApprovals(
    organizationId: string,
    query?: OwnerQuery,
  ): Promise<readonly OwnerApproval[]>

  loadOwnerApproval(
    organizationId: string,
    approvalId: string,
  ): Promise<OwnerApproval | null>

  saveOwnerApproval(
    approval: OwnerApproval,
    expectedVersion: number,
    tx: TransactionHandle,
  ): Promise<OwnerApproval>
}

/* ------------------------------------------------------------- in memory -- */

/**
 * The double the domain tests run against.
 *
 * It stores what it is given and hands back copies. No behaviour lives here —
 * every refusal this module makes is made in `statement.ts`, `approvals.ts` or
 * the operations, so a rule that passed against this double is a rule that will
 * pass against Postgres.
 */
export class InMemoryOwnerRepository implements OwnerRepository {
  private readonly owners: PropertyOwner[] = []
  private readonly ownerships: PropertyOwnership[] = []
  private readonly statements: OwnerStatement[] = []
  private readonly payouts: OwnerPayout[] = []
  private readonly approvals: OwnerApproval[] = []

  seedOwner(owner: PropertyOwner): void {
    this.owners.push(owner)
  }

  seedOwnership(ownership: PropertyOwnership): void {
    this.ownerships.push(ownership)
  }

  seedStatement(statement: OwnerStatement): void {
    this.statements.push(statement)
  }

  seedPayout(payout: OwnerPayout): void {
    this.payouts.push(payout)
  }

  seedApproval(approval: OwnerApproval): void {
    this.approvals.push(approval)
  }

  async listOwners(organizationId: string): Promise<readonly PropertyOwner[]> {
    return this.owners.filter(
      (owner) => owner.organizationId === organizationId,
    )
  }

  async loadOwner(
    organizationId: string,
    ownerId: string,
  ): Promise<PropertyOwner | null> {
    return (
      this.owners.find(
        (owner) =>
          owner.organizationId === organizationId && owner.id === ownerId,
      ) ?? null
    )
  }

  async insertOwner(owner: PropertyOwner): Promise<PropertyOwner> {
    this.owners.push(owner)
    return owner
  }

  async listOwnerships(
    organizationId: string,
    query: OwnerQuery = {},
  ): Promise<readonly PropertyOwnership[]> {
    return this.ownerships.filter(
      (ownership) =>
        ownership.organizationId === organizationId &&
        (query.ownerId === undefined || ownership.ownerId === query.ownerId) &&
        (query.propertyId === undefined ||
          ownership.propertyId === query.propertyId),
    )
  }

  async insertOwnership(
    ownership: PropertyOwnership,
  ): Promise<PropertyOwnership> {
    this.ownerships.push(ownership)
    return ownership
  }

  async listStatements(
    organizationId: string,
    query: OwnerQuery = {},
  ): Promise<readonly OwnerStatement[]> {
    return this.statements.filter(
      (statement) =>
        statement.organizationId === organizationId &&
        (query.ownerId === undefined || statement.ownerId === query.ownerId) &&
        (query.propertyId === undefined ||
          statement.propertyId === query.propertyId),
    )
  }

  async loadStatement(
    organizationId: string,
    statementId: string,
  ): Promise<OwnerStatement | null> {
    return (
      this.statements.find(
        (statement) =>
          statement.organizationId === organizationId &&
          statement.id === statementId,
      ) ?? null
    )
  }

  async insertStatement(statement: OwnerStatement): Promise<OwnerStatement> {
    this.statements.push(statement)
    return statement
  }

  async listPayouts(
    organizationId: string,
    query: OwnerQuery = {},
  ): Promise<readonly OwnerPayout[]> {
    return this.payouts.filter(
      (payout) =>
        payout.organizationId === organizationId &&
        (query.ownerId === undefined || payout.ownerId === query.ownerId) &&
        (query.propertyId === undefined ||
          payout.propertyId === query.propertyId),
    )
  }

  async insertPayout(payout: OwnerPayout): Promise<OwnerPayout> {
    this.payouts.push(payout)
    return payout
  }

  async listOwnerApprovals(
    organizationId: string,
    query: OwnerQuery = {},
  ): Promise<readonly OwnerApproval[]> {
    return this.approvals.filter(
      (approval) =>
        approval.organizationId === organizationId &&
        (query.ownerId === undefined || approval.ownerId === query.ownerId) &&
        (query.propertyId === undefined ||
          approval.propertyId === query.propertyId),
    )
  }

  async loadOwnerApproval(
    organizationId: string,
    approvalId: string,
  ): Promise<OwnerApproval | null> {
    return (
      this.approvals.find(
        (approval) =>
          approval.organizationId === organizationId &&
          approval.id === approvalId,
      ) ?? null
    )
  }

  async saveOwnerApproval(
    approval: OwnerApproval,
    expectedVersion: number,
  ): Promise<OwnerApproval> {
    const index = this.approvals.findIndex(
      (candidate) =>
        candidate.organizationId === approval.organizationId &&
        candidate.id === approval.id,
    )
    if (index < 0) throw new Error(`No approval ${approval.id}`)
    if (this.approvals[index].version !== expectedVersion) {
      throw new Error(`Version conflict on approval ${approval.id}`)
    }
    this.approvals[index] = approval
    return approval
  }
}

/* -------------------------------------------------------------- supabase -- */

const OWNER_COLUMNS =
  'id, organization_id, display_name, user_id, email, phone, status, ' +
  'notes, created_at, version'

const OWNERSHIP_COLUMNS =
  'id, organization_id, owner_id, property_id, share_bps, effective_from, ' +
  'effective_to, created_at, version'

const STATEMENT_COLUMNS =
  'id, organization_id, owner_id, property_id, period_start, period_end, ' +
  'status, issued_at, issued_by, share_bps, gross_revenue_agorot, ' +
  'fees_agorot, expenses_agorot, sales_commission_agorot, ' +
  'management_fee_agorot, property_owner_share_agorot, owner_share_agorot, ' +
  'opening_balance_agorot, payments_agorot, payouts_agorot, ' +
  'closing_balance_agorot, booking_count, version'

const STATEMENT_LINE_COLUMNS =
  'statement_id, section, position, line_key, label, amount_agorot, kind, ' +
  'rule_id'

const PAYOUT_COLUMNS =
  'id, organization_id, owner_id, property_id, statement_id, direction, ' +
  'amount_agorot, method, paid_on, reference, note, recorded_by, created_at'

const APPROVAL_COLUMNS =
  'id, organization_id, property_id, subject_id, approval_type, status, ' +
  'reason, requested_agorot, limit_agorot, requested_by, requested_at, ' +
  'decided_by, decided_at, decision_note, expires_at, metadata, version'

function ownerFromRow(row: Row): PropertyOwner {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    displayName: asString(row, 'display_name'),
    userId: asStringOrNull(row, 'user_id'),
    email: asStringOrNull(row, 'email'),
    phone: asStringOrNull(row, 'phone'),
    status: asEnum(row, 'status', OWNER_STATUSES),
    notes: asStringOrNull(row, 'notes'),
    createdAt: asTimestamp(row, 'created_at'),
    version: asNumber(row, 'version'),
  }
}

function ownershipFromRow(row: Row): PropertyOwnership {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    ownerId: asString(row, 'owner_id'),
    propertyId: asString(row, 'property_id'),
    shareBps: asNumber(row, 'share_bps'),
    effectiveFrom: asIsoDate(row, 'effective_from'),
    effectiveTo: asIsoDateOrNull(row, 'effective_to'),
    createdAt: asTimestamp(row, 'created_at'),
    version: asNumber(row, 'version'),
  }
}

function payoutFromRow(row: Row): OwnerPayout {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    ownerId: asString(row, 'owner_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    statementId: asStringOrNull(row, 'statement_id'),
    direction: asEnum(row, 'direction', OWNER_PAYOUT_DIRECTIONS),
    amountAgorot: asNumber(row, 'amount_agorot'),
    method: asEnum(row, 'method', OWNER_PAYOUT_METHODS),
    paidOn: asIsoDate(row, 'paid_on'),
    reference: asStringOrNull(row, 'reference'),
    note: asStringOrNull(row, 'note'),
    recordedBy: asString(row, 'recorded_by'),
    createdAt: asTimestamp(row, 'created_at'),
  }
}

/**
 * The four kinds live in `approvals.metadata`, and the reason is the frozen
 * enum.
 *
 * `approval_type` is a Postgres enum transcribed from `contracts/states.ts`,
 * which this module may not edit. Adding `owner_upgrade` and its three
 * siblings to it would be four new values in a frozen vocabulary for a
 * distinction that is not about *who decides* — and who decides is the only
 * thing `approval_type` is asked. Deny by default: an unrecognised kind is
 * refused at the border rather than defaulted.
 */
function approvalKindFromRow(row: Row): OwnerApprovalKind {
  const metadata = row.metadata
  const raw =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>).owner_approval_kind
      : undefined

  if (
    typeof raw === 'string' &&
    (OWNER_APPROVAL_KINDS as readonly string[]).includes(raw)
  ) {
    return raw as OwnerApprovalKind
  }

  throw new Error(
    `Approval ${asString(row, 'id')} is an owner request with no recognised ` +
      `owner_approval_kind in its metadata`,
  )
}

function ownerApprovalFromRow(row: Row): OwnerApproval {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    ownerId: asString(row, 'subject_id'),
    kind: approvalKindFromRow(row),
    status: asEnum<ApprovalStatus>(row, 'status', APPROVAL_STATUSES),
    reason: asString(row, 'reason'),
    requestedAgorot: rowNumberOrNull(row, 'requested_agorot'),
    limitAgorot: rowNumberOrNull(row, 'limit_agorot'),
    requestedBy: asString(row, 'requested_by'),
    requestedAt: asTimestamp(row, 'requested_at'),
    decidedBy: asStringOrNull(row, 'decided_by'),
    decidedAt: asTimestampOrNull(row, 'decided_at'),
    decisionNote: asStringOrNull(row, 'decision_note'),
    expiresAt: asTimestampOrNull(row, 'expires_at'),
    version: asNumber(row, 'version'),
  }
}

function rowNumberOrNull(row: Row, column: string): number | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  return asNumber(row, column)
}

/**
 * The lines are stored, not recomputed on read.
 *
 * A statement is a document. Rebuilding its lines from its totals when it is
 * opened would mean the labels, the order and the redaction folding could all
 * change under a document somebody has already been sent — which is precisely
 * what "issued" is supposed to prevent. So `owner_statement_lines` holds them,
 * and this maps them back.
 */
function statementFromRows(row: Row, lines: readonly Row[]): OwnerStatement {
  const statementId = asString(row, 'id')
  const own = lines.filter(
    (line) => asString(line, 'statement_id') === statementId,
  )

  const bySection = (section: string) =>
    own
      .filter((line) => asString(line, 'section') === section)
      .sort((a, b) => asNumber(a, 'position') - asNumber(b, 'position'))

  return {
    id: statementId,
    organizationId: asString(row, 'organization_id'),
    ownerId: asString(row, 'owner_id'),
    propertyId: asString(row, 'property_id'),
    periodStart: asIsoDate(row, 'period_start'),
    periodEnd: asIsoDate(row, 'period_end'),
    status: asEnum(row, 'status', OWNER_STATEMENT_STATUSES),
    issuedAt: asTimestampOrNull(row, 'issued_at'),
    issuedBy: asStringOrNull(row, 'issued_by'),
    currency: 'ILS',
    shareBps: asNumber(row, 'share_bps'),
    grossRevenueAgorot: asNumber(row, 'gross_revenue_agorot'),
    feesAgorot: asNumber(row, 'fees_agorot'),
    expensesAgorot: asNumber(row, 'expenses_agorot'),
    salesCommissionAgorot: rowNumberOrNull(row, 'sales_commission_agorot'),
    managementFeeAgorot: asNumber(row, 'management_fee_agorot'),
    propertyOwnerShareAgorot: asNumber(row, 'property_owner_share_agorot'),
    resultLines: bySection('result').map((line) => ({
      key: asString(line, 'line_key'),
      label: asString(line, 'label'),
      amountAgorot: asNumber(line, 'amount_agorot'),
      kind: asEnum(line, 'kind', [
        'revenue',
        'cost',
        'result',
        'carried',
      ] as const),
    })),
    expenses: bySection('expense').map((line) => ({
      ruleId: asString(line, 'rule_id'),
      label: asString(line, 'label'),
      amountAgorot: asNumber(line, 'amount_agorot'),
    })),
    ownerShareAgorot: asNumber(row, 'owner_share_agorot'),
    openingBalanceAgorot: asNumber(row, 'opening_balance_agorot'),
    paymentsAgorot: asNumber(row, 'payments_agorot'),
    payoutsAgorot: asNumber(row, 'payouts_agorot'),
    closingBalanceAgorot: asNumber(row, 'closing_balance_agorot'),
    balanceLines: bySection('balance').map((line) => ({
      key: asString(line, 'line_key'),
      label: asString(line, 'label'),
      amountAgorot: asNumber(line, 'amount_agorot'),
      kind: asEnum(line, 'kind', [
        'revenue',
        'cost',
        'result',
        'carried',
      ] as const),
    })),
    bookingCount: asNumber(row, 'booking_count'),
    withheld: [],
    version: asNumber(row, 'version'),
  }
}

export class SupabaseOwnerRepository implements OwnerRepository {
  constructor(private readonly db: Db) {}

  async listOwners(organizationId: string): Promise<readonly PropertyOwner[]> {
    const { data, error } = await this.db
      .from('property_owners')
      .select(OWNER_COLUMNS)
      .eq('organization_id', organizationId)
      .order('display_name')

    if (error) throw error
    return toRows(data).map(ownerFromRow)
  }

  async loadOwner(
    organizationId: string,
    ownerId: string,
  ): Promise<PropertyOwner | null> {
    const { data, error } = await this.db
      .from('property_owners')
      .select(OWNER_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', ownerId)
      .maybeSingle()

    if (error) throw error
    return data ? ownerFromRow(toRow(data)) : null
  }

  async insertOwner(
    owner: PropertyOwner,
    tx: TransactionHandle,
  ): Promise<PropertyOwner> {
    const db = clientFor(tx, this.db)
    const { data, error } = await db
      .from('property_owners')
      .insert({
        id: owner.id,
        organization_id: owner.organizationId,
        display_name: owner.displayName,
        user_id: owner.userId,
        email: owner.email,
        phone: owner.phone,
        status: owner.status,
        notes: owner.notes,
      })
      .select(OWNER_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, 'property_owners.insert')
    return ownerFromRow(toRow(data))
  }

  async listOwnerships(
    organizationId: string,
    query: OwnerQuery = {},
  ): Promise<readonly PropertyOwnership[]> {
    let request = this.db
      .from('property_ownerships')
      .select(OWNERSHIP_COLUMNS)
      .eq('organization_id', organizationId)

    if (query.ownerId) request = request.eq('owner_id', query.ownerId)
    if (query.propertyId) request = request.eq('property_id', query.propertyId)

    const { data, error } = await request.order('effective_from')
    if (error) throw error
    return toRows(data).map(ownershipFromRow)
  }

  async insertOwnership(
    ownership: PropertyOwnership,
    tx: TransactionHandle,
  ): Promise<PropertyOwnership> {
    const db = clientFor(tx, this.db)
    const { data, error } = await db
      .from('property_ownerships')
      .insert({
        id: ownership.id,
        organization_id: ownership.organizationId,
        owner_id: ownership.ownerId,
        property_id: ownership.propertyId,
        share_bps: ownership.shareBps,
        effective_from: ownership.effectiveFrom,
        effective_to: ownership.effectiveTo,
      })
      .select(OWNERSHIP_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, 'property_ownerships.insert')
    return ownershipFromRow(toRow(data))
  }

  async listStatements(
    organizationId: string,
    query: OwnerQuery = {},
  ): Promise<readonly OwnerStatement[]> {
    let request = this.db
      .from('owner_statements')
      .select(STATEMENT_COLUMNS)
      .eq('organization_id', organizationId)

    if (query.ownerId) request = request.eq('owner_id', query.ownerId)
    if (query.propertyId) request = request.eq('property_id', query.propertyId)

    const { data, error } = await request.order('period_start', {
      ascending: false,
    })
    if (error) throw error

    const rows = toRows(data)
    if (rows.length === 0) return []

    const lines = await this.linesFor(rows.map((row) => asString(row, 'id')))
    return rows.map((row) => statementFromRows(row, lines))
  }

  async loadStatement(
    organizationId: string,
    statementId: string,
  ): Promise<OwnerStatement | null> {
    const { data, error } = await this.db
      .from('owner_statements')
      .select(STATEMENT_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', statementId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const lines = await this.linesFor([statementId])
    return statementFromRows(toRow(data), lines)
  }

  private async linesFor(
    statementIds: readonly string[],
  ): Promise<readonly Row[]> {
    const { data, error } = await this.db
      .from('owner_statement_lines')
      .select(STATEMENT_LINE_COLUMNS)
      .in('statement_id', [...statementIds])

    if (error) throw error
    return toRows(data)
  }

  /**
   * The header and its lines, written together.
   *
   * Both go through the handle the pipeline opened, so a statement whose lines
   * failed to write does not survive as a document with totals and no
   * explanation. Where `DATABASE_URL` is unset the runner is sequential rather
   * than atomic and `PartialCommitError` names what landed — which is the
   * honest failure, and is why the labels below are specific.
   */
  async insertStatement(
    statement: OwnerStatement,
    tx: TransactionHandle,
  ): Promise<OwnerStatement> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('owner_statements')
      .insert({
        id: statement.id,
        organization_id: statement.organizationId,
        owner_id: statement.ownerId,
        property_id: statement.propertyId,
        period_start: statement.periodStart,
        period_end: statement.periodEnd,
        status: statement.status,
        issued_at: statement.issuedAt,
        issued_by: statement.issuedBy,
        share_bps: statement.shareBps,
        gross_revenue_agorot: statement.grossRevenueAgorot,
        fees_agorot: statement.feesAgorot,
        expenses_agorot: statement.expensesAgorot,
        sales_commission_agorot: statement.salesCommissionAgorot,
        management_fee_agorot: statement.managementFeeAgorot,
        property_owner_share_agorot: statement.propertyOwnerShareAgorot,
        owner_share_agorot: statement.ownerShareAgorot,
        opening_balance_agorot: statement.openingBalanceAgorot,
        payments_agorot: statement.paymentsAgorot,
        payouts_agorot: statement.payoutsAgorot,
        closing_balance_agorot: statement.closingBalanceAgorot,
        booking_count: statement.bookingCount,
      })
      .select(STATEMENT_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, 'owner_statements.insert')

    const lineRows = [
      ...statement.resultLines.map((line, position) => ({
        statement_id: statement.id,
        organization_id: statement.organizationId,
        section: 'result',
        position,
        line_key: line.key,
        label: line.label,
        amount_agorot: line.amountAgorot,
        kind: line.kind,
        rule_id: null,
      })),
      ...statement.balanceLines.map((line, position) => ({
        statement_id: statement.id,
        organization_id: statement.organizationId,
        section: 'balance',
        position,
        line_key: line.key,
        label: line.label,
        amount_agorot: line.amountAgorot,
        kind: line.kind,
        rule_id: null,
      })),
      ...statement.expenses.map((expense, position) => ({
        statement_id: statement.id,
        organization_id: statement.organizationId,
        section: 'expense',
        position,
        line_key: expense.ruleId,
        label: expense.label,
        amount_agorot: expense.amountAgorot,
        kind: 'cost',
        rule_id: expense.ruleId,
      })),
    ]

    const { error: lineError } = await db
      .from('owner_statement_lines')
      .insert(lineRows)

    if (lineError) throw lineError
    recordWrite(tx, 'owner_statement_lines.insert')

    return statementFromRows(
      toRow(data),
      lineRows.map((line) => line as unknown as Row),
    )
  }

  async listPayouts(
    organizationId: string,
    query: OwnerQuery = {},
  ): Promise<readonly OwnerPayout[]> {
    let request = this.db
      .from('owner_payouts')
      .select(PAYOUT_COLUMNS)
      .eq('organization_id', organizationId)

    if (query.ownerId) request = request.eq('owner_id', query.ownerId)
    if (query.propertyId) request = request.eq('property_id', query.propertyId)

    const { data, error } = await request.order('paid_on', {
      ascending: false,
    })
    if (error) throw error
    return toRows(data).map(payoutFromRow)
  }

  async insertPayout(
    payout: OwnerPayout,
    tx: TransactionHandle,
  ): Promise<OwnerPayout> {
    const db = clientFor(tx, this.db)
    const { data, error } = await db
      .from('owner_payouts')
      .insert({
        id: payout.id,
        organization_id: payout.organizationId,
        owner_id: payout.ownerId,
        property_id: payout.propertyId,
        statement_id: payout.statementId,
        direction: payout.direction,
        amount_agorot: payout.amountAgorot,
        method: payout.method,
        paid_on: payout.paidOn,
        reference: payout.reference,
        note: payout.note,
        recorded_by: payout.recordedBy,
      })
      .select(PAYOUT_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, 'owner_payouts.insert')
    return payoutFromRow(toRow(data))
  }

  async listOwnerApprovals(
    organizationId: string,
    query: OwnerQuery = {},
  ): Promise<readonly OwnerApproval[]> {
    let request = this.db
      .from('approvals')
      .select(APPROVAL_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('approval_type', OWNER_APPROVAL_TYPE)
      .eq('subject_type', OWNER_APPROVAL_SUBJECT_TYPE)

    if (query.ownerId) request = request.eq('subject_id', query.ownerId)
    if (query.propertyId) request = request.eq('property_id', query.propertyId)

    const { data, error } = await request.order('requested_at', {
      ascending: false,
    })
    if (error) throw error
    return toRows(data).map(ownerApprovalFromRow)
  }

  async loadOwnerApproval(
    organizationId: string,
    approvalId: string,
  ): Promise<OwnerApproval | null> {
    const { data, error } = await this.db
      .from('approvals')
      .select(APPROVAL_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', approvalId)
      .eq('approval_type', OWNER_APPROVAL_TYPE)
      .maybeSingle()

    if (error) throw error
    return data ? ownerApprovalFromRow(toRow(data)) : null
  }

  /**
   * Record the decision, against the version that was read.
   *
   * `.eq('version', expectedVersion)` and then `.single()`: when somebody else
   * decided it in the meantime no row matches, PostgREST answers `PGRST116`,
   * and the caller is told the record moved rather than quietly overwriting
   * the other person's answer.
   */
  async saveOwnerApproval(
    approval: OwnerApproval,
    expectedVersion: number,
    tx: TransactionHandle,
  ): Promise<OwnerApproval> {
    const db = clientFor(tx, this.db)
    const { data, error } = await db
      .from('approvals')
      .update({
        status: approval.status,
        decided_by: approval.decidedBy,
        decided_at: approval.decidedAt,
        decision_note: approval.decisionNote,
        version: approval.version,
      })
      .eq('organization_id', approval.organizationId)
      .eq('id', approval.id)
      .eq('version', expectedVersion)
      .select(APPROVAL_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, 'approvals.update')
    return ownerApprovalFromRow(toRow(data))
  }
}
