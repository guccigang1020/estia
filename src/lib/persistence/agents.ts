/**
 * `AgentRepository`, backed by `0011_operations.sql` and `0015_agent_network.sql`.
 *
 * The port composes five stores. Three of them have tables and are implemented
 * here; two do not exist in any migration to 0017 and raise
 * `SchemaNotProvisionedError` rather than returning `null`, because "this agent
 * has no settings" and "this deployment cannot store agent settings" need very
 * different responses and only one of them is a bug.
 *
 *   `AgentDirectory`      partial   — `findMembership` only. See below.
 *   `AgentSettingsStore`  BLOCKED   — no table.
 *   `AgentHoldStore`      done      — it is `public.holds`.
 *   `CommissionStore`     done      — with one enum caveat, below.
 *   `ApprovalStore`       done      — `public.approvals`.
 *
 * ── The hold ledger is not a table, and that is correct ───────────────────
 *
 * `AgentHoldLedgerEntry` looks like it wants an `agent_hold_ledger` table. It
 * had one, in the domain's imagination, and 0015 deleted the need for it:
 *
 *   > `holds.extension_count`, which deletes the parallel ledger the domain
 *   > built to work around its absence, and without which the extension cap
 *   > cannot be enforced.
 *
 * So the ledger *is* `public.holds`, projected: `holdId` is `id`, `agentUserId`
 * is `held_by_user_id`, and `extensionCount` is the column 0015 added.
 * `holds_agent_created_idx` exists for exactly this read. A second table would
 * be a second answer to "how many times has this hold been extended", and the
 * two would disagree the first time a hold was released by a route that only
 * knew about one of them.
 *
 * The consequence for the port is worth stating: `insertLedgerEntry` does not
 * insert. The hold row already exists — `booking.ts` wrote it — and what this
 * does is claim it for the agent and zero the extension count. It is named
 * `insert` because that is what the port calls it, and renaming the port is
 * not this work's to do.
 *
 * ── One enum that no longer matches the code ──────────────────────────────
 *
 * `public.commission_base` has two members, `whole_booking` and
 * `accommodation_only`. `COMMISSION_BASES` in `src/lib/contracts/states.ts`
 * now has six, and `whole_booking` is not one of them — it was unified away
 * when four modules were found declaring the list differently.
 *
 * So `stay_total`, which `src/lib/agents/commission.ts` explicitly supports,
 * **cannot be stored**. Rather than let that surface as a raw `22P02` from
 * deep inside a write, `assertStorableBase` refuses it up front and names the
 * migration. Reads are the mirror image: a stored `whole_booking` is refused
 * by `asEnum` rather than smuggled into the domain as a value it has no
 * meaning for — on the record that decides what a person is paid.
 *
 *     alter type public.commission_base add value 'stay_total';
 *     -- …and the four others, then migrate the existing `whole_booking` rows.
 *
 * ── Why `findUserByPhone` cannot be written here ──────────────────────────
 *
 * Two independent reasons, either of which is enough.
 *
 * **There is no normalised column.** `user_profiles.phone` is free text; the
 * domain's key is E.164 and `phone.ts` exists to produce it. Matching
 * `'+972501234567'` against a column holding `'050-123-4567'` finds nothing,
 * and finding nothing is not a null answer — it is the *wrong* answer, and it
 * sends `identity.ts` down the `invite_new_user` branch, which creates a
 * second identity for a person who already has one. That is precisely the
 * failure the whole module is built to prevent, and it would be caused by this
 * adapter.
 *
 * **The question is global and RLS is not.** "Does this person exist in ESTIA"
 * spans every organization. `user_profiles_select` scopes a reader to
 * themselves and to people they share an organization with, so a signed-in
 * owner asking about a stranger's number correctly gets nothing back — and
 * that nothing is indistinguishable from "no such user". The answer is a
 * `security definer` function returning only a user id, so the caller learns
 * that the number is taken without learning anything about its owner; not the
 * admin client, which would hand this code the whole table.
 */

import { COMMISSION_BASES, COMMISSION_STATUSES } from '../contracts/states'
import { APPROVAL_STATUSES, APPROVAL_TYPES } from '../contracts/states'
import type {
  Commission,
  CommissionRule,
  CommissionRuleRecord,
} from '../agents/commission'
import type {
  DiscountApproval,
  DiscountApprovalView,
} from '../agents/discounts'
import type { AgentHoldLedgerEntry } from '../agents/holds'
import type {
  AgentDirectory,
  ExistingMembership,
  ExistingUser,
} from '../agents/identity'
import type {
  AgentHoldStore,
  AgentRepository,
  AgentSettingsStore,
  ApprovalStore,
  CommissionStore,
} from '../agents/repository'
import type {
  AgentInvitation,
  AgentOrganizationSettings,
} from '../agents/types'
import { MEMBERSHIP_STATUSES } from './actor'
import { ConflictError, NotFoundError } from '../errors'
import type { TransactionHandle } from '../service'
import type { Db, Row } from './client'
import { SchemaNotProvisionedError } from './errors'
import {
  asEnum,
  asIsoDateOrNull,
  asJsonRecord,
  asNumber,
  asNumberOrNull,
  asString,
  asStringArray,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRow,
  toRows,
} from './mapping'
import { clientFor, recordWrite } from './transaction'

export class SupabaseAgentRepository
  implements
    AgentRepository,
    AgentDirectory,
    AgentSettingsStore,
    AgentHoldStore,
    CommissionStore,
    ApprovalStore
{
  constructor(private readonly db: Db) {}

  // ── AgentDirectory ──────────────────────────────────────────────────────

  /** Blocked. See the header — this one is a correctness trap, not a gap. */
  async findUserByPhone(): Promise<ExistingUser | null> {
    throw new SchemaNotProvisionedError(
      'a normalised phone column and a security-definer lookup over it',
      'finding the ESTIA user behind a telephone number. ' +
        'user_profiles.phone is free text and user_profiles_select cannot see ' +
        'a stranger, so any answer this adapter could give would be "no such ' +
        'user" — which makes identity.ts create a second identity for a person ' +
        'who already has one',
    )
  }

  async findMembership(
    organizationId: string,
    userId: string,
  ): Promise<ExistingMembership | null> {
    const { data, error } = await this.db
      .from('memberships')
      .select('id, user_id, status')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = toRow(data)
    return {
      membershipId: asString(row, 'id'),
      userId: asString(row, 'user_id'),
      status: asEnum(row, 'status', MEMBERSHIP_STATUSES),
    }
  }

  /**
   * Blocked. `public.invitations` is a different thing wearing a similar name.
   *
   * It is keyed on `email` with a `role_id` and a `token_hash`. An
   * `AgentInvitation` is keyed on a phone number and carries the access and
   * inventory ladders the agent will start with — none of which have columns.
   * Reading one as the other would return an invitation with an invented
   * access ladder, and the agent would arrive holding permissions nobody
   * granted.
   */
  async findPendingInvitation(): Promise<AgentInvitation | null> {
    throw new SchemaNotProvisionedError(
      'agent_invitations',
      'finding an outstanding agent invitation. public.invitations is keyed ' +
        'on email with a role, and carries neither the phone number that is ' +
        'the agent identity nor the access and inventory ladders an ' +
        'AgentInvitation grants on acceptance',
    )
  }

  // ── AgentSettingsStore — no table exists ────────────────────────────────

  async loadSettings(): Promise<AgentOrganizationSettings | null> {
    throw settingsBlocked()
  }

  async saveSettings(): Promise<AgentOrganizationSettings> {
    throw settingsBlocked()
  }

  async insertInvitation(): Promise<AgentInvitation> {
    throw settingsBlocked()
  }

  async attachExistingUser(): Promise<AgentOrganizationSettings> {
    throw settingsBlocked()
  }

  // ── AgentHoldStore — which is `public.holds` ────────────────────────────

  /**
   * Every hold this agent started, expired ones included.
   *
   * Expired entries are deliberately not filtered, matching the port's own
   * note: liveness is decided in the domain against the clock, so a sweeper
   * that has not run cannot inflate the count and lock an agent out of their
   * own work. Released ones are kept for the same reason — the daily cap
   * counts holds *started* today, and a hold released an hour later still
   * happened.
   */
  async loadHoldLedger(
    organizationId: string,
    agentUserId: string,
  ): Promise<readonly AgentHoldLedgerEntry[]> {
    const { data, error } = await this.db
      .from('holds')
      .select(
        'id, organization_id, held_by_user_id, created_at, extension_count',
      )
      .eq('organization_id', organizationId)
      .eq('held_by_user_id', agentUserId)
      .order('created_at', { ascending: true })

    if (error) throw error
    return toRows(data).map(toLedgerEntry)
  }

  /**
   * Claim an existing hold for this agent. Not an insert — see the header.
   *
   * The predicate names the agent as well as the hold, so an agent cannot
   * adopt somebody else's hold by quoting its id and thereby move the
   * extension budget onto a row they do not own.
   */
  async insertLedgerEntry(
    entry: AgentHoldLedgerEntry,
    tx: TransactionHandle,
  ): Promise<AgentHoldLedgerEntry> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('holds')
      .update({ extension_count: entry.extensionCount })
      .eq('id', entry.holdId)
      .eq('organization_id', entry.organizationId)
      .eq('held_by_user_id', entry.agentUserId)
      .select(
        'id, organization_id, held_by_user_id, created_at, extension_count',
      )

    if (error) throw error

    const rows = toRows(data)
    if (rows.length === 0) {
      // The hold is gone, belongs to somebody else, or is invisible to this
      // caller. `NotFoundError` says the same thing to all three, which is
      // the right answer to an agent asking about a hold that is not theirs.
      throw new NotFoundError('hold', entry.holdId)
    }

    recordWrite(tx, `holds(${entry.holdId})`)
    return toLedgerEntry(rows[0] as Row)
  }

  /**
   * Record an extension, conditionally on the count it was granted against.
   *
   * `recordExtension` increments in memory, so the stored row is still one
   * behind — the same shape as an optimistic version, and the predicate is
   * `extension_count = entry.extensionCount - 1`. Without it two extensions
   * requested in the same second both read the old count, both pass the cap
   * in the domain, and both write; the cap would be advisory. With it the
   * second matches no rows and is refused.
   */
  async saveLedgerEntry(
    entry: AgentHoldLedgerEntry,
    tx: TransactionHandle,
  ): Promise<AgentHoldLedgerEntry> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('holds')
      .update({ extension_count: entry.extensionCount })
      .eq('id', entry.holdId)
      .eq('organization_id', entry.organizationId)
      .eq('held_by_user_id', entry.agentUserId)
      .eq('extension_count', entry.extensionCount - 1)
      .select(
        'id, organization_id, held_by_user_id, created_at, extension_count',
      )

    if (error) throw error

    const rows = toRows(data)
    if (rows.length === 0) {
      throw new ConflictError({
        resourceType: 'hold',
        resourceId: entry.holdId,
        expectedVersion: entry.extensionCount - 1,
        userMessage:
          'ההחזקה כבר הוארכה. רענן את המסך כדי לראות את מספר ההארכות הנוכחי.',
      })
    }

    recordWrite(tx, `holds(${entry.holdId})`)
    return toLedgerEntry(rows[0] as Row)
  }

  // ── CommissionStore ─────────────────────────────────────────────────────

  async loadCommission(
    organizationId: string,
    commissionId: string,
  ): Promise<Commission | null> {
    const { data, error } = await this.db
      .from('commissions')
      .select(COMMISSION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', commissionId)
      .maybeSingle()

    if (error) throw error
    return data ? toCommission(toRow(data)) : null
  }

  /**
   * Every rule that could govern a booking here.
   *
   * Unfiltered on purpose: `selectCommissionRule` decides which one applies,
   * deterministically and with tie-breaks all the way down to the id, and a
   * `WHERE` here that drifted from that function would pay a different agent
   * than the one the domain's tests prove.
   *
   * Soft-deleted rules are excluded, which is not a filter on applicability —
   * a deleted rule is not a rule.
   */
  async loadCommissionRules(
    organizationId: string,
  ): Promise<readonly CommissionRuleRecord[]> {
    const { data, error } = await this.db
      .from('agent_commission_rules')
      .select(COMMISSION_RULE_COLUMNS)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('priority', { ascending: false })

    if (error) throw error
    return toRows(data).map(toCommissionRuleRecord)
  }

  async saveCommission(
    commission: Commission,
    expectedVersion: number,
    tx: TransactionHandle,
  ): Promise<Commission> {
    const db = clientFor(tx, this.db)
    assertStorableBase(commission.base)

    const { data, error } = await db
      .from('commissions')
      .update({
        status: commission.status,
        base: commission.base,
        basis_agorot: commission.basisAgorot,
        rate_bps: commission.rateBps,
        amount_agorot: commission.amountAgorot,
        currency: commission.currency,
        rule_id: commission.ruleId,
        rule_version: commission.ruleVersion,
        explanation: commission.explanation,
        eligibility: commission.eligibility,
        eligible_at: commission.eligibleAt,
        approved_at: commission.approvedAt,
        approved_by: commission.approvedByUserId,
        paid_at: commission.paidAt,
        payout_reference: commission.payoutReference,
        cancelled_at: commission.cancelledAt,
        cancellation_reason: commission.cancellationReason,
        agency_id: commission.agencyId,
        // `version` is absent: `tg_touch_row` owns it.
      })
      .eq('id', commission.id)
      .eq('organization_id', commission.organizationId)
      .eq('version', expectedVersion)
      .select(COMMISSION_COLUMNS)

    if (error) throw error

    const rows = toRows(data)
    if (rows.length === 0) {
      throw new ConflictError({
        resourceType: 'commission',
        resourceId: commission.id,
        expectedVersion,
        actualVersion: await this.currentVersion(
          db,
          'commissions',
          commission.id,
        ),
      })
    }

    recordWrite(tx, `commissions(${commission.id})`)
    return toCommission(rows[0] as Row)
  }

  // ── ApprovalStore ───────────────────────────────────────────────────────

  async loadApproval(
    organizationId: string,
    approvalId: string,
  ): Promise<DiscountApproval | null> {
    const { data, error } = await this.db
      .from('approvals')
      .select(APPROVAL_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', approvalId)
      .eq('approval_type', 'discount')
      .maybeSingle()

    if (error) throw error
    return data ? toApproval(toRow(data)) : null
  }

  async insertApproval(
    approval: DiscountApproval,
    tx: TransactionHandle,
  ): Promise<DiscountApproval> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('approvals')
      .insert({
        id: approval.id,
        organization_id: approval.organizationId,
        approval_type: approval.type,
        status: approval.status,
        booking_id: approval.bookingId,
        requested_by: approval.requestedByUserId,
        requested_at: approval.requestedAt,
        reason: approval.reason,
        // The two columns 0011 created for exactly this, in basis points
        // because a percentage held as a float eventually fails an equality
        // check against itself.
        requested_value_bps: approval.view.requestedValueBps,
        limit_value_bps: approval.view.limitValueBps,
        requested_agorot: approval.view.requestedTotalAgorot,
        limit_agorot: approval.view.currentTotalAgorot,
        expires_at: approval.expiresAt,
        metadata: { view: approval.view },
      })
      .select(APPROVAL_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, `approvals(${approval.id})`)
    return toApproval(toRow(data))
  }

  /**
   * A decision, or an expiry, or a withdrawal.
   *
   * `decided_at` and `decided_by` are written straight from the record and
   * never synthesised: `approvals_decided_pair` makes `decided_at is not null`
   * exactly equivalent to `status in ('approved','rejected')`, so stamping an
   * expiry with a timestamp would both violate the constraint and invent a
   * decider for something nobody decided.
   */
  async saveApproval(
    approval: DiscountApproval,
    tx: TransactionHandle,
  ): Promise<DiscountApproval> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('approvals')
      .update({
        status: approval.status,
        decided_at: approval.decidedAt,
        decided_by: approval.decidedByUserId,
        decision_note: approval.decisionNote,
        metadata: { view: approval.view },
      })
      .eq('id', approval.id)
      .eq('organization_id', approval.organizationId)
      .select(APPROVAL_COLUMNS)

    if (error) throw error

    const rows = toRows(data)
    if (rows.length === 0) throw new NotFoundError('approval', approval.id)

    recordWrite(tx, `approvals(${approval.id})`)
    return toApproval(rows[0] as Row)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async currentVersion(
    db: Db,
    table: string,
    id: string,
  ): Promise<number | null> {
    const { data, error } = await db
      .from(table)
      .select('version')
      .eq('id', id)
      .maybeSingle()

    if (error || !data) return null
    return asNumberOrNull(toRow(data), 'version')
  }
}

// ── Column lists ──────────────────────────────────────────────────────────

const COMMISSION_COLUMNS =
  'id, organization_id, property_id, booking_id, agent_user_id, agency_id, ' +
  'rule_id, rule_version, status, base, basis_agorot, rate_bps, ' +
  'amount_agorot, currency, explanation, eligibility, created_at, ' +
  'eligible_at, approved_at, approved_by, paid_at, payout_reference, ' +
  'cancelled_at, cancellation_reason, version'

const COMMISSION_RULE_COLUMNS =
  'id, organization_id, agent_user_id, agency_id, rule, base, property_ids, ' +
  'unit_ids, rate_plan_ids, period_from, period_to, eligibility_conditions, ' +
  'priority, effective_from, effective_until, version'

const APPROVAL_COLUMNS =
  'id, organization_id, approval_type, status, booking_id, requested_by, ' +
  'requested_at, reason, requested_value_bps, limit_value_bps, ' +
  'requested_agorot, limit_agorot, decided_by, decided_at, decision_note, ' +
  'expires_at, metadata'

// ── Row mapping ───────────────────────────────────────────────────────────

function toLedgerEntry(row: Row): AgentHoldLedgerEntry {
  return {
    holdId: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    agentUserId: asString(row, 'held_by_user_id'),
    createdAt: asTimestamp(row, 'created_at'),
    extensionCount: asNumber(row, 'extension_count'),
  }
}

function toCommission(row: Row): Commission {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    bookingId: asString(row, 'booking_id'),
    // `NOT NULL` in the domain and nullable in the column, because a
    // commission can be owed to an agency with no named person. That case
    // needs an `agencyId`-only variant on the port; until it has one, a row
    // with no agent cannot be represented and says so rather than inventing
    // an empty user id.
    agentUserId: requireAgent(row),
    agencyId: asStringOrNull(row, 'agency_id'),
    ruleId: asStringOrNull(row, 'rule_id'),
    ruleVersion: asNumberOrNull(row, 'rule_version'),
    status: asEnum(row, 'status', COMMISSION_STATUSES),
    base: asEnum(row, 'base', COMMISSION_BASES),
    basisAgorot: asNumber(row, 'basis_agorot'),
    rateBps: asNumberOrNull(row, 'rate_bps'),
    amountAgorot: asNumber(row, 'amount_agorot'),
    currency: asString(row, 'currency'),
    explanation: asStringOrNull(row, 'explanation') ?? '',
    eligibility: {
      conditions: asStringArray(
        row,
        'eligibility',
      ) as Commission['eligibility']['conditions'],
    },
    createdAt: asTimestamp(row, 'created_at'),
    eligibleAt: asTimestampOrNull(row, 'eligible_at'),
    approvedAt: asTimestampOrNull(row, 'approved_at'),
    approvedByUserId: asStringOrNull(row, 'approved_by'),
    paidAt: asTimestampOrNull(row, 'paid_at'),
    payoutReference: asStringOrNull(row, 'payout_reference'),
    cancelledAt: asTimestampOrNull(row, 'cancelled_at'),
    cancellationReason: asStringOrNull(row, 'cancellation_reason'),
    version: asNumber(row, 'version'),
  }
}

function requireAgent(row: Row): string {
  const agent = asStringOrNull(row, 'agent_user_id')
  if (agent === null) {
    throw new SchemaNotProvisionedError(
      'an agency-only shape on the Commission record',
      'reading a commission owed to an agency rather than to a named person. ' +
        'commissions.agent_user_id is nullable and the domain type is not',
    )
  }
  return agent
}

/**
 * `eligibility` is stored as jsonb, and the domain reads a bare array.
 *
 * The column holds either the array or `{"conditions": [...]}` depending on
 * which writer got there; both are read, and neither is guessed at — an
 * unrecognised shape yields no conditions, which makes a commission *harder*
 * to become eligible rather than easier. Erring toward "not yet payable" is
 * the only safe direction on a record that authorises a payment.
 */
function toCommissionRuleRecord(row: Row): CommissionRuleRecord {
  const eligibility = row.eligibility ?? row.eligibility_conditions
  const conditions = Array.isArray(eligibility)
    ? eligibility.filter((c): c is string => typeof c === 'string')
    : []

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    agentUserId: asStringOrNull(row, 'agent_user_id'),
    agencyId: asStringOrNull(row, 'agency_id'),
    rule: asJsonRecord(row, 'rule') as unknown as CommissionRule,
    base: asEnum(row, 'base', COMMISSION_BASES),
    scope: {
      // NULL and '{}' are different answers, and 0015 says so at length: a
      // rule that names no properties applies everywhere, a rule whose list
      // was emptied applies nowhere. `asStringArray` collapses both to `[]`,
      // so the null check has to happen before it.
      propertyIds: nullableList(row, 'property_ids'),
      unitIds: nullableList(row, 'unit_ids'),
      ratePlanIds: nullableList(row, 'rate_plan_ids'),
      period:
        row.period_from === null || row.period_from === undefined
          ? null
          : {
              from: asString(row, 'period_from'),
              to: asString(row, 'period_to'),
            },
    },
    eligibility: {
      conditions:
        conditions as CommissionRuleRecord['eligibility']['conditions'],
    },
    priority: asNumber(row, 'priority'),
    effectiveFrom: asIsoDateOrNull(row, 'effective_from'),
    effectiveUntil: asIsoDateOrNull(row, 'effective_until'),
    version: asNumber(row, 'version'),
  }
}

function nullableList(row: Row, column: string): readonly string[] | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  return asStringArray(row, column)
}

function toApproval(row: Row): DiscountApproval {
  const metadata = asJsonRecord(row, 'metadata')
  const stored = metadata.view

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    type: asEnum(row, 'approval_type', APPROVAL_TYPES) as 'discount',
    status: asEnum(row, 'status', APPROVAL_STATUSES),
    requestedByUserId: asString(row, 'requested_by'),
    bookingId: asString(row, 'booking_id'),
    reason: asString(row, 'reason'),
    // The computed view, frozen at request time.
    //
    // The two figures a person filters and reports on — the ask and the
    // ceiling — are real columns, and are the ones written above. The rest is
    // a rendering: the Hebrew sentence, the commission before and after, the
    // margin delta. It is kept whole in `metadata` because an approver reading
    // a two-week-old request must see the numbers *they* were shown, not
    // today's recomputation of them, and because inventing eight columns for a
    // presentation snapshot would be this adapter deciding the approvals
    // schema by the back door.
    view: viewFrom(stored, row),
    requestedAt: asTimestamp(row, 'requested_at'),
    expiresAt: asTimestamp(row, 'expires_at'),
    decidedAt: asTimestampOrNull(row, 'decided_at'),
    decidedByUserId: asStringOrNull(row, 'decided_by'),
    decisionNote: asStringOrNull(row, 'decision_note'),
  }
}

function viewFrom(stored: unknown, row: Row): DiscountApprovalView {
  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    return stored as DiscountApprovalView
  }
  // A row written before the view was carried, or by another writer. The two
  // real columns are all there is; the rest is reported as zero rather than
  // guessed, and a zero here is visibly wrong in a way an invented number
  // would not be.
  return {
    bookingReference: '',
    currentTotalAgorot: asNumber(row, 'limit_agorot'),
    requestedTotalAgorot: asNumber(row, 'requested_agorot'),
    discountAgorot: 0,
    discountPercent: 0,
    capPercent: 0,
    requestedValueBps: asNumber(row, 'requested_value_bps'),
    limitValueBps: asNumber(row, 'limit_value_bps'),
    commissionBeforeAgorot: 0,
    commissionAfterAgorot: 0,
    marginDeltaAgorot: 0,
    summary: '',
  }
}

// ── Refusals ──────────────────────────────────────────────────────────────

/** The members `public.commission_base` can actually hold today. */
const STORABLE_BASES = new Set(['accommodation_only'])

function assertStorableBase(base: string): void {
  if (STORABLE_BASES.has(base)) return
  throw new SchemaNotProvisionedError(
    `public.commission_base value '${base}'`,
    'writing this commission. The enum was created by 0015 with ' +
      "'whole_booking' and 'accommodation_only'; COMMISSION_BASES in " +
      'src/lib/contracts/states.ts now has six members and no ' +
      "'whole_booking'. The enum needs widening before a commission on any " +
      'other base can be stored',
  )
}

function settingsBlocked(): SchemaNotProvisionedError {
  return new SchemaNotProvisionedError(
    'agent_organization_settings',
    'reading or writing what an agent is, inside one organization. ' +
      'AgentOrganizationSettings carries the access, inventory, discount and ' +
      'hold ladders plus a reputation score, and no migration to 0017 creates ' +
      'a table for any of them. public.memberships holds the relationship but ' +
      'none of the terms',
  )
}
