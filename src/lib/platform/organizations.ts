/**
 * EXECUTION CONTEXT — SERVER ONLY. The console's view of a customer account.
 *
 * ── What this reads, and what it deliberately does not ────────────────────
 *
 * Six tables: `organizations`, `organization_subscriptions`, `plans`,
 * `memberships`, `membership_roles`, `user_profiles`. That is the whole list,
 * and it matches the six SELECT policies 0041 adds for platform staff exactly.
 * There is no read here of a booking, a guest, a payment or a task, because a
 * console that could reach them is a console that eventually does.
 *
 * Usage is the one number that would have required more. Counting a customer's
 * properties and units means reading `properties` and `units`, which carry
 * addresses and unit names — so it is not read at all: 0041's
 * `platform_organization_usage()` returns three integers and the tables stay
 * shut. `storageGb` is missing from the result on purpose; nothing in this
 * database accounts for storage, and a fourth field holding `0` would be a
 * fabricated measurement of a real limit.
 *
 * ── Every read is scoped by the platform role and by nothing else ─────────
 *
 * No query below names a membership, and none of them could: a platform staff
 * member has none. The rows come back because
 * `has_platform_permission('platform.organization.view')` is true, which is
 * the single justification, stated once in the database and once here.
 */

import type { Db, Row } from '@/lib/persistence'
import {
  asEnum,
  asJsonRecord,
  asNumber,
  asString,
  asStringArray,
  asStringOrNull,
  asTimestampOrNull,
  toRows,
} from '@/lib/persistence'
import { ENTITLEMENTS, type Entitlement } from '@/lib/plans/entitlements'
import type { BillingInterval, SubscriptionStatus } from '@/lib/plans/plan'

/* ----------------------------------------------------------------- types -- */

/** `public.organization_status`, declared in 0001. */
export const ORGANIZATION_STATUSES = [
  'onboarding',
  'active',
  'suspended',
  'closed',
] as const

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number]

const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'paused',
  'cancelled',
] as const

const BILLING_INTERVALS = ['monthly', 'yearly'] as const

/**
 * The subscription as the console shows it.
 *
 * `agreedMonthlyAgorot` is the price this customer actually pays, not the
 * plan's current price. The two differ for every customer who signed up before
 * a price change, and the difference is the point of the column — see the
 * header of 0003. Showing the catalogue price beside their name would be
 * showing a number nobody is charged.
 */
export interface ConsoleSubscription {
  id: string
  planCode: string
  planName: string
  status: SubscriptionStatus
  interval: BillingInterval
  agreedMonthlyAgorot: number
  agreedYearlyAgorot: number
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  cancelledAt: string | null
  /** Entitlements the plan carries. */
  planEntitlements: readonly Entitlement[]
  /** Added for this customer specifically. */
  entitlementGrants: readonly Entitlement[]
  /** Withdrawn for this customer specifically. A revocation beats a grant. */
  entitlementRevocations: readonly Entitlement[]
  planLimits: Record<string, unknown>
  limitOverrides: Record<string, unknown>
}

export interface OrganizationSummary {
  id: string
  name: string
  slug: string
  status: OrganizationStatus
  businessType: string
  createdAt: string | null
  /**
   * `null` when the organization has no live subscription row.
   *
   * That is a real state and not a loading failure: `shellContext()` reports
   * it to the customer as `no_subscription`, and it is one of the things a
   * support console exists to notice. It is never filled in with a default.
   */
  subscription: ConsoleSubscription | null
}

/** What a package allows, counted. `storageGb` is absent — see the header. */
export interface OrganizationUsage {
  properties: number
  units: number
  members: number
}

export interface OrganizationOwner {
  userId: string
  membershipId: string
  displayName: string | null
  joinedAt: string | null
}

export interface OrganizationDetail extends OrganizationSummary {
  legalName: string | null
  country: string
  timezone: string
  currency: string
  locale: string
  /**
   * The members holding `organization_owner`, which is normally one person and
   * occasionally none — an organization whose owner was removed still exists,
   * and the console is where that is noticed.
   */
  owners: readonly OrganizationOwner[]
  activeMembers: number
}

/* -------------------------------------------------------------- the reads -- */

const ORGANIZATION_COLUMNS =
  'id, name, slug, status, business_type, legal_name, country, timezone, ' +
  'currency, locale, created_at'

/**
 * Every customer account, newest first.
 *
 * Ordered by creation rather than by name because the question this list
 * answers on most days is "who signed up", and a Hebrew alphabetical sort is
 * the wrong default for a list somebody scans for what changed.
 */
export async function listPlatformOrganizations(
  db: Db,
): Promise<readonly OrganizationSummary[]> {
  const { data, error } = await db
    .from('organizations')
    .select(ORGANIZATION_COLUMNS)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) throw new Error(error.message)

  const rows = toRows(data)
  const subscriptions = await loadSubscriptions(
    db,
    rows.map((row) => asString(row, 'id')),
  )

  return rows.map((row) => ({
    ...summary(row),
    subscription: subscriptions.get(asString(row, 'id')) ?? null,
  }))
}

/** One account, in full. `null` when there is no such organization. */
export async function loadPlatformOrganization(
  db: Db,
  organizationId: string,
): Promise<OrganizationDetail | null> {
  const { data, error } = await db
    .from('organizations')
    .select(ORGANIZATION_COLUMNS)
    .eq('id', organizationId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) return null

  // `as unknown as Row` rather than `as Row`: PostgREST types a single-row
  // result as a union that includes its own error shape, and TypeScript is
  // right to refuse the direct cast. Every column is mapped explicitly below,
  // so a row that is not the shape assumed surfaces as a `RowShapeError`
  // naming the column rather than as `undefined` three screens away.
  const row = data as unknown as Row
  const [subscriptions, owners, activeMembers] = await Promise.all([
    loadSubscriptions(db, [organizationId]),
    loadOwners(db, organizationId),
    countActiveMembers(db, organizationId),
  ])

  return {
    ...summary(row),
    subscription: subscriptions.get(organizationId) ?? null,
    legalName: asStringOrNull(row, 'legal_name'),
    country: asString(row, 'country'),
    timezone: asString(row, 'timezone'),
    currency: asString(row, 'currency'),
    locale: asString(row, 'locale'),
    owners,
    activeMembers,
  }
}

/**
 * Properties, units and active members.
 *
 * Through the definer function, which returns no row at all when the caller is
 * not platform staff. `null` therefore means "refused or unavailable" and is
 * rendered as unknown rather than as zero — a usage panel reading `0 / 5` for
 * a customer with four properties is a number somebody would act on.
 */
export async function loadOrganizationUsage(
  db: Db,
  organizationId: string,
): Promise<OrganizationUsage | null> {
  const { data, error } = await db.rpc('platform_organization_usage', {
    target_organization_id: organizationId,
  })

  if (error) return null

  // A `returns table (...)` function comes back as an array of one row through
  // PostgREST, and as the row itself through some clients. Both are handled
  // rather than assumed, because guessing wrong here produces `null` — which
  // this function's contract says means "unknown", and which the screen then
  // renders as an honest "not measured" for an account that is measured fine.
  const rows = Array.isArray(data) ? (data as unknown[]) : [data]
  const row = rows[0] as Row | null | undefined
  if (!row || typeof row !== 'object') return null

  return {
    properties: asNumber(row, 'properties'),
    units: asNumber(row, 'units'),
    members: asNumber(row, 'members'),
  }
}

/* ------------------------------------------------------------- internals -- */

function summary(row: Row): Omit<OrganizationSummary, 'subscription'> {
  return {
    id: asString(row, 'id'),
    name: asString(row, 'name'),
    slug: asString(row, 'slug'),
    status: asEnum(row, 'status', ORGANIZATION_STATUSES),
    businessType: asString(row, 'business_type'),
    createdAt: asTimestampOrNull(row, 'created_at'),
  }
}

/**
 * Subscriptions and their plans, for a set of organizations.
 *
 * Two queries and a join in memory rather than a PostgREST embed. The embed
 * would work; it would also make the plan's absence — a subscription pointing
 * at a plan the console cannot read — indistinguishable from a subscription
 * that is not there, and those are different problems.
 */
async function loadSubscriptions(
  db: Db,
  organizationIds: readonly string[],
): Promise<Map<string, ConsoleSubscription>> {
  const result = new Map<string, ConsoleSubscription>()
  if (organizationIds.length === 0) return result

  const { data, error } = await db
    .from('organization_subscriptions')
    .select(
      'id, organization_id, plan_id, status, billing_interval, ' +
        'agreed_monthly_price_agorot, agreed_yearly_price_agorot, ' +
        'trial_ends_at, current_period_end, cancelled_at, ' +
        'limit_overrides, entitlement_grants, entitlement_revocations',
    )
    .in('organization_id', [...organizationIds])
    .is('deleted_at', null)

  if (error) throw new Error(error.message)

  const rows = toRows(data)
  const plans = await loadPlans(
    db,
    rows.map((row) => asString(row, 'plan_id')),
  )

  for (const row of rows) {
    const plan = plans.get(asString(row, 'plan_id'))

    result.set(asString(row, 'organization_id'), {
      id: asString(row, 'id'),
      // A subscription whose plan did not come back is shown by its id, not by
      // a made-up name. It is a broken row and the console should say so.
      planCode: plan?.code ?? '—',
      planName: plan?.name ?? `חבילה שלא נטענה (${asString(row, 'plan_id')})`,
      status: asEnum(row, 'status', SUBSCRIPTION_STATUSES),
      interval: asEnum(row, 'billing_interval', BILLING_INTERVALS),
      agreedMonthlyAgorot: asNumber(row, 'agreed_monthly_price_agorot'),
      agreedYearlyAgorot: asNumber(row, 'agreed_yearly_price_agorot'),
      trialEndsAt: asTimestampOrNull(row, 'trial_ends_at'),
      currentPeriodEnd: asTimestampOrNull(row, 'current_period_end'),
      cancelledAt: asTimestampOrNull(row, 'cancelled_at'),
      planEntitlements: plan?.entitlements ?? [],
      entitlementGrants: knownEntitlements(row, 'entitlement_grants'),
      entitlementRevocations: knownEntitlements(row, 'entitlement_revocations'),
      planLimits: plan?.limits ?? {},
      limitOverrides: asJsonRecord(row, 'limit_overrides'),
    })
  }

  return result
}

type PlanRow = {
  code: string
  name: string
  entitlements: readonly Entitlement[]
  limits: Record<string, unknown>
}

async function loadPlans(
  db: Db,
  planIds: readonly string[],
): Promise<Map<string, PlanRow>> {
  const result = new Map<string, PlanRow>()
  const unique = [...new Set(planIds)]
  if (unique.length === 0) return result

  const { data, error } = await db
    .from('plans')
    .select('id, code, name, entitlements, limits')
    .in('id', unique)

  if (error) throw new Error(error.message)

  for (const row of toRows(data)) {
    result.set(asString(row, 'id'), {
      code: asString(row, 'code'),
      name: asString(row, 'name'),
      entitlements: knownEntitlements(row, 'entitlements'),
      limits: asJsonRecord(row, 'limits'),
    })
  }

  return result
}

/**
 * A stored feature list, narrowed to the names the product knows.
 *
 * The database's CHECK constraints already refuse an unknown entitlement, so
 * this filter should never drop anything. It exists so that if one ever does
 * appear — a constraint dropped in a hurry, a restore from an older schema —
 * the console shows the features it understands rather than rendering a string
 * the reader would take for a real capability.
 */
function knownEntitlements(row: Row, column: string): readonly Entitlement[] {
  const known = ENTITLEMENTS as readonly string[]
  return asStringArray(row, column).filter((value): value is Entitlement =>
    known.includes(value),
  )
}

/** The members holding `organization_owner`. Normally one; occasionally none. */
async function loadOwners(
  db: Db,
  organizationId: string,
): Promise<readonly OrganizationOwner[]> {
  const { data, error } = await db
    .from('membership_roles')
    .select('membership_id, role_id, roles!inner(code)')
    .eq('organization_id', organizationId)

  if (error) return []

  const ownerMembershipIds = toRows(data)
    .filter((row) => {
      const role = (row as { roles?: { code?: unknown } | null }).roles
      return role?.code === 'organization_owner'
    })
    .map((row) => asString(row, 'membership_id'))

  if (ownerMembershipIds.length === 0) return []

  const { data: memberships, error: membershipError } = await db
    .from('memberships')
    .select('id, user_id, joined_at')
    .in('id', ownerMembershipIds)

  if (membershipError) return []

  const rows = toRows(memberships)
  const names = await loadDisplayNames(
    db,
    rows.map((row) => asString(row, 'user_id')),
  )

  return rows.map((row) => ({
    membershipId: asString(row, 'id'),
    userId: asString(row, 'user_id'),
    displayName: names.get(asString(row, 'user_id')) ?? null,
    joinedAt: asTimestampOrNull(row, 'joined_at'),
  }))
}

async function countActiveMembers(
  db: Db,
  organizationId: string,
): Promise<number> {
  const { count, error } = await db
    .from('memberships')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'active')

  if (error || count === null || count === undefined) return 0
  return count
}

/**
 * Names for a set of users.
 *
 * Exported because the people screen needs exactly the same lookup, and two
 * copies of a query that reads a table the console is careful about is two
 * places to widen it by accident.
 */
export async function loadDisplayNames(
  db: Db,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return result

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name')
    .in('id', unique)

  if (error) return result

  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name && name.trim() !== '') result.set(asString(row, 'id'), name)
  }

  return result
}
