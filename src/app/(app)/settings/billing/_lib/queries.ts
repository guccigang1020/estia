/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the billing screen.
 *
 * ── The plan is loaded through `ActorSource`, not read off the row ────────
 *
 * `organization_subscriptions` joined to `plans` is the obvious query and it is
 * the wrong one here. `SupabaseActorSource.loadPlan` already issues exactly
 * that query, applies `deleted_at is null` and `status <> 'cancelled'`, and
 * hands back an `EffectivePlan` — and in demo mode `DemoActorSource` wraps it
 * and substitutes the package the switcher names. A screen that read the row
 * directly would show `pro` while the switcher said `basic`, which is the demo
 * contradicting its own caption on the one screen whose entire subject is which
 * package the business is on.
 *
 * So this file takes an `ActorSource` rather than a `Db` for that one read. It
 * is also what makes the whole thing testable: the test constructs the same
 * `DemoActorSource(new SupabaseActorSource(client()), plan)` the shell does.
 *
 * ── Entitlements and limits come from the domain, never from the plan row ─
 *
 * `effectiveEntitlements` and `effectiveLimits` in `src/lib/plans/plan.ts`
 * apply the per-customer grants, revocations and overrides — and
 * `effectiveLimits` has a comment explaining that a naive spread copies an
 * `undefined` over a real figure and produces a permanent overage, which for
 * members and storage *blocks the action outright*. Recomputing any of that
 * here would be reintroducing that bug in a second place. Nothing below
 * subtracts, divides or compares a limit; `checkQuota` does.
 *
 * ── The distinction this screen exists to draw ────────────────────────────
 *
 * `QUOTA_BLOCKS_ACTION` says which quotas refuse and which merely warn, and
 * `quota.ts` gives the test for membership: would refusing it stop the business
 * serving a guest today? Properties and units warn — a business that cannot
 * check a guest in because it added a fifteenth unit cancels that afternoon.
 * Members and storage block, because inviting a colleague can wait.
 *
 * Those are genuinely different sentences and the screen prints them
 * differently. `QuotaLine` therefore carries `blocks` alongside `state` rather
 * than leaving a component to look the answer up, and the wording for each is
 * chosen once, here, in `describeQuota`.
 *
 * ── One quota cannot be measured at all, and says so ──────────────────────
 *
 * `storageGb` is a limit in every package and there is no storage table, no
 * bytes column and no upload path in the schema. Reporting `0` would tell a
 * customer they have used none of their allowance, which is a claim this
 * product cannot make. It is reported as unmeasured — a finding, not a figure.
 */

import type { ActorSource } from '@/lib/actor'
import type { Entitlement, PlanLimits } from '@/lib/plans/entitlements'
import { ENTITLEMENTS } from '@/lib/plans/entitlements'
import {
  agreedPrice,
  effectiveEntitlements,
  effectiveLimits,
  isGrandfathered,
  type EffectivePlan,
} from '@/lib/plans/plan'
import {
  QUOTA_BLOCKS_ACTION,
  checkQuota,
  isBlockedByQuota,
  type QuotaKey,
  type QuotaState,
} from '@/lib/plans/quota'
import {
  asBoolean,
  asJsonRecord,
  asNumber,
  asString,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

/* ----------------------------------------------------------------- plan -- */

/**
 * The organization's live subscription and the package behind it.
 *
 * `null` is a real state: `no_subscription` is one of the four `ShellContext`
 * statuses and the dashboard has a screen for it. It reaches here only if a
 * subscription disappears mid-request, and the screen says so rather than
 * rendering an empty package.
 */
export async function loadEffectivePlan(
  source: ActorSource,
  organizationId: string,
): Promise<EffectivePlan | null> {
  return source.loadPlan(organizationId)
}

/* ---------------------------------------------------------------- usage -- */

/**
 * What the organization is actually using, per quota.
 *
 * `null` means the product cannot measure it — which is a different answer from
 * zero and must render differently. Today exactly one key is null and it is
 * `storageGb`; see the header.
 */
export type Usage = Readonly<Record<QuotaKey, number | null>>

/**
 * Count what the limits are about.
 *
 * Three `head` counts, so the page costs no rows. Each is deliberately the same
 * population the limit is written about:
 *
 *   · `properties` — not soft-deleted. A closed property is not occupying an
 *     allowance.
 *   · `units` — not soft-deleted, across every property in the organization.
 *     Not narrowed by the shell's property switcher: a quota is a fact about
 *     the *organization*, and narrowing it would tell an owner looking at one
 *     villa that they are well within a limit they have already passed.
 *   · `members` — `status = 'active'`. An invitation that has not been accepted
 *     is not a seat, and a removed member is not one either.
 *
 * Row level security still applies, so a reader who cannot see the units cannot
 * count them — which is fine, because `organization.billing.manage` is an
 * owner-level grant and the route already demands it.
 */
export async function loadUsage(
  db: Db,
  organizationId: string,
): Promise<Usage> {
  const [properties, units, members] = await Promise.all([
    countRows(db, 'properties', organizationId, true),
    countRows(db, 'units', organizationId, true),
    activeMemberCount(db, organizationId),
  ])

  return {
    properties,
    units,
    members,
    // Not zero. There is no storage table, no bytes column and no upload path
    // in any migration, so the product has nothing to count. Saying "0 GB used"
    // would be a claim it cannot support.
    storageGb: null,
  }
}

async function countRows(
  db: Db,
  table: 'properties' | 'units',
  organizationId: string,
  excludeDeleted: boolean,
): Promise<number> {
  let query = db
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)

  if (excludeDeleted) query = query.is('deleted_at', null)

  const { count, error } = await query
  if (error) throw error
  return count ?? 0
}

async function activeMemberCount(
  db: Db,
  organizationId: string,
): Promise<number> {
  const { count, error } = await db
    .from('memberships')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'active')

  if (error) throw error
  return count ?? 0
}

/* --------------------------------------------------------------- quotas -- */

export type QuotaLine = {
  key: QuotaKey
  /** `null` when the product cannot measure this one. */
  state: QuotaState | null
  /**
   * Whether crossing this line refuses an action or only warns.
   *
   * Carried on the line rather than looked up by a component, so the two
   * sentences are chosen in one place. `QUOTA_BLOCKS_ACTION` is the source.
   */
  blocks: boolean
  /** True only when over the allowance *and* the quota blocks. */
  blocked: boolean
  /** Why the state cannot be computed, when it cannot. */
  unmeasuredReason?: string
}

/** Rendered in this order: the two that only warn, then the two that refuse. */
export const QUOTA_ORDER: readonly QuotaKey[] = [
  'properties',
  'units',
  'members',
  'storageGb',
]

/**
 * Every quota, with its state and with what crossing it costs.
 *
 * `limits` is `effectiveLimits(plan)` — the plan's, after the customer's own
 * overrides — and is passed in rather than derived here so the caller cannot
 * accidentally compare usage against the list price of a package this customer
 * negotiated away from.
 */
export function quotaLines(
  usage: Usage,
  limits: PlanLimits,
): readonly QuotaLine[] {
  return QUOTA_ORDER.map((key): QuotaLine => {
    const current = usage[key]

    if (current === null) {
      return {
        key,
        state: null,
        blocks: QUOTA_BLOCKS_ACTION[key],
        blocked: false,
        unmeasuredReason:
          'אין במסד טבלת אחסון, עמודת נפח או מסלול העלאה — ולכן אין מה למדוד. ' +
          'הצגת ״0 מתוך המכסה״ הייתה טענה שהמוצר אינו יכול לגבות.',
      }
    }

    const state = checkQuota(key, current, limits)
    return {
      key,
      state,
      blocks: QUOTA_BLOCKS_ACTION[key],
      blocked: isBlockedByQuota(state),
    }
  })
}

/** Any quota that is already refusing an action. The screen leads with these. */
export function blockedQuotas(
  lines: readonly QuotaLine[],
): readonly QuotaLine[] {
  return lines.filter((line) => line.blocked)
}

/** Any quota that is over the line but does not refuse. A different sentence. */
export function warningQuotas(
  lines: readonly QuotaLine[],
): readonly QuotaLine[] {
  return lines.filter(
    (line) => line.state !== null && line.state.inOverage && !line.blocked,
  )
}

/** Any quota that is close but not over. Told before it is crossed. */
export function approachingQuotas(
  lines: readonly QuotaLine[],
): readonly QuotaLine[] {
  return lines.filter((line) => line.state?.approaching === true)
}

/* ------------------------------------------------------------ the offer -- */

/**
 * A package on offer, read from `plans` at runtime.
 *
 * Deliberately not `SEED_PLANS`. That file opens by saying nothing in the
 * product reads it at runtime: it seeds a fresh installation and then stops
 * being the source of truth, because a platform administrator edits names,
 * prices, limits and features in the back office. Comparing this customer's
 * package against a hard-coded catalogue would show them an upgrade that no
 * longer exists at a price nobody charges.
 *
 * `plans_select` admits every public plan to any authenticated user, plus the
 * non-public one this organization is actually on — so the query is exactly
 * "what could we move to", answered by the database.
 */
export type OfferedPlan = {
  id: string
  code: string
  name: string
  description: string
  monthlyPriceAgorot: number
  yearlyPriceAgorot: number
  limits: PlanLimits
  entitlements: readonly Entitlement[]
  sortOrder: number
}

export async function listOfferedPlans(
  db: Db,
): Promise<readonly OfferedPlan[]> {
  const { data, error } = await db
    .from('plans')
    .select(
      'id, code, name, description, monthly_price_agorot, ' +
        'yearly_price_agorot, limits, entitlements, is_public, sort_order',
    )
    .is('deleted_at', null)
    .eq('is_public', true)
    .order('sort_order', { ascending: true })

  if (error) throw error

  return toRows(data)
    .filter((row) => asBoolean(row, 'is_public'))
    .map((row): OfferedPlan => ({
      id: asString(row, 'id'),
      code: asString(row, 'code'),
      name: asString(row, 'name'),
      description: asString(row, 'description'),
      monthlyPriceAgorot: asNumber(row, 'monthly_price_agorot'),
      yearlyPriceAgorot: asNumber(row, 'yearly_price_agorot'),
      limits: readLimits(row),
      entitlements: readEntitlements(row),
      sortOrder: asNumber(row, 'sort_order'),
    }))
}

/**
 * `limits` is `jsonb`, so every key is read and defended individually.
 *
 * A missing key becomes `null`, which `checkQuota` reads as "unlimited". That
 * is the safe direction for a *limit*: an unreadable ceiling that defaulted to
 * zero would put every customer permanently in overage, and for members and
 * storage that blocks the action outright.
 */
function readLimits(row: Row): PlanLimits {
  const raw = asJsonRecord(row, 'limits')
  const read = (key: QuotaKey): number | null => {
    const value = raw[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  return {
    properties: read('properties'),
    units: read('units'),
    members: read('members'),
    storageGb: read('storageGb'),
  }
}

/**
 * `entitlements` is a text array, and an unknown member is dropped.
 *
 * A plan row naming a feature this build has never heard of is a deployment
 * running ahead of its code. Rendering the raw string would put `owner_portal2`
 * on a Hebrew comparison table; dropping it understates the package, which is
 * the direction that cannot mis-sell.
 */
const KNOWN_ENTITLEMENTS = new Set<string>(ENTITLEMENTS)

function readEntitlements(row: Row): readonly Entitlement[] {
  const raw = row.entitlements
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (value): value is Entitlement =>
      typeof value === 'string' && KNOWN_ENTITLEMENTS.has(value),
  )
}

/**
 * What moving to another package would actually change.
 *
 * Both directions, because a comparison table that only ever adds is a sales
 * page rather than a settings screen: an owner considering a cheaper package
 * has to be able to see what they would lose, and a business already in overage
 * on `members` needs to know that Basic would refuse an invitation outright.
 *
 * `current` is the *effective* entitlement set and the *effective* limits — the
 * customer's, after their own grants, revocations and overrides — so a business
 * on "Pro without the website" is not told that Pro would add a website they
 * are already paying not to have.
 */
export type PlanDifference = {
  plan: OfferedPlan
  /** Higher `sortOrder` than the current package. */
  isUpgrade: boolean
  /** Features this package has that the customer does not have today. */
  gains: readonly Entitlement[]
  /** Features the customer has today that this package does not include. */
  losses: readonly Entitlement[]
  /** Quotas whose ceiling moves, and in which direction. */
  limitChanges: readonly {
    key: QuotaKey
    from: number | null
    to: number | null
    /** True when the new ceiling is lower than what the business already uses. */
    alreadyExceeded: boolean
  }[]
}

export function comparePlans(
  offered: readonly OfferedPlan[],
  current: EffectivePlan,
  usage: Usage,
): readonly PlanDifference[] {
  const held = effectiveEntitlements(current)
  const limits = effectiveLimits(current)

  return offered
    .filter((plan) => plan.code !== current.plan.code)
    .map((plan) => {
      const theirs = new Set(plan.entitlements)

      return {
        plan,
        isUpgrade: plan.sortOrder > current.plan.sortOrder,
        gains: ENTITLEMENTS.filter(
          (entitlement) => theirs.has(entitlement) && !held.has(entitlement),
        ),
        losses: ENTITLEMENTS.filter(
          (entitlement) => held.has(entitlement) && !theirs.has(entitlement),
        ),
        limitChanges: QUOTA_ORDER.filter(
          (key) => limits[key] !== plan.limits[key],
        ).map((key) => {
          const to = plan.limits[key]
          const current = usage[key]
          return {
            key,
            from: limits[key],
            to,
            alreadyExceeded: to !== null && current !== null && current > to,
          }
        }),
      }
    })
}

/** The features the customer has today, in the catalogue's own order. */
export function includedEntitlements(
  plan: EffectivePlan,
): readonly Entitlement[] {
  const held = effectiveEntitlements(plan)
  return ENTITLEMENTS.filter((entitlement) => held.has(entitlement))
}

/** The features the customer does not have. Shown, never hidden. */
export function excludedEntitlements(
  plan: EffectivePlan,
): readonly Entitlement[] {
  const held = effectiveEntitlements(plan)
  return ENTITLEMENTS.filter((entitlement) => !held.has(entitlement))
}

/**
 * The price this customer actually pays, and whether it is below list.
 *
 * `agreedPrice` and `isGrandfathered` are the domain's own answers.
 * `plan.ts` explains why they exist: a subscription stores the price agreed at
 * signup and editing the catalogue does not reach it, so "early customers keep
 * their price forever" is a property of the schema rather than a promise
 * somebody has to remember. An owner opening this screen has to be able to see
 * that, or the first they hear of it is a support call.
 */
export type PriceSummary = {
  agreedAgorot: number
  listAgorot: number
  interval: EffectivePlan['subscription']['interval']
  grandfathered: boolean
}

export function priceSummary(plan: EffectivePlan): PriceSummary {
  return {
    agreedAgorot: agreedPrice(plan),
    listAgorot:
      plan.subscription.interval === 'yearly'
        ? plan.plan.yearlyPrice
        : plan.plan.monthlyPrice,
    interval: plan.subscription.interval,
    grandfathered: isGrandfathered(plan),
  }
}
