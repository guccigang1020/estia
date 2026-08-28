/**
 * What the booking is worth, and what it cost to deliver.
 *
 * ── The rule that governs every number in this file ───────────────────────
 *
 * **A total is the plain sum of its lines, and every line is already a whole
 * number of agorot.** Rounding happens once, at the leaf, and never again.
 * The alternative — computing an exact total and rounding it — produces a
 * statement whose parts do not add up to its bottom line, and the first person
 * to check the arithmetic by hand stops trusting the whole screen. There is a
 * test that adds every group up and demands the answer.
 *
 * ── Allocation is division, and division needs a window ───────────────────
 *
 * Rent is not a cost of a booking; it is a cost of a month, some of which the
 * booking is responsible for. Which share depends on what kind of cost it is:
 * rent accrues whether or not anyone stays, a cleaner's retainer earns out on
 * occupied nights, a licence fee is per booking, water follows heads, and a
 * management fee follows the money. Five methods, one per behaviour.
 *
 * The denominators come from the caller as an `AllocationContext` **per
 * frequency** — the month's figures for monthly costs, the year's for annual
 * ones. That keeps every calendar assumption outside the engine: nothing here
 * believes a month is thirty days.
 *
 * ── Why the breakdown is not optional ─────────────────────────────────────
 *
 * "Net contribution ₪3,120" is a number nobody can act on. `explain` on every
 * line is written by the calculator that produced it, because only that
 * calculator knows the cleaning line was 350 plus fifteen guests over the
 * threshold plus fifteen mattresses.
 */

import type { Agorot } from '../booking/types'
import { formatAgorot } from '../plans/plan'
import { COMMISSION_BASE_LABEL } from '../contracts/states'
import { evaluateCondition, factValue } from './rules'
import type {
  AllocationContext,
  AllocationMethod,
  CommissionBase,
  CommissionRule,
  CostActual,
  CostFormula,
  CostFrequency,
  EventPnL,
  FixedCost,
  PnLGroup,
  PnLLine,
  PreparationBooking,
  PreparationFacts,
  PreparationSnapshot,
  Requirement,
  SharingRule,
  StaffingEstimate,
  VarianceLine,
  VarianceReport,
  VariableCostRule,
} from './types'

/** Basis points per whole. 10,000 bp = 100%. */
const BASIS_POINTS_SCALE = 10_000

/** Percent is per hundred. Display only; the arithmetic stays in basis points. */
const PERCENT_SCALE = 100

/**
 * Price line kinds that are not revenue.
 *
 * A deposit is money held and given back, not money earned. A commission line
 * on the price breakdown is what the business pays out of the sale, and
 * counting it as revenue would inflate the top line and then charge commission
 * on the commission.
 */
const NON_REVENUE_LINE_KINDS = new Set(['deposit', 'agent_commission'])

// ── Small arithmetic, in one place ────────────────────────────────────────

/**
 * A share of an amount, rounded once.
 *
 * A zero denominator is zero, not `NaN` and not a thrown error: a month in
 * which nothing was sold allocates nothing, which is the arithmetically and
 * commercially correct answer.
 */
export function share(
  amount: Agorot,
  numerator: number,
  denominator: number,
): Agorot {
  if (denominator === 0) return 0
  return Math.round((amount * numerator) / denominator)
}

/** A group whose total is, by construction, the sum of its lines. */
export function group(lines: readonly PnLLine[]): PnLGroup {
  return {
    lines,
    total: lines.reduce((total, line) => total + line.amount, 0),
  }
}

// ── Variable costs ────────────────────────────────────────────────────────

export interface CostFacts {
  facts: PreparationFacts
  requirements: readonly Requirement[]
}

/**
 * A formula, evaluated.
 *
 * `per_requirement` is the one worth pausing on: laundry is twelve shekels per
 * linen set, and the number of linen sets is whatever the preparation rules
 * decided — not a second derivation from the guest count. Binding the cost to
 * the requirement is what makes the profit statement and the work plan
 * incapable of disagreeing about how much laundry there was.
 */
export function evaluateCostFormula(
  formula: CostFormula,
  context: CostFacts,
): Agorot {
  switch (formula.kind) {
    case 'fixed':
      return formula.amount

    case 'per_unit':
      return Math.round(
        factValue(formula.basis, context.facts) * formula.unitAmount,
      )

    case 'above_threshold': {
      const measured = factValue(formula.basis, context.facts)
      const over = Math.max(0, measured - formula.threshold)
      return Math.round(over * formula.unitAmount)
    }

    case 'per_requirement': {
      const quantity = context.requirements
        .filter(
          (requirement) =>
            (formula.itemId === undefined ||
              requirement.itemId === formula.itemId) &&
            (formula.category === undefined ||
              requirement.category === formula.category),
        )
        .reduce((total, requirement) => total + requirement.quantity, 0)
      return Math.round(quantity * formula.unitAmount)
    }

    case 'sum':
      return formula.of.reduce(
        (total, inner) => total + evaluateCostFormula(inner, context),
        0,
      )
  }
}

export function computeVariableCosts(
  rules: readonly VariableCostRule[],
  context: CostFacts,
): readonly PnLLine[] {
  return rules
    .filter((rule) => evaluateCondition(rule.condition, context.facts))
    .map((rule) => {
      const amount = evaluateCostFormula(rule.formula, context)
      return {
        key: rule.key,
        label: rule.label,
        amount,
        explain: explainFormula(rule.formula, context),
      }
    })
    .filter((line) => line.amount !== 0)
}

/**
 * The arithmetic, in Hebrew, as the manager would have done it.
 *
 * Built from the same formula tree that produced the number, so it cannot
 * describe a calculation other than the one that ran.
 */
function explainFormula(formula: CostFormula, context: CostFacts): string {
  switch (formula.kind) {
    case 'fixed':
      return formatAgorot(formula.amount)

    case 'per_unit': {
      const measured = factValue(formula.basis, context.facts)
      return `${measured} × ${formatAgorot(formula.unitAmount)}`
    }

    case 'above_threshold': {
      const measured = factValue(formula.basis, context.facts)
      const over = Math.max(0, measured - formula.threshold)
      return `(${measured} − ${formula.threshold}) × ${formatAgorot(formula.unitAmount)} = ${formatAgorot(Math.round(over * formula.unitAmount))}`
    }

    case 'per_requirement': {
      const amount = evaluateCostFormula(formula, context)
      const target = formula.itemId ?? formula.category ?? 'הכל'
      return `${target}: ${formatAgorot(amount)}`
    }

    case 'sum':
      return formula.of
        .map((inner) => explainFormula(inner, context))
        .join(' + ')
  }
}

// ── Fixed costs ───────────────────────────────────────────────────────────

/**
 * The share of a shared cost that reaches one property.
 *
 * Four methods and one code path. `equal` is every weight set to one;
 * `by_revenue`, `by_units` and `custom_percent` differ only in where the
 * weight came from, which is the customer's business and not the engine's.
 * Dividing by the sum of the weights rather than by a hundred is what makes
 * `custom_percent` behave when the percentages were typed in and come to
 * ninety-nine.
 */
export function shareForProperty(
  amount: Agorot,
  sharing: SharingRule,
  propertyId: string,
): Agorot {
  const weights = sharing.shares.map((entry) => ({
    propertyId: entry.propertyId,
    weight: sharing.method === 'equal' ? 1 : entry.weight,
  }))

  const total = weights.reduce((sum, entry) => sum + entry.weight, 0)
  const mine = weights.find((entry) => entry.propertyId === propertyId)

  if (!mine || total === 0) return 0
  return share(amount, mine.weight, total)
}

export interface FixedAllocationInput {
  costs: readonly FixedCost[]
  /** One measured window per frequency. Monthly costs get the month's. */
  contexts: Readonly<Partial<Record<CostFrequency, AllocationContext>>>
  facts: PreparationFacts
  /** This booking's revenue, for `per_property_share`. */
  bookingRevenue: Agorot
  propertyId: string
  unitId: string
}

export function allocateFixedCosts(
  input: FixedAllocationInput,
): readonly PnLLine[] {
  const lines: PnLLine[] = []

  for (const cost of input.costs) {
    if (!appliesTo(cost, input.propertyId, input.unitId)) continue

    const context = input.contexts[cost.frequency]
    if (!context) continue

    const scoped =
      cost.scope.kind === 'organization' && cost.sharing
        ? shareForProperty(cost.amount, cost.sharing, input.propertyId)
        : cost.amount

    const allocated = allocate(
      scoped,
      cost.allocation,
      context,
      input.facts,
      input.bookingRevenue,
    )

    if (allocated === 0) continue

    lines.push({
      key: cost.key,
      label: cost.label,
      amount: allocated,
      explain: explainAllocation(
        scoped,
        cost.allocation,
        context,
        input.facts,
        input.bookingRevenue,
      ),
    })
  }

  return lines
}

function appliesTo(
  cost: FixedCost,
  propertyId: string,
  unitId: string,
): boolean {
  switch (cost.scope.kind) {
    case 'organization':
      return true
    case 'property':
      return cost.scope.propertyId === propertyId
    case 'unit':
      return cost.scope.unitId === unitId
  }
}

/**
 * The five methods, as five divisions.
 *
 *   per_calendar_day    amount × nights ÷ days in the period
 *   per_occupied_night  amount × nights ÷ nights sold in the period
 *   per_booking         amount ÷ bookings in the period
 *   per_guest           amount × guests ÷ guests in the period
 *   per_property_share  amount × this booking's revenue ÷ period revenue
 *
 * The last one is the method for costs that should follow money rather than
 * time or heads — a management fee, a revenue-linked service charge. It is
 * also the only one whose meaning had to be decided rather than read off the
 * specification; see `docs/SPEC_HOUSEKEEPING.md` for the note.
 */
function allocate(
  amount: Agorot,
  method: AllocationMethod,
  context: AllocationContext,
  facts: PreparationFacts,
  bookingRevenue: Agorot,
): Agorot {
  switch (method) {
    case 'per_calendar_day':
      return share(amount, facts.nights, context.periodDays)
    case 'per_occupied_night':
      return share(amount, facts.nights, context.periodOccupiedNights)
    case 'per_booking':
      return share(amount, facts.booking, context.periodBookings)
    case 'per_guest':
      return share(amount, facts.guests, context.periodGuests)
    case 'per_property_share':
      return share(amount, bookingRevenue, context.periodRevenue)
  }
}

function explainAllocation(
  amount: Agorot,
  method: AllocationMethod,
  context: AllocationContext,
  facts: PreparationFacts,
  bookingRevenue: Agorot,
): string {
  const money = formatAgorot(amount)

  switch (method) {
    case 'per_calendar_day':
      return `${money} × ${facts.nights} לילות ÷ ${context.periodDays} ימים בתקופה`
    case 'per_occupied_night':
      return `${money} × ${facts.nights} לילות ÷ ${context.periodOccupiedNights} לילות תפוסים`
    case 'per_booking':
      return `${money} ÷ ${context.periodBookings} הזמנות בתקופה`
    case 'per_guest':
      return `${money} × ${facts.guests} אורחים ÷ ${context.periodGuests} אורחים בתקופה`
    case 'per_property_share':
      return `${money} × ${formatAgorot(bookingRevenue)} ÷ ${formatAgorot(context.periodRevenue)} הכנסות בתקופה`
  }
}

// ── Revenue and commission ────────────────────────────────────────────────

export function revenueLines(booking: PreparationBooking): readonly PnLLine[] {
  return booking.priceLines
    .filter((line) => !NON_REVENUE_LINE_KINDS.has(line.kind))
    .map((line) => ({
      key: `revenue:${line.kind}:${line.label}`,
      label: line.label,
      amount: line.amount,
      explain:
        line.date === null
          ? `${line.quantity} × ${line.label}`
          : `${line.date} · ${line.quantity} × ${line.label}`,
    }))
}

export function accommodationRevenue(booking: PreparationBooking): Agorot {
  return booking.priceLines
    .filter((line) => line.kind === 'accommodation')
    .reduce((total, line) => total + line.amount, 0)
}

export interface CommissionInput {
  basis: CommissionBase
  revenue: Agorot
  accommodation: Agorot
  directCosts: Agorot
  allocatedFixedCosts: Agorot
}

/**
 * What the percentage is taken of.
 *
 * The base is the argument, not the rate. Two agents on ten percent of
 * different bases earn materially different money on the same booking, and a
 * commission field that stores only the resulting number cannot answer "why
 * did I get less this time".
 */
export function commissionBaseAmount(input: CommissionInput): Agorot {
  switch (input.basis) {
    case 'gross_revenue':
      return input.revenue
    case 'accommodation_only':
      return input.accommodation
    case 'net_of_direct_costs':
      return input.revenue - input.directCosts
    case 'net_contribution':
      return input.revenue - input.directCosts - input.allocatedFixedCosts
    default:
      // `stay_total` and `net_revenue` are in the shared catalogue but belong
      // to agent commission and to finance; neither is derivable from a
      // costing input. Refuse rather than fall through to gross, which would
      // pay on revenue this model never measured and look correct on every
      // report until somebody reconciled it.
      throw new Error(
        `Commission base "${input.basis}" is not computable from a costing input`,
      )
  }
}

export function commissionLine(
  rule: CommissionRule,
  input: CommissionInput,
): PnLLine {
  const base = Math.max(0, commissionBaseAmount(input))
  const amount = share(base, rule.rateBasisPoints, BASIS_POINTS_SCALE)

  return {
    key: 'commission',
    label: 'עמלת סוכן',
    amount,
    explain: `${formatAgorot(base)} × ${basisPointsToPercent(rule.rateBasisPoints)}% (${basisLabel(rule.basis)})`,
  }
}

function basisLabel(basis: CommissionBase): string {
  switch (basis) {
    case 'gross_revenue':
      return 'הכנסה ברוטו'
    case 'accommodation_only':
      return 'לינה בלבד'
    case 'net_of_direct_costs':
      return 'נטו אחרי עלויות ישירות'
    case 'net_contribution':
      return 'תרומה נטו'
    default:
      // A label is cosmetic, so unlike the arithmetic above this falls back to
      // the shared catalogue rather than throwing. Failing a whole P&L over a
      // caption would be the wrong trade.
      return COMMISSION_BASE_LABEL[basis]
  }
}

/** Basis points as a percentage, for display only. Never for arithmetic. */
export function basisPointsToPercent(basisPoints: number): number {
  return basisPoints / (BASIS_POINTS_SCALE / PERCENT_SCALE)
}

// ── The statement ─────────────────────────────────────────────────────────

export interface EventPnLInput {
  booking: PreparationBooking
  snapshot: PreparationSnapshot
  facts: PreparationFacts
  requirements: readonly Requirement[]
  staffing: StaffingEstimate
  contexts: FixedAllocationInput['contexts']
}

export function computeEventPnL(input: EventPnLInput): EventPnL {
  const { booking, snapshot, facts, requirements, staffing } = input

  const revenue = group(revenueLines(booking))

  const directCosts = group([
    ...computeVariableCosts(snapshot.variableCosts, { facts, requirements }),
    {
      key: 'labour',
      label: 'עבודה',
      amount: staffing.labourCost,
      explain: `${staffing.recommendedStaff} אנשי צוות × ${staffing.estimatedMinutes} דקות`,
    },
  ])

  const allocatedFixedCosts = group(
    allocateFixedCosts({
      costs: snapshot.fixedCosts,
      contexts: input.contexts,
      facts,
      bookingRevenue: revenue.total,
      propertyId: booking.propertyId,
      unitId: booking.unitId,
    }),
  )

  const commission = group(
    snapshot.commissionRule
      ? [
          commissionLine(snapshot.commissionRule, {
            basis: snapshot.commissionRule.basis,
            revenue: revenue.total,
            accommodation: accommodationRevenue(booking),
            directCosts: directCosts.total,
            allocatedFixedCosts: allocatedFixedCosts.total,
          }),
        ]
      : [],
  )

  const netContribution =
    revenue.total -
    directCosts.total -
    allocatedFixedCosts.total -
    commission.total

  return {
    bookingId: booking.id,
    revenue,
    directCosts,
    allocatedFixedCosts,
    commission,
    netContribution,
    marginBasisPoints:
      revenue.total === 0
        ? 0
        : Math.round((netContribution * BASIS_POINTS_SCALE) / revenue.total),
  }
}

/** Every cost line of a statement, in one list. */
export function costLines(pnl: EventPnL): readonly PnLLine[] {
  return [
    ...pnl.directCosts.lines,
    ...pnl.allocatedFixedCosts.lines,
    ...pnl.commission.lines,
  ]
}

// ── Estimate against actual ───────────────────────────────────────────────

/**
 * What it really cost, against what was expected.
 *
 * Keyed by the cost's `key`, so an actual can be recorded against the rule
 * that predicted it. Actuals with no estimate appear with an estimate of zero
 * — an unbudgeted cost is precisely the thing this report exists to surface,
 * and dropping it because there is nothing to compare against would hide it.
 */
export function reconcile(
  pnl: EventPnL,
  actuals: readonly CostActual[],
): VarianceReport {
  const estimated = new Map(costLines(pnl).map((line) => [line.key, line]))
  const recorded = new Map<string, Agorot>()

  for (const actual of actuals) {
    recorded.set(actual.key, (recorded.get(actual.key) ?? 0) + actual.amount)
  }

  const keys = [...new Set([...estimated.keys(), ...recorded.keys()])].sort()

  const lines: VarianceLine[] = keys.map((key) => {
    const line = estimated.get(key)
    const estimate = line?.amount ?? 0
    const actual = recorded.get(key) ?? 0

    return {
      key,
      label: line?.label ?? key,
      estimated: estimate,
      actual,
      variance: actual - estimate,
    }
  })

  return {
    lines,
    totalEstimated: lines.reduce((total, line) => total + line.estimated, 0),
    totalActual: lines.reduce((total, line) => total + line.actual, 0),
    totalVariance: lines.reduce((total, line) => total + line.variance, 0),
  }
}
