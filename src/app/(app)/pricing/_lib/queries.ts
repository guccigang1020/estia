/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the pricing screen.
 *
 * ══ WHY A NEW ROUTE AND NOT AN EXTENSION OF `/promotions` ═══════════════════
 *
 * `/promotions` reads `agent_commission_rules` and the discount lines actually
 * given, and says out loud in its own header that there is no promotions
 * catalogue. That screen is about DISCOUNTS — money taken off a total — and it
 * is being rebuilt by the migration that adds `promotions` and `coupons`.
 *
 * This is the RATE CARD: what a night costs before anybody discounts anything.
 * Spec §7.7 makes the distinction load-bearing rather than cosmetic — an agent
 * rate is a rate PLAN chosen at step 1, and a promotion is a line at step 11,
 * and the reason a season, a weekend uplift, an agent rate and a campaign can
 * combine into one number without arguing is that they operate at four
 * different levels. Two screens, because they are two levels.
 *
 * `/quotes` was the other candidate and is also wrong: a quote is one stay's
 * answer, and this is the machine that answers.
 *
 * ══ THE TABLES MAY NOT BE THERE ═════════════════════════════════════════════
 *
 * `0072_pricing.sql` is written but has not been applied to any database by
 * the agent that wrote it. `PricingRepository` answers `null` rather than
 * throwing when a relation is missing, and this file turns that into a
 * `not_provisioned` screen state saying so in Hebrew. A deployment that is
 * behind on migrations is a state, not a stack trace.
 *
 * ══ FIELD-LEVEL WITHHOLDING, NOT SCREEN-LEVEL ═══════════════════════════════
 *
 * The three rates are three circles of trust (spec §13). A plan whose
 * `requires_grant` the reader does not hold is not in the response at all —
 * row level security removes it before this code runs, and `canManage` below
 * decides only whether the controls render. Hiding a button is not security
 * and this file does not pretend otherwise: every write goes back through an
 * operation that checks the grant again, and RLS refuses underneath both.
 */

import type { Actor } from '@/lib/authz/can'
import { PricingRepository } from '@/lib/pricing'
import type {
  DynamicPricingPolicy,
  RateCalendarEntry,
  RatePlan,
  RateSuggestion,
} from '@/lib/pricing'
import { asString, asStringOrNull, toRows, type Db } from '@/lib/persistence'

export type PricingScreen =
  | { status: 'not_provisioned' }
  | {
      status: 'ready'
      plans: readonly RatePlan[]
      units: readonly { id: string; name: string; propertyId: string }[]
      calendar: readonly (RateCalendarEntry & { propertyId: string })[]
      /** The unit and plan the calendar above belongs to, or null. */
      focus: {
        unitId: string
        ratePlanId: string
        from: string
        to: string
      } | null
      suggestions: readonly (RateSuggestion & { propertyId: string })[]
      policy: DynamicPricingPolicy | null
    }

/**
 * A calendar month, half-open.
 *
 * `[from, to)` like every range in the product, so the last night of the month
 * is included and the first of the next is not — and so the same arithmetic
 * that decides a stay decides a screen.
 */
export function monthBounds(anchor: string): { from: string; to: string } {
  const [year, month] = anchor.split('-').map(Number)
  const from = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }
  const to = `${String(next.y).padStart(4, '0')}-${String(next.m).padStart(2, '0')}-01`
  return { from, to }
}

export async function loadPricingScreen(
  db: Db,
  actor: Actor,
  options: {
    propertyIds: readonly string[]
    /** `YYYY-MM`. The month the calendar shows. */
    month: string
    unitId?: string
    ratePlanId?: string
  },
): Promise<PricingScreen> {
  const repository = new PricingRepository(db)

  const plans = await repository.plans(actor.organizationId)
  // `null` is "the tables are not here", which is a different answer from an
  // empty list — a business with no rate card yet. Collapsing them would tell
  // somebody to go and set prices on a deployment where they could not.
  if (plans === null) return { status: 'not_provisioned' }

  const units = await loadUnits(db, actor.organizationId, options.propertyIds)

  const unitId = options.unitId ?? units[0]?.id
  const ratePlanId = options.ratePlanId ?? plans[0]?.id
  const { from, to } = monthBounds(options.month)

  const calendar =
    unitId === undefined || ratePlanId === undefined
      ? []
      : ((await repository.calendar(actor.organizationId, {
          unitId,
          ratePlanId,
          from,
          to,
        })) ?? [])

  // `pricing.manage` gates the recommendations queue, not `rate.view_public`:
  // a recommendation carries the deterministic price and the floor beside the
  // proposal, which together are most of what the net rate protects.
  const suggestions = actor.grants.has('pricing.manage')
    ? ((await repository.pendingSuggestions(
        actor.organizationId,
        options.propertyIds,
      )) ?? [])
    : []

  const policy = actor.grants.has('pricing.manage')
    ? await repository.policy(actor.organizationId, null)
    : null

  return {
    status: 'ready',
    plans,
    units,
    calendar,
    focus:
      unitId === undefined || ratePlanId === undefined
        ? null
        : { unitId, ratePlanId, from, to },
    suggestions,
    policy,
  }
}

/**
 * The units a person may price.
 *
 * Read through the same client as everything else, so row level security
 * answers it: a manager scoped to two properties gets those units and cannot
 * discover the others by choosing a different value in the selector.
 */
async function loadUnits(
  db: Db,
  organizationId: string,
  propertyIds: readonly string[],
): Promise<{ id: string; name: string; propertyId: string }[]> {
  if (propertyIds.length === 0) return []

  const { data, error } = await db
    .from('units')
    .select('id, name, property_id')
    .eq('organization_id', organizationId)
    .in('property_id', [...propertyIds])
    .order('name', { ascending: true })

  if (error) return []

  return toRows(data).map((row) => ({
    id: asString(row, 'id'),
    name: asStringOrNull(row, 'name') ?? 'יחידה ללא שם',
    propertyId: asString(row, 'property_id'),
  }))
}
