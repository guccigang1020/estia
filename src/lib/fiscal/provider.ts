/**
 * The fiscal provider port.
 *
 * No invoicing vendor has been chosen and there are no credentials in this
 * repository. That is the reason to write the port now, exactly as
 * `finance/provider.ts` argues for the payment processor: while nobody's API
 * is in the room to be leaked into the domain. What follows is a statement of
 * what ESTIA needs from *any* Israeli invoicing vendor, in ESTIA's vocabulary.
 *
 * ── A provider declares what it can do, and is never asked for more ───────
 *
 * `capabilities` is not documentation. Vendors differ in ways that matter: one
 * issues a combined tax-invoice-receipt and another does not; one can be asked
 * "what documents did you issue last month" and another has no such endpoint
 * at all, which makes reconciliation against it impossible rather than merely
 * unimplemented. Calling a method a provider has not declared is **refused
 * before the call is attempted** — `guardCapability` below is the single place
 * that decides, and `guarded()` wraps a provider so the rule holds by
 * construction rather than by nine implementations each remembering it.
 *
 * ── Every method returns a result; none of them throws for a timeout ──────
 *
 * The same rule, and the same reason, as the payment port — with more at stake.
 * A call that dies after the request left has either caused a numbered legal
 * document to exist or not. An exception says "it did not", the queue retries,
 * and the business now holds two tax invoices for one stay. So `unknown` is a
 * first-class outcome of this port, it maps onto the `unknown` fiscal document
 * status, and nothing in this module collapses it into failure.
 *
 * Implementations still throw for what genuinely is exceptional — a malformed
 * request, a refused credential — as `ExternalServiceError` with an honest
 * `dataOutcome`.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 *
 * Every issuing call takes an `idempotencyKey` and an implementation must
 * forward it to the vendor. ESTIA's own key protects its database; the
 * vendor's key protects the document series. Neither substitutes for the
 * other, and a duplicated legal document cannot be un-issued.
 */

import type { Agorot } from '../booking/types'
import type { Currency } from '../finance/money'
import type {
  FiscalDocumentType,
  IssuedDocumentFacts,
  ProviderDocumentSummary,
} from './types'

// ── Capabilities ──────────────────────────────────────────────────────────

/**
 * One member per method on the port, and no member that is not a method.
 *
 * Keeping them one-to-one is what lets `guarded()` be written once instead of
 * as a table somebody has to keep in step.
 */
export const FISCAL_CAPABILITIES = [
  'create_invoice',
  'create_receipt',
  'create_invoice_receipt',
  'create_credit_document',
  'lookup_customer',
  'lookup_document',
  'cancel_or_credit',
  'handle_webhook',
  'reconcile',
] as const

export type FiscalCapability = (typeof FISCAL_CAPABILITIES)[number]

// ── Refusals ──────────────────────────────────────────────────────────────

/**
 * Why a provider will not do something, in a closed vocabulary.
 *
 * Closed because the retry queue reads it: `not_configured` and
 * `capability_unsupported` must never be retried, `rate_limited` must be
 * retried later, and a free-text reason string would make that decision a
 * substring match.
 */
export const FISCAL_REFUSAL_CODES = [
  /** There is no provider connected to this organization at all. */
  'not_configured',
  /** A provider is connected and this is not one of the things it does. */
  'capability_unsupported',
  /** The vendor requires a customer name and none was supplied. */
  'missing_customer',
  /** A legal document for nothing is not a document. */
  'zero_amount',
  /** ESTIA already holds an issued document for this source. */
  'already_issued',
  /** The document cannot be cancelled — usually because it is too old. */
  'not_cancellable',
  /** The vendor's own limit, and the one refusal worth retrying later. */
  'rate_limited',
] as const

export type FiscalRefusalCode = (typeof FISCAL_REFUSAL_CODES)[number]

/** Refusals a queue may legitimately try again. Everything else needs a person. */
export const RETRYABLE_REFUSAL_CODES: readonly FiscalRefusalCode[] = [
  'rate_limited',
]

export interface FiscalRefusal {
  outcome: 'refused'
  code: FiscalRefusalCode
  /** Hebrew, shown to the person. A refusal is an ordinary outcome. */
  reason: string
  provider: string
}

export interface FiscalFailure {
  outcome: 'failed'
  /** The vendor's code where there is one, otherwise ours. */
  code: string
  /** Hebrew. */
  reason: string
  providerStatus: string | null
  provider: string
}

/**
 * The vendor did not answer. It may or may not have issued a document.
 *
 * `providerReference` is whatever ESTIA sent as its own idempotency handle, so
 * a later `lookupDocument` has something to ask about. It is the only thing
 * that turns an `unknown` into a resolvable one rather than a permanent
 * mystery.
 */
export interface FiscalUnknown {
  outcome: 'unknown'
  reason: string
  providerReference: string | null
  provider: string
}

export type FiscalIssueResult =
  | { outcome: 'issued'; document: IssuedDocumentFacts; provider: string }
  | FiscalRefusal
  | FiscalFailure
  | FiscalUnknown

export type FiscalCustomerLookupResult =
  | { outcome: 'found'; customer: ProviderCustomer; provider: string }
  | { outcome: 'not_found'; provider: string }
  | FiscalRefusal
  | FiscalFailure
  | FiscalUnknown

export type FiscalDocumentLookupResult =
  | {
      outcome: 'found'
      document: ProviderDocumentSummary
      provider: string
    }
  | { outcome: 'not_found'; provider: string }
  | FiscalRefusal
  | FiscalFailure
  | FiscalUnknown

export type FiscalCancelResult =
  | { outcome: 'cancelled'; providerDocumentId: string; provider: string }
  /** The vendor corrected it with a new credit document instead. */
  | { outcome: 'credited'; document: IssuedDocumentFacts; provider: string }
  | FiscalRefusal
  | FiscalFailure
  | FiscalUnknown

export type FiscalWebhookResult =
  | { outcome: 'accepted'; event: FiscalWebhookEvent; provider: string }
  /** Understood, signed, and about nothing ESTIA tracks. Not an error. */
  | { outcome: 'ignored'; reason: string; provider: string }
  /** The signature did not verify. Never treated as data. */
  | { outcome: 'rejected'; reason: string; provider: string }
  | FiscalRefusal

export type FiscalReconcileResult =
  | {
      outcome: 'listed'
      documents: readonly ProviderDocumentSummary[]
      provider: string
    }
  | FiscalRefusal
  | FiscalFailure
  | FiscalUnknown

// ── Requests ──────────────────────────────────────────────────────────────

export interface ProviderCustomer {
  providerCustomerId: string
  name: string
  taxId: string | null
  email: string | null
}

/** Who the document is made out to. Snapshotted by the caller, not looked up. */
export interface FiscalCustomer {
  name: string
  taxId: string | null
  email: string | null
  /** Free-form, one line. Some vendors require it, most do not. */
  address: string | null
}

export interface IssueDocumentRequest {
  organizationId: string
  /** ESTIA's own id for the fiscal document row. Echoed back on every event. */
  documentId: string
  type: FiscalDocumentType
  customer: FiscalCustomer
  /**
   * Copied from the ESTIA invoice or payment. **Not recomputed.**
   *
   * The provider is being told what the document is for, not asked to price
   * anything. A vendor that returns a different total has produced a
   * difference, and `reconciliation.ts` reports it rather than adopting it.
   */
  amountAgorot: Agorot
  taxAgorot: Agorot
  taxRateBps: number | null
  currency: Currency
  /** Hebrew, printed on the document. */
  description: string
  /** ESTIA's reference, printed and echoed: the booking reference. */
  externalReference: string
  /** Forwarded to the vendor. See the header. */
  idempotencyKey: string
}

export interface CreditDocumentRequest extends IssueDocumentRequest {
  /** The provider's id for the document being corrected. */
  correctsProviderDocumentId: string
  /** Required. A credit document with no stated reason is unauditable. */
  reason: string
}

export interface CustomerLookupRequest {
  organizationId: string
  taxId: string | null
  email: string | null
  name: string | null
}

export interface DocumentLookupRequest {
  organizationId: string
  /** One of the two must be present; an implementation refuses otherwise. */
  providerDocumentId: string | null
  externalReference: string | null
}

export interface CancelOrCreditRequest {
  organizationId: string
  providerDocumentId: string
  reason: string
  idempotencyKey: string
}

/** The raw delivery, before anything has been trusted about it. */
export interface FiscalWebhookDelivery {
  /** The vendor's id for the delivery. The duplicate guard keys on this. */
  deliveryId: string
  /** Verbatim body. Never parsed before the signature verifies. */
  body: string
  signature: string | null
  receivedAt: Date
}

export const FISCAL_WEBHOOK_EVENT_TYPES = [
  'document_issued',
  'document_cancelled',
  'document_credited',
  'document_failed',
] as const

export type FiscalWebhookEventType = (typeof FISCAL_WEBHOOK_EVENT_TYPES)[number]

export interface FiscalWebhookEvent {
  eventId: string
  type: FiscalWebhookEventType
  /** ESTIA's document id, when the vendor echoes metadata back. */
  documentId: string | null
  providerDocumentId: string
  /** Present on `document_issued`, absent otherwise. */
  document: IssuedDocumentFacts | null
  occurredAt: Date
}

export interface ReconcileWindow {
  organizationId: string
  /** Inclusive, `YYYY-MM-DD`. Vendors deal in dates, not instants. */
  from: string
  to: string
}

// ── The port ──────────────────────────────────────────────────────────────

export interface FiscalProvider {
  /** A stable name, recorded on every document row. `none` is the null one. */
  readonly name: string
  /**
   * What this provider does. An empty set means nothing is connected, which is
   * a different statement from "connected but limited" — see `guardCapability`.
   */
  readonly capabilities: ReadonlySet<FiscalCapability>

  createInvoice(request: IssueDocumentRequest): Promise<FiscalIssueResult>
  createReceipt(request: IssueDocumentRequest): Promise<FiscalIssueResult>
  createInvoiceReceipt(
    request: IssueDocumentRequest,
  ): Promise<FiscalIssueResult>
  createCreditDocument(
    request: CreditDocumentRequest,
  ): Promise<FiscalIssueResult>

  lookupCustomer(
    request: CustomerLookupRequest,
  ): Promise<FiscalCustomerLookupResult>
  lookupDocument(
    request: DocumentLookupRequest,
  ): Promise<FiscalDocumentLookupResult>

  cancelOrCredit(request: CancelOrCreditRequest): Promise<FiscalCancelResult>

  handleWebhook(delivery: FiscalWebhookDelivery): Promise<FiscalWebhookResult>

  reconcile(window: ReconcileWindow): Promise<FiscalReconcileResult>
}

// ── The capability guard ──────────────────────────────────────────────────

/**
 * The refusal for a capability a provider does not declare, or `null`.
 *
 * The two codes are not interchangeable and the difference is visible to the
 * person reading the screen. An empty capability set means no vendor is
 * connected at all: the answer is "connect one", and every method gives the
 * same answer. A non-empty set missing one member means a vendor *is*
 * connected and cannot do this particular thing: the answer is "this vendor
 * does not issue that document", which is a purchasing decision, not a setup
 * step. Collapsing them would send a business to the wrong screen.
 */
export function guardCapability(
  provider: FiscalProvider,
  capability: FiscalCapability,
): FiscalRefusal | null {
  if (provider.capabilities.has(capability)) return null

  if (provider.capabilities.size === 0) {
    return {
      outcome: 'refused',
      code: 'not_configured',
      provider: provider.name,
      reason:
        'לא מחובר ספק הפקת מסמכים לחשבון הזה, ולכן לא הופק מסמך. ' +
        'התשלום עצמו נרשם כרגיל.',
    }
  }

  return {
    outcome: 'refused',
    code: 'capability_unsupported',
    provider: provider.name,
    reason: `הספק המחובר (${provider.name}) אינו תומך בפעולה הזו, ולכן היא לא בוצעה.`,
  }
}

/**
 * Wrap a provider so an undeclared capability is refused before the call.
 *
 * Written once, here, rather than as nine `if` statements inside every
 * implementation. An implementation that forgot one would issue a request to a
 * vendor endpoint it does not have and turn a clean refusal into a 404 that
 * the queue reads as a retryable failure.
 */
export function guarded(provider: FiscalProvider): FiscalProvider {
  const refuse = (capability: FiscalCapability): FiscalRefusal | null =>
    guardCapability(provider, capability)

  return {
    name: provider.name,
    capabilities: provider.capabilities,

    async createInvoice(request) {
      return refuse('create_invoice') ?? provider.createInvoice(request)
    },
    async createReceipt(request) {
      return refuse('create_receipt') ?? provider.createReceipt(request)
    },
    async createInvoiceReceipt(request) {
      return (
        refuse('create_invoice_receipt') ??
        provider.createInvoiceReceipt(request)
      )
    },
    async createCreditDocument(request) {
      return (
        refuse('create_credit_document') ??
        provider.createCreditDocument(request)
      )
    },
    async lookupCustomer(request) {
      return refuse('lookup_customer') ?? provider.lookupCustomer(request)
    },
    async lookupDocument(request) {
      return refuse('lookup_document') ?? provider.lookupDocument(request)
    },
    async cancelOrCredit(request) {
      return refuse('cancel_or_credit') ?? provider.cancelOrCredit(request)
    },
    async handleWebhook(delivery) {
      return refuse('handle_webhook') ?? provider.handleWebhook(delivery)
    },
    async reconcile(window) {
      return refuse('reconcile') ?? provider.reconcile(window)
    },
  }
}

/** Whether the retry queue may try this refusal again on its own. */
export function isRetryableRefusal(code: FiscalRefusalCode): boolean {
  return RETRYABLE_REFUSAL_CODES.includes(code)
}
