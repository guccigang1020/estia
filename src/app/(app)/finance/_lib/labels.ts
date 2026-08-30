/**
 * Hebrew wording for the finance enums, and the tone that accompanies it.
 *
 * WHAT IS NOT HERE. `PAYMENT_STATUS_LABEL`, `COMMISSION_STATUS_LABEL` and
 * `COMMISSION_BASE_LABEL` already exist in the domain — in
 * `finance/payment-state-machine.ts`, `finance/commissions.ts` and
 * `contracts/states.ts` respectively — and are imported from there by every
 * screen in this module. Restating a status label here would be a second
 * Hebrew name for the same state, and the two would disagree the first time
 * somebody edited one of them.
 *
 * WHAT IS HERE is the wording the domain has never needed: a payment's method,
 * its purpose, the channel it arrived through, the kind of document an invoice
 * is. The domain reasons about those and has never had to print them.
 *
 * THE TEST BESIDE THIS FILE IS THE POINT, exactly as it is for
 * `properties/_lib/labels.ts`: every record below is total over its tuple, so
 * adding a member to `PAYMENT_METHODS` without wording it here fails the suite
 * rather than shipping `paybox` into a Hebrew screen.
 *
 * ── The one judgement this file makes ─────────────────────────────────────
 *
 * `unknown` is not `failed`. A processor that timed out has left the business
 * in a state where the card may or may not have been charged, and folding that
 * into "נכשל" tells a bookkeeper the money is definitely not there — which is
 * the one thing nobody knows. So it is the single status that leaves the
 * neutral palette for `accent`, it keeps the domain's own label ("לא ידוע —
 * דורש בירור"), and the screens above additionally count such rows out loud.
 * Colour is never the only signal: the word is always rendered.
 */

import type { BadgeTone } from '@/components/ui/badge'
import type {
  CommissionStatus,
  PaymentMethod,
  PaymentStatus,
} from '@/lib/contracts/states'
import type {
  CollectionChannel,
  InvoiceKind,
  InvoiceStatus,
  PaymentAttention,
  PaymentPurpose,
} from '@/lib/finance'

/**
 * What a screen prints where a value exists and this reader may not see it.
 *
 * The same sentence `BookingTable` uses, and for the same reason: a blank cell
 * reads as "there is nothing here", which is a different and false statement.
 */
export const WITHHELD = 'לא זמין לצפייה'

/* -------------------------------------------------------------- payment -- */

/** `public.payment_method`, 0010. */
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  card: 'כרטיס אשראי',
  bit: 'ביט',
  bank_transfer: 'העברה בנקאית',
  cash: 'מזומן',
  paybox: 'פייבוקס',
  other: 'אחר',
}

/** `PAYMENT_PURPOSES` — why the money was collected, not how. */
export const PAYMENT_PURPOSE_LABEL: Record<PaymentPurpose, string> = {
  deposit: 'מקדמה',
  balance: 'יתרה',
  full: 'תשלום מלא',
  instalment: 'תשלום מתוך פריסה',
  partial: 'תשלום חלקי',
  security_deposit: 'פיקדון ביטחון',
  fee: 'עמלה או תוספת',
}

/** `COLLECTION_CHANNELS` — how the request reached the payer. */
export const COLLECTION_CHANNEL_LABEL: Record<CollectionChannel, string> = {
  payment_link: 'קישור לתשלום',
  hosted_page: 'עמוד תשלום של הסולק',
  terminal: 'מסופון',
  manual: 'נרשם ידנית',
}

/**
 * `PAYMENT_ATTENTIONS` — the three states automation must not resolve alone.
 *
 * Worded as an instruction rather than as a category, because the row is on
 * screen precisely so that a person does something about it.
 */
export const PAYMENT_ATTENTION_LABEL: Record<PaymentAttention, string> = {
  reconcile_unknown: 'הסולק לא השיב — יש לבדוק מול הסולק אם החיוב בוצע',
  refund_after_cancellation: 'הכסף התקבל להזמנה שבוטלה — יש להחזיר',
  overpaid: 'שולם יותר מהסכום שנדרש',
}

/**
 * `unknown` is the only status that leaves the neutral palette.
 *
 * `paid` is deliberately `brand` and everything else neutral: a list in which
 * five states each have their own colour is a list nobody scans, and the label
 * carries the meaning in every case.
 */
export function paymentStatusTone(status: PaymentStatus): BadgeTone {
  if (status === 'unknown') return 'accent'
  if (status === 'paid') return 'brand'
  return 'neutral'
}

/** Struck through, as `BookingStatusBadge` strikes a cancelled booking. */
export function paymentStatusVoided(status: PaymentStatus): boolean {
  return status === 'cancelled' || status === 'failed'
}

/* -------------------------------------------------------------- invoice -- */

/** `INVOICE_KINDS` — different documents to the tax authority, not a flag. */
export const INVOICE_KIND_LABEL: Record<InvoiceKind, string> = {
  proforma: 'חשבון עסקה',
  tax_invoice: 'חשבונית מס',
  receipt: 'קבלה',
  tax_invoice_receipt: 'חשבונית מס/קבלה',
}

/** `INVOICE_STATUSES`. `archivedAt` is deliberately not one of them. */
export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'טיוטה',
  issued: 'הופקה',
  cancelled: 'בוטלה',
}

export function invoiceStatusTone(status: InvoiceStatus): BadgeTone {
  return status === 'issued' ? 'brand' : 'neutral'
}

/* ----------------------------------------------------------- commission -- */

/**
 * `eligible` and `approved` are money the business has committed to and has
 * not yet paid, which is the state somebody scanning this list is looking for.
 * `paid` is settled and `cancelled` is struck through.
 */
export function commissionStatusTone(status: CommissionStatus): BadgeTone {
  if (status === 'eligible' || status === 'approved') return 'accent'
  if (status === 'paid') return 'brand'
  return 'neutral'
}

export function commissionStatusVoided(status: CommissionStatus): boolean {
  return status === 'cancelled'
}

/* ------------------------------------------------------------ fallbacks -- */

/**
 * A label for a value the database returned that this file does not know.
 *
 * The same escape hatch `properties/_lib/labels.ts` carries. Every read in
 * this module goes through `asEnum`, so an unknown value throws long before it
 * reaches here — this exists for the display of a value that was never an
 * enum, and prints the raw string rather than inventing a Hebrew name for it.
 */
export function labelOr<T extends string>(
  labels: Record<T, string>,
  value: string,
): string {
  return value in labels ? labels[value as T] : value
}
