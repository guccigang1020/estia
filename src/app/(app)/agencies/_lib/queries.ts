/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the agencies screen.
 *
 * ── An agency is not a tenant, and this file is shaped by that ────────────
 *
 * `agencies` carries no `organization_id`, deliberately: a holiday agency sells
 * for several businesses at once and cannot be a sub-record of any one of them.
 * `agency.ts` says so, and `0015` had to write that table's RLS policy by hand
 * for exactly this reason.
 *
 * The consequence for a *read* is the one thing that is easy to get wrong. The
 * list cannot start from `agencies` — there is no tenant column to filter on,
 * and a query without one is the shape of a cross-tenant read even where the
 * policy would refuse it. So it starts from `agency_agreements`, which is the
 * per-organization half: the agreements this business has, and then the
 * agencies those agreements name. An agency with no agreement here is not this
 * business's agency and does not appear.
 *
 * ── Liveness is computed, never read off the status ───────────────────────
 *
 * `isAgreementActive` decides against the date every time it is asked, because
 * an agreement whose end date passed last night is over whether or not a job has
 * run to say so. The status column alone would let a background job that stopped
 * running keep granting reach it was supposed to remove. So the screen shows the
 * stored status *and* the computed answer, and they are allowed to differ — a
 * terminated agreement with a future end date is a notice period, which is
 * normal and is not a contradiction.
 *
 * ── Money ─────────────────────────────────────────────────────────────────
 *
 * Integer agorot, and nothing here computes a commission. The agreement's rule
 * is read whole through `toCommissionRule`-shaped mapping and rendered; what an
 * agency is actually owed comes from `commissions`, which stores figures that
 * were computed from a snapshotted rule at the time. Applying today's rule to
 * last quarter's stays would produce a number that disagrees with the ledger.
 */

import { can, holdsGrant, type Actor, type Resource } from '@/lib/authz/can'
import {
  COMMISSION_BASES,
  COMMISSION_STATUSES,
  type CommissionBase,
  type CommissionStatus,
} from '@/lib/contracts/states'
import { sumAgorot } from '@/lib/finance'
import {
  isAgreementActive,
  type AgencyAgreement,
  type CommissionRule,
} from '@/lib/agents'
import {
  asAgorot,
  asEnum,
  asIsoDate,
  asIsoDateOrNull,
  asJsonRecord,
  asNumber,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shared -- */

export const AGENCY_PAGE_SIZE = 100

/**
 * The resource an authorization question about an agency is asked about.
 *
 * `family: 'team'` — the same family the agent settings use, because an agency
 * is the commercial counterparty of a *relationship with people*, not a piece
 * of inventory and not a financial document. No property is carried: an agency
 * agreement is organization-wide, so a property-scoped membership does not reach
 * it, which is the correct answer and the reason `can()` is asked at all.
 */
function agencyResource(organizationId: string): Resource {
  return { organizationId, family: 'team' }
}

/* ------------------------------------------------------------ the shapes -- */

/** The commercial terms, as the agreement stores them. */
export type AgreementTerms = {
  id: string
  agencyId: string
  /**
   * The commission the agency negotiated, as the domain's own union.
   *
   * `CommissionRule` from `agents/commission.ts` has four members —
   * `none`, `percentage`, `fixed`, `tiered` — and `none` is a real arrangement
   * that is not the same as zero. Rebuilding it through `toRule` below rather
   * than casting the JSON is the difference between a screen that renders a
   * misconfigured row as "no commission" and one that says the row is
   * unreadable.
   */
  rule: CommissionRule | null
  base: CommissionBase
  activeFrom: string
  activeUntil: string | null
  paymentTermsDays: number
  status: string
  signedOn: string | null
  terminatedOn: string | null
  terminationReason: string | null
  note: string | null
  /**
   * Whether it is live **today**, computed rather than read.
   *
   * See the header: the status column and this can honestly differ, and the
   * screen renders both.
   */
  live: boolean
}

export type AgencyMember = {
  userId: string
  displayName: string | null
  role: string
  status: string
  joinedOn: string
  leftOn: string | null
}

export type AgencyListItem = {
  id: string
  name: string
  taxId: string | null
  contactPhoneE164: string | null
  contactEmail: string | null
  status: string
  note: string | null
  agreements: readonly AgreementTerms[]
  /**
   * The people selling under this agency's banner, or `null` when this reader
   * may not see the organization's members at all.
   *
   * `null` and an empty list are different answers and the screen says so
   * differently: "this agency has nobody selling for you" versus "there are
   * people here and you may not see who". Collapsing the two would tell a
   * reader an agency is dormant because of their own permissions.
   */
  members: readonly AgencyMember[] | null
  /**
   * What this business owes the agency's sellers, across every commission that
   * names it. `null` without `commission.view` — never zero, which would be a
   * false statement about money.
   */
  owedAgorot: number | null
  unpaidAgorot: number | null
  commissionCount: number
}

/* ------------------------------------------------------------- the query -- */

/**
 * The agencies this business works with, and on what terms.
 *
 * Starts from `agency_agreements`, for the reason in the header. One further
 * query per related table rather than an embed: `agency_agreements.agencies` is
 * not declared in `RELATIONS`, and declaring an embed is a change to a file this
 * module treats as read-only — three `in()` lookups over at most a page of ids
 * are cheaper than the embed would have been anyway.
 */
export async function listAgencies(args: {
  db: Db
  actor: Actor
  organizationId: string
  /** Today, as an ISO date. Injected so the liveness rule is testable. */
  on: string
  limit?: number
}): Promise<readonly AgencyListItem[]> {
  const { db, actor, organizationId, on } = args

  // The permission floor. `agency.manage` is the grant the menu gates the
  // screen on and is mapped to `agent_network`; asked here again per read
  // rather than trusted from the route.
  if (!can(actor, 'agency.manage', agencyResource(organizationId))) return []

  const { data, error } = await db
    .from('agency_agreements')
    .select(AGREEMENT_COLUMNS)
    .eq('organization_id', organizationId)
    .order('active_from', { ascending: false })
    .limit(args.limit ?? AGENCY_PAGE_SIZE)

  if (error) throw error

  const agreementRows = toRows(data)
  const agencyIds = [
    ...new Set(agreementRows.map((row) => asString(row, 'agency_id'))),
  ]
  if (agencyIds.length === 0) return []

  const [agencyRows, members, money] = await Promise.all([
    agencyRecords(db, agencyIds),
    agencyMembers(db, actor, organizationId, agencyIds),
    agencyMoney(db, actor, organizationId, agencyIds),
  ])

  return agencyIds
    .map((agencyId) => {
      const record = agencyRows.get(agencyId)
      // An agreement naming an agency row this reader cannot read. The
      // agreement is real and the counterparty is not nameable, which is a row
      // somebody should look at rather than one to drop silently.
      const name = record === undefined ? null : asString(record, 'name')
      const totals = money?.get(agencyId) ?? null

      const item: AgencyListItem = {
        id: agencyId,
        name: name ?? 'סוכנות שאינה גלויה לך',
        taxId: record ? asStringOrNull(record, 'tax_id') : null,
        contactPhoneE164: record
          ? asStringOrNull(record, 'contact_phone_e164')
          : null,
        contactEmail: record ? asStringOrNull(record, 'contact_email') : null,
        status: record ? asString(record, 'status') : 'unknown',
        note: record ? asStringOrNull(record, 'note') : null,
        agreements: agreementRows
          .filter((row) => asString(row, 'agency_id') === agencyId)
          .map((row) => toTerms(row, on)),
        members: members === null ? null : (members.get(agencyId) ?? []),
        owedAgorot: totals?.owedAgorot ?? null,
        unpaidAgorot: totals?.unpaidAgorot ?? null,
        commissionCount: totals?.count ?? 0,
      }

      return item
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'he'))
}

/** How many agreements exist, for the empty-state decision. */
export async function countAgreements(
  db: Db,
  organizationId: string,
): Promise<number> {
  const { count, error } = await db
    .from('agency_agreements')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)

  if (error) throw error
  return count ?? 0
}

/* --------------------------------------------------------------- pieces -- */

const AGREEMENT_COLUMNS =
  'id, agency_id, organization_id, rule, base, active_from, active_until, ' +
  'payment_terms_days, status, signed_at, terminated_at, termination_reason, ' +
  'note, created_at, version'

/**
 * The agreement's terms, and whether it is live today.
 *
 * `isAgreementActive` is the domain's own function, given a value built to its
 * own interface. Reimplementing "status is active and today is inside the
 * window" here would be a second definition of a rule that decides whether an
 * agency may sell — and the two would disagree the first time somebody changed
 * one of them.
 */
function toTerms(row: Row, on: string): AgreementTerms {
  const rule = toRule(asJsonRecord(row, 'rule'))

  const agreement: AgencyAgreement = {
    id: asString(row, 'id'),
    agencyId: asString(row, 'agency_id'),
    organizationId: asString(row, 'organization_id'),
    // A rule that could not be rebuilt becomes `{ kind: 'none' }` *for the
    // liveness question only* — `isAgreementActive` reads the status and the
    // dates and never the rule, so this substitution cannot change its answer.
    // What the screen renders is `rule` below, which stays null and says so.
    rule: rule ?? { kind: 'none' },
    base: asEnum(row, 'base', COMMISSION_BASES),
    activeFrom: asIsoDate(row, 'active_from'),
    activeUntil: asIsoDateOrNull(row, 'active_until'),
    paymentTermsDays: asNumber(row, 'payment_terms_days'),
    status: asEnum(row, 'status', AGREEMENT_STATUS_VALUES),
    signedAt: asTimestampOrNull(row, 'signed_at'),
    createdAt: asTimestamp(row, 'created_at'),
    version: asNumber(row, 'version'),
  }

  return {
    id: agreement.id,
    agencyId: agreement.agencyId,
    rule,
    base: agreement.base,
    activeFrom: agreement.activeFrom,
    activeUntil: agreement.activeUntil,
    paymentTermsDays: agreement.paymentTermsDays,
    status: agreement.status,
    signedOn: agreement.signedAt,
    terminatedOn: asTimestampOrNull(row, 'terminated_at'),
    terminationReason: asStringOrNull(row, 'termination_reason'),
    note: asStringOrNull(row, 'note'),
    live: isAgreementActive(agreement, on),
  }
}

const AGREEMENT_STATUS_VALUES = ['draft', 'active', 'terminated'] as const

/**
 * The stored rule, rebuilt through the union rather than cast into it.
 *
 * `SupabaseAgentRepository.toCommissionRuleRecord` casts the same JSON with
 * `as unknown as CommissionRule`, which is a claim the data has not earned: a
 * row written before a rule kind existed, or repaired by hand in a console,
 * becomes a value with a `kind` no `switch` downstream has a branch for. That
 * is tolerable inside an adapter feeding a domain function that will refuse the
 * shape anyway; it is not tolerable on a screen, where the fallthrough renders
 * as a blank commission beside a live agreement.
 *
 * So this returns `null` for anything it does not recognise, and the screen
 * says the terms are unreadable rather than showing nothing where a percentage
 * belongs. `tiered` is carried whole because the tiers are the rule.
 */
function toRule(raw: Record<string, unknown>): CommissionRule | null {
  switch (raw.kind) {
    case 'none':
      return { kind: 'none' }
    case 'percentage':
      return typeof raw.percent === 'number'
        ? { kind: 'percentage', percent: raw.percent }
        : null
    case 'fixed':
      return typeof raw.amountAgorot === 'number' &&
        Number.isInteger(raw.amountAgorot)
        ? { kind: 'fixed', amountAgorot: raw.amountAgorot }
        : null
    case 'tiered':
      // Not reconstructed field by field: a tier list is the whole rule and a
      // partial rebuild would be a different commercial arrangement. It is
      // recognised or refused.
      return isTiered(raw) ? (raw as unknown as CommissionRule) : null
    default:
      return null
  }
}

function isTiered(raw: Record<string, unknown>): boolean {
  if (typeof raw.mode !== 'string') return false
  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) return false
  return raw.tiers.every(
    (tier) =>
      typeof tier === 'object' &&
      tier !== null &&
      typeof (tier as Record<string, unknown>).percent === 'number',
  )
}

/**
 * The agency rows behind the agreements.
 *
 * No `organization_id` filter, and there cannot be one — the table has no such
 * column. What confines this is the id list, every entry of which came off an
 * agreement row belonging to this organization, and `agencies_select`
 * underneath. A row the policy refuses simply does not come back, and the
 * caller renders "an agency not visible to you" rather than dropping the
 * agreement.
 */
async function agencyRecords(
  db: Db,
  agencyIds: readonly string[],
): Promise<ReadonlyMap<string, Row>> {
  const { data, error } = await db
    .from('agencies')
    .select('id, name, tax_id, contact_phone_e164, contact_email, status, note')
    .in('id', [...agencyIds])

  if (error) throw error

  const rows = new Map<string, Row>()
  for (const row of toRows(data)) rows.set(asString(row, 'id'), row)
  return rows
}

/**
 * Who sells under each agency's banner.
 *
 * `agency_memberships` is global — a person is a member of the agency, and the
 * agency's agreements decide which businesses that reaches — so the read is by
 * agency id and not by organization. `null` when this reader may not see the
 * organization's people at all, which is a different sentence from "nobody".
 *
 * The names come from `user_profiles`, which every member may read for somebody
 * who shares an organization with them. A person in the agency who is *not* in
 * this organization therefore has no name here, and stays null rather than
 * being filled with a uuid — which is correct: they are the agency's employee
 * and not this business's.
 */
async function agencyMembers(
  db: Db,
  actor: Actor,
  organizationId: string,
  agencyIds: readonly string[],
): Promise<ReadonlyMap<string, AgencyMember[]> | null> {
  if (!can(actor, 'agency.manage', agencyResource(organizationId))) return null

  const { data, error } = await db
    .from('agency_memberships')
    .select('agency_id, user_id, role, status, joined_at, left_at')
    .in('agency_id', [...agencyIds])

  if (error) throw error

  const rows = toRows(data)
  const names = await profileNames(
    db,
    rows.map((row) => asString(row, 'user_id')),
  )

  const byAgency = new Map<string, AgencyMember[]>()
  for (const row of rows) {
    const agencyId = asString(row, 'agency_id')
    const userId = asString(row, 'user_id')
    const list = byAgency.get(agencyId) ?? []
    list.push({
      userId,
      displayName: names.get(userId) ?? null,
      role: asString(row, 'role'),
      status: asString(row, 'status'),
      joinedOn: asTimestamp(row, 'joined_at'),
      leftOn: asTimestampOrNull(row, 'left_at'),
    })
    byAgency.set(agencyId, list)
  }
  return byAgency
}

async function profileNames(
  db: Db,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name')
    .in('id', unique)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}

/**
 * What is owed per agency, from the commissions ledger.
 *
 * **`agency_id` on a commission is a real commercial fact, not a schema
 * accident.** `commissions_has_a_payee` requires an agent *or* an agency,
 * because an agency keeps the relationship when the individual leaves — so a
 * commission with `agent_user_id = null` is money owed to a company, and this
 * read finds it by the agency alone. Grouping by the person would lose exactly
 * the rows the agencies screen exists to show.
 *
 * `null` without `commission.view`, and never zero.
 */
type AgencyMoney = {
  owedAgorot: number
  unpaidAgorot: number
  count: number
}

async function agencyMoney(
  db: Db,
  actor: Actor,
  organizationId: string,
  agencyIds: readonly string[],
): Promise<ReadonlyMap<string, AgencyMoney> | null> {
  if (!holdsGrant(actor, 'commission.view')) return null

  const { data, error } = await db
    .from('commissions')
    .select('id, agency_id, property_id, status, amount_agorot')
    .eq('organization_id', organizationId)
    .in('agency_id', [...agencyIds])

  if (error) throw error

  const totals = new Map<string, { owed: number[]; unpaid: number[] }>()

  for (const row of toRows(data)) {
    // The same per-row narrowing the commissions list applies. An agent scoped
    // to one property contributes only their own property's rows to the total,
    // which is what makes the figure true for the person reading it.
    if (
      !can(actor, 'commission.view', {
        organizationId,
        propertyId: asString(row, 'property_id'),
        family: 'finance',
      })
    ) {
      continue
    }

    const agencyId = asStringOrNull(row, 'agency_id')
    if (agencyId === null) continue

    const amount = asAgorot(row, 'amount_agorot')
    const status: CommissionStatus = asEnum(row, 'status', COMMISSION_STATUSES)
    const bucket = totals.get(agencyId) ?? { owed: [], unpaid: [] }
    bucket.owed.push(amount)
    if (status !== 'paid' && status !== 'cancelled') bucket.unpaid.push(amount)
    totals.set(agencyId, bucket)
  }

  const money = new Map<string, AgencyMoney>()
  for (const [agencyId, bucket] of totals) {
    money.set(agencyId, {
      owedAgorot: sumAgorot(bucket.owed),
      unpaidAgorot: sumAgorot(bucket.unpaid),
      count: bucket.owed.length,
    })
  }
  return money
}
