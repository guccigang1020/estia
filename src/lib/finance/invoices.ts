/**
 * Invoices and credit notes.
 *
 * A tax invoice is a legal document, not a view of a booking. That single fact
 * decides everything in this file:
 *
 * **It is issued from the snapshot, never from live data.** The lines are
 * copied out of the booking's `FinanceSnapshot`, which was itself copied from
 * what `booking/pricing.ts` produced. Nothing here prices anything, and
 * nothing here re-rounds anything — `totalAgorot` is the sum of the lines
 * because the lines are the ones that were already summed.
 *
 * **It is immutable once issued.** There is no `updateInvoice`. A mistake on
 * an issued document is corrected with a credit note, which is a second
 * document with its own number, because that is what the tax authority
 * recognises and because an edited invoice destroys the evidence of what was
 * originally sent.
 *
 * **Archiving is not cancelling.** `archiveInvoice` sets `archivedAt` and
 * leaves the status alone. An archived tax invoice is still in force; filing
 * it away is an operational convenience for the person working the list. A
 * product that made archival a status would eventually have somebody "tidy up"
 * a year's revenue.
 *
 * ── What is on the document and what is not ───────────────────────────────
 *
 * **The refundable security deposit is excluded.** It is on the payment
 * request — the guest genuinely hands it over — but it is not a supply of
 * anything, so it does not belong on a tax invoice and is not part of the VAT
 * base. It is reported alongside as `depositExcludedAgorot`, so the invoice
 * total and the amount charged can be reconciled without anyone guessing at
 * the difference.
 *
 * **Agent commission is excluded**, for the reason `pricing.ts` already gives:
 * it is never in the guest's total, and putting it on the guest's invoice
 * would bill them for the business's own cost of sale.
 */

import { sumLines } from '../booking/pricing'
import type { Agorot, PriceLine } from '../booking/types'
import { BusinessRuleError } from '../errors'
import { formatAgorot } from '../plans/plan'
import { CURRENCY, sumAgorot } from './money'
import type { FinanceSnapshot } from './snapshot'
import type { CreditNote, Invoice, InvoiceKind, InvoiceStatus } from './types'

// ── What goes on the document ─────────────────────────────────────────────

/** Line kinds a tax invoice never carries. See the header for each. */
const EXCLUDED_KINDS: ReadonlySet<PriceLine['kind']> = new Set([
  'deposit',
  'agent_commission',
])

export interface InvoiceComposition {
  lines: readonly PriceLine[]
  subtotalAgorot: Agorot
  taxAgorot: Agorot
  totalAgorot: Agorot
  /** Charged to the guest but off the document. Reconciles the difference. */
  depositExcludedAgorot: Agorot
}

/**
 * Split a snapshot's lines into what the document says.
 *
 * `subtotal + tax = total` holds by construction: the two are partitions of
 * the same array, not two independent calculations that are expected to agree.
 */
export function composeInvoice(snapshot: FinanceSnapshot): InvoiceComposition {
  const lines = snapshot.lines.filter((line) => !EXCLUDED_KINDS.has(line.kind))
  const taxLines = lines.filter((line) => line.kind === 'tax')
  const supplyLines = lines.filter((line) => line.kind !== 'tax')

  const subtotalAgorot = sumLines(supplyLines)
  const taxAgorot = sumLines(taxLines)

  return {
    lines,
    subtotalAgorot,
    taxAgorot,
    totalAgorot: subtotalAgorot + taxAgorot,
    depositExcludedAgorot: sumLines(
      snapshot.lines.filter((line) => line.kind === 'deposit'),
    ),
  }
}

// ── Numbering ─────────────────────────────────────────────────────────────

/**
 * The printed form of a document number.
 *
 * `2026-000184` for a per-year series, `000184` for one unbroken run. Kept as
 * its own value on the record so the display form survives a change in how
 * numbers are composed — an issued document's printed number must never move.
 */
export function formatDocumentNumber(year: number, number: number): string {
  const padded = String(number).padStart(6, '0')
  return year === 0 ? padded : `${year}-${padded}`
}

// ── Issuing ───────────────────────────────────────────────────────────────

export interface IssueInvoiceInput {
  id: string
  snapshot: FinanceSnapshot
  kind: InvoiceKind
  /** Allocated by the database's gapless counter. Never chosen here. */
  number: number
  series?: string
  year?: number
  customerName: string
  customerTaxId?: string | null
  taxRateBps?: number | null
  touristVatExempt?: boolean
  /** The payments this document accounts for. */
  paymentIds?: readonly string[]
  issuedAt: Date
}

/**
 * Turn a snapshot into a document.
 *
 * Born `issued`, with a number and a moment — there is deliberately no path
 * that produces an issued invoice without both, because the database's own
 * `invoices_issued_pair` constraint says the same thing and a domain that
 * could produce a row the schema refuses is a domain that fails at the last
 * moment, inside a transaction, with a Postgres error nobody can read.
 */
export function issueInvoice(input: IssueInvoiceInput): Invoice {
  const { snapshot } = input

  if (input.customerName.trim().length === 0) {
    throw new BusinessRuleError({
      code: 'finance.invoice_needs_customer',
      userMessage: 'לא ניתן להפיק חשבונית ללא שם לקוח.',
      message: 'issueInvoice called without a customer name',
    })
  }
  if (!Number.isInteger(input.number) || input.number < 1) {
    throw new BusinessRuleError({
      code: 'finance.invoice_needs_number',
      userMessage: 'לא ניתן להפיק חשבונית ללא מספר סידורי תקין.',
      message: `Invalid invoice number: ${input.number}`,
    })
  }

  const composed = composeInvoice(snapshot)

  if (composed.totalAgorot <= 0) {
    throw new BusinessRuleError({
      code: 'finance.invoice_has_no_value',
      userMessage:
        'אין מה לחייב בהזמנה הזו — סכום החשבונית הוא אפס. בדוק את התמחור.',
      message: `Refusing to issue an invoice for ${composed.totalAgorot} agorot`,
    })
  }

  const year = input.year ?? new Date(input.issuedAt).getUTCFullYear()

  return {
    id: input.id,
    organizationId: snapshot.organizationId,
    // A booking always sits in a property; the snapshot's nullable
    // `propertyId` is a looser type than the invoice table allows, so the
    // mismatch is refused here rather than at the insert.
    propertyId: requirePropertyId(snapshot),
    bookingId: snapshot.bookingId,
    kind: input.kind,
    status: 'issued',
    series: input.series ?? 'default',
    year,
    number: input.number,
    displayNumber: formatDocumentNumber(year, input.number),
    customerName: input.customerName.trim(),
    customerTaxId: input.customerTaxId ?? null,
    lines: composed.lines,
    subtotalAgorot: composed.subtotalAgorot,
    taxAgorot: composed.taxAgorot,
    totalAgorot: composed.totalAgorot,
    // Basis points from the snapshotted percentage. A zero rate is recorded as
    // `null` rather than `0`: "this supply carried no VAT" and "the rate was
    // zero per cent" read the same on screen and are different statements to
    // an auditor.
    taxRateBps: input.taxRateBps ?? taxRateBpsFrom(snapshot.taxRatePercent),
    touristVatExempt: input.touristVatExempt ?? false,
    currency: CURRENCY,
    issuedAt: input.issuedAt,
    cancelledAt: null,
    cancellationReason: null,
    archivedAt: null,
    paymentIds: [...(input.paymentIds ?? [])],
    snapshotCapturedAt: snapshot.capturedAt,
  }
}

function taxRateBpsFrom(percent: number): number | null {
  if (!Number.isFinite(percent) || percent <= 0) return null
  return Math.round(percent * 100)
}

function requirePropertyId(snapshot: FinanceSnapshot): string {
  if (snapshot.propertyId !== null) return snapshot.propertyId
  throw new BusinessRuleError({
    code: 'finance.invoice_needs_property',
    userMessage: 'לא ניתן להפיק חשבונית להזמנה שאינה משויכת לנכס.',
    message: `Snapshot for booking ${snapshot.bookingId} has no property`,
  })
}

// ── Archiving and cancelling ──────────────────────────────────────────────

/**
 * File the document away.
 *
 * Legal on an issued document, and it changes nothing about the document —
 * only where it appears in the working list. Archiving an already-archived
 * invoice is a no-op rather than an error: it is a filing action, and a second
 * click on "archive" is not a business rule violation.
 */
export function archiveInvoice(invoice: Invoice, now: Date): Invoice {
  if (invoice.status !== 'issued') {
    throw new BusinessRuleError({
      code: 'finance.cannot_archive_unissued',
      userMessage: 'ניתן לתייק רק חשבונית שהופקה.',
      message: `Cannot archive an invoice in status ${invoice.status}`,
    })
  }
  if (invoice.archivedAt !== null) return invoice
  return { ...invoice, archivedAt: now }
}

/**
 * Cancel a document.
 *
 * **Only a draft, or a proforma.** An issued tax invoice is not cancellable:
 * the tax authority has a copy, and the instrument that corrects it is a
 * credit note. Allowing a cancellation here would be a one-line change that
 * quietly makes the business's books deniable.
 */
export function cancelInvoice(
  invoice: Invoice,
  reason: string,
  now: Date,
): Invoice {
  const cancellable = invoice.status === 'draft' || invoice.kind === 'proforma'
  if (!cancellable) {
    throw new BusinessRuleError({
      code: 'finance.cannot_cancel_issued_invoice',
      userMessage:
        'לא ניתן לבטל חשבונית מס שהופקה. התיקון נעשה באמצעות חשבונית זיכוי.',
      message: `Refusing to cancel issued ${invoice.kind} ${invoice.id}`,
    })
  }
  if (reason.trim().length === 0) {
    throw new BusinessRuleError({
      code: 'finance.cancellation_needs_reason',
      userMessage: 'ביטול מסמך דורש נימוק.',
      message: 'cancelInvoice called without a reason',
    })
  }

  return {
    ...invoice,
    status: 'cancelled' as InvoiceStatus,
    cancelledAt: now,
    cancellationReason: reason,
  }
}

// ── Credit notes ──────────────────────────────────────────────────────────

/** What has already been credited against an invoice. Cancelled notes freed. */
export function creditedAgainst(
  invoice: Invoice,
  notes: readonly CreditNote[],
): Agorot {
  return sumAgorot(
    notes
      .filter(
        (note) => note.invoiceId === invoice.id && note.status !== 'cancelled',
      )
      .map((note) => note.amountAgorot),
  )
}

/** What is still creditable. The ceiling on the next credit note. */
export function remainingCreditable(
  invoice: Invoice,
  notes: readonly CreditNote[],
): Agorot {
  return Math.max(0, invoice.totalAgorot - creditedAgainst(invoice, notes))
}

export interface IssueCreditNoteInput {
  id: string
  invoice: Invoice
  /** Every note already raised against this invoice. */
  existingNotes: readonly CreditNote[]
  /** The itemisation, when there is one. The amount is its sum. */
  lines?: readonly PriceLine[]
  /** Used when there are no lines — a lump credit. */
  amountAgorot?: Agorot
  taxAgorot?: Agorot
  reason: string
  number: number
  series?: string
  issuedAt: Date
}

/**
 * Credit part or all of an issued invoice.
 *
 * The ceiling is the invoice total less what has already been credited, and it
 * is enforced here as well as by a database trigger. Two enforcements of one
 * rule is not duplication: this one gives the user a Hebrew sentence naming
 * both figures, and the trigger is what protects the table from a code path
 * nobody anticipated.
 */
export function issueCreditNote(input: IssueCreditNoteInput): CreditNote {
  const { invoice } = input

  if (invoice.status !== 'issued') {
    throw new BusinessRuleError({
      code: 'finance.credit_note_needs_issued_invoice',
      userMessage: 'ניתן להפיק חשבונית זיכוי רק כנגד חשבונית שהופקה.',
      message: `Invoice ${invoice.id} is ${invoice.status}`,
    })
  }
  if (input.reason.trim().length === 0) {
    throw new BusinessRuleError({
      code: 'finance.credit_note_needs_reason',
      userMessage: 'חשבונית זיכוי דורשת נימוק.',
      message: 'issueCreditNote called without a reason',
    })
  }

  const lines = input.lines ?? []
  const amountAgorot =
    lines.length > 0 ? Math.abs(sumLines(lines)) : (input.amountAgorot ?? 0)

  if (!Number.isInteger(amountAgorot) || amountAgorot <= 0) {
    throw new BusinessRuleError({
      code: 'finance.invalid_credit_amount',
      userMessage: 'סכום הזיכוי חייב להיות מספר שלם של אגורות, וגדול מאפס.',
      message: `Invalid credit note amount: ${amountAgorot}`,
    })
  }

  const remaining = remainingCreditable(invoice, input.existingNotes)
  if (amountAgorot > remaining) {
    throw new BusinessRuleError({
      code: 'finance.credit_exceeds_invoice',
      userMessage:
        `לא ניתן לזכות ${formatAgorot(amountAgorot)} — ` +
        `הסכום שנותר לזיכוי בחשבונית הוא ${formatAgorot(remaining)}.`,
      message:
        `Credit note of ${amountAgorot} exceeds remaining ${remaining} on ` +
        `invoice ${invoice.id}`,
      publicDetails: { requested: amountAgorot, remaining },
    })
  }

  const year = invoice.year

  return {
    id: input.id,
    organizationId: invoice.organizationId,
    propertyId: invoice.propertyId,
    invoiceId: invoice.id,
    bookingId: invoice.bookingId,
    status: 'issued',
    series: input.series ?? 'credit',
    year,
    number: input.number,
    displayNumber: formatDocumentNumber(year, input.number),
    lines,
    amountAgorot,
    taxAgorot:
      input.taxAgorot ??
      Math.abs(sumLines(lines.filter((line) => line.kind === 'tax'))),
    currency: CURRENCY,
    reason: input.reason,
    issuedAt: input.issuedAt,
  }
}

// ── Export ────────────────────────────────────────────────────────────────

/**
 * One flat row per document, for the accountant's file.
 *
 * Deliberately not the domain object: an export is a contract with somebody
 * else's software, and handing them our nested shapes means every internal
 * rename becomes their problem. Amounts stay in agorot as integers — the
 * conversion to shekels happens in whatever writes the file, once, the same
 * way it happens for a screen.
 */
export interface InvoiceExportRow {
  documentType: 'invoice' | 'credit_note'
  kind: string
  displayNumber: string
  issuedAt: string
  customerName: string
  customerTaxId: string
  bookingId: string
  subtotalAgorot: Agorot
  taxAgorot: Agorot
  totalAgorot: Agorot
  currency: string
  status: InvoiceStatus
}

export function exportDocuments(
  invoices: readonly Invoice[],
  creditNotes: readonly CreditNote[] = [],
): readonly InvoiceExportRow[] {
  const invoiceRows: InvoiceExportRow[] = invoices.map((invoice) => ({
    documentType: 'invoice',
    kind: invoice.kind,
    displayNumber: invoice.displayNumber ?? '',
    issuedAt: invoice.issuedAt?.toISOString() ?? '',
    customerName: invoice.customerName,
    customerTaxId: invoice.customerTaxId ?? '',
    bookingId: invoice.bookingId,
    subtotalAgorot: invoice.subtotalAgorot,
    taxAgorot: invoice.taxAgorot,
    totalAgorot: invoice.totalAgorot,
    currency: invoice.currency,
    status: invoice.status,
  }))

  const noteRows: InvoiceExportRow[] = creditNotes.map((note) => ({
    documentType: 'credit_note',
    kind: 'credit_note',
    displayNumber: note.displayNumber ?? '',
    issuedAt: note.issuedAt?.toISOString() ?? '',
    customerName: '',
    customerTaxId: '',
    bookingId: note.bookingId,
    // A credit note reduces revenue, so it exports negative. The sign lives
    // here, in the export, and never on the document itself.
    subtotalAgorot: -(note.amountAgorot - note.taxAgorot),
    taxAgorot: -note.taxAgorot,
    totalAgorot: -note.amountAgorot,
    currency: note.currency,
    status: note.status,
  }))

  return [...invoiceRows, ...noteRows].sort((a, b) =>
    a.issuedAt === b.issuedAt
      ? a.displayNumber.localeCompare(b.displayNumber)
      : a.issuedAt.localeCompare(b.issuedAt),
  )
}
