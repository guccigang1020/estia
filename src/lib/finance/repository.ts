/**
 * The finance data port.
 *
 * The domain does not open a connection. Everything above this line is pure —
 * which is why the whole module is testable without a database, and why the
 * rules can be proved rather than demonstrated.
 *
 * The shapes here are the domain's, not the schema's: the adapter maps
 * `amount_agorot` to `amountAgorot` and `provider_payment_id` to `providerRef`
 * on the way through. That mapping is deliberately the adapter's job. A domain
 * that spoke in column names would have to change every time a column was
 * renamed, and a schema that spoke in domain names would have to change every
 * time the domain learned a better word.
 *
 * ── One method that is not a mapping ──────────────────────────────────────
 *
 * `allocateInvoiceNumber` is a call to the database's `next_invoice_number()`,
 * and it must stay that way. An Israeli tax invoice carries a gapless
 * sequential number, and "read the highest, add one, insert" is the double
 * booking race in different clothes: two issuers read the same number and
 * either one fails or — on a table without the right unique index — both
 * succeed and two legal documents share a number. The counter row lock is the
 * serialisation, so allocation is one statement with no read. Nothing in this
 * module may reimplement it.
 */

import type { PriceLine } from '../booking/types'
import type {
  CommissionBase,
  CommissionStatus,
  PaymentMethod,
  PaymentStatus,
} from '../contracts/states'
import type { TransactionHandle } from '../service/transaction'
import type { FinanceSnapshot } from './snapshot'
import type {
  AllocationMethod,
  CollectionChannel,
  Commission,
  CommissionRule,
  CreditNote,
  Deposit,
  ExpenseFrequency,
  ExpenseKind,
  ExpenseScope,
  ExpenseScopeKind,
  Invoice,
  InvoiceKind,
  InvoiceStatus,
  Payment,
  PaymentAttention,
  PaymentPurpose,
  Refund,
  VariableFormula,
} from './types'

/* ============================================================== listing == */

/**
 * The question a list screen asks, which the per-booking methods cannot answer.
 *
 * `loadPaymentsForBooking` and its two siblings are the write path's reads: a
 * booking is in hand and its money is wanted. A list screen has no booking —
 * it asks "every payment in this organization" — and building that out of the
 * per-booking methods is one round trip per booking, an N+1 over the table the
 * business opens every morning. So the port answers it directly.
 *
 * ── Why these return rows and not `Payment` ───────────────────────────────
 *
 * A `Payment` carries `appliedEventIds`, which is a second query against
 * `payment_provider_events` for every row on the page, and a list prints none
 * of it. An `Invoice` carries `currency` and `metadata` for the same reason. A
 * list row is what the list actually reads — narrower on purpose, and the
 * narrowing is the reason the port grew a second shape rather than reusing the
 * record the operations write.
 *
 * ── Why the flags, rather than an `Actor` ─────────────────────────────────
 *
 * Two of these reads are *conditional on a grant*: booking references are
 * skipped without `booking.view` because `bookings_select` would return nothing
 * and the round trip cannot succeed, and a commission's free-text label is not
 * built for a reader who may not see the base it spells out. Those are
 * authorization decisions and they belong to the caller — a repository that
 * took an `Actor` would put `can()` inside the data port and force the
 * in-memory double to reimplement the authorization engine. So the caller
 * answers the question and passes the answer; the port only obeys it.
 *
 * `can()` per row and `redact()` per field stay above this line, in
 * `finance/_lib/queries.ts`, where they were.
 */
export interface FinanceListQuery<S extends string> {
  organizationId: string
  /** A single property, or null for every property the reader can reach. */
  propertyId: string | null
  /** Null means every status. */
  status: S | null
  limit: number
}

export interface PaymentListQuery extends FinanceListQuery<PaymentStatus> {
  /** False without `booking.view`; every row then falls back to its own snapshot. */
  withBookingReferences: boolean
}

export interface InvoiceListQuery extends FinanceListQuery<InvoiceStatus> {
  /**
   * False without `payment.view`, which makes `payments` null rather than
   * empty — "you may not see them" and "there are none" are different
   * sentences, and collapsing them tells a reader an invoice is unpaid because
   * of their own permissions.
   */
  withLinkedPayments: boolean
  /** False without `booking.view_price`. The link keeps its status, not its amount. */
  withLinkedAmounts: boolean
}

export interface CommissionListQuery extends FinanceListQuery<CommissionStatus> {
  withBookingReferences: boolean
  /**
   * False without `booking.view_price`.
   *
   * `CommissionRule.label` is derived from `commissions.explanation`, which
   * routinely spells the base out in words — "10% מסך הלינות (4,500 ₪)". It is
   * the base by another name, it lives one level down inside `rule`, and
   * `redact()` cannot reach into a nested object. So it is never built.
   */
  withRuleLabel: boolean
}

/** Expense rules are scoped, not owned by a property column. See `ExpenseScope`. */
export interface ExpenseRuleListQuery {
  organizationId: string
  /**
   * Narrow to one property.
   *
   * Organization-wide rules are returned regardless: a rule that applies
   * everywhere applies here too, and dropping it would tell somebody looking at
   * one property that the business has no cleaning cost.
   */
  propertyId: string | null
  /** `fixed` or `variable`, or null for both. The two behave nothing alike. */
  kind: ExpenseKind | null
  limit: number
}

/**
 * One row of the payments list.
 *
 * Every field is present. What a given reader may see is decided above this
 * line by `redact()`, which deletes keys — so the type the port answers with is
 * the complete one, and the optionality lives on the screen's own item type.
 */
export interface PaymentListRow {
  id: string
  bookingId: string
  propertyId: string
  /** The booking's own reference, or the payment's snapshot of it. */
  bookingReference: string | null
  status: PaymentStatus
  method: PaymentMethod
  purpose: PaymentPurpose
  channel: CollectionChannel
  /** Set when a person must intervene. Never cleared by automation. */
  requiresAttention: PaymentAttention | null
  /** When the provider stopped answering, as a property-local date. */
  unknownSince: string | null
  recordedOn: string
  paidOn: string | null
  payerName: string | null
  amountAgorot: number
  capturedAgorot: number
  refundedAgorot: number
}

/** One payment an invoice accounts for, as much of it as was asked for. */
export interface InvoicePaymentLinkRow {
  id: string
  status: PaymentStatus
  method: PaymentMethod
  /** Absent when `withLinkedAmounts` was false. */
  amountAgorot?: number
  paidOn: string | null
}

export interface InvoiceListRow {
  id: string
  bookingId: string
  propertyId: string
  kind: InvoiceKind
  status: InvoiceStatus
  series: string
  year: number
  number: number | null
  /** What is printed. Null on a draft, which has not been allocated one. */
  displayNumber: string | null
  issuedOn: string | null
  cancelledOn: string | null
  cancellationReason: string | null
  recordedOn: string
  taxRateBps: number | null
  touristVatExempt: boolean
  lines: readonly PriceLine[]
  /** `sumAgorot` over the lines. Carried beside the stored total, never instead. */
  linesTotalAgorot: number
  subtotalAgorot: number
  taxAgorot: number
  totalAgorot: number
  customerName: string
  customerTaxId: string | null
  /** The number of `invoice_payments` rows. Needs only `invoice.view`. */
  linkedPaymentCount: number
  /** Null when `withLinkedPayments` was false. */
  payments: readonly InvoicePaymentLinkRow[] | null
}

/**
 * Who a commission is owed to.
 *
 * `unknown` is reachable: the person's `auth.users` row is `on delete set null`
 * and the agency may be unreadable. It is a row somebody must look at, not one
 * to paper over with an id.
 */
export type CommissionPayee =
  | { kind: 'agent'; name: string | null; agencyName: string | null }
  | { kind: 'agency'; name: string | null }
  | { kind: 'unknown' }

export interface CommissionListRow {
  id: string
  bookingId: string
  propertyId: string
  bookingReference: string | null
  status: CommissionStatus
  payee: CommissionPayee
  amountAgorot: number
  /** Basis points — 1200 is 12%. Null for a fixed-amount commission. */
  rateBps: number | null
  /** Which base was agreed. The *name* of it, never the figure. */
  basis: CommissionBase
  rule: CommissionRule
  basisAgorot: number
  explanation: string | null
  becameEligibleOn: string | null
  approvedOn: string | null
  paidOn: string | null
  cancellationReason: string | null
  /** Paid, and then the booking was refunded. Somebody must claw it back. */
  clawbackRequired: boolean
  recordedOn: string
}

export interface ExpenseRuleListRow {
  id: string
  label: string
  category: string
  kind: ExpenseKind
  frequency: ExpenseFrequency
  /** The periodic amount, for a `fixed` rule. Zero for a variable one. */
  amountAgorot: number
  /** The calculation, for a `variable` rule. Null for a fixed one. */
  formula: VariableFormula | null
  allocation: AllocationMethod
  scopeKind: ExpenseScopeKind
  /** The property the scope names, or null for an organization-wide rule. */
  scopePropertyId: string | null
  effectiveFrom: string
  /** Exclusive. Null means still in force. */
  effectiveTo: string | null
  approvalRequired: boolean
  version: number
}

/** One booking's share of one rule, as `expense_allocations` recorded it. */
export interface ExpenseAllocationRow {
  id: string
  ruleId: string
  ruleVersion: number
  bookingId: string
  method: AllocationMethod
  periodStart: string
  periodEnd: string
  amountAgorot: number
  /** The weight this booking contributed, for the explanation on screen. */
  weight: number
  /** Hebrew, one line, written when the allocation ran. */
  basis: string | null
  allocatedOn: string
}

/** What `expense.create` writes. The id is the caller's, so a retry replays. */
export interface ExpenseRuleDraft {
  id: string
  organizationId: string
  label: string
  category: string
  kind: ExpenseKind
  frequency: ExpenseFrequency
  amountAgorot: number
  formula: VariableFormula | null
  allocation: AllocationMethod
  scope: ExpenseScope
  effectiveFrom: string
  effectiveTo: string | null
  approvalRequired: boolean
  createdByUserId: string | null
}

export interface FinanceRepository {
  // ── Payments ────────────────────────────────────────────────────────────
  loadPayment(
    organizationId: string,
    paymentId: string,
  ): Promise<Payment | null>
  loadPaymentsForBooking(
    organizationId: string,
    bookingId: string,
  ): Promise<readonly Payment[]>
  /** Finds the payment a provider event is about, by the processor's own id. */
  loadPaymentByProviderRef(
    organizationId: string,
    providerRef: string,
  ): Promise<Payment | null>
  insertPayment(payment: Payment, tx?: TransactionHandle): Promise<Payment>
  updatePayment(payment: Payment, tx?: TransactionHandle): Promise<Payment>

  // ── Refunds ─────────────────────────────────────────────────────────────
  loadRefundsForPayment(
    organizationId: string,
    paymentId: string,
  ): Promise<readonly Refund[]>
  insertRefund(refund: Refund, tx?: TransactionHandle): Promise<Refund>
  updateRefund(refund: Refund, tx?: TransactionHandle): Promise<Refund>

  // ── Deposits ────────────────────────────────────────────────────────────
  loadDeposit(
    organizationId: string,
    bookingId: string,
  ): Promise<Deposit | null>
  upsertDeposit(deposit: Deposit, tx?: TransactionHandle): Promise<Deposit>

  // ── Documents ───────────────────────────────────────────────────────────
  loadInvoicesForBooking(
    organizationId: string,
    bookingId: string,
  ): Promise<readonly Invoice[]>
  loadCreditNotesForInvoice(
    organizationId: string,
    invoiceId: string,
  ): Promise<readonly CreditNote[]>
  insertInvoice(invoice: Invoice, tx?: TransactionHandle): Promise<Invoice>
  updateInvoice(invoice: Invoice, tx?: TransactionHandle): Promise<Invoice>
  insertCreditNote(
    note: CreditNote,
    tx?: TransactionHandle,
  ): Promise<CreditNote>
  /** Delegates to `next_invoice_number()`. Never reimplemented. See the header. */
  allocateInvoiceNumber(
    organizationId: string,
    series: string,
    year: number,
    tx?: TransactionHandle,
  ): Promise<number>

  // ── Snapshots ───────────────────────────────────────────────────────────
  /** The current capture for a booking. `null` before it was ever committed. */
  loadSnapshot(
    organizationId: string,
    bookingId: string,
  ): Promise<FinanceSnapshot | null>
  insertSnapshot(
    snapshot: FinanceSnapshot,
    tx?: TransactionHandle,
  ): Promise<FinanceSnapshot>

  // ── Commissions ─────────────────────────────────────────────────────────
  loadCommissionsForBooking(
    organizationId: string,
    bookingId: string,
  ): Promise<readonly Commission[]>
  updateCommission(
    commission: Commission,
    tx?: TransactionHandle,
  ): Promise<Commission>

  // ── Lists ───────────────────────────────────────────────────────────────
  //
  // The organization-wide reads the list screens make. See `FinanceListQuery`
  // for why they exist beside the per-booking methods rather than on top of
  // them, and why they carry flags instead of an `Actor`.

  listPayments(query: PaymentListQuery): Promise<readonly PaymentListRow[]>
  listInvoices(query: InvoiceListQuery): Promise<readonly InvoiceListRow[]>
  listCommissions(
    query: CommissionListQuery,
  ): Promise<readonly CommissionListRow[]>

  /**
   * How many rows exist before any filter.
   *
   * Paired with the lists rather than derived from them, because "you have
   * never taken a payment" and "your filter matched nothing" are different
   * empty states and the filtered list cannot tell them apart. A `head` count,
   * so the distinction does not cost the rows.
   */
  countPayments(
    organizationId: string,
    propertyId: string | null,
  ): Promise<number>
  countInvoices(
    organizationId: string,
    propertyId: string | null,
  ): Promise<number>
  countCommissions(
    organizationId: string,
    propertyId: string | null,
  ): Promise<number>

  // ── Expenses ────────────────────────────────────────────────────────────

  listExpenseRules(
    query: ExpenseRuleListQuery,
  ): Promise<readonly ExpenseRuleListRow[]>
  /**
   * How many live rules the organization has, at any scope.
   *
   * Deliberately not narrowed by property: the question the empty state asks is
   * "has this business ever written down a cost", and a business whose only
   * rules are organization-wide has, even when the reader is looking at one
   * property.
   */
  countExpenseRules(organizationId: string): Promise<number>
  /** The shares recorded against these rules. Empty ids means empty result. */
  listExpenseAllocations(
    organizationId: string,
    ruleIds: readonly string[],
  ): Promise<readonly ExpenseAllocationRow[]>
  insertExpenseRule(
    draft: ExpenseRuleDraft,
    tx?: TransactionHandle,
  ): Promise<ExpenseRuleListRow>
}

// ── An in-memory implementation ───────────────────────────────────────────

/**
 * A repository in Maps.
 *
 * For tests and for a development server. It is a faithful double in one
 * respect that matters: `allocateInvoiceNumber` really does hand out
 * consecutive numbers per `(organization, series, year)`, so a test can prove
 * that two invoices never share one. It is single-process, so it cannot model
 * the race the real counter exists to prevent — which is why the real
 * implementation must be the database function and not this.
 */
export class InMemoryFinanceRepository implements FinanceRepository {
  readonly payments = new Map<string, Payment>()
  readonly refunds = new Map<string, Refund>()
  readonly deposits = new Map<string, Deposit>()
  readonly invoices = new Map<string, Invoice>()
  readonly creditNotes = new Map<string, CreditNote>()
  readonly snapshots = new Map<string, FinanceSnapshot>()
  readonly commissions = new Map<string, Commission>()
  /** Keyed by id, carrying the tenant so `listExpenseRules` can filter on it. */
  readonly expenseRules = new Map<string, StoredExpenseRule>()
  readonly expenseAllocations: ExpenseAllocationRow[] = []

  private readonly sequences = new Map<string, number>()

  async loadPayment(
    organizationId: string,
    paymentId: string,
  ): Promise<Payment | null> {
    const payment = this.payments.get(paymentId)
    // The tenant check is part of the read, not a filter applied afterwards.
    // A repository that returned the row and left scoping to the caller is a
    // repository one forgotten `if` away from a cross-tenant leak.
    if (!payment || payment.organizationId !== organizationId) return null
    return payment
  }

  async loadPaymentsForBooking(
    organizationId: string,
    bookingId: string,
  ): Promise<readonly Payment[]> {
    return [...this.payments.values()].filter(
      (payment) =>
        payment.organizationId === organizationId &&
        payment.bookingId === bookingId,
    )
  }

  async loadPaymentByProviderRef(
    organizationId: string,
    providerRef: string,
  ): Promise<Payment | null> {
    return (
      [...this.payments.values()].find(
        (payment) =>
          payment.organizationId === organizationId &&
          payment.providerRef === providerRef,
      ) ?? null
    )
  }

  async insertPayment(payment: Payment): Promise<Payment> {
    this.payments.set(payment.id, payment)
    return payment
  }

  async updatePayment(payment: Payment): Promise<Payment> {
    this.payments.set(payment.id, payment)
    return payment
  }

  async loadRefundsForPayment(
    organizationId: string,
    paymentId: string,
  ): Promise<readonly Refund[]> {
    return [...this.refunds.values()].filter(
      (refund) =>
        refund.organizationId === organizationId &&
        refund.paymentId === paymentId,
    )
  }

  async insertRefund(refund: Refund): Promise<Refund> {
    this.refunds.set(refund.id, refund)
    return refund
  }

  async updateRefund(refund: Refund): Promise<Refund> {
    this.refunds.set(refund.id, refund)
    return refund
  }

  async loadDeposit(
    organizationId: string,
    bookingId: string,
  ): Promise<Deposit | null> {
    return (
      [...this.deposits.values()].find(
        (deposit) =>
          deposit.organizationId === organizationId &&
          deposit.bookingId === bookingId,
      ) ?? null
    )
  }

  async upsertDeposit(deposit: Deposit): Promise<Deposit> {
    this.deposits.set(deposit.id, deposit)
    return deposit
  }

  async loadInvoicesForBooking(
    organizationId: string,
    bookingId: string,
  ): Promise<readonly Invoice[]> {
    return [...this.invoices.values()].filter(
      (invoice) =>
        invoice.organizationId === organizationId &&
        invoice.bookingId === bookingId,
    )
  }

  async loadCreditNotesForInvoice(
    organizationId: string,
    invoiceId: string,
  ): Promise<readonly CreditNote[]> {
    return [...this.creditNotes.values()].filter(
      (note) =>
        note.organizationId === organizationId && note.invoiceId === invoiceId,
    )
  }

  async insertInvoice(invoice: Invoice): Promise<Invoice> {
    this.invoices.set(invoice.id, invoice)
    return invoice
  }

  async updateInvoice(invoice: Invoice): Promise<Invoice> {
    this.invoices.set(invoice.id, invoice)
    return invoice
  }

  async insertCreditNote(note: CreditNote): Promise<CreditNote> {
    this.creditNotes.set(note.id, note)
    return note
  }

  async allocateInvoiceNumber(
    organizationId: string,
    series: string,
    year: number,
  ): Promise<number> {
    const key = `${organizationId} ${series} ${year}`
    const next = this.sequences.get(key) ?? 1
    this.sequences.set(key, next + 1)
    return next
  }

  async loadSnapshot(
    organizationId: string,
    bookingId: string,
  ): Promise<FinanceSnapshot | null> {
    const candidates = [...this.snapshots.values()].filter(
      (snapshot) =>
        snapshot.organizationId === organizationId &&
        snapshot.bookingId === bookingId,
    )
    if (candidates.length === 0) return null
    // The newest capture is the current basis. Superseded ones are retained —
    // they are the evidence for statements that were already sent.
    return candidates.sort((a, b) =>
      a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
    )[0]
  }

  async insertSnapshot(snapshot: FinanceSnapshot): Promise<FinanceSnapshot> {
    this.snapshots.set(`${snapshot.bookingId}@${snapshot.capturedAt}`, snapshot)
    return snapshot
  }

  async loadCommissionsForBooking(
    organizationId: string,
    bookingId: string,
  ): Promise<readonly Commission[]> {
    return [...this.commissions.values()].filter(
      (commission) =>
        commission.organizationId === organizationId &&
        commission.bookingId === bookingId,
    )
  }

  async updateCommission(commission: Commission): Promise<Commission> {
    this.commissions.set(commission.id, commission)
    return commission
  }

  /* ------------------------------------------------------------- lists -- */

  /**
   * The lists, over the Maps.
   *
   * Faithful about what it can be faithful about — the tenant filter, the
   * property filter, the status filter, the newest-first ordering and the
   * limit, which is everything a caller can get wrong. Deliberately *not*
   * faithful about the three joins the adapter performs: a booking's
   * reference, a payee's name and an invoice's linked payments live in tables
   * this double does not have, so they come back null and empty rather than
   * invented. A test that needs those needs the demo client, which has rows.
   */
  async listPayments(
    query: PaymentListQuery,
  ): Promise<readonly PaymentListRow[]> {
    return this.listed(
      this.payments,
      query,
      (payment) => payment.createdAt.getTime(),
      (payment) => ({
        id: payment.id,
        bookingId: payment.bookingId,
        propertyId: payment.propertyId ?? '',
        bookingReference: null,
        status: payment.status,
        method: payment.method,
        purpose: payment.purpose,
        channel: payment.channel,
        requiresAttention: payment.requiresAttention,
        unknownSince: dayOf(payment.unknownSince),
        recordedOn: dayOf(payment.createdAt) ?? '',
        paidOn: null,
        payerName: null,
        amountAgorot: payment.amountAgorot,
        capturedAgorot: payment.capturedAgorot,
        refundedAgorot: payment.refundedAgorot,
      }),
    )
  }

  async listInvoices(
    query: InvoiceListQuery,
  ): Promise<readonly InvoiceListRow[]> {
    return this.listed(
      this.invoices,
      query,
      (invoice) => invoice.issuedAt?.getTime() ?? 0,
      (invoice) => ({
        id: invoice.id,
        bookingId: invoice.bookingId,
        propertyId: invoice.propertyId,
        kind: invoice.kind,
        status: invoice.status,
        series: invoice.series,
        year: invoice.year,
        number: invoice.number,
        displayNumber: invoice.displayNumber,
        issuedOn: dayOf(invoice.issuedAt),
        cancelledOn: dayOf(invoice.cancelledAt),
        cancellationReason: invoice.cancellationReason,
        recordedOn: dayOf(invoice.issuedAt) ?? '',
        taxRateBps: invoice.taxRateBps,
        touristVatExempt: invoice.touristVatExempt,
        lines: invoice.lines,
        linesTotalAgorot: invoice.lines.reduce(
          (sum, line) => sum + line.amount,
          0,
        ),
        subtotalAgorot: invoice.subtotalAgorot,
        taxAgorot: invoice.taxAgorot,
        totalAgorot: invoice.totalAgorot,
        customerName: invoice.customerName,
        customerTaxId: invoice.customerTaxId,
        linkedPaymentCount: invoice.paymentIds.length,
        payments: query.withLinkedPayments ? [] : null,
      }),
    )
  }

  async listCommissions(
    query: CommissionListQuery,
  ): Promise<readonly CommissionListRow[]> {
    return this.listed(
      this.commissions,
      query,
      (commission) => commission.createdAt.getTime(),
      (commission) => ({
        id: commission.id,
        bookingId: commission.bookingId,
        propertyId: commission.propertyId,
        bookingReference: null,
        status: commission.status,
        payee:
          commission.agentUserId !== null
            ? { kind: 'agent' as const, name: null, agencyName: null }
            : commission.agencyId !== null
              ? { kind: 'agency' as const, name: null }
              : { kind: 'unknown' as const },
        amountAgorot: commission.amountAgorot,
        rateBps: commission.rateBps,
        basis: commission.rule.basis,
        rule: query.withRuleLabel
          ? commission.rule
          : { ...commission.rule, label: '' },
        basisAgorot: commission.basisAgorot,
        explanation:
          commission.rule.label.length > 0 ? commission.rule.label : null,
        becameEligibleOn: dayOf(commission.becameEligibleAt),
        approvedOn: null,
        paidOn: dayOf(commission.paidAt),
        cancellationReason: commission.cancelledReason,
        clawbackRequired: commission.clawbackRequired,
        recordedOn: dayOf(commission.createdAt) ?? '',
      }),
    )
  }

  async countPayments(
    organizationId: string,
    propertyId: string | null,
  ): Promise<number> {
    return this.counted(this.payments, organizationId, propertyId)
  }

  async countInvoices(
    organizationId: string,
    propertyId: string | null,
  ): Promise<number> {
    return this.counted(this.invoices, organizationId, propertyId)
  }

  async countCommissions(
    organizationId: string,
    propertyId: string | null,
  ): Promise<number> {
    return this.counted(this.commissions, organizationId, propertyId)
  }

  async listExpenseRules(
    query: ExpenseRuleListQuery,
  ): Promise<readonly ExpenseRuleListRow[]> {
    return [...this.expenseRules.values()]
      .filter(
        (rule) =>
          rule.organizationId === query.organizationId &&
          (query.kind === null || rule.kind === query.kind) &&
          (query.propertyId === null ||
            rule.scopePropertyId === null ||
            rule.scopePropertyId === query.propertyId),
      )
      .slice(0, query.limit)
  }

  async countExpenseRules(organizationId: string): Promise<number> {
    return [...this.expenseRules.values()].filter(
      (rule) => rule.organizationId === organizationId,
    ).length
  }

  async listExpenseAllocations(
    organizationId: string,
    ruleIds: readonly string[],
  ): Promise<readonly ExpenseAllocationRow[]> {
    if (ruleIds.length === 0) return []
    const wanted = new Set(ruleIds)
    const known = new Set(
      [...this.expenseRules.values()]
        .filter((rule) => rule.organizationId === organizationId)
        .map((rule) => rule.id),
    )
    return this.expenseAllocations.filter(
      (allocation) =>
        wanted.has(allocation.ruleId) && known.has(allocation.ruleId),
    )
  }

  async insertExpenseRule(
    draft: ExpenseRuleDraft,
  ): Promise<ExpenseRuleListRow> {
    const row: StoredExpenseRule = {
      organizationId: draft.organizationId,
      id: draft.id,
      label: draft.label,
      category: draft.category,
      kind: draft.kind,
      frequency: draft.frequency,
      amountAgorot: draft.amountAgorot,
      formula: draft.formula,
      allocation: draft.allocation,
      scopeKind: draft.scope.kind,
      scopePropertyId: draft.scope.propertyId ?? null,
      effectiveFrom: draft.effectiveFrom,
      effectiveTo: draft.effectiveTo,
      approvalRequired: draft.approvalRequired,
      version: 1,
    }
    this.expenseRules.set(row.id, row)
    return row
  }

  /* --------------------------------------------------------- internals -- */

  private listed<TRecord extends TenantRecord, TRow>(
    store: ReadonlyMap<string, TRecord>,
    query: FinanceListQuery<string>,
    /**
     * Newest first, as the adapter orders. `Invoice` carries no `createdAt`,
     * so the accessor is a parameter rather than a field on `TenantRecord` —
     * the record that has no moment says so instead of being given one.
     */
    orderedBy: (record: TRecord) => number,
    toRow: (record: TRecord) => TRow,
  ): TRow[] {
    return this.matching(store, query.organizationId, query.propertyId)
      .filter(
        (record) => query.status === null || record.status === query.status,
      )
      .sort((a, b) => orderedBy(b) - orderedBy(a))
      .slice(0, query.limit)
      .map(toRow)
  }

  private counted<TRecord extends TenantRecord>(
    store: ReadonlyMap<string, TRecord>,
    organizationId: string,
    propertyId: string | null,
  ): number {
    return this.matching(store, organizationId, propertyId).length
  }

  private matching<TRecord extends TenantRecord>(
    store: ReadonlyMap<string, TRecord>,
    organizationId: string,
    propertyId: string | null,
  ): TRecord[] {
    return [...store.values()].filter(
      (record) =>
        record.organizationId === organizationId &&
        (propertyId === null || record.propertyId === propertyId),
    )
  }
}

/** What every listable record has in common, so one filter serves the three. */
type TenantRecord = {
  organizationId: string
  propertyId: string | null
  status: string
}

/** The row plus the tenant it belongs to, which the list row itself omits. */
type StoredExpenseRule = ExpenseRuleListRow & { organizationId: string }

/**
 * A `Date` as the calendar day it fell on, in UTC.
 *
 * The adapter converts against the property's own time zone, which is the only
 * correct answer for a screen; this double has no property to ask and says so
 * by using UTC rather than by pretending.
 */
function dayOf(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10)
}
