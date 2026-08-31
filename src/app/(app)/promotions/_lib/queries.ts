/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the promotions screen.
 *
 * ══ WHAT DOES AND DOES NOT EXIST ═════════════════════════════════════════
 *
 * There is no `promotions` table, no `rate_plans` table and no pricing
 * calendar. `promotion` is a member of `PRICE_LINE_KINDS` — a *line on a
 * booking* — and that is the whole of it: a promotion in ESTIA today is a
 * negative line somebody wrote onto a stay, not a campaign the system manages,
 * schedules or applies. `pricing.manage` exists in the catalogue and
 * `dynamic_pricing` is an entitlement, and the engine behind them is not built.
 *
 * Two rule tables *do* exist and are genuinely rate rules:
 *
 *   · `agent_commission_rules` — what a particular seller is paid, on what
 *     base, over which properties, from when, and at what priority. `0015`
 *     built it with versioning and `selectCommissionRule` resolves it.
 *   · `agent_organization_settings.discount_max_*` — the ceiling on what a
 *     seller may give away before it becomes an approval rather than a refusal.
 *
 * So this screen shows the rules that exist and the discounts that have
 * actually been given, and says out loud that there is no promotions catalogue.
 * A screen that drew campaign cards over an engine nobody has written would let
 * a business plan a season around a feature that does not exist.
 *
 * ── `NULL` and `'{}'` are different answers ───────────────────────────────
 *
 * `agent_commission_rules.property_ids` is nullable, and 0015 says at length
 * why: a rule that names no properties applies **everywhere**, and a rule whose
 * list was emptied applies **nowhere**. `asStringArray` collapses both to `[]`,
 * so the null check happens before it — the same care
 * `toCommissionRuleRecord` takes in the adapter, for the same reason. Getting
 * it backwards pays commission on every property in the portfolio.
 *
 * ── Money ─────────────────────────────────────────────────────────────────
 *
 * Integer agorot. The discount lines are read as they were written; nothing
 * here re-derives a discount from a percentage, because the line is what the
 * guest was actually charged and a recomputation would disagree with the
 * invoice.
 */

import { can, holdsGrant, type Actor, type Resource } from '@/lib/authz/can'
import { COMMISSION_BASES, type CommissionBase } from '@/lib/contracts/states'
import { sumAgorot } from '@/lib/finance'
import { PRICE_LINE_KINDS, type PriceLineKind } from '@/lib/booking/types'
import {
  asAgorot,
  asEnum,
  asIsoDateOrNull,
  asNumber,
  asString,
  asStringArray,
  asStringOrNull,
  asTimestamp,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shared -- */

export const PROMOTION_PAGE_SIZE = 100

/** The kinds of price line this screen is about. Nothing else is a giveaway. */
export const GIVEAWAY_KINDS = ['discount', 'promotion'] as const
export type GiveawayKind = (typeof GIVEAWAY_KINDS)[number]

function pricingResource(organizationId: string): Resource {
  return { organizationId, family: 'finance' }
}

/* ---------------------------------------------------------- rate rules --- */

/**
 * One commission rule, as an owner needs to read it.
 *
 * `appliesEverywhere` is carried as its own boolean rather than left to the
 * reader to infer from an empty array, because the two states an empty array
 * can represent are opposites — see the header.
 */
export type RateRule = {
  id: string
  name: string
  agentUserId: string | null
  agentName: string | null
  agencyId: string | null
  agencyName: string | null
  ruleKind: string
  rulePercent: number | null
  ruleAgorot: number | null
  base: CommissionBase
  /** Null means "no property list was written", which means everywhere. */
  propertyIds: readonly string[] | null
  appliesEverywhere: boolean
  propertyNames: readonly string[]
  eligibility: readonly string[]
  /** Higher wins. Equal priorities are broken by specificity, then by id. */
  priority: number
  effectiveFrom: string | null
  effectiveUntil: string | null
  note: string | null
}

const RULE_COLUMNS =
  'id, organization_id, agent_user_id, agency_id, name, rule, base, ' +
  'property_ids, unit_ids, rate_plan_ids, eligibility_conditions, priority, ' +
  'effective_from, effective_until, note, created_at'

/**
 * The commission rules this business has written.
 *
 * Gated on `commission.view` — the rule *is* the money, and a reader who may
 * not see what an agent is owed may not see the rule that decides it. An empty
 * list for a reader without the grant, which the screen distinguishes from
 * "there are no rules" by asking `holdsGrant` itself.
 */
export async function listRateRules(args: {
  db: Db
  actor: Actor
  organizationId: string
  limit?: number
}): Promise<readonly RateRule[]> {
  const { db, actor, organizationId } = args

  if (!can(actor, 'commission.view', pricingResource(organizationId))) return []

  const { data, error } = await db
    .from('agent_commission_rules')
    .select(RULE_COLUMNS)
    .eq('organization_id', organizationId)
    .order('priority', { ascending: false })
    .limit(args.limit ?? PROMOTION_PAGE_SIZE)

  if (error) throw error

  const rows = toRows(data)

  const [people, agencies, properties] = await Promise.all([
    profileNames(db, idsIn(rows, 'agent_user_id')),
    agencyNames(db, idsIn(rows, 'agency_id')),
    propertyNames(
      db,
      organizationId,
      rows.flatMap((row) => nullableList(row, 'property_ids') ?? []),
    ),
  ])

  return rows.map((row) => {
    const rule = asJsonRule(row)
    const propertyIds = nullableList(row, 'property_ids')
    const agentUserId = asStringOrNull(row, 'agent_user_id')
    const agencyId = asStringOrNull(row, 'agency_id')

    return {
      id: asString(row, 'id'),
      name: asString(row, 'name'),
      agentUserId,
      agentName:
        agentUserId === null ? null : (people.get(agentUserId) ?? null),
      agencyId,
      agencyName: agencyId === null ? null : (agencies.get(agencyId) ?? null),
      ruleKind: rule.kind,
      rulePercent: rule.percent,
      ruleAgorot: rule.amountAgorot,
      base: asEnum(row, 'base', COMMISSION_BASES),
      propertyIds,
      appliesEverywhere: propertyIds === null,
      propertyNames:
        propertyIds === null
          ? []
          : propertyIds
              .map((id) => properties.get(id))
              .filter((name): name is string => name !== undefined),
      eligibility: asStringArray(row, 'eligibility_conditions'),
      priority: asNumber(row, 'priority'),
      effectiveFrom: asIsoDateOrNull(row, 'effective_from'),
      effectiveUntil: asIsoDateOrNull(row, 'effective_until'),
      note: asStringOrNull(row, 'note'),
    }
  })
}

/* ------------------------------------------------------- what was given -- */

/**
 * A discount or promotion that was actually applied to a stay.
 *
 * This is the honest answer to "what promotions are running": the ones somebody
 * wrote onto a booking. `booking_price_lines.amount_agorot` is negative for a
 * reduction — the domain's own convention, so the total is always a plain sum —
 * and it is read as written rather than re-derived from a percentage.
 */
export type GiveawayLine = {
  id: string
  bookingId: string
  propertyId: string
  kind: GiveawayKind
  label: string
  /** Negative. A reduction, as the price engine writes it. */
  amountAgorot: number
  appliedOn: string
}

/**
 * Every reduction on a booking in this organization, newest first.
 *
 * `booking_price_lines` carries `organization_id` and `property_id`, so this
 * needs no join and no embed — which matters, because `booking_price_lines`
 * has no declared relation to `bookings` that the demo client or the
 * transaction compiler would resolve.
 *
 * Gated on `booking.view_price`: a reduction is a price, and a reader who may
 * not see what a stay cost may not see what was taken off it.
 */
export async function listGiveaways(args: {
  db: Db
  actor: Actor
  organizationId: string
  propertyId: string | null
  limit?: number
}): Promise<readonly GiveawayLine[] | null> {
  const { db, actor, organizationId, propertyId } = args

  if (!holdsGrant(actor, 'booking.view_price')) return null

  let query = db
    .from('booking_price_lines')
    .select(
      'id, booking_id, organization_id, property_id, kind, label, ' +
        'amount_agorot, created_at',
    )
    .eq('organization_id', organizationId)
    .in('kind', [...GIVEAWAY_KINDS])

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(args.limit ?? PROMOTION_PAGE_SIZE)

  if (error) throw error

  return toRows(data)
    .filter((row) =>
      can(actor, 'booking.view_price', {
        organizationId,
        propertyId: asString(row, 'property_id'),
        family: 'finance',
      }),
    )
    .map((row) => ({
      id: asString(row, 'id'),
      bookingId: asString(row, 'booking_id'),
      propertyId: asString(row, 'property_id'),
      // `asEnum` against the two kinds this screen is about. A third kind
      // arriving here would mean the `in()` filter and this list disagreed,
      // which is worth a throw rather than a silent miscategorisation.
      kind: asEnum(row, 'kind', GIVEAWAY_KINDS),
      label: asString(row, 'label'),
      amountAgorot: asAgorot(row, 'amount_agorot'),
      appliedOn: asTimestamp(row, 'created_at'),
    }))
}

/**
 * What the reductions on screen add up to.
 *
 * `sumAgorot` over figures that are already negative integers, so the result is
 * the amount given away as a negative number — not an absolute value dressed up
 * as a positive one, which would read as revenue.
 */
export function giveawayTotalAgorot(
  lines: readonly GiveawayLine[] | null,
): number | null {
  if (lines === null) return null
  return sumAgorot(lines.map((line) => line.amountAgorot))
}

/** The reductions grouped by their label, which is the closest thing to a campaign. */
export type GiveawayGroup = {
  label: string
  kind: GiveawayKind
  count: number
  totalAgorot: number
}

/**
 * The nearest thing to "which promotions are running", built from what happened.
 *
 * Grouped by the label somebody typed, because that is the only identifier a
 * reduction has — there is no campaign id, and inventing one by parsing the
 * label would be building the missing table out of free text.
 */
export function groupGiveaways(
  lines: readonly GiveawayLine[],
): readonly GiveawayGroup[] {
  const groups = new Map<string, { kind: GiveawayKind; amounts: number[] }>()

  for (const line of lines) {
    const key = `${line.kind}:${line.label}`
    const group = groups.get(key) ?? { kind: line.kind, amounts: [] }
    group.amounts.push(line.amountAgorot)
    groups.set(key, group)
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      label: key.slice(key.indexOf(':') + 1),
      kind: group.kind,
      count: group.amounts.length,
      totalAgorot: sumAgorot(group.amounts),
    }))
    .sort((a, b) => a.totalAgorot - b.totalAgorot)
}

/* ----------------------------------------------------------- the ceiling -- */

/**
 * The discount ceilings the sellers are working under.
 *
 * The other half of "what may be given away": a rule says what a seller earns,
 * and this says what they may hand over before it becomes somebody else's
 * decision. Read from the same table the agents screen reads, narrowed by the
 * same `family: 'team'` resource.
 */
export type DiscountCeiling = {
  agentUserId: string
  agentName: string | null
  maxPercent: number
  maxAgorot: number | null
}

export async function listDiscountCeilings(args: {
  db: Db
  actor: Actor
  organizationId: string
  limit?: number
}): Promise<readonly DiscountCeiling[]> {
  const { db, actor, organizationId } = args

  const { data, error } = await db
    .from('agent_organization_settings')
    .select('agent_user_id, discount_max_percent, discount_max_agorot')
    .eq('organization_id', organizationId)
    .limit(args.limit ?? PROMOTION_PAGE_SIZE)

  if (error) throw error

  const rows = toRows(data).filter((row) =>
    can(actor, 'agent.view', {
      organizationId,
      assignedToUserId: asString(row, 'agent_user_id'),
      family: 'team',
    }),
  )

  const names = await profileNames(db, idsIn(rows, 'agent_user_id'))

  return rows.map((row) => {
    const agentUserId = asString(row, 'agent_user_id')
    return {
      agentUserId,
      agentName: names.get(agentUserId) ?? null,
      // `numeric`, so it arrives as `"8.000"` and goes through `asNumber`.
      maxPercent: asNumber(row, 'discount_max_percent'),
      maxAgorot:
        row['discount_max_agorot'] === null ||
        row['discount_max_agorot'] === undefined
          ? null
          : asAgorot(row, 'discount_max_agorot'),
    }
  })
}

/* --------------------------------------------------------------- shared -- */

/**
 * `NULL` and `'{}'` mean opposite things, and this is the only place that
 * distinction is preserved.
 *
 * A rule with no property list applies to every property; a rule whose list was
 * emptied applies to none. `asStringArray` returns `[]` for both, which is safe
 * on the columns that are `NOT NULL DEFAULT '{}'` and is exactly wrong here.
 */
function nullableList(row: Row, column: string): readonly string[] | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  return asStringArray(row, column)
}

/** The rule JSON, read for display and never for arithmetic. */
function asJsonRule(row: Row): {
  kind: string
  percent: number | null
  amountAgorot: number | null
} {
  const raw = row['rule']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'unknown', percent: null, amountAgorot: null }
  }
  const rule = raw as Record<string, unknown>
  return {
    kind: typeof rule.kind === 'string' ? rule.kind : 'unknown',
    percent: typeof rule.percent === 'number' ? rule.percent : null,
    amountAgorot:
      typeof rule.amountAgorot === 'number' ? rule.amountAgorot : null,
  }
}

function idsIn(rows: readonly Row[], column: string): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    const value = asStringOrNull(row, column)
    if (value !== null) ids.add(value)
  }
  return [...ids]
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

async function agencyNames(
  db: Db,
  agencyIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (agencyIds.length === 0) return new Map()

  const { data, error } = await db
    .from('agencies')
    .select('id, name')
    .in('id', [...agencyIds])

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data))
    names.set(asString(row, 'id'), asString(row, 'name'))
  return names
}

async function propertyNames(
  db: Db,
  organizationId: string,
  propertyIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(propertyIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('properties')
    .select('id, name')
    .eq('organization_id', organizationId)
    .in('id', unique)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}

/**
 * The price-line kinds this screen deliberately ignores.
 *
 * Referenced so that a kind added to `PRICE_LINE_KINDS` shows up in a grep for
 * this file rather than silently belonging to neither list. `GIVEAWAY_KINDS` is
 * the pair this screen is about; everything else is a charge, not a giveaway.
 */
export const NON_GIVEAWAY_KINDS: readonly PriceLineKind[] =
  PRICE_LINE_KINDS.filter(
    (kind): kind is PriceLineKind =>
      !(GIVEAWAY_KINDS as readonly string[]).includes(kind),
  )
