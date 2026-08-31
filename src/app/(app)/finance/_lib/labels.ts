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
  AllocationMethod,
  CollectionChannel,
  ExpenseFrequency,
  ExpenseKind,
  ExpenseScopeKind,
  InvoiceKind,
  InvoiceStatus,
  PaymentAttention,
  PaymentPurpose,
  VariableFormula,
} from '@/lib/finance'
import { formatAgorot } from '@/lib/plans/plan'

import type { ReconciliationOutcome } from './queries'

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

/* -------------------------------------------------------------- expense -- */

/**
 * `EXPENSE_KINDS`. Two words that carry the whole distinction.
 *
 * A variable cost is caused by the stay and is computed from it; a fixed cost
 * belongs to a period and exists whether or not anybody stayed. Everything else
 * on the expenses screen follows from which of the two a rule is, which is why
 * the labels say what the rule *does* rather than repeating the enum.
 */
export const EXPENSE_KIND_LABEL: Record<ExpenseKind, string> = {
  fixed: 'קבועה — סכום לתקופה',
  variable: 'משתנה — מחושבת לפי ההזמנה',
}

/** `EXPENSE_FREQUENCIES`. How often a fixed rule recurs. */
export const EXPENSE_FREQUENCY_LABEL: Record<ExpenseFrequency, string> = {
  one_time: 'חד־פעמי',
  daily: 'יומי',
  weekly: 'שבועי',
  monthly: 'חודשי',
  quarterly: 'רבעוני',
  yearly: 'שנתי',
}

/**
 * `ALLOCATION_METHODS` — how a period cost is attributed to the stays in it.
 *
 * Worded as the statement each one makes, because businesses genuinely disagree
 * and the disagreement is not about rounding: a monthly premium spread
 * `per_day` says the cost existed whether or not anyone stayed, and spread
 * `per_occupied_night` it says the opposite. Both are defensible; the product's
 * job is to let the business say which and then be consistent for ever.
 */
export const ALLOCATION_METHOD_LABEL: Record<AllocationMethod, string> = {
  per_day: 'לפי ימי התקופה',
  per_occupied_night: 'לפי לילות תפוסים',
  per_booking: 'בחלוקה שווה בין ההזמנות',
  per_guest: 'לפי מספר האורחים',
  by_revenue: 'לפי ההכנסה נטו',
  by_unit: 'בחלוקה שווה בין היחידות',
  custom: 'לפי משקלים ידניים',
}

/** `EXPENSE_SCOPE_KINDS` — where the rule applies. */
export const EXPENSE_SCOPE_LABEL: Record<ExpenseScopeKind, string> = {
  organization: 'כל הארגון',
  property: 'נכס מסוים',
  unit: 'יחידה מסוימת',
  booking: 'הזמנה בודדת',
}

/** The five formulas a variable rule may be computed by. */
export const VARIABLE_FORMULA_LABEL: Record<VariableFormula['kind'], string> = {
  per_night: 'תעריף לכל לילה',
  per_guest_night: 'תעריף לכל אורח לכל לילה',
  per_booking: 'תעריף לכל הזמנה',
  per_guest: 'תעריף לכל אורח',
  percent_of_revenue: 'אחוז מההכנסה נטו',
}

/**
 * A variable rule's calculation, in one Hebrew line.
 *
 * The figure is formatted here and only here at the display border —
 * `formatAgorot` for a rate, a plain percentage for the other. Nothing divides
 * by 100 to get shekels; `formatAgorot` is the product's one ₪ formatter.
 */
export function describeFormula(formula: VariableFormula): string {
  if (formula.kind === 'percent_of_revenue') {
    return `${formula.percent}% מההכנסה נטו של ההזמנה`
  }
  return `${formatAgorot(formula.rateAgorot)} · ${VARIABLE_FORMULA_LABEL[formula.kind]}`
}

/* ------------------------------------------------------- reconciliation -- */

/**
 * The three answers a reconciliation row can give.
 *
 * `unresolved` is not a kind of difference and must not read as one. A payment
 * the processor never answered about is money that may or may not have been
 * taken, and the row is on screen precisely because nobody can yet say which.
 */
export const RECONCILIATION_OUTCOME_LABEL: Record<
  ReconciliationOutcome,
  string
> = {
  unresolved: 'ממתין לבירור מול הסולק',
  difference: 'יש פער בין הצפוי לנגבה',
  matched: 'תואם במלואו',
}

export function reconciliationTone(outcome: ReconciliationOutcome): BadgeTone {
  if (outcome === 'unresolved') return 'accent'
  if (outcome === 'matched') return 'brand'
  return 'neutral'
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
