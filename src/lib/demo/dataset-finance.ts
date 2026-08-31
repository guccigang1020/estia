/**
 * Money: what was collected, what is still owed, what was documented, what
 * the business spent, and what the external agent earned.
 *
 * ── Several states on purpose ─────────────────────────────────────────────
 *
 * A demo in which every payment is `paid` and every invoice is `issued`
 * demonstrates a screen, not a product. The rows below include a card that
 * failed, a bank transfer still pending, a partial refund, a draft invoice
 * with no number yet, and an invoice that was cancelled and re-issued —
 * because each of those is a different shape on the page and a different
 * sentence a person has to be able to read.
 *
 * ── The constraints are honoured, not worked around ───────────────────────
 *
 * `invoices_total_is_sum` means `total = subtotal + tax`, so the split is
 * computed from the total rather than typed. `invoices_issued_pair` means a
 * draft has no number and no issue date, and anything else has both.
 * `payments_paid_has_moment` means a paid payment knows when. Every one of
 * those is a row-level truth the product relies on, and a dataset that broke
 * them would be a dataset the real database would reject.
 */

import type { DemoRow } from './types'
import {
  AGENCY_ID,
  ID_GROUP,
  day,
  idsFor,
  momentOn,
  share,
  stamped,
  stampedNoDelete,
} from './dataset-support'
import { ORGANIZATION_ID, person } from './dataset-identity'
import { PROPERTY_IDS } from './dataset-inventory'
import {
  BOOKINGS,
  SOLD_BOOKINGS,
  bookedOffset,
  type DemoBooking,
} from './dataset-bookings'

const paymentIds = idsFor(ID_GROUP.payment)
const depositIds = idsFor(ID_GROUP.deposit)
const invoiceIds = idsFor(ID_GROUP.invoice)
const invoiceLineIds = idsFor(ID_GROUP.invoiceLine)
const commissionIds = idsFor(ID_GROUP.commission)
const expenseRuleIds = idsFor(ID_GROUP.expenseRule)
const allocationIds = idsFor(ID_GROUP.expenseAllocation)

const FINANCE_ID = person('general-manager').userId
const RECEPTION_ID = person('reception').userId
const OWNER_ID = person('owner').userId
const AGENT_ID = person('sales-agent').userId

/** VAT in Israel, in basis points, matching the `properties` rows. */
const VAT_BPS = 1700

/** The price is VAT-inclusive, so the tax is backed out of the total. */
function splitTax(totalAgorot: number): { subtotal: number; tax: number } {
  const subtotal = Math.round((totalAgorot * 10_000) / (10_000 + VAT_BPS))
  return { subtotal, tax: totalAgorot - subtotal }
}

/* ----------------------------------------------------------- payments ---- */

type PaymentPlan = {
  booking: DemoBooking
  amount: number
  purpose: string
  method: string
  channel: string
  status: string
  /** Days from today the money moved. Null for a payment that has not. */
  paidOffset: number | null
  refunded?: number
  failure?: { code: string; message: string }
}

/**
 * The collection story for each sold stay.
 *
 * A deposit on booking and a balance on or before arrival is the ordinary
 * Israeli pattern; the exceptions below are the ones a real week produces.
 */
const PAYMENT_PLANS: PaymentPlan[] = []

SOLD_BOOKINGS.forEach((booking, index) => {
  const depositAmount = share(booking.totalAgorot, 30)
  const balanceAmount = booking.totalAgorot - depositAmount
  const arrived = booking.startOffset <= 0

  // Every sold stay pays a deposit when it is booked.
  PAYMENT_PLANS.push({
    booking,
    amount: depositAmount,
    purpose: 'deposit',
    method: index % 4 === 1 ? 'bit' : 'card',
    channel: index % 4 === 1 ? 'payment_link' : 'hosted_page',
    status: 'paid',
    paidOffset: Math.min(bookedOffset(booking) + 1, 0),
  })

  // The balance falls due on arrival, so only stays that have arrived have
  // one — anything else would be money the business has not been given.
  if (!arrived) return

  if (index === 3) {
    // A card that was declined, and then a transfer that has not landed. Two
    // rows, because that is two events and the reconciliation screen has to
    // show both.
    PAYMENT_PLANS.push({
      booking,
      amount: balanceAmount,
      purpose: 'balance',
      method: 'card',
      channel: 'hosted_page',
      status: 'failed',
      paidOffset: null,
      failure: {
        code: 'card_declined',
        message: 'הכרטיס נדחה על ידי חברת האשראי (יתרה לא מספקת).',
      },
    })
    PAYMENT_PLANS.push({
      booking,
      amount: balanceAmount,
      purpose: 'balance',
      method: 'bank_transfer',
      channel: 'manual',
      status: 'pending',
      paidOffset: null,
    })
    return
  }

  if (index === 6) {
    // Paid in full and then partly refunded — a night was cut short.
    PAYMENT_PLANS.push({
      booking,
      amount: balanceAmount,
      purpose: 'balance',
      method: 'card',
      channel: 'terminal',
      status: 'partially_refunded',
      paidOffset: booking.startOffset,
      refunded: share(balanceAmount, 25),
    })
    return
  }

  PAYMENT_PLANS.push({
    booking,
    amount: balanceAmount,
    purpose: 'balance',
    method: index % 5 === 0 ? 'cash' : 'card',
    channel: index % 5 === 0 ? 'manual' : 'terminal',
    status: 'paid',
    paidOffset: booking.startOffset,
  })
})

export const PAYMENTS = PAYMENT_PLANS.map((plan, index) => ({
  ...plan,
  id: paymentIds(index + 1),
}))

export const PAYMENT_ROWS: DemoRow[] = PAYMENTS.map((payment) => ({
  id: payment.id,
  organization_id: ORGANIZATION_ID,
  property_id: payment.booking.unit.propertyId,
  booking_id: payment.booking.id,
  status: payment.status,
  method: payment.method,
  amount_agorot: payment.amount,
  currency: 'ILS',
  amount_refunded_agorot: payment.refunded ?? 0,
  idempotency_key: `demo-pay-${payment.id}`,
  provider: payment.method === 'cash' ? null : 'cardcom',
  provider_payment_id:
    payment.method === 'cash'
      ? null
      : `cc_${payment.id.replace(/-/g, '').slice(-14)}`,
  provider_reference: null,
  provider_status: payment.status === 'failed' ? 'declined' : null,
  failure_code: payment.failure?.code ?? null,
  failure_message: payment.failure?.message ?? null,
  authorized_at:
    payment.paidOffset === null ? null : momentOn(payment.paidOffset, '13:40'),
  // `payments_paid_has_moment`: a payment that says it was paid must say when.
  paid_at:
    payment.paidOffset === null ? null : momentOn(payment.paidOffset, '13:41'),
  failed_at: payment.status === 'failed' ? momentOn(-1, '19:05') : null,
  cancelled_at: null,
  payer_name: payment.booking.guestName,
  payer_reference: payment.booking.reference,
  note: null,
  metadata: {},
  // Added by 0016 with defaults, and filled in because a payment with no
  // purpose and no channel cannot be reconciled against a provider.
  authorized_agorot: payment.paidOffset === null ? 0 : payment.amount,
  captured_agorot: payment.status === 'paid' ? payment.amount : 0,
  purpose: payment.purpose,
  channel: payment.channel,
  requires_attention: payment.status === 'pending' ? 'reconcile_unknown' : null,
  unknown_since: payment.status === 'pending' ? momentOn(-1, '19:10') : null,
  last_provider_event_at:
    payment.paidOffset === null ? null : momentOn(payment.paidOffset, '13:41'),
  schedule_id: null,
  instalment_number: null,
  due_on: null,
  ...stampedNoDelete(RECEPTION_ID, bookedOffset(payment.booking)),
}))

/* ----------------------------------------------------------- deposits ---- */

type DepositPlan = {
  booking: DemoBooking
  status: string
  held: number
  released: number
  forfeited: number
  reason: string | null
}

/**
 * Security deposits, one per booking at most — the table says so.
 *
 * Only the villa and the family cabin take one, which is how it actually
 * works: nobody holds ₪2,500 against a midweek room.
 */
const DEPOSIT_PLANS: readonly DepositPlan[] = (() => {
  const eligible = SOLD_BOOKINGS.filter(
    (booking) => booking.unit.depositAgorot >= 50_000,
  ).slice(0, 6)

  return eligible.map((booking, index) => {
    const required = booking.unit.depositAgorot
    if (booking.status === 'no_show') {
      return {
        booking,
        status: 'paid',
        held: required,
        released: 0,
        forfeited: required,
        // `deposits_forfeit_has_reason`: money kept must say why.
        reason: 'האורח לא הגיע ולא ביטל — חולט לפי מדיניות הביטול.',
      }
    }
    if (booking.startOffset + booking.nights < 0) {
      return {
        booking,
        status: 'refunded',
        held: required,
        released: required,
        forfeited: 0,
        reason: null,
      }
    }
    if (index % 3 === 2) {
      return {
        booking,
        status: 'authorized',
        held: 0,
        released: 0,
        forfeited: 0,
        reason: null,
      }
    }
    return {
      booking,
      status: 'paid',
      held: required,
      released: 0,
      forfeited: 0,
      reason: null,
    }
  })
})()

export const DEPOSIT_ROWS: DemoRow[] = DEPOSIT_PLANS.map((plan, index) => ({
  id: depositIds(index + 1),
  organization_id: ORGANIZATION_ID,
  property_id: plan.booking.unit.propertyId,
  booking_id: plan.booking.id,
  status: plan.status,
  method: 'card',
  required_agorot: plan.booking.unit.depositAgorot,
  held_agorot: plan.held,
  released_agorot: plan.released,
  forfeited_agorot: plan.forfeited,
  currency: 'ILS',
  payment_id: null,
  idempotency_key: `demo-dep-${plan.booking.reference}`,
  authorized_at: momentOn(Math.min(plan.booking.startOffset - 1, 0), '10:00'),
  captured_at:
    plan.held > 0
      ? momentOn(Math.min(plan.booking.startOffset, 0), '15:20')
      : null,
  released_at:
    plan.released > 0
      ? momentOn(plan.booking.startOffset + plan.booking.nights + 1, '12:00')
      : null,
  released_by: plan.released > 0 ? FINANCE_ID : null,
  forfeited_at:
    plan.forfeited > 0 ? momentOn(plan.booking.startOffset + 1, '09:30') : null,
  forfeit_reason: plan.reason,
  note: null,
  metadata: {},
  ...stampedNoDelete(RECEPTION_ID, bookedOffset(plan.booking)),
}))

/* ----------------------------------------------------------- invoices ---- */

type InvoicePlan = {
  booking: DemoBooking
  kind: string
  status: string
  number: number | null
  issuedOffset: number | null
  cancelledOffset?: number
}

/**
 * Documents, for the stays that are far enough along to have earned one.
 *
 * Numbering is sequential and gapless within the series, which is what
 * `invoice_sequences` exists to guarantee — a cancelled document keeps its
 * number rather than freeing it, because a tax authority reads the gap as a
 * missing document rather than as a mistake somebody fixed.
 */
const INVOICE_PLANS: readonly InvoicePlan[] = (() => {
  const documented = SOLD_BOOKINGS.filter(
    (booking) => booking.startOffset + booking.nights <= 0,
  )

  return documented.map((booking, index) => {
    if (index === 2) {
      return {
        booking,
        kind: 'tax_invoice_receipt',
        status: 'cancelled',
        number: index + 20,
        issuedOffset: booking.startOffset + booking.nights,
        cancelledOffset: booking.startOffset + booking.nights + 2,
      }
    }
    if (index === documented.length - 1) {
      // Still a draft: the stay ended, nobody has issued the document yet.
      // `invoices_issued_pair` forbids it from carrying a number.
      return {
        booking,
        kind: 'tax_invoice',
        status: 'draft',
        number: null,
        issuedOffset: null,
      }
    }
    return {
      booking,
      kind: index % 3 === 0 ? 'tax_invoice_receipt' : 'tax_invoice',
      status: 'issued',
      number: index + 20,
      issuedOffset: booking.startOffset + booking.nights,
    }
  })
})()

const CURRENT_YEAR = Number(day(0).slice(0, 4))

export const INVOICES = INVOICE_PLANS.map((plan, index) => ({
  ...plan,
  id: invoiceIds(index + 1),
  ...splitTax(plan.booking.totalAgorot),
}))

export const INVOICE_ROWS: DemoRow[] = INVOICES.map((invoice) => ({
  id: invoice.id,
  organization_id: ORGANIZATION_ID,
  property_id: invoice.booking.unit.propertyId,
  booking_id: invoice.booking.id,
  kind: invoice.kind,
  status: invoice.status,
  series: 'default',
  year: CURRENT_YEAR,
  number: invoice.number,
  display_number:
    invoice.number === null ? null : `${CURRENT_YEAR}-${invoice.number}`,
  customer_name: invoice.booking.guestName,
  customer_tax_id: null,
  customer_address: null,
  customer_email: null,
  subtotal_agorot: invoice.subtotal,
  tax_agorot: invoice.tax,
  total_agorot: invoice.booking.totalAgorot,
  tax_rate_bps: VAT_BPS,
  tourist_vat_exempt: false,
  currency: 'ILS',
  issued_at:
    invoice.issuedOffset === null
      ? null
      : momentOn(invoice.issuedOffset, '11:30'),
  due_date:
    invoice.issuedOffset === null ? null : day(invoice.issuedOffset + 30),
  cancelled_at:
    invoice.cancelledOffset === undefined
      ? null
      : momentOn(invoice.cancelledOffset, '16:45'),
  cancelled_by: invoice.cancelledOffset === undefined ? null : FINANCE_ID,
  cancellation_reason:
    invoice.cancelledOffset === undefined
      ? null
      : 'הוצאה על שם שגוי; הוצא מסמך מתקן.',
  idempotency_key: `demo-inv-${invoice.booking.reference}`,
  provider: 'greeninvoice',
  provider_invoice_id: invoice.number === null ? null : `gi_${invoice.number}`,
  document_url: null,
  note: null,
  metadata: {},
  ...stampedNoDelete(
    FINANCE_ID,
    invoice.booking.startOffset + invoice.booking.nights,
  ),
}))

export const INVOICE_LINE_ROWS: DemoRow[] = INVOICES.flatMap(
  (invoice, invoiceIndex) =>
    invoice.booking.lines.map((line, lineIndex) => ({
      id: invoiceLineIds(invoiceIndex * 10 + lineIndex + 1),
      organization_id: ORGANIZATION_ID,
      invoice_id: invoice.id,
      kind: line.kind,
      label: line.label,
      amount_agorot: line.amountAgorot,
      quantity: line.quantity,
      line_date: line.kind === 'accommodation' ? invoice.booking.checkIn : null,
      sort_order: lineIndex,
      created_at: momentOn(
        invoice.booking.startOffset + invoice.booking.nights,
        '11:30',
      ),
    })),
)

/**
 * Which payment settled which document.
 *
 * Only issued documents are linked: a draft has settled nothing, and a
 * cancelled one settled something that was then undone.
 */
export const INVOICE_PAYMENT_ROWS: DemoRow[] = INVOICES.filter(
  (invoice) => invoice.status === 'issued',
).flatMap((invoice) =>
  PAYMENTS.filter(
    (payment) =>
      payment.booking.id === invoice.booking.id && payment.status === 'paid',
  ).map((payment) => ({
    invoice_id: invoice.id,
    payment_id: payment.id,
    organization_id: ORGANIZATION_ID,
    booking_id: invoice.booking.id,
    metadata: {},
    created_at: momentOn(
      invoice.booking.startOffset + invoice.booking.nights,
      '11:31',
    ),
    created_by: FINANCE_ID,
  })),
)

/* -------------------------------------------------------- commissions ---- */

/** Ten per cent of the nights, which is what the agreement below says. */
const COMMISSION_BPS = 1000

const AGENT_BOOKINGS = BOOKINGS.filter((booking) => booking.source === 'agent')

export const COMMISSION_ROWS: DemoRow[] = AGENT_BOOKINGS.map(
  (booking, index) => {
    // `accommodation_only`: the agreement pays on the nights, not on the
    // cleaning fee and not on a discount line.
    const basis =
      booking.lines.find((line) => line.kind === 'accommodation')
        ?.amountAgorot ?? 0
    const amount = Math.round((basis * COMMISSION_BPS) / 10_000)
    const ended = booking.startOffset + booking.nights < 0

    const status =
      booking.status === 'cancelled'
        ? 'cancelled'
        : ended
          ? 'paid'
          : booking.startOffset <= 14
            ? 'approved'
            : 'estimated'

    return {
      id: commissionIds(index + 1),
      organization_id: ORGANIZATION_ID,
      property_id: booking.unit.propertyId,
      booking_id: booking.id,
      // `commissions_has_a_payee`: one of the two must be present.
      agent_user_id: AGENT_ID,
      agency_id: AGENCY_ID,
      status,
      basis_agorot: basis,
      rate_bps: COMMISSION_BPS,
      amount_agorot: status === 'cancelled' ? 0 : amount,
      currency: 'ILS',
      eligible_at:
        status === 'estimated' || status === 'cancelled'
          ? null
          : momentOn(booking.startOffset + booking.nights, '12:00'),
      approved_at:
        status === 'approved' || status === 'paid'
          ? momentOn(
              Math.min(booking.startOffset + booking.nights + 1, 0),
              '12:00',
            )
          : null,
      approved_by:
        status === 'approved' || status === 'paid' ? FINANCE_ID : null,
      paid_at:
        status === 'paid'
          ? momentOn(booking.startOffset + booking.nights + 7, '12:00')
          : null,
      payout_reference: status === 'paid' ? `PAYOUT-${index + 1}` : null,
      cancelled_at: status === 'cancelled' ? momentOn(-4, '10:00') : null,
      cancellation_reason:
        status === 'cancelled' ? 'ההזמנה בוטלה, ולכן אין עמלה.' : null,
      note: null,
      metadata: {},
      rule_id: null,
      rule_version: null,
      base: 'accommodation_only',
      explanation: `10% מסך הלינות (${basis / 100} ₪).`,
      eligibility: ['stay_completed'],
      statement_id: null,
      payout_batch_id: null,
      clawback_required: false,
      ...stampedNoDelete(FINANCE_ID, bookedOffset(booking)),
    }
  },
)

/* ----------------------------------------------------------- expenses ---- */

/**
 * What the business spends, as rules rather than as a ledger.
 *
 * `expense_rules` plus `expense_allocations` is how this schema models cost:
 * a rule says what recurs, and an allocation says which booking carried a
 * share of it. There is no `expenses` table, and inventing rows for one would
 * be describing a database that does not exist.
 */
type ExpenseSeed = {
  label: string
  category: string
  kind: string
  frequency: string
  /** The periodic amount of a `fixed` rule. Zero for a variable one — see below. */
  amount: number
  /** `expense_rules_formula_pair`: present for a variable rule, null for a fixed one. */
  formula: Record<string, unknown> | null
  allocation: string
  scopeKind: string
  propertyId: string | null
  approval: boolean
}

/**
 * What one cleaning costs, and what one night of laundry costs.
 *
 * Named constants because the allocation rows below charge bookings the
 * cleaning rate, and a second copy of the figure is a second figure that
 * eventually disagrees with the first.
 */
const CLEANING_AGOROT = 16_000
const LAUNDRY_PER_NIGHT_AGOROT = 4_200

const EXPENSE_SEEDS: readonly ExpenseSeed[] = [
  {
    label: 'ניקיון יחידה',
    category: 'תפעול',
    kind: 'variable',
    frequency: 'one_time',
    // `expense_rules_formula_pair` requires `(kind = 'variable') = (formula is
    // not null)`, and a variable rule's cost is its formula rather than a
    // periodic amount — so the figure lives in `formula` and `amount_agorot`
    // is zero. Written the other way round, the database refuses the row and
    // the domain's own `variableAmount` computes nothing.
    amount: 0,
    formula: { kind: 'per_booking', rateAgorot: CLEANING_AGOROT },
    allocation: 'per_booking',
    scopeKind: 'organization',
    propertyId: null,
    approval: false,
  },
  {
    label: 'כביסת מצעים ומגבות',
    category: 'תפעול',
    kind: 'variable',
    frequency: 'one_time',
    amount: 0,
    formula: { kind: 'per_night', rateAgorot: LAUNDRY_PER_NIGHT_AGOROT },
    allocation: 'per_occupied_night',
    scopeKind: 'organization',
    propertyId: null,
    approval: false,
  },
  {
    label: 'חשמל ומים — רימונים',
    category: 'תשתיות',
    kind: 'fixed',
    frequency: 'monthly',
    amount: 310_000,
    formula: null,
    allocation: 'per_day',
    scopeKind: 'property',
    propertyId: PROPERTY_IDS.rimonim,
    approval: false,
  },
  {
    label: 'ארנונה — כחול ים',
    category: 'מיסים',
    kind: 'fixed',
    frequency: 'quarterly',
    amount: 480_000,
    formula: null,
    allocation: 'by_revenue',
    scopeKind: 'property',
    propertyId: PROPERTY_IDS.kacholYam,
    approval: false,
  },
  {
    label: 'עמלת סליקה',
    category: 'פיננסי',
    kind: 'variable',
    frequency: 'one_time',
    amount: 0,
    // 145 basis points. `percent_of_revenue` is the one formula whose figure is
    // a percentage rather than agorot, and the adapter reads `bps` into the
    // percentage points the domain's `VariableFormula` declares — 1.45, not 145.
    formula: { kind: 'percent_of_revenue', bps: 145 },
    allocation: 'by_revenue',
    scopeKind: 'organization',
    propertyId: null,
    approval: false,
  },
  {
    label: 'תחזוקת בריכה',
    category: 'אחזקה',
    kind: 'fixed',
    frequency: 'monthly',
    amount: 145_000,
    formula: null,
    allocation: 'per_day',
    scopeKind: 'organization',
    propertyId: null,
    approval: true,
  },
]

export const EXPENSE_RULE_ROWS: DemoRow[] = EXPENSE_SEEDS.map(
  (seed, index) => ({
    id: expenseRuleIds(index + 1),
    organization_id: ORGANIZATION_ID,
    label: seed.label,
    category: seed.category,
    kind: seed.kind,
    frequency: seed.frequency,
    amount_agorot: seed.amount,
    formula: seed.formula,
    allocation: seed.allocation,
    scope_kind: seed.scopeKind,
    scope_property_id: seed.propertyId,
    scope_unit_id: null,
    scope_booking_id: null,
    effective_from: day(-365),
    effective_to: null,
    approval_required: seed.approval,
    metadata: {},
    ...stamped(OWNER_ID, -365),
  }),
)

/** A handful of stays that carried a share of the cleaning rule. */
export const EXPENSE_ALLOCATION_ROWS: DemoRow[] = SOLD_BOOKINGS.filter(
  (booking) => booking.startOffset + booking.nights <= 0,
)
  .slice(0, 8)
  .map((booking, index) => ({
    id: allocationIds(index + 1),
    organization_id: ORGANIZATION_ID,
    rule_id: expenseRuleIds(1),
    rule_version: 1,
    booking_id: booking.id,
    method: 'per_booking',
    period_start: booking.checkIn,
    period_end: booking.checkOut,
    // The cleaning rate, not the rule's `amount_agorot` — which is zero, as a
    // variable rule's must be. What a booking carried is what the formula
    // produced for it, and for `per_booking` that is one flat rate.
    amount_agorot: CLEANING_AGOROT,
    weight: '1.000000',
    basis: 'הזמנה אחת',
    allocated_at: momentOn(booking.startOffset + booking.nights, '23:30'),
    allocated_by: null,
  }))
