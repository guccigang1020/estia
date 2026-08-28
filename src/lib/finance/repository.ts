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

import type { TransactionHandle } from '../service/transaction'
import type { FinanceSnapshot } from './snapshot'
import type {
  Commission,
  CreditNote,
  Deposit,
  Invoice,
  Payment,
  Refund,
} from './types'

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
}
