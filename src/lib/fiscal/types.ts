/**
 * The fiscal document — ESTIA's *reference* to a document somebody else issued.
 *
 * ── What this module is, stated before anything else ──────────────────────
 *
 * `src/lib/finance/invoices.ts` composes and issues ESTIA's own invoice: it
 * takes a `FinanceSnapshot`, partitions the lines, and produces an `Invoice`
 * with a gapless number from `invoice_sequences`. That module works, it is
 * integrated, and **nothing here replaces any of it**.
 *
 * This module sits beside it and answers a different question: *what did the
 * external accounting system say?* An Israeli guesthouse issues its legal
 * documents through a licensed invoicing vendor, and that vendor — not ESTIA —
 * owns the document's number, its legal series, its signature and its PDF.
 * ESTIA's job is to ask for one, record what came back, and be able to say
 * exactly what state that request is in.
 *
 * So a `FiscalDocument` is a **reference**, not a ledger. It carries no lines.
 * It never computes a total. `amountAgorot` is copied from the ESTIA invoice
 * or payment that caused it and is never re-derived here, because the moment
 * two places compute the same total they eventually disagree, and the version
 * an accountant sees would be the wrong one. ESTIA is not becoming accounting
 * software.
 *
 * ── Payment truth and fiscal truth are two columns, never one ─────────────
 *
 * A payment can be `paid` while its fiscal document is `failed`. That is not a
 * corner case; it is the ordinary consequence of one HTTP call succeeding and
 * a second one not. There is deliberately no field anywhere in this file that
 * summarises both, and `failure.ts` is the only place the two are read
 * together — as two separate sides of one sentence, never merged into a
 * status. See §148 there.
 *
 * ── Money ─────────────────────────────────────────────────────────────────
 *
 * Integer agorot, the same `Agorot` the booking and finance domains use. Never
 * a float, never shekels, never a string.
 */

import type { Agorot } from '../booking/types'
import { INVOICE_KINDS, type InvoiceKind } from '../finance/types'
import type { Currency } from '../finance/money'

// ── Document type ─────────────────────────────────────────────────────────

/**
 * What kind of document the provider was asked for.
 *
 * Built by **extending** `INVOICE_KINDS` rather than restating it. The four
 * kinds ESTIA already knows — proforma, tax invoice, receipt, and the combined
 * form most small Israeli businesses actually issue — are the same four kinds
 * a vendor issues, and a second hand-written copy of that tuple is a second
 * vocabulary that drifts the first time somebody adds a member to one of them.
 *
 * `credit_invoice` is the one member that is genuinely new here: `finance`
 * models a correction as a `CreditNote` record with its own series, and from
 * the vendor's side it is simply another document type it can be asked to
 * produce. Extending is what keeps both statements true at once.
 */
export const FISCAL_DOCUMENT_TYPES = [
  ...INVOICE_KINDS,
  'credit_invoice',
] as const

export type FiscalDocumentType = (typeof FISCAL_DOCUMENT_TYPES)[number]

/** The identity mapping, written down so a caller never guesses at it. */
export function fiscalTypeForInvoiceKind(
  kind: InvoiceKind,
): FiscalDocumentType {
  return kind
}

// ── Status ────────────────────────────────────────────────────────────────

/**
 * Where the *request for a document* stands. Seven values, and the two that
 * look redundant are the two that matter most.
 *
 * `failed` and `refused` are not synonyms. A `failed` attempt might succeed if
 * it runs again — the vendor was down, the request timed out on their side
 * after they answered "no". A `refused` attempt will fail identically forever
 * until a person changes something: no provider is configured, the provider
 * cannot issue this kind of document at all, the customer has no name. A queue
 * that retries both burns quota forever on the second kind; a queue that
 * retries neither leaves recoverable documents unissued.
 *
 * `unknown` is the same third outcome `finance/provider.ts` argues for at
 * length, for the same reason and with more force: the call died after the
 * request left, so the vendor may have issued a numbered legal document that
 * ESTIA has no record of. Retrying an `unknown` is how a business ends up with
 * two tax invoices for one stay, which is a worse problem than having none.
 * Only a person, or a `lookupDocument` against the provider, closes one.
 *
 * `credited` is not `cancelled`. An issued tax invoice corrected by a credit
 * document is still an issued tax invoice as far as the tax authority is
 * concerned — the same argument `finance/types.ts` makes about `archivedAt`.
 */
export const FISCAL_DOCUMENT_STATUSES = [
  'pending',
  'issued',
  'failed',
  'refused',
  'unknown',
  'cancelled',
  'credited',
] as const

export type FiscalDocumentStatus = (typeof FISCAL_DOCUMENT_STATUSES)[number]

/**
 * Statuses no automation moves out of on its own.
 *
 * `refused` and `unknown` are here beside the three settled ones, and that is
 * the point: both need a person, and a retry loop that treated them as
 * transient would either loop forever or duplicate a legal document.
 */
export const TERMINAL_FISCAL_STATUSES: readonly FiscalDocumentStatus[] = [
  'issued',
  'cancelled',
  'credited',
  'refused',
  'unknown',
]

/** Statuses where the provider has confirmed a document exists. */
export const ISSUED_FISCAL_STATUSES: readonly FiscalDocumentStatus[] = [
  'issued',
  'cancelled',
  'credited',
]

// ── What caused this document ─────────────────────────────────────────────

/**
 * The ESTIA record this document accounts for.
 *
 * A discriminated pair rather than four nullable id columns, because "which
 * one of these is set" is exactly the question a nullable-column model makes
 * unanswerable, and a document that points at both a payment and a refund is
 * not a thing.
 */
export const FISCAL_SOURCE_KINDS = [
  'invoice',
  'payment',
  'refund',
  'credit_note',
] as const

export type FiscalSourceKind = (typeof FISCAL_SOURCE_KINDS)[number]

export interface FiscalSource {
  kind: FiscalSourceKind
  /** The ESTIA row's id. Never the provider's. */
  id: string
}

// ── The record ────────────────────────────────────────────────────────────

/**
 * What the provider told us about a document it holds.
 *
 * Every field on it is either something ESTIA asked for or something the
 * provider answered. There is nothing derived, and in particular there is no
 * document number ESTIA made up: `providerDocumentNumber` is `null` until a
 * vendor supplies one, and `failure.ts` refuses to describe a document as
 * issued without it. Inventing a number would put a string on a screen, and
 * then on a guest's email, that no tax authority has ever heard of.
 */
export interface IssuedDocumentFacts {
  /** The provider's own primary key. Stable, opaque, never parsed. */
  providerDocumentId: string
  /**
   * What is printed on the document. The provider's format, verbatim — never
   * reformatted by `formatDocumentNumber`, which is ESTIA's own numbering.
   */
  providerDocumentNumber: string
  type: FiscalDocumentType
  /** `YYYY-MM-DD`, as the provider dated it. Their date, not our clock. */
  issueDate: string
  amountAgorot: Agorot
  taxAgorot: Agorot
  /**
   * Where a person can read the document itself.
   *
   * Almost always short-lived and signed, which is why the expiry is beside
   * it: a screen that renders an expired link has shown a broken button, and a
   * screen that knows the link expired can ask for a fresh one.
   */
  documentUrl: string | null
  documentUrlExpiresAt: Date | null
}

/** Why an attempt did not produce a document. Recorded, never discarded. */
export interface FiscalFailureFacts {
  /** Machine-readable, ours: `not_configured`, `capability_unsupported`, … */
  code: string
  /** Hebrew, shown to the person working the queue. Never a stack trace. */
  reason: string
  /** The provider's own status string, kept verbatim for support. */
  providerStatus: string | null
}

export interface FiscalDocument {
  id: string
  organizationId: string
  propertyId: string | null
  bookingId: string | null
  /**
   * The ESTIA invoice this references, when the document was requested for
   * one. Nullable because a receipt for a standalone payment has no ESTIA
   * invoice behind it — and inventing one to satisfy a foreign key would put a
   * document in the finance list that no accountant asked for.
   */
  invoiceId: string | null

  /** A stable provider name. `none` is the null implementation. */
  provider: string
  providerDocumentId: string | null
  providerDocumentNumber: string | null

  type: FiscalDocumentType
  status: FiscalDocumentStatus

  /** Snapshotted at request time, like the invoice's. Not a live join. */
  customerName: string
  customerTaxId: string | null

  /**
   * Copied from the ESTIA record named by `source`. Never recomputed here.
   *
   * The tax figure is carried separately rather than derived from a rate,
   * because a rate times a total re-rounds, and a re-rounded tax figure that
   * differs by one agora from the vendor's is a difference somebody has to
   * explain to an auditor.
   */
  amountAgorot: Agorot
  taxAgorot: Agorot
  /** Basis points, so 18% is 1800 and a rate is never a float. */
  taxRateBps: number | null
  currency: Currency

  /** The provider's date, `YYYY-MM-DD`. `null` until they issue. */
  issueDate: string | null

  source: FiscalSource

  documentUrl: string | null
  documentUrlExpiresAt: Date | null

  /** Present exactly when the status is `failed`, `refused` or `unknown`. */
  failure: FiscalFailureFacts | null

  /** How many times ESTIA has asked. Bounds the retry queue. */
  attemptCount: number
  lastAttemptAt: Date | null
  /** `null` when nothing is scheduled — including every `refused` document. */
  nextRetryAt: Date | null

  /** Set when a person has looked at a failed or unknown document. */
  reviewedAt: Date | null
  reviewedByUserId: string | null

  /** The document this one cancels or credits, when it is a correction. */
  correctsDocumentId: string | null

  createdAt: Date
  updatedAt: Date
  version: number
}

/**
 * A document the provider says it holds, as returned by `reconcile`.
 *
 * Deliberately thinner than `FiscalDocument`: it is the other party's claim,
 * and typing it as our own record would invite somebody to store it as one.
 */
export interface ProviderDocumentSummary {
  providerDocumentId: string
  providerDocumentNumber: string
  type: FiscalDocumentType
  status: 'issued' | 'cancelled'
  issueDate: string
  amountAgorot: Agorot
  taxAgorot: Agorot
  /** Whatever ESTIA sent as its own reference, echoed back. Often null. */
  externalReference: string | null
}
