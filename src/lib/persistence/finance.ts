/**
 * `FinanceRepository`, backed by `0010_payments.sql` and `0016_finance.sql`.
 *
 * The port is `src/lib/finance/repository.ts` and the shapes are the domain's,
 * not the schema's. Everything below is mapping. The decisions — what may be
 * refunded, what a tax invoice may say, when a commission becomes a debt —
 * live above this line and are tested without a database.
 *
 * ── Four things the database does that the domain does not expect ─────────
 *
 * **1. `payments.amount_refunded_agorot` is not writable.**
 * `refunds_recalc_payment` is an `AFTER INSERT OR UPDATE OR DELETE` trigger on
 * `refunds` that recomputes the column from the settled refunds. 0016 says so
 * explicitly: "The adapter must not write it." A caller that also wrote it
 * would be overwritten on the next refund change — silently, and correctly.
 * So `refundedAgorot` is read here and never sent.
 *
 * **2. The finance domain pre-increments `version`, and so does the trigger.**
 * `payments.ts` returns `version: payment.version + 1` before the record ever
 * reaches this file, and `tg_touch_row` increments the stored value again on
 * update. The optimistic-lock predicate is therefore
 *
 *     where version = payment.version - 1
 *
 * and **not** `= payment.version`. Backwards it fails in one direction only:
 * a repository that conflicts on every single update is found in a minute,
 * and one that never conflicts at all is found when two people have
 * overwritten each other's refunds for a month. `version` is never sent —
 * the trigger owns it.
 *
 * **3. `finance_snapshots` is insert-only**, enforced by a statement-level
 * trigger, which is why there is no `updateSnapshot` and why a `DELETE` on
 * `bookings` fails even for a booking that has no snapshot. Anything creating
 * test bookings has to plan its teardown around that.
 *
 * **4. `payments.property_id` and `refunds.property_id` are `NOT NULL` with no
 * default**, while `Payment.propertyId` is nullable and `Refund` has no
 * property at all. Neither is invented here. A payment with no property reads
 * it from its booking, and a refund reads it from the payment it is against —
 * the same move `booking.ts` makes for `bookings.property_id`, and for the
 * same reason: the fact exists on a row we already name, so reading it is not
 * a guess.
 *
 * ============================================================================
 * TWO THINGS 0018 AND 0022 CHANGED HERE
 * ============================================================================
 *
 * **The commission methods are no longer blocked on an enum.** 0015 created
 * `public.commission_base` with `whole_booking` and `accommodation_only`, and
 * the unified `COMMISSION_BASES` in `src/lib/contracts/states.ts` grew to six
 * members with no `whole_booking` at all — so the database's type and the
 * code's described different sets in both directions, on the record that
 * decides what an agent is paid. 0018 rebuilt the type with exactly those six
 * and rewrote every stored `whole_booking` as `stay_total`.
 *
 * What `commissions` still has no column for is `Commission.rule` — the
 * `{ basis, kind, value, label }` value object the domain carries beside the
 * amount. It is written to `commissions.metadata` under `rule`, the same way
 * `approvals.metadata` carries the frozen `DiscountApprovalView`, and read back
 * from there. When it is absent — a row written before this, or by another
 * writer — it is **derived from the real columns** rather than invented:
 * `basis` is the `base` column, `kind` follows whether `rate_bps` is set,
 * `value` comes from `rate_bps` or `amount_agorot`, and `label` from
 * `explanation`. Those are the columns that reproduce the money, so a derived
 * rule agrees with the amount sitting beside it by construction — which an
 * invented one would not.
 *
 * **`Invoice.paymentIds` is a join table now.** 0022 created
 * `public.invoice_payments`, carrying `booking_id` so that both composite
 * foreign keys name it — which is what refuses a link between an invoice for
 * one stay and a payment against another, and what an array of ids could never
 * check. `invoices.metadata.payment_ids` is no longer written and no longer
 * read.
 *
 * The order matters, and 0022's own header states it: **backfill first, then
 * stop writing.** Dropping the write before the rows are copied loses the link
 * between an invoice and the payments that settled it, and nothing else records
 * it. A deployment that has not run the backfill reads invoices with no
 * payments rather than invoices with the wrong ones.
 *
 * `updateInvoice` reconciles the links rather than replacing them.
 * `invoice_payments` has no UPDATE — no grant and no policy, two independent
 * refusals — because the row *is* its key: a changed set is a delete of what
 * left and an insert of what arrived, and both are separately visible.
 *
 * ============================================================================
 * WHAT IS STILL NOT CLOSED
 * ============================================================================
 *
 * **`Invoice` and `CreditNote` carry no `version`**, so `updateInvoice` locks
 * on nothing. The column exists and the trigger maintains it; the port has no
 * field to compare against, so two concurrent issuers of the same invoice
 * cannot be told apart here. Adding `version` to the port would close it.
 */

import { localDate } from '../booking/dates'
import { PRICE_LINE_KINDS, type PriceLine } from '../booking/types'
import {
  APPROVAL_STATUSES,
  COMMISSION_BASES,
  COMMISSION_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
} from '../contracts/states'
import { ConflictError } from '../errors'
import type {
  CommissionListQuery,
  CommissionListRow,
  CommissionPayee,
  ExpenseAllocationRow,
  ExpenseRuleDraft,
  ExpenseRuleListQuery,
  ExpenseRuleListRow,
  FinanceRepository,
  InvoiceListQuery,
  InvoiceListRow,
  InvoicePaymentLinkRow,
  PaymentListQuery,
  PaymentListRow,
} from '../finance/repository'
import { sumAgorot } from '../finance/money'
import type { FinanceSnapshot } from '../finance/snapshot'
import {
  ALLOCATION_METHODS,
  EXPENSE_FREQUENCIES,
  EXPENSE_KINDS,
  EXPENSE_SCOPE_KINDS,
  type VariableFormula,
} from '../finance/types'
import {
  COLLECTION_CHANNELS,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  PAYMENT_ATTENTIONS,
  PAYMENT_PURPOSES,
  REFUND_REASONS,
  REFUND_STATUSES,
  type Commission,
  type CreditNote,
  type Deposit,
  type Invoice,
  type Payment,
  type Refund,
} from '../finance/types'
import type { TransactionHandle } from '../service'
import type { Db, Row } from './client'
import {
  asAgorot,
  asBoolean,
  asDate,
  asDateOrNull,
  asEnum,
  asEnumOrNull,
  asIsoDate,
  asIsoDateOrNull,
  asJsonRecord,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRow,
  toRows,
} from './mapping'
import { clientFor, recordWrite } from './transaction'

export class SupabaseFinanceRepository implements FinanceRepository {
  constructor(private readonly db: Db) {}

  // ── Payments ────────────────────────────────────────────────────────────

  async loadPayment(
    organizationId: string,
    paymentId: string,
  ): Promise<Payment | null> {
    const { data, error } = await this.db
      .from('payments')
      .select(PAYMENT_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', paymentId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const events = await this.appliedEvents(this.db, organizationId, [
      paymentId,
    ])
    return toPayment(toRow(data), events.get(paymentId) ?? [])
  }

  async loadPaymentsForBooking(
    organizationId: string,
    bookingId: string,
  ): Promise<readonly Payment[]> {
    const { data, error } = await this.db
      .from('payments')
      .select(PAYMENT_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true })

    if (error) throw error

    const rows = toRows(data)
    const events = await this.appliedEvents(
      this.db,
      organizationId,
      rows.map((row) => asString(row, 'id')),
    )
    return rows.map((row) =>
      toPayment(row, events.get(asString(row, 'id')) ?? []),
    )
  }

  async loadPaymentByProviderRef(
    organizationId: string,
    providerRef: string,
  ): Promise<Payment | null> {
    const { data, error } = await this.db
      .from('payments')
      .select(PAYMENT_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('provider_payment_id', providerRef)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const id = asString(toRow(data), 'id')
    const events = await this.appliedEvents(this.db, organizationId, [id])
    return toPayment(toRow(data), events.get(id) ?? [])
  }

  async insertPayment(
    payment: Payment,
    tx?: TransactionHandle,
  ): Promise<Payment> {
    const db = clientFor(tx, this.db)
    const propertyId =
      payment.propertyId ??
      (await this.propertyForBooking(
        db,
        payment.organizationId,
        payment.bookingId,
      ))

    const { data, error } = await db
      .from('payments')
      .insert({
        id: payment.id,
        organization_id: payment.organizationId,
        property_id: propertyId,
        booking_id: payment.bookingId,
        purpose: payment.purpose,
        method: payment.method,
        channel: payment.channel,
        status: payment.status,
        currency: payment.currency,
        amount_agorot: payment.amountAgorot,
        authorized_agorot: payment.authorizedAgorot,
        captured_agorot: payment.capturedAgorot,
        // `amount_refunded_agorot` is absent on purpose — see note 1.
        provider: payment.providerId,
        provider_payment_id: payment.providerRef,
        schedule_id: payment.scheduleId,
        instalment_number: payment.instalmentNumber,
        due_on: payment.dueOn,
        last_provider_event_at: iso(payment.lastProviderEventAt),
        requires_attention: payment.requiresAttention,
        unknown_since: iso(payment.unknownSince),
        created_at: payment.createdAt.toISOString(),
        created_by: payment.createdByUserId,
        // `version` is absent: `tg_touch_row` owns it.
      })
      .select(PAYMENT_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, `payments(${payment.id})`)

    // `appliedEventIds` is deliberately not written. `payment_provider_events`
    // is owned by the webhook ingestion path, which is the only place that
    // knows an event's provider, type and payload — all `NOT NULL` — and the
    // uniqueness on (organization, provider, event_id) is what actually makes
    // a redelivery a no-op. Synthesising rows here to satisfy a field would
    // put a fabricated `event_type` in the evidence a dispute is settled with.
    return toPayment(toRow(data), payment.appliedEventIds)
  }

  async updatePayment(
    payment: Payment,
    tx?: TransactionHandle,
  ): Promise<Payment> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('payments')
      .update({
        status: payment.status,
        purpose: payment.purpose,
        method: payment.method,
        channel: payment.channel,
        amount_agorot: payment.amountAgorot,
        authorized_agorot: payment.authorizedAgorot,
        captured_agorot: payment.capturedAgorot,
        provider: payment.providerId,
        provider_payment_id: payment.providerRef,
        schedule_id: payment.scheduleId,
        instalment_number: payment.instalmentNumber,
        due_on: payment.dueOn,
        last_provider_event_at: iso(payment.lastProviderEventAt),
        requires_attention: payment.requiresAttention,
        unknown_since: iso(payment.unknownSince),
      })
      .eq('id', payment.id)
      .eq('organization_id', payment.organizationId)
      // The predicate the header is about. `payment.version` has already been
      // incremented by the domain, so the row still holds one less.
      .eq('version', payment.version - 1)
      .select(PAYMENT_COLUMNS)

    if (error) throw error

    const rows = toRows(data)
    if (rows.length === 0) {
      throw new ConflictError({
        resourceType: 'payment',
        resourceId: payment.id,
        expectedVersion: payment.version - 1,
        actualVersion: await this.currentVersion(db, 'payments', payment.id),
      })
    }

    recordWrite(tx, `payments(${payment.id})`)
    return toPayment(rows[0] as Row, payment.appliedEventIds)
  }

  // ── Refunds ─────────────────────────────────────────────────────────────

  async loadRefundsForPayment(
    organizationId: string,
    paymentId: string,
  ): Promise<readonly Refund[]> {
    const { data, error } = await this.db
      .from('refunds')
      .select(REFUND_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('payment_id', paymentId)
      .order('requested_at', { ascending: true })

    if (error) throw error
    return toRows(data).map(toRefund)
  }

  async insertRefund(refund: Refund, tx?: TransactionHandle): Promise<Refund> {
    const db = clientFor(tx, this.db)
    const parent = await this.paymentAnchor(
      db,
      refund.organizationId,
      refund.paymentId,
    )

    const { data, error } = await db
      .from('refunds')
      .insert({
        id: refund.id,
        organization_id: refund.organizationId,
        property_id: parent.propertyId,
        booking_id: refund.bookingId,
        payment_id: refund.paymentId,
        amount_agorot: refund.amountAgorot,
        status: refund.status,
        approval_status: refund.approvalStatus,
        reason_code: refund.reason,
        reason: refund.reasonText,
        approved_by: refund.approvedByUserId,
        requested_by: refund.requestedByUserId,
        provider_refund_id: refund.providerRef,
        requested_at: refund.requestedAt.toISOString(),
        processed_at: iso(refund.processedAt),
        ...settledByEvent(refund.settledByEventId),
      })
      .select(REFUND_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, `refunds(${refund.id})`)
    return toRefund(toRow(data))
  }

  async updateRefund(refund: Refund, tx?: TransactionHandle): Promise<Refund> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('refunds')
      .update({
        status: refund.status,
        approval_status: refund.approvalStatus,
        amount_agorot: refund.amountAgorot,
        reason_code: refund.reason,
        reason: refund.reasonText,
        approved_by: refund.approvedByUserId,
        provider_refund_id: refund.providerRef,
        processed_at: iso(refund.processedAt),
        ...settledByEvent(refund.settledByEventId),
      })
      .eq('id', refund.id)
      .eq('organization_id', refund.organizationId)
      .select(REFUND_COLUMNS)

    if (error) throw error

    const rows = toRows(data)
    // `Refund` carries no `version`, so there is no lock to take: zero rows
    // means the refund is gone or invisible, not that somebody wrote first.
    if (rows.length === 0) {
      throw new ConflictError({
        resourceType: 'refund',
        resourceId: refund.id,
      })
    }

    recordWrite(tx, `refunds(${refund.id})`)
    return toRefund(rows[0] as Row)
  }

  // ── Deposits ────────────────────────────────────────────────────────────

  async loadDeposit(
    organizationId: string,
    bookingId: string,
  ): Promise<Deposit | null> {
    const { data, error } = await this.db
      .from('deposits')
      .select(DEPOSIT_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('booking_id', bookingId)
      .maybeSingle()

    if (error) throw error
    return data ? toDeposit(toRow(data)) : null
  }

  /**
   * Update, and insert only if that matched nothing.
   *
   * Deliberately not `ON CONFLICT DO UPDATE`. `postgrest-sql.ts` refuses to
   * compile one because the only upsert in this directory before now was the
   * idempotency reservation, where `do update` would hand the key to a second
   * caller and let both proceed. Rather than open that door for a deposit, the
   * two statements are written out — which is exact inside a transaction, and
   * is why this method wants one.
   *
   * Outside a transaction two callers can both miss and both insert; the
   * unique index on `(organization_id, booking_id)` is what refuses the
   * second, so the failure is a loud constraint violation rather than a
   * duplicate deposit.
   */
  async upsertDeposit(
    deposit: Deposit,
    tx?: TransactionHandle,
  ): Promise<Deposit> {
    const db = clientFor(tx, this.db)

    const patch = {
      status: deposit.status,
      method: deposit.method,
      required_agorot: deposit.requiredAgorot,
      held_agorot: deposit.heldAgorot,
      released_agorot: deposit.releasedAgorot,
      forfeited_agorot: deposit.forfeitedAgorot,
      currency: deposit.currency,
      payment_id: deposit.paymentId,
      forfeit_reason: deposit.forfeitReason,
      authorized_at: iso(deposit.authorizedAt),
      captured_at: iso(deposit.capturedAt),
      released_at: iso(deposit.releasedAt),
      released_by: deposit.releasedByUserId,
      forfeited_at: iso(deposit.forfeitedAt),
    }

    const updated = await db
      .from('deposits')
      .update(patch)
      .eq('organization_id', deposit.organizationId)
      .eq('booking_id', deposit.bookingId)
      .select(DEPOSIT_COLUMNS)

    if (updated.error) throw updated.error

    const existing = toRows(updated.data)
    if (existing.length > 0) {
      recordWrite(tx, `deposits(${deposit.bookingId})`)
      return toDeposit(existing[0] as Row)
    }

    const { data, error } = await db
      .from('deposits')
      .insert({
        id: deposit.id,
        organization_id: deposit.organizationId,
        property_id: deposit.propertyId,
        booking_id: deposit.bookingId,
        created_at: deposit.createdAt.toISOString(),
        ...patch,
      })
      .select(DEPOSIT_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, `deposits(${deposit.bookingId})`)
    return toDeposit(toRow(data))
  }

  // ── Documents ───────────────────────────────────────────────────────────

  async loadInvoicesForBooking(
    organizationId: string,
    bookingId: string,
  ): Promise<readonly Invoice[]> {
    const { data, error } = await this.db
      .from('invoices')
      .select(INVOICE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true })

    if (error) throw error
    return toRows(data).map(toInvoice)
  }

  async loadCreditNotesForInvoice(
    organizationId: string,
    invoiceId: string,
  ): Promise<readonly CreditNote[]> {
    const { data, error } = await this.db
      .from('credit_notes')
      .select(CREDIT_NOTE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('invoice_id', invoiceId)
      .order('created_at', { ascending: true })

    if (error) throw error
    return toRows(data).map(toCreditNote)
  }

  async insertInvoice(
    invoice: Invoice,
    tx?: TransactionHandle,
  ): Promise<Invoice> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('invoices')
      .insert({
        id: invoice.id,
        organization_id: invoice.organizationId,
        property_id: invoice.propertyId,
        booking_id: invoice.bookingId,
        kind: invoice.kind,
        status: invoice.status,
        series: invoice.series,
        year: invoice.year,
        number: invoice.number,
        display_number: invoice.displayNumber,
        customer_name: invoice.customerName,
        customer_tax_id: invoice.customerTaxId,
        subtotal_agorot: invoice.subtotalAgorot,
        tax_agorot: invoice.taxAgorot,
        total_agorot: invoice.totalAgorot,
        tax_rate_bps: invoice.taxRateBps,
        tourist_vat_exempt: invoice.touristVatExempt,
        currency: invoice.currency,
        issued_at: iso(invoice.issuedAt),
        cancelled_at: iso(invoice.cancelledAt),
        cancellation_reason: invoice.cancellationReason,
        archived_at: iso(invoice.archivedAt),
        snapshot_captured_at: invoice.snapshotCapturedAt,
        // `metadata` is not written. The payment ids that used to live in it
        // are rows in `invoice_payments` now, and writing both would leave two
        // answers to "which payments settled this" with nothing to keep them
        // in step.
      })
      .select(INVOICE_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, `invoices(${invoice.id})`)

    await this.writeLines(db, 'invoice_lines', 'invoice_id', {
      documentId: invoice.id,
      organizationId: invoice.organizationId,
      lines: invoice.lines,
      tx,
    })

    await this.linkPayments(db, invoice, invoice.paymentIds, tx)

    return {
      ...toInvoice(toRow(data)),
      lines: invoice.lines,
      // The row came back before the links were written, so its embed is
      // empty. Reporting what was just stored is more honest than a second
      // round trip that could only agree with it.
      paymentIds: [...invoice.paymentIds],
    }
  }

  async updateInvoice(
    invoice: Invoice,
    tx?: TransactionHandle,
  ): Promise<Invoice> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('invoices')
      .update({
        status: invoice.status,
        number: invoice.number,
        display_number: invoice.displayNumber,
        issued_at: iso(invoice.issuedAt),
        cancelled_at: iso(invoice.cancelledAt),
        cancellation_reason: invoice.cancellationReason,
        archived_at: iso(invoice.archivedAt),
        // `metadata` is deliberately absent. It used to be overwritten whole
        // with `{ payment_ids: … }` on every update, which also discarded
        // anything else stored under it; the links live in `invoice_payments`
        // now and this column is left to whoever else uses it.
      })
      .eq('id', invoice.id)
      .eq('organization_id', invoice.organizationId)
      .select(INVOICE_COLUMNS)

    if (error) throw error

    const rows = toRows(data)
    if (rows.length === 0) {
      throw new ConflictError({
        resourceType: 'invoice',
        resourceId: invoice.id,
      })
    }

    recordWrite(tx, `invoices(${invoice.id})`)

    const stored = toInvoice(rows[0] as Row)
    await this.reconcilePayments(db, invoice, stored.paymentIds, tx)

    return {
      ...stored,
      lines: invoice.lines,
      paymentIds: [...invoice.paymentIds],
    }
  }

  async insertCreditNote(
    note: CreditNote,
    tx?: TransactionHandle,
  ): Promise<CreditNote> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('credit_notes')
      .insert({
        id: note.id,
        organization_id: note.organizationId,
        property_id: note.propertyId,
        invoice_id: note.invoiceId,
        booking_id: note.bookingId,
        status: note.status,
        series: note.series,
        year: note.year,
        number: note.number,
        display_number: note.displayNumber,
        amount_agorot: note.amountAgorot,
        tax_agorot: note.taxAgorot,
        currency: note.currency,
        reason: note.reason,
        issued_at: iso(note.issuedAt),
      })
      .select(CREDIT_NOTE_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, `credit_notes(${note.id})`)

    await this.writeLines(db, 'credit_note_lines', 'credit_note_id', {
      documentId: note.id,
      organizationId: note.organizationId,
      lines: note.lines,
      tx,
    })

    return { ...toCreditNote(toRow(data)), lines: note.lines }
  }

  /**
   * The next number in the series, from the database's own counter.
   *
   * `next_invoice_number()` and never a read-then-write. An Israeli tax
   * invoice carries a gapless sequential number; "read the highest, add one"
   * is the double-booking race wearing a different hat, and two legal
   * documents sharing a number is not a bug anybody can fix afterwards. The
   * counter row lock inside the function is the serialisation.
   */
  async allocateInvoiceNumber(
    organizationId: string,
    series: string,
    year: number,
    tx?: TransactionHandle,
  ): Promise<number> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db.rpc('next_invoice_number', {
      target_organization_id: organizationId,
      target_series: series,
      target_year: year,
    })

    if (error) throw error
    const allocated = typeof data === 'string' ? Number(data) : data
    if (typeof allocated !== 'number' || !Number.isInteger(allocated)) {
      throw new Error(
        `next_invoice_number() returned ${JSON.stringify(data)}, ` +
          `which is not a whole number.`,
      )
    }
    recordWrite(tx, `invoice_sequences(${series}/${year})`)
    return allocated
  }

  // ── Snapshots ───────────────────────────────────────────────────────────

  async loadSnapshot(
    organizationId: string,
    bookingId: string,
  ): Promise<FinanceSnapshot | null> {
    const { data, error } = await this.db
      .from('finance_snapshots')
      .select(SNAPSHOT_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('booking_id', bookingId)
      // The newest capture is the current basis. Superseded ones stay: they
      // are the evidence for statements that have already been sent.
      .order('captured_at', { ascending: false })
      .limit(1)

    if (error) throw error
    const rows = toRows(data)
    return rows.length > 0 ? toSnapshot(rows[0] as Row) : null
  }

  async insertSnapshot(
    snapshot: FinanceSnapshot,
    tx?: TransactionHandle,
  ): Promise<FinanceSnapshot> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('finance_snapshots')
      .insert({
        organization_id: snapshot.organizationId,
        booking_id: snapshot.bookingId,
        captured_at: snapshot.capturedAt,
        property_id: snapshot.propertyId,
        unit_id: snapshot.unitId,
        captured_by: snapshot.capturedByUserId,
        reason: snapshot.reason,
        revision: snapshot.revision,
        supersedes_captured_at: snapshot.supersedesCapturedAt,
        check_in: snapshot.range.checkIn,
        check_out: snapshot.range.checkOut,
        nights: snapshot.nights,
        guests: snapshot.guests,
        lines: snapshot.lines,
        total_agorot: snapshot.totalAgorot,
        stay_total_agorot: snapshot.stayTotalAgorot,
        deposit_agorot: snapshot.depositAgorot,
        tax_agorot: snapshot.taxAgorot,
        tax_rate_percent: snapshot.taxRatePercent,
        currency: snapshot.currency,
        commission_rule: snapshot.commissionRule,
        owner_share_rule: snapshot.ownerShareRule,
        expense_rules: snapshot.expenseRules,
      })
      .select(SNAPSHOT_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(
      tx,
      `finance_snapshots(${snapshot.bookingId}@${snapshot.capturedAt})`,
    )
    return toSnapshot(toRow(data))
  }

  // ── Commissions ─────────────────────────────────────────────────────────

  /**
   * Every commission on this booking, cancelled ones included.
   *
   * No status filter. A cancelled commission and a clawed-back one are both
   * part of what a booking owes and both appear on the statement that explains
   * it; filtering here would make an agent's total silently disagree with the
   * bookings it was computed from.
   */
  async loadCommissionsForBooking(
    organizationId: string,
    bookingId: string,
  ): Promise<readonly Commission[]> {
    const { data, error } = await this.db
      .from('commissions')
      .select(COMMISSION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true })

    if (error) throw error
    return toRows(data).map(toCommission)
  }

  /**
   * Save a commission, on the version it was read at.
   *
   * `version = commission.version - 1`, for the reason note 2 in the header
   * gives about payments: `commissions.ts` returns `version + 1` before the
   * record reaches this file and `tg_touch_row` increments the stored value
   * again, so the predicate is one behind what the record carries. `version`
   * itself is never sent.
   *
   * The four timestamps are written from the record and not synthesised.
   * `tg_commissions_stamp_status` fills them when they are null and the status
   * says they should be set, which means a `null` here is "the domain did not
   * decide when" rather than "clear it" — and the trigger is what keeps
   * `paid_at` and `status = 'paid'` from disagreeing.
   */
  async updateCommission(
    commission: Commission,
    tx?: TransactionHandle,
  ): Promise<Commission> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('commissions')
      .update({
        agent_user_id: commission.agentUserId,
        agency_id: commission.agencyId,
        status: commission.status,
        base: commission.rule.basis,
        basis_agorot: commission.basisAgorot,
        rate_bps: commission.rateBps,
        amount_agorot: commission.amountAgorot,
        statement_id: commission.statementId,
        payout_batch_id: commission.payoutBatchId,
        eligible_at: iso(commission.becameEligibleAt),
        approved_by: commission.approvedByUserId,
        paid_at: iso(commission.paidAt),
        cancellation_reason: commission.cancelledReason,
        clawback_required: commission.clawbackRequired,
        // The rule has no columns of its own. See the header: this is the
        // same move `approvals.metadata` makes for the frozen view.
        metadata: { rule: commission.rule },
      })
      .eq('id', commission.id)
      .eq('organization_id', commission.organizationId)
      .eq('version', commission.version - 1)
      .select(COMMISSION_COLUMNS)

    if (error) throw error

    const rows = toRows(data)
    if (rows.length === 0) {
      throw new ConflictError({
        resourceType: 'commission',
        resourceId: commission.id,
        expectedVersion: commission.version - 1,
      })
    }

    recordWrite(tx, `commissions(${commission.id})`)
    return toCommission(rows[0] as Row)
  }

  // ── Lists ───────────────────────────────────────────────────────────────
  //
  // The organization-wide reads, moved here from `finance/_lib/queries.ts`
  // unchanged: the same columns, the same filters, the same ordering, the same
  // page ceiling and the same three joins. What stayed above is what was never
  // this layer's: `can()` per row and `redact()` per field, which is why the
  // flags on each query exist rather than an `Actor`.
  //
  // These are deliberately narrower than the record readers above them. A
  // `Payment` costs a second query against `payment_provider_events` for
  // `appliedEventIds`, per page, and a list prints none of it.

  /**
   * The payments in this organization, newest first.
   *
   * Ordered by `created_at` and not by `paid_at`: a pending or failed payment
   * has no `paid_at`, and ordering by it would sort exactly the rows somebody
   * is looking for to the bottom of the list.
   */
  async listPayments(
    query: PaymentListQuery,
  ): Promise<readonly PaymentListRow[]> {
    const rows = await this.listRows(
      'payments',
      PAYMENT_LIST_COLUMNS,
      query.organizationId,
      query.propertyId,
      query.status,
      query.limit,
    )

    const references = query.withBookingReferences
      ? await this.bookingReferences(
          query.organizationId,
          rows.map((row) => asString(row, 'booking_id')),
        )
      : new Map<string, string>()

    return rows.map((row) => {
      const bookingId = asString(row, 'booking_id')
      return {
        id: asString(row, 'id'),
        bookingId,
        propertyId: asString(row, 'property_id'),
        // The booking's own reference where it is readable, and otherwise the
        // one the payment recorded when it was taken. Both are real; neither is
        // invented, and null is a real answer.
        bookingReference:
          references.get(bookingId) ?? asStringOrNull(row, 'payer_reference'),
        status: asEnum(row, 'status', PAYMENT_STATUSES),
        method: asEnum(row, 'method', PAYMENT_METHODS),
        purpose: asEnum(row, 'purpose', PAYMENT_PURPOSES),
        channel: asEnum(row, 'channel', COLLECTION_CHANNELS),
        requiresAttention: asEnumOrNull(
          row,
          'requires_attention',
          PAYMENT_ATTENTIONS,
        ),
        unknownSince: propertyDate(row, 'unknown_since'),
        recordedOn: requiredPropertyDate(row, 'created_at'),
        paidOn: propertyDate(row, 'paid_at'),
        payerName: asStringOrNull(row, 'payer_name'),
        amountAgorot: asAgorot(row, 'amount_agorot'),
        capturedAgorot: asAgorot(row, 'captured_agorot'),
        refundedAgorot: asAgorot(row, 'amount_refunded_agorot'),
      }
    })
  }

  async listInvoices(
    query: InvoiceListQuery,
  ): Promise<readonly InvoiceListRow[]> {
    const rows = await this.listRows(
      'invoices',
      INVOICE_LIST_COLUMNS,
      query.organizationId,
      query.propertyId,
      query.status,
      query.limit,
    )

    const linked = query.withLinkedPayments
      ? await this.linkedPayments(
          query.organizationId,
          rows.flatMap(toPaymentIds),
          query.withLinkedAmounts,
        )
      : null

    return rows.map((row) => {
      const ids = toPaymentIds(row)
      const lines = toLines(row, 'invoice_lines')

      return {
        id: asString(row, 'id'),
        bookingId: asString(row, 'booking_id'),
        propertyId: asString(row, 'property_id'),
        kind: asEnum(row, 'kind', INVOICE_KINDS),
        status: asEnum(row, 'status', INVOICE_STATUSES),
        series: asString(row, 'series'),
        year: asNumber(row, 'year'),
        number: asNumberOrNull(row, 'number'),
        displayNumber: asStringOrNull(row, 'display_number'),
        issuedOn: propertyDate(row, 'issued_at'),
        cancelledOn: propertyDate(row, 'cancelled_at'),
        cancellationReason: asStringOrNull(row, 'cancellation_reason'),
        recordedOn: requiredPropertyDate(row, 'created_at'),
        taxRateBps: asNumberOrNull(row, 'tax_rate_bps'),
        touristVatExempt: asBoolean(row, 'tourist_vat_exempt'),
        lines,
        // The domain's own sum, computed once here so that no component adds
        // anything up. Carried *beside* the stored total rather than instead of
        // it: an issued invoice's total is frozen, and rendering the sum of the
        // lines in its place would be quietly correcting a legal document.
        linesTotalAgorot: sumAgorot(lines.map((line) => line.amount)),
        subtotalAgorot: asAgorot(row, 'subtotal_agorot'),
        taxAgorot: asAgorot(row, 'tax_agorot'),
        totalAgorot: asAgorot(row, 'total_agorot'),
        customerName: asString(row, 'customer_name'),
        customerTaxId: asStringOrNull(row, 'customer_tax_id'),
        linkedPaymentCount: ids.length,
        payments:
          linked === null
            ? null
            : ids
                .map((id) => linked.get(id))
                .filter(
                  (entry): entry is InvoicePaymentLinkRow =>
                    entry !== undefined,
                ),
      }
    })
  }

  async listCommissions(
    query: CommissionListQuery,
  ): Promise<readonly CommissionListRow[]> {
    const rows = await this.listRows(
      'commissions',
      COMMISSION_LIST_COLUMNS,
      query.organizationId,
      query.propertyId,
      query.status,
      query.limit,
    )

    const [references, people, agencies] = await Promise.all([
      query.withBookingReferences
        ? this.bookingReferences(
            query.organizationId,
            rows.map((row) => asString(row, 'booking_id')),
          )
        : new Map<string, string>(),
      this.profileNames(namesNeeded(rows, 'agent_user_id')),
      this.agencyNames(namesNeeded(rows, 'agency_id')),
    ])

    return rows.map((row) => {
      const bookingId = asString(row, 'booking_id')
      return {
        id: asString(row, 'id'),
        bookingId,
        propertyId: asString(row, 'property_id'),
        bookingReference: references.get(bookingId) ?? null,
        status: asEnum(row, 'status', COMMISSION_STATUSES),
        payee: toPayee(row, people, agencies),
        amountAgorot: asAgorot(row, 'amount_agorot'),
        rateBps: asNumberOrNull(row, 'rate_bps'),
        basis: asEnum(row, 'base', COMMISSION_BASES),
        rule: toListedCommissionRule(row, query.withRuleLabel),
        basisAgorot: asAgorot(row, 'basis_agorot'),
        explanation: asStringOrNull(row, 'explanation'),
        becameEligibleOn: propertyDate(row, 'eligible_at'),
        approvedOn: propertyDate(row, 'approved_at'),
        paidOn: propertyDate(row, 'paid_at'),
        cancellationReason: asStringOrNull(row, 'cancellation_reason'),
        clawbackRequired: asBoolean(row, 'clawback_required'),
        recordedOn: requiredPropertyDate(row, 'created_at'),
      }
    })
  }

  async countPayments(
    organizationId: string,
    propertyId: string | null,
  ): Promise<number> {
    return this.countRows('payments', organizationId, propertyId)
  }

  async countInvoices(
    organizationId: string,
    propertyId: string | null,
  ): Promise<number> {
    return this.countRows('invoices', organizationId, propertyId)
  }

  async countCommissions(
    organizationId: string,
    propertyId: string | null,
  ): Promise<number> {
    return this.countRows('commissions', organizationId, propertyId)
  }

  // ── Expenses ────────────────────────────────────────────────────────────

  /**
   * The live expense rules.
   *
   * `deleted_at is null`, because `expense_rules` carries a soft delete and a
   * retired rule is retired — unlike a cancelled invoice, which is a document
   * that still exists.
   *
   * The property filter is `scope_property_id = ? or scope_property_id is
   * null` expressed as two reads rather than one `.or()`: PostgREST's `or`
   * syntax is not in this codebase's supported surface, and a rule that applies
   * to the whole organization applies to the selected property too. Dropping
   * the organization-wide rules would tell somebody looking at one property
   * that the business has no cleaning cost.
   */
  async listExpenseRules(
    query: ExpenseRuleListQuery,
  ): Promise<readonly ExpenseRuleListRow[]> {
    const scoped =
      query.propertyId === null
        ? [await this.expenseRulePage(query, null, false)]
        : await Promise.all([
            this.expenseRulePage(query, query.propertyId, false),
            this.expenseRulePage(query, null, true),
          ])

    const seen = new Set<string>()
    const rules: ExpenseRuleListRow[] = []

    for (const page of scoped) {
      for (const row of page) {
        const id = asString(row, 'id')
        if (seen.has(id)) continue
        seen.add(id)
        rules.push(toExpenseRule(row))
      }
    }

    // Sorted after the merge, so the two reads produce one list in one order.
    return rules
      .sort((a, b) =>
        a.effectiveFrom === b.effectiveFrom
          ? a.label.localeCompare(b.label, 'he')
          : a.effectiveFrom < b.effectiveFrom
            ? 1
            : -1,
      )
      .slice(0, query.limit)
  }

  async countExpenseRules(organizationId: string): Promise<number> {
    const { count, error } = await this.db
      .from('expense_rules')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .is('deleted_at', null)

    if (error) throw error
    return count ?? 0
  }

  async listExpenseAllocations(
    organizationId: string,
    ruleIds: readonly string[],
  ): Promise<readonly ExpenseAllocationRow[]> {
    const unique = [...new Set(ruleIds)]
    if (unique.length === 0) return []

    const { data, error } = await this.db
      .from('expense_allocations')
      .select(EXPENSE_ALLOCATION_COLUMNS)
      .eq('organization_id', organizationId)
      .in('rule_id', unique)
      .order('allocated_at', { ascending: false })

    if (error) throw error
    return toRows(data).map(toExpenseAllocation)
  }

  /**
   * Write a rule.
   *
   * `version` is absent: `tg_touch_row` owns it, exactly as it owns a payment's.
   * The scope columns are written from the union rather than all four being
   * sent, because `expense_rules_scope_target` refuses a scope that names
   * something at a level it does not claim.
   */
  async insertExpenseRule(
    draft: ExpenseRuleDraft,
    tx?: TransactionHandle,
  ): Promise<ExpenseRuleListRow> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('expense_rules')
      .insert({
        id: draft.id,
        organization_id: draft.organizationId,
        label: draft.label,
        category: draft.category,
        kind: draft.kind,
        frequency: draft.frequency,
        amount_agorot: draft.amountAgorot,
        formula: draft.formula,
        allocation: draft.allocation,
        scope_kind: draft.scope.kind,
        scope_property_id: draft.scope.propertyId ?? null,
        scope_unit_id: draft.scope.unitId ?? null,
        scope_booking_id: draft.scope.bookingId ?? null,
        effective_from: draft.effectiveFrom,
        effective_to: draft.effectiveTo,
        approval_required: draft.approvalRequired,
        created_by: draft.createdByUserId,
      })
      .select(EXPENSE_RULE_COLUMNS)
      .single()

    if (error) throw error
    recordWrite(tx, `expense_rules(${draft.id})`)
    return toExpenseRule(toRow(data))
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** One page of a finance list, with the filters every one of the three shares. */
  private async listRows(
    table: 'payments' | 'invoices' | 'commissions',
    columns: string,
    organizationId: string,
    propertyId: string | null,
    status: string | null,
    limit: number,
  ): Promise<Row[]> {
    let query = this.db
      .from(table)
      .select(columns)
      .eq('organization_id', organizationId)

    if (propertyId !== null) query = query.eq('property_id', propertyId)
    if (status !== null) query = query.eq('status', status)

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    return toRows(data)
  }

  /**
   * A `head` count, so "you have never taken a payment" and "your filter
   * matched nothing" can be told apart without paying for the rows.
   */
  private async countRows(
    table: 'payments' | 'invoices' | 'commissions',
    organizationId: string,
    propertyId: string | null,
  ): Promise<number> {
    let query = this.db
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)

    if (propertyId !== null) query = query.eq('property_id', propertyId)

    const { count, error } = await query
    if (error) throw error
    return count ?? 0
  }

  /**
   * Booking references for the rows on screen, in one query.
   *
   * Not an embed: there is no `payments.bookings` relation declared for the
   * transaction compiler or the demo client, and adding one for a single text
   * column would widen a surface both files keep deliberately narrow. One `in`
   * over at most a page of ids is cheaper than the embed would have been.
   */
  private async bookingReferences(
    organizationId: string,
    bookingIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(bookingIds)]
    if (unique.length === 0) return new Map()

    const { data, error } = await this.db
      .from('bookings')
      .select('id, reference')
      .eq('organization_id', organizationId)
      .in('id', unique)

    if (error) throw error

    const references = new Map<string, string>()
    for (const row of toRows(data)) {
      references.set(asString(row, 'id'), asString(row, 'reference'))
    }
    return references
  }

  /** The payments an invoice accounts for, with or without their amounts. */
  private async linkedPayments(
    organizationId: string,
    paymentIds: readonly string[],
    withAmounts: boolean,
  ): Promise<ReadonlyMap<string, InvoicePaymentLinkRow>> {
    const unique = [...new Set(paymentIds)]
    if (unique.length === 0) return new Map()

    const { data, error } = await this.db
      .from('payments')
      .select('id, status, method, amount_agorot, paid_at')
      .eq('organization_id', organizationId)
      .in('id', unique)

    if (error) throw error

    const links = new Map<string, InvoicePaymentLinkRow>()
    for (const row of toRows(data)) {
      const link: InvoicePaymentLinkRow = {
        id: asString(row, 'id'),
        status: asEnum(row, 'status', PAYMENT_STATUSES),
        method: asEnum(row, 'method', PAYMENT_METHODS),
        paidOn: propertyDate(row, 'paid_at'),
      }
      if (withAmounts) link.amountAgorot = asAgorot(row, 'amount_agorot')
      links.set(link.id, link)
    }
    return links
  }

  /**
   * Display names for the people a commission is owed to.
   *
   * `user_profiles_select` admits anybody who shares an organization with the
   * subject, and this is only ever asked for ids that appeared on a commission
   * row the reader was already admitted to. A missing name is left null rather
   * than filled with the uuid.
   */
  private async profileNames(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (userIds.length === 0) return new Map()

    const { data, error } = await this.db
      .from('user_profiles')
      .select('id, full_name')
      .in('id', [...userIds])

    if (error) throw error

    const names = new Map<string, string>()
    for (const row of toRows(data)) {
      const name = asStringOrNull(row, 'full_name')
      if (name !== null) names.set(asString(row, 'id'), name)
    }
    return names
  }

  /** Agency names. A row this reader cannot see leaves the name null, which is true. */
  private async agencyNames(
    agencyIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (agencyIds.length === 0) return new Map()

    const { data, error } = await this.db
      .from('agencies')
      .select('id, name')
      .in('id', [...agencyIds])

    if (error) throw error

    const names = new Map<string, string>()
    for (const row of toRows(data)) {
      names.set(asString(row, 'id'), asString(row, 'name'))
    }
    return names
  }

  /**
   * One of the two reads `listExpenseRules` merges.
   *
   * `organizationWide` is the difference between "narrow to this property" and
   * "the rules that name no property at all", which is `scope_property_id is
   * null` rather than an absent filter.
   */
  private async expenseRulePage(
    filters: ExpenseRuleListQuery,
    propertyId: string | null,
    organizationWide: boolean,
  ): Promise<Row[]> {
    let query = this.db
      .from('expense_rules')
      .select(EXPENSE_RULE_COLUMNS)
      .eq('organization_id', filters.organizationId)
      .is('deleted_at', null)

    if (organizationWide) query = query.is('scope_property_id', null)
    else if (propertyId !== null) {
      query = query.eq('scope_property_id', propertyId)
    }

    if (filters.kind !== null) query = query.eq('kind', filters.kind)

    const { data, error } = await query
      .order('effective_from', { ascending: false })
      .limit(filters.limit)

    if (error) throw error
    return toRows(data)
  }

  /**
   * The provider events already applied to each of these payments.
   *
   * One query for the whole set rather than one per payment: `loadPaymentsForBooking`
   * on a booking with an instalment plan would otherwise issue a dozen.
   */
  private async appliedEvents(
    db: Db,
    organizationId: string,
    paymentIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const byPayment = new Map<string, string[]>()
    if (paymentIds.length === 0) return byPayment

    const { data, error } = await db
      .from('payment_provider_events')
      .select('payment_id, event_id, applied_at')
      .eq('organization_id', organizationId)
      .in('payment_id', [...paymentIds])
      .order('received_at', { ascending: true })

    if (error) throw error

    for (const row of toRows(data)) {
      // Recorded but not applied is not the same as applied. An event that
      // arrived, was found stale and was filed is evidence; treating it as
      // applied would make the next genuine delivery look like a redelivery.
      if (row.applied_at === null || row.applied_at === undefined) continue
      const paymentId = asStringOrNull(row, 'payment_id')
      if (!paymentId) continue
      const list = byPayment.get(paymentId) ?? []
      list.push(asString(row, 'event_id'))
      byPayment.set(paymentId, list)
    }

    return byPayment
  }

  /** The property a booking belongs to. See note 4 in the header. */
  private async propertyForBooking(
    db: Db,
    organizationId: string,
    bookingId: string,
  ): Promise<string> {
    const { data, error } = await db
      .from('bookings')
      .select('property_id')
      .eq('organization_id', organizationId)
      .eq('id', bookingId)
      .maybeSingle()

    if (error) throw error
    if (!data) {
      throw new ConflictError({
        resourceType: 'booking',
        resourceId: bookingId,
        userMessage:
          'ההזמנה שעבורה נרשם התשלום אינה זמינה. רענן את המסך ונסה שוב.',
      })
    }
    return asString(toRow(data), 'property_id')
  }

  /** The property and booking a refund inherits from its payment. */
  private async paymentAnchor(
    db: Db,
    organizationId: string,
    paymentId: string,
  ): Promise<{ propertyId: string }> {
    const { data, error } = await db
      .from('payments')
      .select('property_id')
      .eq('organization_id', organizationId)
      .eq('id', paymentId)
      .maybeSingle()

    if (error) throw error
    if (!data) {
      throw new ConflictError({
        resourceType: 'payment',
        resourceId: paymentId,
        userMessage: 'התשלום שעבורו התבקש הזיכוי אינו זמין. רענן את המסך.',
      })
    }
    return { propertyId: asString(toRow(data), 'property_id') }
  }

  /**
   * Record which payments account for this invoice.
   *
   * `booking_id` is carried on every row, not derived, because it is what both
   * composite foreign keys are checked against: a link between an invoice for
   * one stay and a payment against another is refused by the database rather
   * than discovered during an audit, and neither end can be a row from
   * another organization.
   */
  private async linkPayments(
    db: Db,
    invoice: Invoice,
    paymentIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<void> {
    if (paymentIds.length === 0) return

    const { error } = await db.from('invoice_payments').insert(
      paymentIds.map((paymentId) => ({
        invoice_id: invoice.id,
        payment_id: paymentId,
        organization_id: invoice.organizationId,
        booking_id: invoice.bookingId,
      })),
    )

    if (error) throw error
    recordWrite(tx, `invoice_payments(${paymentIds.length} × ${invoice.id})`)
  }

  /**
   * Bring the stored links in line with the record, by difference.
   *
   * Not a delete-then-reinsert of the whole set. `invoice_payments` has no
   * UPDATE by design, and clearing every link to rewrite an unchanged one
   * would make each save look like a reallocation in anything watching the
   * table — while briefly leaving an issued invoice accounting for nothing.
   * Only what actually left is deleted and only what actually arrived is
   * inserted.
   */
  private async reconcilePayments(
    db: Db,
    invoice: Invoice,
    stored: readonly string[],
    tx?: TransactionHandle,
  ): Promise<void> {
    const wanted = new Set(invoice.paymentIds)
    const removed = stored.filter((id) => !wanted.has(id))
    const added = invoice.paymentIds.filter((id) => !stored.includes(id))

    if (removed.length > 0) {
      const { error } = await db
        .from('invoice_payments')
        .delete()
        .eq('invoice_id', invoice.id)
        .eq('organization_id', invoice.organizationId)
        .in('payment_id', removed)

      if (error) throw error
      recordWrite(tx, `invoice_payments(-${removed.length} × ${invoice.id})`)
    }

    await this.linkPayments(db, invoice, added, tx)
  }

  private async writeLines(
    db: Db,
    table: 'invoice_lines' | 'credit_note_lines',
    parentColumn: 'invoice_id' | 'credit_note_id',
    args: {
      documentId: string
      organizationId: string
      lines: readonly PriceLine[]
      tx?: TransactionHandle
    },
  ): Promise<void> {
    if (args.lines.length === 0) return

    const { error } = await db.from(table).insert(
      args.lines.map((line, index) => ({
        organization_id: args.organizationId,
        [parentColumn]: args.documentId,
        kind: line.kind,
        label: line.label,
        amount_agorot: line.amount,
        quantity: line.quantity,
        line_date: line.date,
        // Rows have no inherent order, and a printed document whose lines
        // came back shuffled is a document nobody can check against a quote.
        sort_order: index,
      })),
    )

    if (error) throw error
    recordWrite(args.tx, `${table}(${args.lines.length} × ${args.documentId})`)
  }

  private async currentVersion(
    db: Db,
    table: string,
    id: string,
  ): Promise<number | null> {
    const { data, error } = await db
      .from(table)
      .select('version')
      .eq('id', id)
      .maybeSingle()

    if (error || !data) return null
    return asNumberOrNull(toRow(data), 'version')
  }
}

// ── Column lists ──────────────────────────────────────────────────────────

const PAYMENT_COLUMNS =
  'id, organization_id, property_id, booking_id, purpose, method, channel, ' +
  'status, currency, amount_agorot, authorized_agorot, captured_agorot, ' +
  'amount_refunded_agorot, provider, provider_payment_id, schedule_id, ' +
  'instalment_number, due_on, last_provider_event_at, requires_attention, ' +
  'unknown_since, created_at, updated_at, created_by, version'

const REFUND_COLUMNS =
  'id, organization_id, property_id, booking_id, payment_id, amount_agorot, ' +
  'status, approval_status, reason, reason_code, approved_by, requested_by, ' +
  'provider_refund_id, settled_by_event_id, requested_at, processed_at, metadata'

const DEPOSIT_COLUMNS =
  'id, organization_id, property_id, booking_id, status, method, ' +
  'required_agorot, held_agorot, released_agorot, forfeited_agorot, currency, ' +
  'payment_id, forfeit_reason, authorized_at, captured_at, released_at, ' +
  'released_by, forfeited_at, created_at, updated_at, version'

const INVOICE_COLUMNS =
  'id, organization_id, property_id, booking_id, kind, status, series, year, ' +
  'number, display_number, customer_name, customer_tax_id, subtotal_agorot, ' +
  'tax_agorot, total_agorot, tax_rate_bps, tourist_vat_exempt, currency, ' +
  'issued_at, cancelled_at, cancellation_reason, archived_at, ' +
  'snapshot_captured_at, metadata, invoice_lines(kind, label, amount_agorot, ' +
  'quantity, line_date, sort_order), invoice_payments(payment_id)'

const COMMISSION_COLUMNS =
  'id, organization_id, property_id, booking_id, agent_user_id, agency_id, ' +
  'status, base, basis_agorot, rate_bps, amount_agorot, explanation, ' +
  'statement_id, payout_batch_id, eligible_at, approved_by, paid_at, ' +
  'cancellation_reason, clawback_required, metadata, created_at, version'

const CREDIT_NOTE_COLUMNS =
  'id, organization_id, property_id, invoice_id, booking_id, status, series, ' +
  'year, number, display_number, amount_agorot, tax_agorot, currency, reason, ' +
  'issued_at, credit_note_lines(kind, label, amount_agorot, quantity, ' +
  'line_date, sort_order)'

/* ── The list reads ────────────────────────────────────────────────────────
 *
 * Narrower than the record columns above, and each is the exact list the
 * screens used before the port grew these methods. A list that selected
 * `PAYMENT_COLUMNS` would carry `version`, `currency` and `authorized_agorot`
 * across the wire for a hundred rows nobody prints them for.
 */

const PAYMENT_LIST_COLUMNS =
  'id, booking_id, property_id, status, method, purpose, channel, ' +
  'amount_agorot, captured_agorot, amount_refunded_agorot, payer_name, ' +
  'payer_reference, requires_attention, unknown_since, paid_at, created_at'

/**
 * `invoice_payments(payment_id)`, and never `metadata.payment_ids`.
 *
 * 0022 created the join table and 0024 dropped the array after proving nothing
 * was lost. A fallback to the array here would resurrect links somebody
 * deliberately removed, on a deployment where the key still happens to exist.
 */
const INVOICE_LIST_COLUMNS =
  'id, booking_id, property_id, kind, status, series, year, number, ' +
  'display_number, customer_name, customer_tax_id, subtotal_agorot, ' +
  'tax_agorot, total_agorot, tax_rate_bps, tourist_vat_exempt, issued_at, ' +
  'cancelled_at, cancellation_reason, created_at, ' +
  'invoice_lines(kind, label, amount_agorot, quantity, line_date, sort_order), ' +
  'invoice_payments(payment_id)'

const COMMISSION_LIST_COLUMNS =
  'id, booking_id, property_id, agent_user_id, agency_id, status, base, ' +
  'basis_agorot, rate_bps, amount_agorot, explanation, eligible_at, ' +
  'approved_at, paid_at, cancellation_reason, clawback_required, metadata, ' +
  'created_at'

const EXPENSE_RULE_COLUMNS =
  'id, label, category, kind, frequency, amount_agorot, formula, allocation, ' +
  'scope_kind, scope_property_id, scope_unit_id, scope_booking_id, ' +
  'effective_from, effective_to, approval_required, version'

const EXPENSE_ALLOCATION_COLUMNS =
  'id, rule_id, rule_version, booking_id, method, period_start, period_end, ' +
  'amount_agorot, weight, basis, allocated_at'

const SNAPSHOT_COLUMNS =
  'organization_id, booking_id, captured_at, property_id, unit_id, ' +
  'captured_by, reason, revision, supersedes_captured_at, check_in, ' +
  'check_out, nights, guests, lines, total_agorot, stay_total_agorot, ' +
  'deposit_agorot, tax_agorot, tax_rate_percent, currency, commission_rule, ' +
  'owner_share_rule, expense_rules'

// ── Row mapping ───────────────────────────────────────────────────────────

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

/**
 * `settled_by_event_id` is a uuid pointing at a `payment_provider_events` row;
 * the domain's `settledByEventId` is the *provider's* identifier for the same
 * event — a string like `evt_3PqR…`. They are not the same value, and coercing
 * one into the other would either throw on a uuid column or store a foreign
 * key that points at nothing.
 *
 * So the provider's id is kept in `metadata`, where it round-trips exactly,
 * and the uuid column is left to the ingestion path that owns the event row.
 * A `settled_by_event_id` migration that accepted the provider's own string
 * would make this a plain column, and should.
 */
function settledByEvent(providerEventId: string | null): Row {
  return { metadata: { settled_by_provider_event_id: providerEventId } }
}

function toPayment(row: Row, appliedEventIds: readonly string[]): Payment {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    bookingId: asString(row, 'booking_id'),
    purpose: asEnum(row, 'purpose', PAYMENT_PURPOSES),
    method: asEnum(row, 'method', PAYMENT_METHODS),
    channel: asEnum(row, 'channel', COLLECTION_CHANNELS),
    status: asEnum(row, 'status', PAYMENT_STATUSES),
    currency: asString(row, 'currency') as Payment['currency'],
    amountAgorot: asAgorot(row, 'amount_agorot'),
    authorizedAgorot: asAgorot(row, 'authorized_agorot'),
    capturedAgorot: asAgorot(row, 'captured_agorot'),
    refundedAgorot: asAgorot(row, 'amount_refunded_agorot'),
    providerId: asStringOrNull(row, 'provider'),
    providerRef: asStringOrNull(row, 'provider_payment_id'),
    scheduleId: asStringOrNull(row, 'schedule_id'),
    instalmentNumber: asNumberOrNull(row, 'instalment_number'),
    dueOn: asIsoDateOrNull(row, 'due_on'),
    appliedEventIds: [...appliedEventIds],
    lastProviderEventAt: asDateOrNull(row, 'last_provider_event_at'),
    requiresAttention: asEnumOrNull(
      row,
      'requires_attention',
      PAYMENT_ATTENTIONS,
    ),
    unknownSince: asDateOrNull(row, 'unknown_since'),
    createdAt: asDate(row, 'created_at'),
    updatedAt: asDate(row, 'updated_at'),
    createdByUserId: asStringOrNull(row, 'created_by'),
    version: asNumber(row, 'version'),
  }
}

function toRefund(row: Row): Refund {
  const metadata = asJsonRecord(row, 'metadata')
  const carried = metadata.settled_by_provider_event_id
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    paymentId: asString(row, 'payment_id'),
    bookingId: asString(row, 'booking_id'),
    amountAgorot: asAgorot(row, 'amount_agorot'),
    reason: asEnum(row, 'reason_code', REFUND_REASONS),
    reasonText: asString(row, 'reason'),
    status: asEnum(row, 'status', REFUND_STATUSES),
    approvalStatus: asEnum(row, 'approval_status', APPROVAL_STATUSES),
    approvedByUserId: asStringOrNull(row, 'approved_by'),
    requestedByUserId: asStringOrNull(row, 'requested_by'),
    providerRef: asStringOrNull(row, 'provider_refund_id'),
    settledByEventId: typeof carried === 'string' ? carried : null,
    requestedAt: asDate(row, 'requested_at'),
    processedAt: asDateOrNull(row, 'processed_at'),
  }
}

function toDeposit(row: Row): Deposit {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    bookingId: asString(row, 'booking_id'),
    status: asEnum(row, 'status', PAYMENT_STATUSES),
    method: asEnumOrNull(row, 'method', PAYMENT_METHODS),
    requiredAgorot: asAgorot(row, 'required_agorot'),
    heldAgorot: asAgorot(row, 'held_agorot'),
    releasedAgorot: asAgorot(row, 'released_agorot'),
    forfeitedAgorot: asAgorot(row, 'forfeited_agorot'),
    currency: asString(row, 'currency') as Deposit['currency'],
    paymentId: asStringOrNull(row, 'payment_id'),
    forfeitReason: asStringOrNull(row, 'forfeit_reason'),
    authorizedAt: asDateOrNull(row, 'authorized_at'),
    capturedAt: asDateOrNull(row, 'captured_at'),
    releasedAt: asDateOrNull(row, 'released_at'),
    releasedByUserId: asStringOrNull(row, 'released_by'),
    forfeitedAt: asDateOrNull(row, 'forfeited_at'),
    createdAt: asDate(row, 'created_at'),
    updatedAt: asDate(row, 'updated_at'),
    version: asNumber(row, 'version'),
  }
}

function toLines(row: Row, column: string): PriceLine[] {
  const raw = row[column]
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => toRow(entry))
    .sort((a, b) => asNumber(a, 'sort_order') - asNumber(b, 'sort_order'))
    .map((line) => ({
      kind: asEnum(line, 'kind', PRICE_LINE_KINDS),
      label: asString(line, 'label'),
      amount: asAgorot(line, 'amount_agorot'),
      quantity: asNumber(line, 'quantity'),
      date: asStringOrNull(line, 'line_date'),
    }))
}

function toInvoice(row: Row): Invoice {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    bookingId: asString(row, 'booking_id'),
    kind: asEnum(row, 'kind', INVOICE_KINDS),
    status: asEnum(row, 'status', INVOICE_STATUSES),
    series: asString(row, 'series'),
    year: asNumber(row, 'year'),
    number: asNumberOrNull(row, 'number'),
    displayNumber: asStringOrNull(row, 'display_number'),
    customerName: asString(row, 'customer_name'),
    customerTaxId: asStringOrNull(row, 'customer_tax_id'),
    lines: toLines(row, 'invoice_lines'),
    subtotalAgorot: asAgorot(row, 'subtotal_agorot'),
    taxAgorot: asAgorot(row, 'tax_agorot'),
    totalAgorot: asAgorot(row, 'total_agorot'),
    taxRateBps: asNumberOrNull(row, 'tax_rate_bps'),
    touristVatExempt: asBoolean(row, 'tourist_vat_exempt'),
    currency: asString(row, 'currency') as Invoice['currency'],
    issuedAt: asDateOrNull(row, 'issued_at'),
    cancelledAt: asDateOrNull(row, 'cancelled_at'),
    cancellationReason: asStringOrNull(row, 'cancellation_reason'),
    archivedAt: asDateOrNull(row, 'archived_at'),
    // `invoice_payments`, not `metadata.payment_ids`. An empty list is a real
    // answer — an issued invoice nothing has settled yet — and is why nothing
    // here falls back to the array 0022 replaced: a stale copy in `metadata`
    // would resurrect a link somebody deliberately removed.
    paymentIds: toPaymentIds(row),
    // `asTimestampOrNull`, not `asTimestamp`. The column is nullable — 0016
    // added it to a table that already held documents, with no backfill — and
    // `asTimestamp` refuses null, so a single invoice without a capture made
    // this method throw before it returned a row. `archived_at` above is the
    // same shape and was already read tolerantly; this one was not.
    snapshotCapturedAt: asTimestampOrNull(row, 'snapshot_captured_at'),
  }
}

function toPaymentIds(row: Row): readonly string[] {
  const embedded = row.invoice_payments
  if (!Array.isArray(embedded)) return []
  return embedded.map((entry) => asString(toRow(entry), 'payment_id'))
}

function toCommission(row: Row): Commission {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    bookingId: asString(row, 'booking_id'),
    // Both nullable, and the domain says one of the two is always there: an
    // agency keeps the relationship when the individual leaves. Neither is
    // invented here — a commission with no owner at all is a row somebody
    // should look at, not one this layer should paper over.
    agentUserId: asStringOrNull(row, 'agent_user_id'),
    agencyId: asStringOrNull(row, 'agency_id'),
    status: asEnum(row, 'status', COMMISSION_STATUSES),
    basisAgorot: asAgorot(row, 'basis_agorot'),
    rateBps: asNumberOrNull(row, 'rate_bps'),
    amountAgorot: asAgorot(row, 'amount_agorot'),
    rule: toCommissionRule(row),
    statementId: asStringOrNull(row, 'statement_id'),
    payoutBatchId: asStringOrNull(row, 'payout_batch_id'),
    becameEligibleAt: asDateOrNull(row, 'eligible_at'),
    approvedByUserId: asStringOrNull(row, 'approved_by'),
    paidAt: asDateOrNull(row, 'paid_at'),
    cancelledReason: asStringOrNull(row, 'cancellation_reason'),
    clawbackRequired: asBoolean(row, 'clawback_required'),
    createdAt: asDate(row, 'created_at'),
    version: asNumber(row, 'version'),
  }
}

/**
 * The rule a commission was computed under.
 *
 * Stored in `metadata.rule` and read back whole, because that is the value the
 * domain wrote and re-deriving it would be a second calculation of a settled
 * number. When it is absent, it is rebuilt from the columns that *reproduce
 * the money* — the base, the rate and the amount — rather than guessed at, so
 * a derived rule cannot contradict the figure beside it. `basis` always comes
 * from the `base` column, which is the constrained one; a `basis` stored in
 * jsonb that disagreed with it would be the drift 0018 has just finished
 * removing.
 */
function toCommissionRule(row: Row): Commission['rule'] {
  const basis = asEnum(row, 'base', COMMISSION_BASES)
  const stored = asJsonRecord(row, 'metadata').rule

  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    return { ...(stored as Commission['rule']), basis }
  }

  const rateBps = asNumberOrNull(row, 'rate_bps')
  return {
    basis,
    kind: rateBps === null ? 'fixed' : 'percent',
    // Percentage points for `percent`, agorot for `fixed` — the units the
    // domain's own type declares.
    value: rateBps === null ? asAgorot(row, 'amount_agorot') : rateBps / 100,
    label: asStringOrNull(row, 'explanation') ?? '',
  }
}

/* ── List row mapping ──────────────────────────────────────────────────── */

/**
 * A `timestamptz` as the calendar date it fell on at the property.
 *
 * Not `iso.slice(0, 10)`. A payment taken at 00:30 in Israel is `21:30Z` the
 * previous day, and slicing the ISO string would file it under yesterday — on
 * the screen a bookkeeper uses to reconcile a day's takings. `localDate` is the
 * domain's own conversion, against `PROPERTY_TIME_ZONE`.
 */
function propertyDate(row: Row, column: string): string | null {
  const value = asTimestampOrNull(row, column)
  return value === null ? null : localDate(new Date(value))
}

function requiredPropertyDate(row: Row, column: string): string {
  return localDate(new Date(asTimestamp(row, column)))
}

function namesNeeded(rows: readonly Row[], column: string): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    const value = asStringOrNull(row, column)
    if (value !== null) ids.add(value)
  }
  return [...ids]
}

/**
 * The payee, decided the way the domain decides it.
 *
 * `payeeKey` in `finance/commissions.ts` prefers `agentUserId` and falls back
 * to the agency, and this follows that order rather than inventing a second
 * rule — the two must agree, because one groups a statement and the other
 * labels it.
 */
function toPayee(
  row: Row,
  people: ReadonlyMap<string, string>,
  agencies: ReadonlyMap<string, string>,
): CommissionPayee {
  const agentUserId = asStringOrNull(row, 'agent_user_id')
  const agencyId = asStringOrNull(row, 'agency_id')

  if (agentUserId !== null) {
    return {
      kind: 'agent',
      name: people.get(agentUserId) ?? null,
      agencyName: agencyId === null ? null : (agencies.get(agencyId) ?? null),
    }
  }
  if (agencyId !== null) {
    return { kind: 'agency', name: agencies.get(agencyId) ?? null }
  }
  return { kind: 'unknown' }
}

/**
 * `toCommissionRule`, with the label withheld.
 *
 * The rule is read exactly as the record reader reads it. `withLabel` is the
 * only difference and it is not cosmetic: the label is free text written when
 * the commission was created and it routinely quotes the base in words —
 * "10% מסך הלינות (2,940 ₪)" — so it is the base by another name. It lives one
 * level down inside `rule`, where `redact()` cannot reach it, which is correct
 * behaviour and not a bug in `redact`: a field rule cannot know that another
 * field's value was copied somewhere else. So the copy is never built.
 *
 * An empty label is the domain's own "no explanation", which the screen renders
 * as nothing rather than as a blank quotation.
 */
function toListedCommissionRule(
  row: Row,
  withLabel: boolean,
): Commission['rule'] {
  const rule = toCommissionRule(row)
  return withLabel ? rule : { ...rule, label: '' }
}

function toExpenseRule(row: Row): ExpenseRuleListRow {
  return {
    id: asString(row, 'id'),
    label: asString(row, 'label'),
    category: asString(row, 'category'),
    kind: asEnum(row, 'kind', EXPENSE_KINDS),
    frequency: asEnum(row, 'frequency', EXPENSE_FREQUENCIES),
    amountAgorot: asAgorot(row, 'amount_agorot'),
    formula: toVariableFormula(row),
    allocation: asEnum(row, 'allocation', ALLOCATION_METHODS),
    scopeKind: asEnum(row, 'scope_kind', EXPENSE_SCOPE_KINDS),
    scopePropertyId: asStringOrNull(row, 'scope_property_id'),
    effectiveFrom: asIsoDate(row, 'effective_from'),
    effectiveTo: asIsoDateOrNull(row, 'effective_to'),
    approvalRequired: asBoolean(row, 'approval_required'),
    version: asNumber(row, 'version'),
  }
}

/**
 * The `VariableFormula` union, out of jsonb.
 *
 * `expense_rules_formula_kind` constrains `formula ->> 'kind'` to the five the
 * domain declares, and `expense_rules_formula_pair` makes the column null for
 * every fixed rule — so a row that reaches here with an unrecognised kind is a
 * row the database should have refused. It comes back as `null` rather than as
 * a half-built object: `variableAmount` denies by default on a formula it does
 * not recognise, and a shape that lies about its kind would be worse than an
 * absent one.
 */
function toVariableFormula(row: Row): VariableFormula | null {
  const raw = row.formula
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  if (Array.isArray(raw)) return null

  const formula = raw as Record<string, unknown>
  const kind = formula.kind

  if (kind === 'percent_of_revenue') {
    // Stored as basis points by the seed and as `percent` by the domain. Both
    // are read, and neither is guessed at: a `bps` key means basis points.
    const bps = formula.bps
    const percent = formula.percent
    if (typeof bps === 'number') {
      return { kind: 'percent_of_revenue', percent: bps / 100 }
    }
    if (typeof percent === 'number') {
      return { kind: 'percent_of_revenue', percent }
    }
    return null
  }

  if (
    kind === 'per_night' ||
    kind === 'per_guest_night' ||
    kind === 'per_booking' ||
    kind === 'per_guest'
  ) {
    const rate = formula.rateAgorot
    return typeof rate === 'number' && Number.isInteger(rate)
      ? { kind, rateAgorot: rate }
      : null
  }

  return null
}

function toExpenseAllocation(row: Row): ExpenseAllocationRow {
  return {
    id: asString(row, 'id'),
    ruleId: asString(row, 'rule_id'),
    ruleVersion: asNumber(row, 'rule_version'),
    bookingId: asString(row, 'booking_id'),
    method: asEnum(row, 'method', ALLOCATION_METHODS),
    periodStart: asIsoDate(row, 'period_start'),
    periodEnd: asIsoDate(row, 'period_end'),
    amountAgorot: asAgorot(row, 'amount_agorot'),
    // `numeric(12,6)` arrives as a string. `asNumber` is what stops "1.000000"
    // reaching arithmetic as a concatenation.
    weight: asNumber(row, 'weight'),
    basis: asStringOrNull(row, 'basis'),
    allocatedOn: requiredPropertyDate(row, 'allocated_at'),
  }
}

function toCreditNote(row: Row): CreditNote {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    invoiceId: asString(row, 'invoice_id'),
    bookingId: asString(row, 'booking_id'),
    status: asEnum(row, 'status', INVOICE_STATUSES),
    series: asString(row, 'series'),
    year: asNumber(row, 'year'),
    number: asNumberOrNull(row, 'number'),
    displayNumber: asStringOrNull(row, 'display_number'),
    lines: toLines(row, 'credit_note_lines'),
    amountAgorot: asAgorot(row, 'amount_agorot'),
    taxAgorot: asAgorot(row, 'tax_agorot'),
    currency: asString(row, 'currency') as CreditNote['currency'],
    reason: asString(row, 'reason'),
    issuedAt: asDateOrNull(row, 'issued_at'),
  }
}

function toSnapshot(row: Row): FinanceSnapshot {
  const lines = Array.isArray(row.lines) ? row.lines : []
  return {
    bookingId: asString(row, 'booking_id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    unitId: asString(row, 'unit_id'),
    capturedAt: asTimestamp(row, 'captured_at'),
    capturedByUserId: asStringOrNull(row, 'captured_by'),
    reason: asString(row, 'reason'),
    revision: asNumber(row, 'revision'),
    supersedesCapturedAt: asTimestampOrNull(row, 'supersedes_captured_at'),
    range: {
      checkIn: asIsoDate(row, 'check_in'),
      checkOut: asIsoDate(row, 'check_out'),
    },
    nights: asNumber(row, 'nights'),
    guests: asNumber(row, 'guests'),
    // Stored as the domain wrote it. This jsonb column *is* the designed
    // storage for the frozen quote — see 0016 — so it is carried through
    // rather than reassembled from columns that do not exist.
    lines: lines as unknown as readonly PriceLine[],
    totalAgorot: asAgorot(row, 'total_agorot'),
    stayTotalAgorot: asAgorot(row, 'stay_total_agorot'),
    depositAgorot: asAgorot(row, 'deposit_agorot'),
    taxAgorot: asAgorot(row, 'tax_agorot'),
    taxRatePercent: asNumber(row, 'tax_rate_percent'),
    currency: asString(row, 'currency') as FinanceSnapshot['currency'],
    commissionRule: (row.commission_rule ??
      null) as FinanceSnapshot['commissionRule'],
    ownerShareRule: (row.owner_share_rule ??
      null) as FinanceSnapshot['ownerShareRule'],
    expenseRules: (Array.isArray(row.expense_rules)
      ? row.expense_rules
      : []) as FinanceSnapshot['expenseRules'],
  }
}

// ── Vocabularies ──────────────────────────────────────────────────────────
//
// Imported from the domain, never restated. A list copied into an adapter is a
// list that stops agreeing with the state machine the first time a member is
// added, and `asEnum` refusing an unknown value is only a guarantee while the
// two lists are the same list.
