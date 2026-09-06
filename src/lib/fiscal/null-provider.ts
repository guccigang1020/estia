/**
 * The fiscal provider this codebase ships: one that refuses, honestly.
 *
 * There are no invoicing-vendor credentials in this repository and there will
 * be none in this task. The wrong response to that is a stub that fabricates a
 * document number so the screens look finished — a made-up number reaches a
 * guest's email and an accountant's spreadsheet, and it belongs to no series
 * any tax authority has heard of. There is no HTTP call to any vendor in this
 * file, no base URL, and no number generator.
 *
 * The right response is the one `website/ai.ts` already established for the
 * absent content generator, and `site_generation_requests` for its storage: it
 * **refuses as a value**, names itself `none` so a row written today is
 * distinguishable from one written after somebody wires a real vendor, and
 * records why.
 *
 * ── Why it still validates the request ────────────────────────────────────
 *
 * Because the refusal it gives should be the refusal a real vendor would give
 * for the same input. A request with no customer name is not "no provider is
 * configured" — it is "this document cannot be made out to nobody", and a
 * business hitting that today should hear the same sentence they will hear
 * with a vendor connected. Otherwise connecting one silently changes the
 * meaning of every message this product has ever shown.
 *
 * That ordering — input first, configuration second — is deliberate and is the
 * opposite of what `guarded()` would do. `guarded()` refuses on the capability
 * before looking at anything, which is right for a *connected* provider whose
 * endpoint genuinely does not exist. This provider is not connected at all, so
 * it can afford to answer the more useful question first. It is therefore
 * exported unguarded; `nullFiscalProvider.capabilities` is empty and every
 * method already refuses.
 */

import type {
  CancelOrCreditRequest,
  CreditDocumentRequest,
  DocumentLookupRequest,
  FiscalCancelResult,
  FiscalCapability,
  FiscalCustomerLookupResult,
  FiscalDocumentLookupResult,
  FiscalIssueResult,
  FiscalProvider,
  FiscalRefusal,
  FiscalReconcileResult,
  FiscalWebhookDelivery,
  FiscalWebhookResult,
  IssueDocumentRequest,
} from './provider'

/** The name recorded on every row this provider produces. */
export const NULL_FISCAL_PROVIDER = 'none'

/**
 * The sentence a business reads when nothing is connected.
 *
 * Written once because it appears on the settings screen, on every failed
 * document row and in the §148 payment/fiscal pair, and three copies would
 * drift into three different promises. It says what did not happen, what did,
 * and what the person can do — and it does not apologise for a state that is
 * a perfectly ordinary configuration.
 */
export const NOT_CONFIGURED_REASON =
  'לא מחובר ספק הפקת מסמכים לחשבון הזה, ולכן לא הופק מסמך חשבונאי. ' +
  'התשלום עצמו נרשם במלואו. אפשר להפיק את המסמך במערכת ההנהלה חשבונות ' +
  'ולרשום כאן את מספרו.'

function refusal(code: FiscalRefusal['code'], reason: string): FiscalRefusal {
  return { outcome: 'refused', code, reason, provider: NULL_FISCAL_PROVIDER }
}

/**
 * The refusals a real vendor would also give, checked before configuration.
 *
 * Returns `null` when the request itself is sound — at which point the only
 * thing left to say is that no vendor is connected.
 */
function refuseRequest(request: IssueDocumentRequest): FiscalRefusal | null {
  if (request.customer.name.trim().length === 0) {
    return refusal(
      'missing_customer',
      'לא ניתן להפיק מסמך חשבונאי ללא שם לקוח.',
    )
  }
  if (!Number.isInteger(request.amountAgorot) || request.amountAgorot <= 0) {
    return refusal(
      'zero_amount',
      'לא ניתן להפיק מסמך חשבונאי על סכום אפס. בדקו את התמחור.',
    )
  }
  return null
}

const NO_CAPABILITIES: ReadonlySet<FiscalCapability> = new Set()

/**
 * Declares no capabilities, refuses everything, and says which of the two
 * reasons applies.
 */
export const nullFiscalProvider: FiscalProvider = {
  name: NULL_FISCAL_PROVIDER,
  capabilities: NO_CAPABILITIES,

  async createInvoice(
    request: IssueDocumentRequest,
  ): Promise<FiscalIssueResult> {
    return (
      refuseRequest(request) ?? refusal('not_configured', NOT_CONFIGURED_REASON)
    )
  },

  async createReceipt(
    request: IssueDocumentRequest,
  ): Promise<FiscalIssueResult> {
    return (
      refuseRequest(request) ?? refusal('not_configured', NOT_CONFIGURED_REASON)
    )
  },

  async createInvoiceReceipt(
    request: IssueDocumentRequest,
  ): Promise<FiscalIssueResult> {
    return (
      refuseRequest(request) ?? refusal('not_configured', NOT_CONFIGURED_REASON)
    )
  },

  async createCreditDocument(
    request: CreditDocumentRequest,
  ): Promise<FiscalIssueResult> {
    if (request.reason.trim().length === 0) {
      return refusal(
        'missing_customer',
        'לא ניתן להפיק מסמך זיכוי ללא סיבה מפורטת.',
      )
    }
    return (
      refuseRequest(request) ?? refusal('not_configured', NOT_CONFIGURED_REASON)
    )
  },

  // No parameter: this implementation cannot use one, and naming an argument it
  // ignores would imply it looked.
  async lookupCustomer(): Promise<FiscalCustomerLookupResult> {
    return refusal('not_configured', NOT_CONFIGURED_REASON)
  },

  async lookupDocument(
    request: DocumentLookupRequest,
  ): Promise<FiscalDocumentLookupResult> {
    // The refusal a real vendor gives for an unanswerable question, kept ahead
    // of the configuration refusal for the reason in the header.
    if (
      request.providerDocumentId === null &&
      request.externalReference === null
    ) {
      return refusal(
        'capability_unsupported',
        'לא נמסר מזהה מסמך ולא אסמכתה, ולכן אין מה לחפש.',
      )
    }
    return refusal('not_configured', NOT_CONFIGURED_REASON)
  },

  async cancelOrCredit(
    request: CancelOrCreditRequest,
  ): Promise<FiscalCancelResult> {
    if (request.reason.trim().length === 0) {
      return refusal('not_cancellable', 'לא ניתן לבטל מסמך ללא סיבה מפורטת.')
    }
    return refusal('not_configured', NOT_CONFIGURED_REASON)
  },

  /**
   * Rejects rather than refuses when a delivery arrives unsigned.
   *
   * A webhook reaching a deployment with no provider connected is not a
   * configuration message — it is an unauthenticated POST from the internet,
   * and answering "we are not configured" would confirm the endpoint exists to
   * whoever sent it. Unsigned is rejected first, always.
   */
  async handleWebhook(
    delivery: FiscalWebhookDelivery,
  ): Promise<FiscalWebhookResult> {
    if (delivery.signature === null || delivery.signature.trim() === '') {
      return {
        outcome: 'rejected',
        provider: NULL_FISCAL_PROVIDER,
        reason: 'הפנייה הגיעה ללא חתימה ולכן נדחתה.',
      }
    }
    return {
      outcome: 'rejected',
      provider: NULL_FISCAL_PROVIDER,
      reason:
        'לא מחובר ספק הפקת מסמכים, ולכן אין מפתח לאמת מולו את החתימה. ' +
        'הפנייה נדחתה ולא נקראה.',
    }
  },

  async reconcile(): Promise<FiscalReconcileResult> {
    return refusal('not_configured', NOT_CONFIGURED_REASON)
  },
}

/**
 * A provider for tests: answers exactly what it was constructed with.
 *
 * Exported from the module rather than hidden in one test file, for the reason
 * `website/ai.ts` gives about its own double: more than one suite needs it, and
 * a double that lives in one test file and is imported by another is a double
 * nobody maintains. It declares whatever capabilities it is given, so wrapping
 * it in `guarded()` exercises the capability refusal.
 */
export function fixedFiscalProvider(args: {
  name?: string
  capabilities?: readonly FiscalCapability[]
  issue?: FiscalIssueResult
  lookupDocument?: FiscalDocumentLookupResult
  lookupCustomer?: FiscalCustomerLookupResult
  cancel?: FiscalCancelResult
  webhook?: FiscalWebhookResult
  reconcile?: FiscalReconcileResult
}): FiscalProvider {
  const name = args.name ?? 'fixture'
  const capabilities: ReadonlySet<FiscalCapability> = new Set(
    args.capabilities ?? [],
  )
  const fallback = (): FiscalRefusal => ({
    outcome: 'refused',
    code: 'capability_unsupported',
    reason: 'הכפיל לא הוגדר להשיב על הפעולה הזו.',
    provider: name,
  })

  return {
    name,
    capabilities,
    async createInvoice() {
      return args.issue ?? fallback()
    },
    async createReceipt() {
      return args.issue ?? fallback()
    },
    async createInvoiceReceipt() {
      return args.issue ?? fallback()
    },
    async createCreditDocument() {
      return args.issue ?? fallback()
    },
    async lookupCustomer() {
      return args.lookupCustomer ?? fallback()
    },
    async lookupDocument() {
      return args.lookupDocument ?? fallback()
    },
    async cancelOrCredit() {
      return args.cancel ?? fallback()
    },
    async handleWebhook() {
      return args.webhook ?? fallback()
    },
    async reconcile() {
      return args.reconcile ?? fallback()
    },
  }
}
