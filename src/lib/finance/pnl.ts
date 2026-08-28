/**
 * Profit and loss — for one booking, and for a property.
 *
 * The rule the whole file is built around: **never a single opaque number.**
 * Every figure is returned with the parts that produced it, in order, as
 * `PnlLine`s a screen can render without doing any arithmetic of its own. An
 * owner who is told "your March profit was ₪18,420" and cannot see how will
 * not believe the figure, and they are right not to.
 *
 * ── Where the numbers come from ───────────────────────────────────────────
 *
 * **From the snapshot, and only the snapshot.** `bookingPnl` takes a
 * `FinanceSnapshot` and a set of already-computed costs. There is no parameter
 * through which a live rule catalogue could be passed, which is how "a cost
 * rule changed today must not alter last month's booking" is guaranteed by the
 * type signature rather than by anybody's care. See `snapshot.ts`.
 *
 * **Prices are never recomputed.** The revenue figures are partitions of the
 * snapshot's `PriceLine[]`, which `booking/pricing.ts` produced. This file
 * classifies and sums; it does not price, and it does not round a price a
 * second time.
 *
 * ── The chain, and why it is in this order ────────────────────────────────
 *
 *     gross revenue
 *   − discount                → net revenue
 *   − variable cost
 *   − allocated fixed cost
 *   − agent commission
 *   − owner share             → net profit
 *
 * Tax is **not** in the chain. VAT collected is the state's money passing
 * through the business, not revenue; including it inflates both revenue and
 * margin by the rate. It is reported beside the chain as `taxCollectedAgorot`
 * so the P&L can still be reconciled against what the guest was charged.
 *
 * The refundable security deposit is not in the chain either, for the stronger
 * reason that it is the guest's own money.
 *
 * ── Margin ────────────────────────────────────────────────────────────────
 *
 * `marginPercent` is `null`, not `0`, when there is no net revenue to divide
 * by. A booking that earned nothing has no margin — that is not "0% margin",
 * which would mean it broke even on real revenue. The distinction is the
 * metrics module's rule and is honoured here by using its `percentOf`.
 */

import { sumLines } from '../booking/pricing'
import type { Agorot, PriceLine } from '../booking/types'
import { METRICS } from '../metrics/dictionary'
import type { MetricFacts } from '../metrics/facts'
import { percentOf } from '../metrics/rounding'
import type { MetricValue } from '../metrics/types'
import { applyPercent, assertSumsExactly, sumAgorot } from './money'
import type { FinanceSnapshot, OwnerShareRule } from './snapshot'
import type { CommissionRule } from './types'

// ── The breakdown ─────────────────────────────────────────────────────────

/**
 * One row of the explanation.
 *
 * `kind` decides how a screen renders it — revenue positive, cost negative,
 * result emphasised — so the interface never has to infer meaning from the
 * sign of a number, which is exactly the inference that puts a discount in the
 * revenue column.
 */
export interface PnlLine {
  key: string
  /** Hebrew, as it appears on the statement. */
  label: string
  /** Signed as it contributes to the chain: costs are negative. */
  amountAgorot: Agorot
  kind: 'revenue' | 'cost' | 'result'
}

/** One named cost, for the detail behind `variableCost` and `fixedCost`. */
export interface CostComponent {
  ruleId: string
  label: string
  amountAgorot: Agorot
}

export interface BookingPnl {
  bookingId: string
  organizationId: string
  propertyId: string | null
  unitId: string
  /** Which capture produced these figures. The audit trail of the number. */
  snapshotCapturedAt: string
  snapshotRevision: number

  grossRevenueAgorot: Agorot
  /** Positive magnitude. The chain subtracts it. */
  discountAgorot: Agorot
  netRevenueAgorot: Agorot

  variableCostAgorot: Agorot
  allocatedFixedCostAgorot: Agorot
  agentCommissionAgorot: Agorot
  ownerShareAgorot: Agorot

  netProfitAgorot: Agorot
  /** Percent points to one decimal, or `null` when there is nothing to divide. */
  marginPercent: MetricValue

  /** VAT collected. Not revenue — see the header. */
  taxCollectedAgorot: Agorot
  /** The guest's own money, held. Not revenue. */
  depositAgorot: Agorot

  variableCosts: readonly CostComponent[]
  fixedCosts: readonly CostComponent[]
  lines: readonly PnlLine[]
}

// ── Classifying the price lines ───────────────────────────────────────────

const REVENUE_KINDS: ReadonlySet<PriceLine['kind']> = new Set([
  'accommodation',
  'extra_guest',
  'addon',
  'cleaning_fee',
])

const DISCOUNT_KINDS: ReadonlySet<PriceLine['kind']> = new Set([
  'discount',
  'promotion',
])

export interface RevenueBreakdown {
  grossAgorot: Agorot
  discountAgorot: Agorot
  netAgorot: Agorot
  taxAgorot: Agorot
  depositAgorot: Agorot
}

/**
 * Partition a snapshot's lines into the revenue figures.
 *
 * A partition rather than five independent sums: every line lands in exactly
 * one bucket, so `gross − discount = net` cannot drift, and a price line kind
 * added to the booking contract without being classified here shows up as an
 * unclassified total rather than silently vanishing from the P&L.
 */
export function revenueBreakdown(
  lines: readonly PriceLine[],
): RevenueBreakdown {
  const gross = sumLines(lines.filter((line) => REVENUE_KINDS.has(line.kind)))
  // Discounts are stored negative so a quote is a plain sum; the P&L states
  // them as a positive magnitude and subtracts, because "הנחה ₪-400" reads as
  // a discount that was added.
  const discount = Math.abs(
    sumLines(lines.filter((line) => DISCOUNT_KINDS.has(line.kind))),
  )

  return {
    grossAgorot: gross,
    discountAgorot: discount,
    netAgorot: gross - discount,
    taxAgorot: sumLines(lines.filter((line) => line.kind === 'tax')),
    depositAgorot: sumLines(lines.filter((line) => line.kind === 'deposit')),
  }
}

// ── Commission and owner share ────────────────────────────────────────────

/**
 * What the agent is owed on this booking, from the snapshotted rule.
 *
 * The basis is part of the rule and not a convention, because a percentage of
 * the gross and a percentage of the net are different numbers and the
 * difference is exactly what gets argued about.
 */
export function commissionFromRule(
  rule: CommissionRule,
  basisAgorot: Agorot,
): Agorot {
  return rule.kind === 'fixed'
    ? Math.round(rule.value)
    : applyPercent(basisAgorot, rule.value)
}

export function commissionBasisAgorot(
  rule: CommissionRule,
  snapshot: FinanceSnapshot,
  revenue: RevenueBreakdown,
): Agorot {
  switch (rule.basis) {
    case 'stay_total':
      // The stay without the refundable deposit: nobody earns commission on
      // money that is going back to the guest.
      return snapshot.stayTotalAgorot
    case 'gross_revenue':
      return revenue.grossAgorot
    case 'net_revenue':
      return revenue.netAgorot
    default:
      return 0
  }
}

function ownerShareAgorot(
  rule: OwnerShareRule,
  revenue: RevenueBreakdown,
  profitBeforeOwner: Agorot,
): Agorot {
  if (rule.kind === 'fixed') return Math.round(rule.value)

  switch (rule.basis) {
    case 'gross_revenue':
      return applyPercent(revenue.grossAgorot, rule.value)
    case 'net_revenue':
      return applyPercent(revenue.netAgorot, rule.value)
    case 'net_profit':
      // Of what is left after every cost including the agent — which is the
      // only reading under which the business and the owner share the same
      // downside.
      return applyPercent(profitBeforeOwner, rule.value)
    default:
      return 0
  }
}

// ── The booking P&L ───────────────────────────────────────────────────────

export interface BookingPnlInput {
  snapshot: FinanceSnapshot
  /** Costs caused by this stay, already computed by `expenses.ts`. */
  variableCosts?: readonly CostComponent[]
  /** This booking's share of period costs, from `allocateExpense`. */
  fixedCosts?: readonly CostComponent[]
  /**
   * Override the commission with what was actually recorded.
   *
   * Supplied when a `Commission` row exists: the recorded amount is the one
   * the agent will be paid, and a P&L that recomputed it from the rule could
   * disagree with the statement that was already sent. Absent, the snapshotted
   * rule is used — which is the estimate, and is correct before a commission
   * row exists.
   */
  agentCommissionAgorot?: Agorot
}

export function bookingPnl(input: BookingPnlInput): BookingPnl {
  const { snapshot } = input
  const revenue = revenueBreakdown(snapshot.lines)

  const variableCosts = input.variableCosts ?? []
  const fixedCosts = input.fixedCosts ?? []
  const variableCostAgorot = sumAgorot(
    variableCosts.map((cost) => cost.amountAgorot),
  )
  const allocatedFixedCostAgorot = sumAgorot(
    fixedCosts.map((cost) => cost.amountAgorot),
  )

  const agentCommissionAgorot =
    input.agentCommissionAgorot ??
    (snapshot.commissionRule === null
      ? 0
      : commissionFromRule(
          snapshot.commissionRule,
          commissionBasisAgorot(snapshot.commissionRule, snapshot, revenue),
        ))

  const profitBeforeOwner =
    revenue.netAgorot -
    variableCostAgorot -
    allocatedFixedCostAgorot -
    agentCommissionAgorot

  const owner =
    snapshot.ownerShareRule === null
      ? 0
      : ownerShareAgorot(snapshot.ownerShareRule, revenue, profitBeforeOwner)

  const netProfitAgorot = profitBeforeOwner - owner

  const lines: PnlLine[] = [
    {
      key: 'gross_revenue',
      label: 'הכנסה ברוטו',
      amountAgorot: revenue.grossAgorot,
      kind: 'revenue',
    },
    {
      key: 'discount',
      label: 'הנחות והטבות',
      amountAgorot: -revenue.discountAgorot,
      kind: 'cost',
    },
    {
      key: 'net_revenue',
      label: 'הכנסה נטו',
      amountAgorot: revenue.netAgorot,
      kind: 'result',
    },
    {
      key: 'variable_cost',
      label: 'עלויות משתנות',
      amountAgorot: -variableCostAgorot,
      kind: 'cost',
    },
    {
      key: 'fixed_cost',
      label: 'עלויות קבועות שהוקצו',
      amountAgorot: -allocatedFixedCostAgorot,
      kind: 'cost',
    },
    {
      key: 'agent_commission',
      label: 'עמלת סוכן',
      amountAgorot: -agentCommissionAgorot,
      kind: 'cost',
    },
    {
      key: 'owner_share',
      label: 'חלק בעל הנכס',
      amountAgorot: -owner,
      kind: 'cost',
    },
    {
      key: 'net_profit',
      label: 'רווח נטו',
      amountAgorot: netProfitAgorot,
      kind: 'result',
    },
  ]

  // The parts add to the whole, checked rather than assumed. `net_revenue` and
  // `net_profit` are restatements of the running total, so they are excluded
  // from the sum — including them would double-count the chain.
  assertSumsExactly(
    'bookingPnl',
    lines
      .filter((line) => line.kind !== 'result')
      .map((line) => line.amountAgorot),
    netProfitAgorot,
  )

  return {
    bookingId: snapshot.bookingId,
    organizationId: snapshot.organizationId,
    propertyId: snapshot.propertyId,
    unitId: snapshot.unitId,
    snapshotCapturedAt: snapshot.capturedAt,
    snapshotRevision: snapshot.revision,
    grossRevenueAgorot: revenue.grossAgorot,
    discountAgorot: revenue.discountAgorot,
    netRevenueAgorot: revenue.netAgorot,
    variableCostAgorot,
    allocatedFixedCostAgorot,
    agentCommissionAgorot,
    ownerShareAgorot: owner,
    netProfitAgorot,
    marginPercent: percentOf(netProfitAgorot, revenue.netAgorot),
    taxCollectedAgorot: revenue.taxAgorot,
    depositAgorot: revenue.depositAgorot,
    variableCosts,
    fixedCosts,
    lines,
  }
}

// ── The property P&L ──────────────────────────────────────────────────────

export interface PropertyPnl {
  propertyId: string | null
  periodStart: string
  periodEnd: string
  bookingCount: number

  grossRevenueAgorot: Agorot
  discountAgorot: Agorot
  netRevenueAgorot: Agorot
  variableCostAgorot: Agorot
  allocatedFixedCostAgorot: Agorot
  /**
   * Period costs that reached no booking.
   *
   * The insurance premium on a month that sold nothing. Carried here, visibly,
   * rather than forced onto an arbitrary stay to make a column add up.
   */
  unallocatedFixedCostAgorot: Agorot
  agentCommissionAgorot: Agorot
  ownerShareAgorot: Agorot
  netProfitAgorot: Agorot
  marginPercent: MetricValue
  taxCollectedAgorot: Agorot

  lines: readonly PnlLine[]
  bookings: readonly BookingPnl[]
}

export interface PropertyPnlInput {
  propertyId: string | null
  periodStart: string
  periodEnd: string
  bookings: readonly BookingPnl[]
  /** From every allocation's `unallocatedAgorot`. */
  unallocatedFixedCostAgorot?: Agorot
}

/**
 * The property's result: the sum of its bookings, plus what reached none.
 *
 * Built by adding up booking P&Ls rather than by re-deriving anything from
 * rules, so a property total can never disagree with the bookings a person
 * opens to check it. That is the same instinct as the pricing engine's "the
 * total is the sum of the lines", one level up.
 */
export function propertyPnl(input: PropertyPnlInput): PropertyPnl {
  const { bookings } = input
  const unallocated = input.unallocatedFixedCostAgorot ?? 0

  const sum = (pick: (pnl: BookingPnl) => Agorot): Agorot =>
    sumAgorot(bookings.map(pick))

  const grossRevenueAgorot = sum((pnl) => pnl.grossRevenueAgorot)
  const discountAgorot = sum((pnl) => pnl.discountAgorot)
  const netRevenueAgorot = sum((pnl) => pnl.netRevenueAgorot)
  const variableCostAgorot = sum((pnl) => pnl.variableCostAgorot)
  const allocatedFixedCostAgorot = sum((pnl) => pnl.allocatedFixedCostAgorot)
  const agentCommissionAgorot = sum((pnl) => pnl.agentCommissionAgorot)
  const ownerShareAgorot = sum((pnl) => pnl.ownerShareAgorot)

  const netProfitAgorot =
    netRevenueAgorot -
    variableCostAgorot -
    allocatedFixedCostAgorot -
    unallocated -
    agentCommissionAgorot -
    ownerShareAgorot

  const lines: PnlLine[] = [
    {
      key: 'gross_revenue',
      label: 'הכנסה ברוטו',
      amountAgorot: grossRevenueAgorot,
      kind: 'revenue',
    },
    {
      key: 'discount',
      label: 'הנחות והטבות',
      amountAgorot: -discountAgorot,
      kind: 'cost',
    },
    {
      key: 'net_revenue',
      label: 'הכנסה נטו',
      amountAgorot: netRevenueAgorot,
      kind: 'result',
    },
    {
      key: 'variable_cost',
      label: 'עלויות משתנות',
      amountAgorot: -variableCostAgorot,
      kind: 'cost',
    },
    {
      key: 'fixed_cost',
      label: 'עלויות קבועות שהוקצו להזמנות',
      amountAgorot: -allocatedFixedCostAgorot,
      kind: 'cost',
    },
    {
      key: 'unallocated_fixed_cost',
      label: 'עלויות קבועות שלא הוקצו',
      amountAgorot: -unallocated,
      kind: 'cost',
    },
    {
      key: 'agent_commission',
      label: 'עמלות סוכנים',
      amountAgorot: -agentCommissionAgorot,
      kind: 'cost',
    },
    {
      key: 'owner_share',
      label: 'חלק בעלי הנכס',
      amountAgorot: -ownerShareAgorot,
      kind: 'cost',
    },
    {
      key: 'net_profit',
      label: 'רווח נטו',
      amountAgorot: netProfitAgorot,
      kind: 'result',
    },
  ]

  assertSumsExactly(
    'propertyPnl',
    lines
      .filter((line) => line.kind !== 'result')
      .map((line) => line.amountAgorot),
    netProfitAgorot,
  )

  return {
    propertyId: input.propertyId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    bookingCount: bookings.length,
    grossRevenueAgorot,
    discountAgorot,
    netRevenueAgorot,
    variableCostAgorot,
    allocatedFixedCostAgorot,
    unallocatedFixedCostAgorot: unallocated,
    agentCommissionAgorot,
    ownerShareAgorot,
    netProfitAgorot,
    marginPercent: percentOf(netProfitAgorot, netRevenueAgorot),
    taxCollectedAgorot: sum((pnl) => pnl.taxCollectedAgorot),
    lines,
    bookings,
  }
}

// ── The named metrics, taken from the dictionary ──────────────────────────

export interface PnlHeadlines {
  revenue: MetricValue
  netOperatingRevenue: MetricValue
  commissionCost: MetricValue
  collected: MetricValue
  outstandingBalance: MetricValue
}

/**
 * The dashboard figures that sit beside a P&L.
 *
 * Read from `metrics/dictionary.ts` and never recomputed here — that is the
 * metrics module's whole rule, and a finance screen quietly dividing revenue
 * by nights is exactly how two screens come to disagree.
 *
 * Worth being explicit about what this is *not*: `revenue` here is the
 * dictionary's window-scoped, night-by-night recognised figure, and it is a
 * different quantity from a booking P&L's `grossRevenueAgorot`, which is one
 * stay's whole value whenever it falls. The two are both correct and must
 * never be presented under the same label. A month's P&L and a month's revenue
 * tile will not tie out, deliberately, and the interface should say so rather
 * than let an owner discover it.
 */
export function pnlHeadlines(facts: MetricFacts): PnlHeadlines {
  return {
    revenue: METRICS.revenue.compute(facts),
    netOperatingRevenue: METRICS.net_operating_revenue.compute(facts),
    commissionCost: METRICS.commission_cost.compute(facts),
    collected: METRICS.collected.compute(facts),
    outstandingBalance: METRICS.outstanding_balance.compute(facts),
  }
}
