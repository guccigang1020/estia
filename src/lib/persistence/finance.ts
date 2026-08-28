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
 * WHAT IS NOT IMPLEMENTED, AND EXACTLY WHY
 * ============================================================================
 *
 * **`loadCommissionsForBooking` and `updateCommission` are blocked on an enum.**
 * Not on a missing table — `commissions` has every column these need. On
 * `public.commission_base`, which 0015 created with two members,
 * `whole_booking` and `accommodation_only`. `COMMISSION_BASES` in
 * `src/lib/contracts/states.ts` now has six, and `whole_booking` is not among
 * them: it was unified out when four modules were found to be declaring the
 * list differently. So the type in the database and the type in the code no
 * longer describe the same set in either direction — `stay_total` cannot be
 * stored, and a stored `whole_booking` is not a value any TypeScript union
 * accepts. Reading one and calling it a `CommissionBase` would put a value in
 * the domain that the domain has no meaning for, on the record that decides
 * what an agent is paid.
 *
 * The migration is small and is not this work's to write:
 *
 *     alter type public.commission_base add value 'stay_total';
 *     -- …and the remaining four, then migrate the `whole_booking` rows.
 *
 * Both methods therefore raise `SchemaNotProvisionedError` — loudly, and never
 * an empty array, because an agent statement that renders zero commissions is
 * indistinguishable from an agent who earned none.
 *
 * **`Invoice.paymentIds` has no storage.** There is no `invoice_payments` join
 * table in any migration to 0017. It is carried in `invoices.metadata` under
 * `payment_ids` so that nothing is lost and an invoice round-trips, and that
 * is a stopgap rather than a design: a join table is what makes "which
 * invoice accounts for this payment" answerable from the payment's side, and
 * a jsonb array cannot be indexed into that question usefully. Flagged here
 * rather than quietly normalised.
 *
 * **`Invoice` and `CreditNote` carry no `version`**, so `updateInvoice` locks
 * on nothing. The column exists and the trigger maintains it; the port has no
 * field to compare against, so two concurrent issuers of the same invoice
 * cannot be told apart here. Adding `version` to the port would close it.
 */

import { PRICE_LINE_KINDS, type PriceLine } from '../booking/types'
import {
  APPROVAL_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
} from '../contracts/states'
import { ConflictError } from '../errors'
import type { FinanceRepository } from '../finance/repository'
import type { FinanceSnapshot } from '../finance/snapshot'
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
import { SchemaNotProvisionedError } from './errors'
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
        // The stopgap named in the header. A join table is what this wants.
        metadata: { payment_ids: [...invoice.paymentIds] },
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

    return { ...toInvoice(toRow(data)), lines: invoice.lines }
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
        metadata: { payment_ids: [...invoice.paymentIds] },
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
    return { ...toInvoice(rows[0] as Row), lines: invoice.lines }
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

  /** Blocked on `public.commission_base`. See the header. */
  async loadCommissionsForBooking(): Promise<readonly Commission[]> {
    throw commissionBaseBlocked()
  }

  /** Blocked on `public.commission_base`. See the header. */
  async updateCommission(): Promise<Commission> {
    throw commissionBaseBlocked()
  }

  // ── Internals ───────────────────────────────────────────────────────────

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
  'quantity, line_date, sort_order)'

const CREDIT_NOTE_COLUMNS =
  'id, organization_id, property_id, invoice_id, booking_id, status, series, ' +
  'year, number, display_number, amount_agorot, tax_agorot, currency, reason, ' +
  'issued_at, credit_note_lines(kind, label, amount_agorot, quantity, ' +
  'line_date, sort_order)'

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
  const metadata = asJsonRecord(row, 'metadata')
  const paymentIds = metadata.payment_ids
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
    paymentIds: Array.isArray(paymentIds)
      ? paymentIds.filter((id): id is string => typeof id === 'string')
      : [],
    snapshotCapturedAt: asTimestamp(row, 'snapshot_captured_at'),
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

function commissionBaseBlocked(): SchemaNotProvisionedError {
  return new SchemaNotProvisionedError(
    'public.commission_base with the six members of COMMISSION_BASES',
    'reading or writing a commission through the finance port. The enum has ' +
      "'whole_booking' and 'accommodation_only'; the unified contract in " +
      "src/lib/contracts/states.ts has 'accommodation_only', 'stay_total', " +
      "'gross_revenue', 'net_revenue', 'net_of_direct_costs' and " +
      "'net_contribution', and does not have 'whole_booking' at all",
  )
}

// ── Vocabularies ──────────────────────────────────────────────────────────
//
// Imported from the domain, never restated. A list copied into an adapter is a
// list that stops agreeing with the state machine the first time a member is
// added, and `asEnum` refusing an unknown value is only a guarantee while the
// two lists are the same list.
