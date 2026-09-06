/**
 * The fiscal reference module, in one import.
 *
 * ── What this module is not ───────────────────────────────────────────────
 *
 * It is not a replacement for `src/lib/finance`. That module composes and
 * issues ESTIA's own invoices out of a `FinanceSnapshot`, numbers them from
 * `invoice_sequences`, and it stays exactly as it is. This module sits beside
 * it and records what an external invoicing vendor said about a document
 * ESTIA asked it to issue. `finance` owns money and lines; `fiscal` owns a
 * reference to somebody else's legal document, and there is no line item
 * anywhere in it.
 *
 * ── What is deliberately not re-exported ──────────────────────────────────
 *
 * `INVOICE_KINDS`, `Agorot`, `Currency`, `PaymentStatus` and every other
 * frozen vocabulary this module consumes. They belong to `finance`,
 * `booking/types` and `contracts/states`, and a second import path for a
 * frozen contract is how two modules come to believe they are reading
 * different vocabularies — the argument `finance/index.ts` makes about
 * `PAYMENT_STATUSES`, applied to itself.
 *
 * Nothing here reaches a database. The read side lives in
 * `src/app/(app)/settings/fiscal/_lib/queries.ts`, so this barrel stays safe
 * for a Client Component to import.
 */

export {
  FISCAL_DOCUMENT_STATUSES,
  FISCAL_DOCUMENT_TYPES,
  FISCAL_SOURCE_KINDS,
  ISSUED_FISCAL_STATUSES,
  TERMINAL_FISCAL_STATUSES,
  fiscalTypeForInvoiceKind,
  type FiscalDocument,
  type FiscalDocumentStatus,
  type FiscalDocumentType,
  type FiscalFailureFacts,
  type FiscalSource,
  type FiscalSourceKind,
  type IssuedDocumentFacts,
  type ProviderDocumentSummary,
} from './types'

export {
  FISCAL_CAPABILITIES,
  FISCAL_REFUSAL_CODES,
  FISCAL_WEBHOOK_EVENT_TYPES,
  RETRYABLE_REFUSAL_CODES,
  guardCapability,
  guarded,
  isRetryableRefusal,
  type CancelOrCreditRequest,
  type CreditDocumentRequest,
  type CustomerLookupRequest,
  type DocumentLookupRequest,
  type FiscalCancelResult,
  type FiscalCapability,
  type FiscalCustomer,
  type FiscalCustomerLookupResult,
  type FiscalDocumentLookupResult,
  type FiscalFailure,
  type FiscalIssueResult,
  type FiscalProvider,
  type FiscalReconcileResult,
  type FiscalRefusal,
  type FiscalRefusalCode,
  type FiscalUnknown,
  type FiscalWebhookDelivery,
  type FiscalWebhookEvent,
  type FiscalWebhookEventType,
  type FiscalWebhookResult,
  type IssueDocumentRequest,
  type ProviderCustomer,
  type ReconcileWindow,
} from './provider'

export {
  NOT_CONFIGURED_REASON,
  NULL_FISCAL_PROVIDER,
  fixedFiscalProvider,
  nullFiscalProvider,
} from './null-provider'

export {
  describeSettlement,
  fiscalLabel,
  fiscalSideOf,
  isFiscallyComplete,
  isPaidAndFiscallyPending,
  moneyLabel,
  moneySideOf,
  type FiscalSide,
  type MoneySide,
  type PaymentFiscalFacts,
  type SettlementView,
} from './failure'

export {
  FISCAL_DIFFERENCE_KINDS,
  describeFiscalReconciliation,
  reconcileFiscalDocuments,
  type FiscalDifference,
  type FiscalDifferenceKind,
  type FiscalReconciliationInput,
  type FiscalReconciliationReport,
} from './reconciliation'

export {
  FISCAL_DIFFERENCE_LABEL,
  FISCAL_DOCUMENT_TYPE_LABEL,
  FISCAL_REFUSAL_LABEL,
  FISCAL_STATUS_LABEL,
} from './labels'
