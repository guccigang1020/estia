/**
 * Expenses, and how a cost reaches a booking.
 *
 * Two kinds of cost, and they behave nothing alike.
 *
 * A **variable** cost is caused by the stay: laundry per night, a welcome
 * basket per guest, a channel fee as a percentage of revenue. It is computed
 * *from* the booking, so there is nothing to allocate — the booking that
 * caused it carries it, whole.
 *
 * A **fixed** cost belongs to a period: insurance, a cleaning retainer, the
 * accountant. It exists whether or not anybody stayed, and attributing it to
 * stays is a judgement the business makes, not a fact the system knows. Seven
 * methods, because businesses genuinely disagree and the disagreement is not
 * about rounding — it changes which bookings look profitable enough to keep
 * selling.
 *
 * ── The rule every method obeys ───────────────────────────────────────────
 *
 * **Shares plus unallocated equals the total, exactly, always.** Every method
 * routes through the largest-remainder allocators in `money.ts`, and every
 * result is checked before it is returned. A cost that cannot be attributed —
 * a month with no bookings still owes the insurer — is reported as
 * `unallocatedAgorot` and carried by the property P&L. It is never forced onto
 * an arbitrary stay to make a column add up, and it is never silently dropped,
 * which is the same lie told quietly.
 *
 * ── Proration ─────────────────────────────────────────────────────────────
 *
 * A monthly rule read over a period is prorated by the *calendar* length of
 * the unit the period starts in, not by an average. A monthly cost read over
 * exactly March is exactly the monthly amount; read over the first half of
 * March it is 15/31 of it, rounded once. Averages ("30.44 days") produce a
 * yearly total that is not twelve times the monthly figure, and an owner who
 * checks will find it.
 */

import { eachNight } from '../booking/dates'
import { nightsBetween, type Agorot, type DateRange } from '../booking/types'
import { BusinessRuleError } from '../errors'
import {
  allocateByWeight,
  allocateEvenly,
  applyPercent,
  assertSumsExactly,
  roundAgorot,
  sumAgorot,
} from './money'
import type {
  AllocatableBooking,
  AllocationMethod,
  AllocationResult,
  AllocationShare,
  ExpenseFrequency,
  ExpenseRule,
  VariableFormula,
} from './types'

// ── Periods ───────────────────────────────────────────────────────────────

/** Half-open `[start, end)`, the same convention as a stay and a metric window. */
export interface ExpensePeriod {
  start: string
  end: string
}

function periodDays(period: ExpensePeriod): number {
  return nightsBetween({ checkIn: period.start, checkOut: period.end })
}

/**
 * How many calendar days one occurrence of this frequency covers.
 *
 * Measured from the period's start, so the unit is the real one: February is
 * 28 days and the next month is 31, and a rule prorated over either lands on
 * the figure an accountant would write down.
 */
function unitDays(
  frequency: ExpenseFrequency,
  periodStart: string,
): number | null {
  const [year, month] = periodStart.split('-').map(Number)

  switch (frequency) {
    case 'one_time':
      return null
    case 'daily':
      return 1
    case 'weekly':
      return 7
    case 'monthly':
      return new Date(Date.UTC(year, month, 0)).getUTCDate()
    case 'quarterly':
      return (
        (Date.UTC(year, month - 1 + 3, 1) - Date.UTC(year, month - 1, 1)) /
        86_400_000
      )
    case 'yearly':
      return (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000
    default:
      return null
  }
}

/**
 * What a fixed rule costs over a window.
 *
 * `one_time` is not prorated: a one-off purchase does not become two thirds of
 * itself because the report covers two thirds of a month.
 */
export function periodicAmount(
  rule: ExpenseRule,
  period: ExpensePeriod,
): Agorot {
  if (rule.kind !== 'fixed') return 0

  const unit = unitDays(rule.frequency, period.start)
  if (unit === null) return rule.amountAgorot

  const days = periodDays(period)
  if (!Number.isFinite(days) || days <= 0) return 0

  // Rounded exactly once, here, from the exact ratio. Never a rounded daily
  // rate multiplied up, which drifts by a day's rounding for every day.
  return roundAgorot((rule.amountAgorot * days) / unit)
}

// ── Variable costs ────────────────────────────────────────────────────────

/**
 * What a variable rule costs for one booking.
 *
 * A closed set of formulas, evaluated as code. There is deliberately no
 * expression the customer types: a string evaluated at runtime is remote code
 * execution wearing a spreadsheet's clothes, and a formula nobody can
 * enumerate is a formula nobody can test.
 */
export function variableAmount(
  formula: VariableFormula,
  booking: AllocatableBooking,
): Agorot {
  switch (formula.kind) {
    case 'per_night':
      return formula.rateAgorot * booking.nights
    case 'per_guest_night':
      return formula.rateAgorot * booking.guests * booking.nights
    case 'per_booking':
      return formula.rateAgorot
    case 'per_guest':
      return formula.rateAgorot * booking.guests
    case 'percent_of_revenue':
      return applyPercent(booking.netRevenueAgorot, formula.percent)
    default:
      // Deny by default: an unrecognised formula costs nothing rather than
      // guessing at a number that will end up on an owner's statement.
      return 0
  }
}

// ── Allocation ────────────────────────────────────────────────────────────

export interface AllocationInput {
  method: AllocationMethod
  totalAgorot: Agorot
  period: ExpensePeriod
  bookings: readonly AllocatableBooking[]
  /**
   * The units the cost belongs to, for `by_unit`.
   *
   * Supplied when idle units must carry a share: a two-cabin property where
   * one cabin sold nothing still owes half the insurance, and deriving the
   * unit set from the bookings alone would quietly hand all of it to the cabin
   * that worked.
   */
  unitIds?: readonly string[]
  /** Explicit weights by booking id, for `custom`. */
  customWeights?: Readonly<Record<string, number>>
}

const BASIS: Record<AllocationMethod, string> = {
  per_day: 'לפי ימי התקופה — כל יום מתחלק בין ההזמנות שתפסו אותו',
  per_occupied_night: 'לפי לילות תפוסים בתקופה',
  per_booking: 'בחלוקה שווה בין ההזמנות בתקופה',
  per_guest: 'לפי מספר האורחים בכל הזמנה',
  by_revenue: 'לפי ההכנסה נטו של כל הזמנה',
  by_unit: 'בחלוקה שווה בין היחידות, ואז לפי לילות בתוך כל יחידה',
  custom: 'לפי משקלים שהוגדרו ידנית',
}

/**
 * Attribute a period cost to the stays inside it.
 *
 * Returns a share for **every** booking, including the zeros. A booking absent
 * from the result would be indistinguishable from a booking that carried
 * nothing, and the second is a fact worth showing on a P&L.
 */
export function allocateExpense(input: AllocationInput): AllocationResult {
  const { method, totalAgorot, bookings } = input

  const result =
    method === 'per_day'
      ? allocatePerDay(input)
      : method === 'by_unit'
        ? allocateByUnit(input)
        : allocateByWeights(input, weightsFor(input))

  assertSumsExactly(
    `allocateExpense(${method})`,
    [
      ...result.shares.map((share) => share.amountAgorot),
      result.unallocatedAgorot,
    ],
    totalAgorot,
  )

  if (result.shares.length !== bookings.length) {
    throw new BusinessRuleError({
      code: 'finance.allocation_incomplete',
      userMessage: 'אירעה תקלה בחישוב ההוצאות. פנה לתמיכה.',
      message:
        `Allocation produced ${result.shares.length} shares for ` +
        `${bookings.length} bookings`,
    })
  }

  return result
}

/** The weight each booking carries, for the methods that are a simple ratio. */
function weightsFor(input: AllocationInput): number[] {
  const { method, bookings, period } = input

  switch (method) {
    case 'per_occupied_night':
      return bookings.map((booking) => nightsInPeriod(booking.range, period))
    case 'per_booking':
      return bookings.map(() => 1)
    case 'per_guest':
      return bookings.map((booking) => Math.max(0, booking.guests))
    case 'by_revenue':
      // Negative revenue carries no cost. A stay in net refund has no share of
      // the insurance premium, and forcing one produces a negative allocation
      // beside positive ones that no longer add to the whole.
      return bookings.map((booking) => Math.max(0, booking.netRevenueAgorot))
    case 'custom': {
      const weights = input.customWeights ?? {}
      return bookings.map((booking) => {
        const weight = weights[booking.bookingId] ?? 0
        return Number.isFinite(weight) && weight > 0 ? weight : 0
      })
    }
    default:
      return bookings.map(() => 0)
  }
}

function allocateByWeights(
  input: AllocationInput,
  weights: readonly number[],
): AllocationResult {
  const amounts = allocateByWeight(input.totalAgorot, weights)
  const shares: AllocationShare[] = input.bookings.map((booking, index) => ({
    bookingId: booking.bookingId,
    amountAgorot: amounts[index] ?? 0,
    weight: weights[index] ?? 0,
  }))

  return {
    method: input.method,
    totalAgorot: input.totalAgorot,
    shares,
    unallocatedAgorot:
      input.totalAgorot - sumAgorot(shares.map((s) => s.amountAgorot)),
    basis: BASIS[input.method],
  }
}

/**
 * Per calendar day of the period.
 *
 * Each day of the period carries an equal share of the cost, and that day's
 * share is split evenly between the bookings occupying it — across all units,
 * because the cost belongs to the business and not to a room. A day nobody
 * occupied leaves its share unallocated, which is exactly the statement this
 * method makes: the cost existed whether or not anyone stayed.
 *
 * Two levels of exact allocation, so nothing is lost at either.
 */
function allocatePerDay(input: AllocationInput): AllocationResult {
  const { totalAgorot, period, bookings } = input
  const days = eachNight({ checkIn: period.start, checkOut: period.end })

  const perDay = allocateEvenly(totalAgorot, days.length)
  const totals = new Map<string, Agorot>(
    bookings.map((booking) => [booking.bookingId, 0]),
  )
  const occupiedDays = new Map<string, number>(
    bookings.map((booking) => [booking.bookingId, 0]),
  )

  let unallocated = 0

  for (let index = 0; index < days.length; index += 1) {
    const day = days[index]
    const occupants = bookings.filter((booking) =>
      coversDay(booking.range, day),
    )

    if (occupants.length === 0) {
      unallocated += perDay[index]
      continue
    }

    const split = allocateEvenly(perDay[index], occupants.length)
    occupants.forEach((booking, position) => {
      totals.set(
        booking.bookingId,
        (totals.get(booking.bookingId) ?? 0) + split[position],
      )
      occupiedDays.set(
        booking.bookingId,
        (occupiedDays.get(booking.bookingId) ?? 0) + 1,
      )
    })
  }

  const shares: AllocationShare[] = bookings.map((booking) => ({
    bookingId: booking.bookingId,
    amountAgorot: totals.get(booking.bookingId) ?? 0,
    weight: occupiedDays.get(booking.bookingId) ?? 0,
  }))

  return {
    method: 'per_day',
    totalAgorot,
    shares,
    unallocatedAgorot: unallocated,
    basis: BASIS.per_day,
  }
}

/**
 * Evenly across units, then by nights inside each unit.
 *
 * The two-step exists because "by unit" is a statement about the asset, not
 * about the stays: each cabin owes an equal share of the property's fixed
 * cost, and what happened inside a cabin decides only how that cabin's share
 * is divided between its own guests. A unit that sold nothing keeps its share
 * unallocated rather than pushing it onto the cabin that worked.
 */
function allocateByUnit(input: AllocationInput): AllocationResult {
  const { totalAgorot, period, bookings } = input

  const units =
    input.unitIds && input.unitIds.length > 0
      ? [...new Set(input.unitIds)]
      : [...new Set(bookings.map((booking) => booking.unitId))]

  if (units.length === 0) {
    return {
      method: 'by_unit',
      totalAgorot,
      shares: bookings.map((booking) => ({
        bookingId: booking.bookingId,
        amountAgorot: 0,
        weight: 0,
      })),
      unallocatedAgorot: totalAgorot,
      basis: BASIS.by_unit,
    }
  }

  const perUnit = allocateEvenly(totalAgorot, units.length)
  const totals = new Map<string, Agorot>(
    bookings.map((booking) => [booking.bookingId, 0]),
  )
  const weights = new Map<string, number>(
    bookings.map((booking) => [booking.bookingId, 0]),
  )

  let unallocated = 0

  units.forEach((unitId, index) => {
    const inUnit = bookings.filter((booking) => booking.unitId === unitId)
    const nights = inUnit.map((booking) =>
      nightsInPeriod(booking.range, period),
    )
    const amounts = allocateByWeight(perUnit[index], nights)
    const allocated = sumAgorot(amounts)

    inUnit.forEach((booking, position) => {
      totals.set(booking.bookingId, amounts[position])
      weights.set(booking.bookingId, nights[position])
    })

    unallocated += perUnit[index] - allocated
  })

  const shares: AllocationShare[] = bookings.map((booking) => ({
    bookingId: booking.bookingId,
    amountAgorot: totals.get(booking.bookingId) ?? 0,
    weight: weights.get(booking.bookingId) ?? 0,
  }))

  return {
    method: 'by_unit',
    totalAgorot,
    shares,
    unallocatedAgorot: unallocated,
    basis: BASIS.by_unit,
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────

/** Nights of this stay that fall inside the window. Half-open on both sides. */
export function nightsInPeriod(
  range: DateRange,
  period: ExpensePeriod,
): number {
  const start = range.checkIn > period.start ? range.checkIn : period.start
  const end = range.checkOut < period.end ? range.checkOut : period.end
  if (start >= end) return 0
  const nights = nightsBetween({ checkIn: start, checkOut: end })
  return Number.isFinite(nights) ? nights : 0
}

function coversDay(range: DateRange, day: string): boolean {
  return day >= range.checkIn && day < range.checkOut
}
