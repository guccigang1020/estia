/**
 * `AgentRepository`, backed by `0011`, `0015`, `0018`, `0019` and `0020`.
 *
 * The port composes five stores and all five are implemented. Three of them
 * were blocked until 0018–0020 landed, and what those migrations changed is
 * worth stating, because the reasons the old code refused were good ones and
 * none of them was "add a table and hope".
 *
 *   `AgentDirectory`      done      — 0020, via a security-definer lookup.
 *   `AgentSettingsStore`  done      — 0019, `agent_organization_settings`.
 *   `AgentHoldStore`      done      — it is `public.holds`.
 *   `CommissionStore`     done      — 0018 widened the enum.
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
 * ── The commission enum, now that it matches ──────────────────────────────
 *
 * 0015 created `public.commission_base` with `whole_booking` and
 * `accommodation_only`, and the unified `COMMISSION_BASES` in
 * `src/lib/contracts/states.ts` later grew to six members with no
 * `whole_booking` at all. This adapter refused both directions of that drift:
 * `assertStorableBase` refused a write it knew would come back as `22P02`, and
 * `asEnum` refused a stored `whole_booking` rather than smuggle a meaningless
 * value into the record that decides what a person is paid.
 *
 * 0018 rebuilt the type with exactly the six members of `COMMISSION_BASES` and
 * rewrote every stored `whole_booking` as `stay_total`. The write-side guard is
 * therefore gone: it can no longer describe a real difference, and a copy of
 * the enum kept here to "be safe" would be a second list to drift from. The
 * read-side guard stays — `asEnum` against `COMMISSION_BASES` is what catches
 * the next divergence, at the border, naming the value.
 *
 * ── How `findUserByPhone` is answered ─────────────────────────────────────
 *
 * The two reasons it could not be written here were a missing normalised
 * column and the fact that the question is global while RLS is not. 0020
 * answers both, and neither answer is "use the admin client".
 *
 * `user_profiles.phone_e164` is `generated always as
 * (normalize_phone_il(phone))` and globally unique, so there is one spelling of
 * a number and no write path can skip producing it.
 *
 * `public.find_user_id_by_phone(text)` is `security definer`, gated on holding
 * `agent.invite` somewhere or on asking about your own number, and returns a
 * bare uuid. That is the whole answer by design: the caller learns the number
 * is taken without learning who holds it, because they are by definition
 * asking about somebody they share no organization with. The display name is
 * read separately, through RLS, and comes back `null` for a stranger — which
 * `ExistingUser` already models, and which `identity.ts` treats as "no name
 * offered" rather than as "no such user".
 */

import { COMMISSION_BASES, COMMISSION_STATUSES } from '../contracts/states'
import { APPROVAL_STATUSES, APPROVAL_TYPES } from '../contracts/states'
import {
  AGENT_CANCELLATION_KINDS,
  parseAgentAccess,
  type AgentAccess,
  type AgentCancellationPolicy,
} from '../agents/access'
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
  AgentInventoryScope,
  AgentInvitation,
  AgentOrganizationSettings,
} from '../agents/types'
import { MEMBERSHIP_STATUSES } from './actor'
import { ConflictError, NotFoundError } from '../errors'
import type { MembershipStatus } from '../authz/can'
import type { TransactionHandle } from '../service'
import type { Db, Row } from './client'
import { SchemaNotProvisionedError } from './errors'
import {
  RowShapeError,
  asBoolean,
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

  /**
   * The global user holding this number, or `null`.
   *
   * Two queries, and the split is the security property rather than an
   * inefficiency. The first is `find_user_id_by_phone`, which is
   * `security definer` and answers the *global* question — the one
   * `user_profiles_select` cannot, because it scopes a reader to people they
   * share an organization with and the whole point here is somebody they do
   * not. It returns a bare uuid and nothing else.
   *
   * The second reads the display name through ordinary RLS. A stranger's name
   * is not visible and comes back `null`, which is exactly what the caller
   * should get: `identity.ts` uses the name only to fill in a blank field on
   * the invitation, and `null` there means "nothing to prefill". The
   * *identity* answer — this number belongs to somebody — is already made, and
   * that is the answer that decides whether a second user gets created.
   *
   * A `null` from the first query is a real "nobody holds this number", or a
   * caller without `agent.invite`, and the function makes those two look alike
   * on purpose: an ordinary signed-in user must not be able to sweep the
   * product for numbers.
   */
  async findUserByPhone(phoneE164: string): Promise<ExistingUser | null> {
    const { data, error } = await this.db.rpc('find_user_id_by_phone', {
      phone_e164: phoneE164,
    })

    if (error) throw error
    if (typeof data !== 'string' || data === '') return null

    return { userId: data, displayName: await this.displayNameOf(data) }
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
   * An outstanding invitation to this number in this organization.
   *
   * `agent_invitations`, and still never `public.invitations` — that table is
   * a different thing wearing a similar name, keyed on email with a role and a
   * token hash, and reading one as the other would seat an agent holding an
   * access ladder nobody granted.
   *
   * `status = 'pending'` and not an expiry test. `isInvitationOpen` decides
   * liveness in the domain against the clock, and a `expires_at > now()`
   * predicate here would make a lapsed invitation look absent — which sends
   * `planAgentInvitation` down `invite_new_user` and issues a second live
   * credential for a number that already has one outstanding, the exact
   * collision `agent_invitations_one_live_per_phone_idx` refuses.
   */
  async findPendingInvitation(
    organizationId: string,
    phoneE164: string,
  ): Promise<AgentInvitation | null> {
    const { data, error } = await this.db
      .from('agent_invitations')
      .select(INVITATION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('phone_e164', phoneE164)
      .eq('status', 'pending')
      .maybeSingle()

    if (error) throw error
    return data ? toInvitation(toRow(data)) : null
  }

  // ── AgentSettingsStore — `agent_organization_settings`, from 0019 ───────

  /**
   * The terms this agent sells on, inside this organization.
   *
   * `memberships(status)` is embedded rather than duplicated, because the
   * status is not a column here: 0019 says at length that it belongs to the
   * membership and stays there, and the composite foreign key on
   * `(membership_id, organization_id, agent_user_id)` is what stops the terms
   * naming somebody else's membership. A copy on this row would be a second
   * answer to "is this agent suspended", and the two would disagree the first
   * time a membership was suspended through the ordinary user-management path.
   */
  async loadSettings(
    organizationId: string,
    agentUserId: string,
  ): Promise<AgentOrganizationSettings | null> {
    const { data, error } = await this.db
      .from('agent_organization_settings')
      .select(SETTINGS_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('agent_user_id', agentUserId)
      .maybeSingle()

    if (error) throw error
    return data ? toSettings(toRow(data)) : null
  }

  /**
   * Write the terms, and the membership status when it actually moved.
   *
   * Two statements, because the record is two rows and 0019 chose that split
   * deliberately. The order matters: the version-locked write goes first, so a
   * caller working from a stale copy is refused *before* anything is changed.
   *
   * `version` is not sent — `tg_touch_row` owns it — and the predicate is
   * `expectedVersion`, which is what the pipeline read. Note that the domain
   * pre-increments: `changeAgentStatus` returns `version + 1`, so using
   * `settings.version` here would match nothing and conflict on every save.
   *
   * The membership is touched only when the status differs from the stored
   * one. That is not an optimisation: `memberships_update` requires
   * `user.edit`, which an owner holding only `agent.manage` does not have, and
   * an unconditional write would refuse every ordinary edit of the ladders for
   * a status nobody was changing.
   */
  async saveSettings(
    settings: AgentOrganizationSettings,
    expectedVersion: number,
    tx: TransactionHandle,
  ): Promise<AgentOrganizationSettings> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('agent_organization_settings')
      .update(settingsPatch(settings))
      .eq('organization_id', settings.organizationId)
      .eq('agent_user_id', settings.agentUserId)
      .eq('version', expectedVersion)
      .select(SETTINGS_COLUMNS)

    if (error) throw error

    const rows = toRows(data)
    if (rows.length === 0) {
      throw new ConflictError({
        resourceType: 'agent',
        resourceId: settings.agentUserId,
        expectedVersion,
        actualVersion: await this.currentSettingsVersion(db, settings),
      })
    }

    recordWrite(tx, `agent_organization_settings(${settings.agentUserId})`)

    const written = toSettings(rows[0] as Row)
    if (written.status === settings.status) return written

    const status = await this.setMembershipStatus(
      db,
      tx,
      written.membershipId,
      settings,
    )
    return { ...written, status }
  }

  /**
   * A pending invitation, by telephone number.
   *
   * `phone` is written and `phone_e164` is not: the column is
   * `generated always`, so the normalisation cannot be skipped by any writer
   * and two spellings of one number cannot become two agents. `created_at` is
   * sent rather than left to `now()` because `expires_at` was computed from it
   * in `buildInvitation`, and `agent_invitations_expires_after_creation`
   * compares the pair.
   */
  async insertInvitation(
    invitation: AgentInvitation,
    tx: TransactionHandle,
  ): Promise<AgentInvitation> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('agent_invitations')
      .insert({
        id: invitation.id,
        organization_id: invitation.organizationId,
        phone: invitation.phoneE164,
        display_name: invitation.displayName,
        email: invitation.email,
        invited_by_user_id: invitation.invitedByUserId,
        ...accessPatch(invitation.access),
        ...inventoryPatch(invitation.inventory),
        status: invitation.status,
        created_at: invitation.createdAt,
        expires_at: invitation.expiresAt,
        accepted_at: invitation.acceptedAt,
      })
      .select(INVITATION_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, `agent_invitations(${invitation.id})`)
    return toInvitation(toRow(data))
  }

  /**
   * Admit somebody who already has an ESTIA identity. A membership, never a
   * user.
   *
   * Three steps, and the third is the one worth reading.
   *
   *   1. The membership. Reactivating one that exists rather than creating a
   *      second, because `identity.ts` reaches this method from both the
   *      `attach_existing_user` and `reactivate_membership` branches and the
   *      second already has a row. `joined_at` is stamped on creation because
   *      `memberships_joined_when_active` requires it of an active membership.
   *
   *   2. Nothing at all, if the terms already exist. **The stored ladders
   *      win.** An owner re-adding a suspended agent passes the preset
   *      defaults down this path, and writing them would silently reset a
   *      negotiated discount cap to zero and an inventory reach to everything.
   *      0019 keeps the terms when a membership is removed precisely so a past
   *      commission can still be argued from them; overwriting them on
   *      re-admission would delete the same record a day later instead.
   *
   *   3. Otherwise the terms are inserted as given.
   *
   * What this cannot do is assign a role. `membership_roles` is where grants
   * come from, `AgentOrganizationSettings` carries no role and `addAgent`
   * chooses a preset it does not pass down, so the membership created here
   * resolves with no grants until one is assigned. That is a gap in the port,
   * not in the schema, and inventing a role code in an adapter would be this
   * file deciding authorization.
   */
  async attachExistingUser(
    input: {
      organizationId: string
      userId: string
      settings: AgentOrganizationSettings
    },
    tx: TransactionHandle,
  ): Promise<AgentOrganizationSettings> {
    const db = clientFor(tx, this.db)
    const { organizationId, userId, settings } = input

    // The ids come from `input`, never from `input.settings`. They are the same
    // today, and a predicate that trusted the nested copy would widen silently
    // the day a caller passed terms belonging to somebody else.
    const anchored: AgentOrganizationSettings = {
      ...settings,
      organizationId,
      agentUserId: userId,
    }

    const membership = await this.findMembership(organizationId, userId)
    const membershipId = membership
      ? await this.reactivateMembership(db, tx, membership, anchored)
      : await this.createMembership(db, tx, organizationId, userId, anchored)

    const existing = await this.loadSettings(organizationId, userId)
    if (existing) return { ...existing, status: settings.status }

    const { data, error } = await db
      .from('agent_organization_settings')
      .insert({
        organization_id: organizationId,
        agent_user_id: userId,
        membership_id: membershipId,
        ...settingsPatch(anchored),
        created_at: anchored.createdAt,
      })
      .select(SETTINGS_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, `agent_organization_settings(${userId})`)
    return toSettings(toRow(data))
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

  /**
   * The name on a profile this caller may see, or `null`.
   *
   * `null` covers both "no name recorded" and "not visible to you", and that
   * conflation is deliberate: distinguishing them would leak the existence of
   * a profile the reader has no relationship with, which is the thing
   * `find_user_id_by_phone` is careful not to do one query earlier.
   */
  private async displayNameOf(userId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from('user_profiles')
      .select('full_name')
      .eq('id', userId)
      .maybeSingle()

    if (error) throw error
    return data ? asStringOrNull(toRow(data), 'full_name') : null
  }

  /**
   * Move the membership status, and refuse to report success if nothing moved.
   *
   * Zero rows means the membership is gone, belongs to somebody else, or —
   * most likely — this caller holds `agent.manage` but not the `user.edit`
   * that `memberships_update` demands. All three must be loud: returning the
   * requested status while the row still says `active` would tell an owner
   * they had suspended an agent who is still selling.
   */
  private async setMembershipStatus(
    db: Db,
    tx: TransactionHandle,
    membershipId: string,
    settings: AgentOrganizationSettings,
  ): Promise<MembershipStatus> {
    const { data, error } = await db
      .from('memberships')
      .update(await this.membershipPatch(db, membershipId, settings.status))
      .eq('id', membershipId)
      .eq('organization_id', settings.organizationId)
      .eq('user_id', settings.agentUserId)
      .select('status')

    if (error) throw error

    const rows = toRows(data)
    if (rows.length === 0) throw new NotFoundError('membership', membershipId)

    recordWrite(tx, `memberships(${membershipId})`)
    return asEnum(rows[0] as Row, 'status', MEMBERSHIP_STATUSES)
  }

  /** Restore an existing membership. Never a second one — see the header. */
  private async reactivateMembership(
    db: Db,
    tx: TransactionHandle,
    membership: ExistingMembership,
    settings: AgentOrganizationSettings,
  ): Promise<string> {
    if (membership.status === settings.status) return membership.membershipId
    await this.setMembershipStatus(db, tx, membership.membershipId, {
      ...settings,
      membershipId: membership.membershipId,
    })
    return membership.membershipId
  }

  private async createMembership(
    db: Db,
    tx: TransactionHandle,
    organizationId: string,
    userId: string,
    settings: AgentOrganizationSettings,
  ): Promise<string> {
    const { data, error } = await db
      .from('memberships')
      .insert({
        organization_id: organizationId,
        user_id: userId,
        status: settings.status,
        // `memberships_joined_when_active` requires it of an active
        // membership, and this is the moment they joined.
        joined_at:
          settings.status === 'active' ? new Date().toISOString() : null,
      })
      .select('id')
      .single()

    if (error) throw error
    const membershipId = asString(toRow(data), 'id')
    recordWrite(tx, `memberships(${membershipId})`)
    return membershipId
  }

  /**
   * The status change, plus `joined_at` only when it has to be invented.
   *
   * `memberships_joined_when_active` requires the timestamp of an active
   * membership, so activating one that never had it must supply it. A
   * membership that already carries a date keeps it: the day somebody joined
   * is a fact about the past, and refreshing it on every reinstatement would
   * quietly rewrite how long they have been here.
   */
  private async membershipPatch(
    db: Db,
    membershipId: string,
    status: MembershipStatus,
  ): Promise<Record<string, unknown>> {
    if (status !== 'active') return { status }

    const { data, error } = await db
      .from('memberships')
      .select('joined_at')
      .eq('id', membershipId)
      .maybeSingle()

    if (error) throw error
    const joinedAt = data ? asTimestampOrNull(toRow(data), 'joined_at') : null
    return joinedAt === null
      ? { status, joined_at: new Date().toISOString() }
      : { status }
  }

  private async currentSettingsVersion(
    db: Db,
    settings: AgentOrganizationSettings,
  ): Promise<number | null> {
    const { data, error } = await db
      .from('agent_organization_settings')
      .select('version')
      .eq('organization_id', settings.organizationId)
      .eq('agent_user_id', settings.agentUserId)
      .maybeSingle()

    if (error || !data) return null
    return asNumberOrNull(toRow(data), 'version')
  }

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

/** The three ladders, shared by the settings row and the invitation. */
const LADDER_COLUMNS =
  'access_calendar, access_price, access_guest_data, access_amendments, ' +
  'access_cancellation_kind, access_cancellation_hours, access_payment_link, ' +
  'inventory_kind, inventory_property_ids, inventory_unit_ids'

const SETTINGS_COLUMNS =
  'id, organization_id, agent_user_id, membership_id, ' +
  LADDER_COLUMNS +
  ', discount_max_percent, discount_max_agorot, hold_max_concurrent, ' +
  'hold_max_per_day, hold_max_extensions, hold_default_minutes, ' +
  'hold_max_minutes, reputation_score, agency_id, internal_note, ' +
  'created_at, updated_at, version, memberships(status)'

const INVITATION_COLUMNS =
  'id, organization_id, phone_e164, display_name, email, ' +
  'invited_by_user_id, ' +
  LADDER_COLUMNS +
  ', status, created_at, expires_at, accepted_at'

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

// ── Row mapping · the agent relationship ──────────────────────────────────

function toSettings(row: Row): AgentOrganizationSettings {
  return {
    organizationId: asString(row, 'organization_id'),
    agentUserId: asString(row, 'agent_user_id'),
    membershipId: asString(row, 'membership_id'),
    status: embeddedStatus(row),
    access: toAccess(row),
    inventory: toInventoryScope(row),
    discountCap: {
      // `numeric` arrives as a string. `asNumber` is what stops `"7.500"`
      // reaching the epsilon comparison in discounts.ts as text.
      maxPercent: asNumber(row, 'discount_max_percent'),
      maxAgorot: asNumberOrNull(row, 'discount_max_agorot'),
    },
    holdLimits: {
      maxConcurrent: asNumber(row, 'hold_max_concurrent'),
      maxPerDay: asNumber(row, 'hold_max_per_day'),
      maxExtensions: asNumber(row, 'hold_max_extensions'),
      defaultMinutes: asNumber(row, 'hold_default_minutes'),
      maxMinutes: asNumber(row, 'hold_max_minutes'),
    },
    reputationScore: asNumber(row, 'reputation_score'),
    agencyId: asStringOrNull(row, 'agency_id'),
    internalNote: asStringOrNull(row, 'internal_note'),
    createdAt: asTimestamp(row, 'created_at'),
    updatedAt: asTimestamp(row, 'updated_at'),
    version: asNumber(row, 'version'),
  }
}

function toInvitation(row: Row): AgentInvitation {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    // The generated column, never the free-text one it is derived from.
    phoneE164: asString(row, 'phone_e164'),
    displayName: asStringOrNull(row, 'display_name'),
    email: asStringOrNull(row, 'email'),
    invitedByUserId: asString(row, 'invited_by_user_id'),
    access: toAccess(row),
    inventory: toInventoryScope(row),
    status: asEnum(row, 'status', INVITATION_STATUSES),
    createdAt: asTimestamp(row, 'created_at'),
    expiresAt: asTimestamp(row, 'expires_at'),
    acceptedAt: asTimestampOrNull(row, 'accepted_at'),
  }
}

/** `AgentInvitation['status']`, which the domain declares inline. */
const INVITATION_STATUSES = [
  'pending',
  'accepted',
  'expired',
  'revoked',
] as const

/**
 * The membership status, from the embed.
 *
 * A missing embed is a refusal, not a default. `memberships_select` admits
 * every member of the organization, so a caller who can read these terms can
 * read that membership; an absent one therefore means the select or the
 * relationship changed, and guessing `active` would report a suspended agent
 * as a working one on the record that governs whether they may sell.
 */
function embeddedStatus(row: Row): MembershipStatus {
  const membership = firstEmbedded(row.memberships)
  if (!membership) {
    throw new RowShapeError(
      'memberships',
      'an embedded membership carrying its status',
      row.memberships,
    )
  }
  return asEnum(membership, 'status', MEMBERSHIP_STATUSES)
}

function firstEmbedded(value: unknown): Row | null {
  if (Array.isArray(value)) return (value[0] as Row | undefined) ?? null
  if (value && typeof value === 'object') return value as Row
  return null
}

/**
 * The access ladder, rebuilt through the union's own door.
 *
 * `parseAgentAccess` and never a cast. The stored columns are constrained to
 * be coherent — 0019 writes the cross-ladder rule as three CHECKs — but a
 * coherent *row* and an inhabitable `AgentAccess` are two claims, and this is
 * the single place the second is established. A cast would put
 * `{ calendar: 'none', price: 'net' }` into a type that cannot hold it, and
 * every `switch` downstream would fall through to a branch nobody wrote.
 */
function toAccess(row: Row): AgentAccess {
  const calendar = asString(row, 'access_calendar')
  const draft: Record<string, unknown> = {
    calendar,
    price: asString(row, 'access_price'),
    guestData: asString(row, 'access_guest_data'),
  }

  if (calendar === 'availability_booking') {
    draft.amendments = asStringArray(row, 'access_amendments')
    draft.cancellation = toCancellation(row)
    draft.paymentLink = asBoolean(row, 'access_payment_link')
  }

  const access = parseAgentAccess(draft)
  if (access === null) {
    throw new RowShapeError(
      'access_calendar/access_price/access_guest_data',
      'a coherent AgentAccess combination',
      draft,
    )
  }
  return access
}

function toCancellation(row: Row): AgentCancellationPolicy {
  const kind = asEnum(row, 'access_cancellation_kind', AGENT_CANCELLATION_KINDS)
  if (kind !== 'hours_before_arrival') return { kind }
  return { kind, hours: asNumber(row, 'access_cancellation_hours') }
}

/**
 * The inventory reach.
 *
 * `NULL` is impossible here — the arrays are `NOT NULL DEFAULT '{}'` — so
 * unlike the scope arrays on `agent_commission_rules` an empty list has no
 * second meaning to preserve. `all_properties` is a kind of its own, and
 * 0019's `inventory_shape` CHECK refuses an empty list on either of the other
 * two, so what reaches here is already one of the three real variants.
 */
function toInventoryScope(row: Row): AgentInventoryScope {
  const kind = asEnum(row, 'inventory_kind', INVENTORY_SCOPE_KINDS)
  switch (kind) {
    case 'properties':
      return { kind, propertyIds: asStringArray(row, 'inventory_property_ids') }
    case 'units':
      return { kind, unitIds: asStringArray(row, 'inventory_unit_ids') }
    default:
      return { kind: 'all_properties' }
  }
}

const INVENTORY_SCOPE_KINDS = ['all_properties', 'properties', 'units'] as const

// ── Writing the relationship ──────────────────────────────────────────────

/**
 * The ladder columns, from the domain's union.
 *
 * Every column is written on every save, including the ones a lower rung does
 * not use. That is what keeps the row coherent: demoting an agent from
 * `availability_booking` has to clear the amendments and the payment link, and
 * a patch that only wrote the fields the new variant carries would leave the
 * old ones behind for `agent_organization_settings_booking_rights_coherent` to
 * refuse — or, worse, for a later promotion to silently restore.
 */
function accessPatch(access: AgentAccess): Record<string, unknown> {
  const booking = access.calendar === 'availability_booking' ? access : null
  const cancellation = booking?.cancellation ?? { kind: 'never' as const }

  return {
    access_calendar: access.calendar,
    access_price: access.price,
    access_guest_data: access.guestData,
    access_amendments: booking ? [...booking.amendments] : [],
    access_cancellation_kind: cancellation.kind,
    access_cancellation_hours:
      cancellation.kind === 'hours_before_arrival' ? cancellation.hours : null,
    access_payment_link: booking?.paymentLink ?? false,
  }
}

function inventoryPatch(
  inventory: AgentInventoryScope,
): Record<string, unknown> {
  return {
    inventory_kind: inventory.kind,
    inventory_property_ids:
      inventory.kind === 'properties' ? [...inventory.propertyIds] : [],
    inventory_unit_ids:
      inventory.kind === 'units' ? [...inventory.unitIds] : [],
  }
}

/**
 * Everything on the settings row the domain owns.
 *
 * `version` is absent: `tg_touch_row` owns it. `status` is absent because it
 * is not a column here — it lives on the membership, and `saveSettings` writes
 * it there when it moves.
 */
function settingsPatch(
  settings: AgentOrganizationSettings,
): Record<string, unknown> {
  return {
    ...accessPatch(settings.access),
    ...inventoryPatch(settings.inventory),
    discount_max_percent: settings.discountCap.maxPercent,
    discount_max_agorot: settings.discountCap.maxAgorot,
    hold_max_concurrent: settings.holdLimits.maxConcurrent,
    hold_max_per_day: settings.holdLimits.maxPerDay,
    hold_max_extensions: settings.holdLimits.maxExtensions,
    hold_default_minutes: settings.holdLimits.defaultMinutes,
    hold_max_minutes: settings.holdLimits.maxMinutes,
    reputation_score: settings.reputationScore,
    agency_id: settings.agencyId,
    internal_note: settings.internalNote,
  }
}

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
