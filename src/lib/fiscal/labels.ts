/**
 * Hebrew for the fiscal vocabularies.
 *
 * Kept beside the vocabularies rather than in a screen's `_lib/labels.ts`,
 * because the same words appear on the settings screen, in the payment list
 * and in a notification — and three copies of "מסמך חשבונאי ממתין" become
 * three slightly different sentences the first time somebody edits one.
 *
 * `Record<Type, string>` and not a lookup with a fallback: adding a member to
 * a vocabulary without a Hebrew word for it should fail the type check, not
 * render an English identifier to a guesthouse owner.
 *
 * No `"use client"` and no imports beyond the types: this is a table of
 * strings, and it must stay importable from a Client Component.
 */

import type { FiscalDifferenceKind } from './reconciliation'
import type { FiscalRefusalCode } from './provider'
import type { FiscalDocumentStatus, FiscalDocumentType } from './types'

export const FISCAL_DOCUMENT_TYPE_LABEL: Record<FiscalDocumentType, string> = {
  proforma: 'חשבון עסקה',
  tax_invoice: 'חשבונית מס',
  receipt: 'קבלה',
  tax_invoice_receipt: 'חשבונית מס קבלה',
  credit_invoice: 'חשבונית זיכוי',
}

/**
 * The status, said as what it means for the reader rather than as a state name.
 *
 * "לא ידוע" carries its consequence — check with the provider — because that
 * is the one status where the wrong next action (retry) creates a duplicate
 * legal document.
 */
export const FISCAL_STATUS_LABEL: Record<FiscalDocumentStatus, string> = {
  pending: 'ממתין להפקה',
  issued: 'הופק',
  failed: 'ההפקה נכשלה',
  refused: 'הספק סירב',
  unknown: 'לא ידוע — יש לבדוק מול הספק',
  cancelled: 'בוטל',
  credited: 'זוכה',
}

export const FISCAL_REFUSAL_LABEL: Record<FiscalRefusalCode, string> = {
  not_configured: 'לא מחובר ספק הפקת מסמכים',
  capability_unsupported: 'הספק אינו תומך בפעולה',
  missing_customer: 'חסר שם לקוח',
  zero_amount: 'סכום אפס',
  already_issued: 'כבר קיים מסמך שהופק',
  not_cancellable: 'לא ניתן לבטל את המסמך',
  rate_limited: 'הספק הגביל את קצב הפניות',
}

export const FISCAL_DIFFERENCE_LABEL: Record<FiscalDifferenceKind, string> = {
  unknown_locally: 'לא ידוע אצלנו',
  missing_at_provider: 'חסר אצל הספק',
  missing_locally: 'חסר אצלנו',
  amount_mismatch: 'פער בסכום',
  status_mismatch: 'פער בסטטוס',
  unmatchable: 'לא ניתן להתאמה',
}
