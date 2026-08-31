/**
 * The finance domain contract.
 *
 * Everything money-shaped that more than one file in this module needs to
 * agree about. The frozen vocabularies — `PaymentStatus`, `PaymentMethod`,
 * `CommissionStatus`, `ApprovalStatus` — are *consumed* from
 * `contracts/states.ts` and are never restated here, and money is
 * `Agorot` from the booking contract, never a number of shekels and never a
 * float.
 *
 * ── Three modelling decisions worth stating ───────────────────────────────
 *
 * **A security deposit is a payment, not a parallel species.** It is a
 * `Payment` whose `purpose` is `security_deposit`, and it moves through the
 * same `PAYMENT_STATUSES`: `authorized` when the card is held, `paid` when it
 * is taken in full, `partially_paid` when part of it is deducted for damage,
 * `cancelled` when the hold is released untouched. Giving deposits their own
 * status enum would be a second answer to "has this money moved", and the two
 * would disagree.
 *
 * **A payment carries four amounts, not one.** `amountAgorot` is what was
 * asked for; `authorizedAgorot` is what is reserved; `capturedAgorot` is what
 * was actually taken; `refundedAgorot` is what went back. The status is a
 * summary of those four and is never the source of truth for any of them — a
 * refund ceiling computed from a status rather than from `capturedAgorot` is
 * how a partially captured deposit gets over-refunded.
 *
 * **What the provider told us is kept beside what we decided.** `providerRef`,
 * `appliedEventIds` and `lastProviderEventAt` are the payment's memory of the
 * outside world. They are what make a duplicate webhook a no-op and an
 * out-of-order webhook detectable, and they are why those two cases are
 * properties of the record rather than of whichever handler happens to run.
 */

import type { Agorot, DateRange, PriceLine } from '../booking/types'
import type {
  ApprovalStatus,
  CommissionStatus,
  PaymentMethod,
  PaymentStatus,
} from '../contracts/states'
import type { Currency } from './money'

// ── Payments ──────────────────────────────────────────────────────────────

/**
 * Why this money is being collected.
 *
 * Separate from `PaymentMethod`, which is *how*. A deposit taken in cash and a
 * deposit taken on a card are the same commercial event settled two ways, and
 * a model that cannot say so ends up with "cash deposit" as a method.
 */
export const PAYMENT_PURPOSES = [
  'deposit',
  'balance',
  'full',
  'instalment',
  'partial',
  'security_deposit',
  'fee',
] as const

export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number]

/**
 * How the request reached the payer.
 *
 * `payment_link` is the guest paying themselves on the provider's hosted page;
 * `manual` is a member of staff recording money that arrived outside the
 * system — cash at the desk, a bank transfer that appeared on the statement.
 * The distinction matters for reconciliation: only provider-collected payments
 * have anything to reconcile against, and treating a cash payment as missing
 * from the provider's file would report a difference on every till.
 */
export const COLLECTION_CHANNELS = [
  'payment_link',
  'hosted_page',
  'terminal',
  'manual',
] as const

export type CollectionChannel = (typeof COLLECTION_CHANNELS)[number]

/**
 * Something about this payment needs a human, and it is not an error.
 *
 * `reconcile_unknown` is the provider timeout: the card may or may not have
 * been charged, and somebody has to look. `refund_after_cancellation` is money
 * that arrived for a booking that no longer exists. `overpaid` is more money
 * than was ever asked for. All three are real money in a state the automation
 * must not resolve on its own.
 */
export const PAYMENT_ATTENTIONS = [
  'reconcile_unknown',
  'refund_after_cancellation',
  'overpaid',
] as const

export type PaymentAttention = (typeof PAYMENT_ATTENTIONS)[number]

/** The four amounts that decide everything. Kept together so they move together. */
export interface PaymentAmounts {
  /** What was asked for. */
  amountAgorot: Agorot
  /** Reserved on the card and not yet taken. */
  authorizedAgorot: Agorot
  /** Actually taken. The only basis a refund may be measured against. */
  capturedAgorot: Agorot
  /** Given back. Never more than `capturedAgorot` — see `refunds.ts`. */
  refundedAgorot: Agorot
}

export interface Payment extends PaymentAmounts {
  id: string
  organizationId: string
  propertyId: string | null
  bookingId: string
  purpose: PaymentPurpose
  method: PaymentMethod
  channel: CollectionChannel
  status: PaymentStatus
  currency: Currency
  /** Which provider holds this money. `null` for cash and manual transfers. */
  providerId: string | null
  /** The provider's own identifier for the transaction. */
  providerRef: string | null
  /** The instalment plan this belongs to, when it is one of several. */
  scheduleId: string | null
  /** 1-based position within the plan. */
  instalmentNumber: number | null
  dueOn: string | null
  /**
   * Provider events already applied, so a redelivery changes nothing.
   *
   * Kept on the payment rather than in a side table because the question
   * "have I already acted on this event" must be answerable in the same read
   * that loads the record it would change.
   */
  appliedEventIds: readonly string[]
  /** The timestamp of the newest event applied. Older events are stale. */
  lastProviderEventAt: Date | null
  /** Set when a person must intervene. Never cleared by automation. */
  requiresAttention: PaymentAttention | null
  /** When the provider stopped answering. Drives the reconciliation queue. */
  unknownSince: Date | null
  createdAt: Date
  updatedAt: Date
  createdByUserId: string | null
  version: number
}

/** What money has actually moved, net. The figure a balance is built from. */
export function settledAgorot(payment: Payment): Agorot {
  return payment.capturedAgorot - payment.refundedAgorot
}

// ── Instalments ───────────────────────────────────────────────────────────

export const INSTALMENT_CADENCES = ['weekly', 'monthly'] as const

export type InstalmentCadence = (typeof INSTALMENT_CADENCES)[number]

export interface ScheduledInstalment {
  instalmentNumber: number
  amountAgorot: Agorot
  dueOn: string
  purpose: PaymentPurpose
}

export interface PaymentSchedule {
  id: string
  organizationId: string
  bookingId: string
  totalAgorot: Agorot
  instalments: readonly ScheduledInstalment[]
}

// ── Refunds ───────────────────────────────────────────────────────────────

export const REFUND_REASONS = [
  'guest_cancellation',
  'business_cancellation',
  'overpayment',
  'service_failure',
  'goodwill',
  'duplicate_charge',
  'deposit_release',
  'correction',
] as const

export type RefundReason = (typeof REFUND_REASONS)[number]

export const REFUND_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'processed',
  'failed',
  'unknown',
] as const

export type RefundStatus = (typeof REFUND_STATUSES)[number]

/**
 * A refund is a request before it is a movement.
 *
 * It carries its own approval because the amount a person may return without
 * a second signature is a policy the business sets, and because
 * `payment.refund` is already in `SENSITIVE_ACTIONS`: a stated reason is
 * mandatory, and the reason is on the record rather than only in the audit log
 * so the guest-facing credit note can quote it.
 */
export interface Refund {
  id: string
  organizationId: string
  paymentId: string
  bookingId: string
  amountAgorot: Agorot
  reason: RefundReason
  /** The free-text justification. Required; see `SENSITIVE_ACTIONS`. */
  reasonText: string
  status: RefundStatus
  approvalStatus: ApprovalStatus
  approvedByUserId: string | null
  requestedByUserId: string | null
  providerRef: string | null
  /** The provider event that settled it, so a redelivery is recognisable. */
  settledByEventId: string | null
  requestedAt: Date
  processedAt: Date | null
}

// ── Deposits ──────────────────────────────────────────────────────────────

/**
 * The security deposit, as four facts rather than one.
 *
 * `required` is what was asked for, `held` is what is actually reserved,
 * `released` is what went back to the guest, and `forfeited` is what was kept
 * for damage. Collapsing them into one signed number forces the other three to
 * be reconstructed from a note, and "how much of my ₪1,000 did you keep, and
 * why" is the most disputed question in the product.
 *
 * One per booking, because the booking state machine treats "the deposit held"
 * as a single number and refuses to complete a stay while it is above zero.
 * Two rows would make that number ambiguous.
 *
 * `paymentId` links to the charge that actually took the money, and is `null`
 * while the deposit is merely authorised on a card — which is its normal
 * resting state.
 */
export interface Deposit {
  id: string
  organizationId: string
  propertyId: string
  bookingId: string
  status: PaymentStatus
  method: PaymentMethod | null
  requiredAgorot: Agorot
  heldAgorot: Agorot
  releasedAgorot: Agorot
  forfeitedAgorot: Agorot
  currency: Currency
  paymentId: string | null
  /** Required whenever anything is forfeited. Not optional, by rule. */
  forfeitReason: string | null
  authorizedAt: Date | null
  capturedAt: Date | null
  releasedAt: Date | null
  releasedByUserId: string | null
  forfeitedAt: Date | null
  createdAt: Date
  updatedAt: Date
  version: number
}

// ── Invoices ──────────────────────────────────────────────────────────────

/**
 * What kind of document this is.
 *
 * A proforma is a request for money and carries no tax consequence; a tax
 * invoice is a legal declaration; a receipt acknowledges money received. The
 * combined form is what most small Israeli businesses actually issue. They are
 * different documents to the tax authority, so they are a kind rather than a
 * flag.
 */
export const INVOICE_KINDS = [
  'proforma',
  'tax_invoice',
  'receipt',
  'tax_invoice_receipt',
] as const

export type InvoiceKind = (typeof INVOICE_KINDS)[number]

export const INVOICE_STATUSES = ['draft', 'issued', 'cancelled'] as const

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

/**
 * A legal document, which is why it is not editable.
 *
 * Once `issued` it has a number and a moment, and its money fields are frozen:
 * the only correction is a credit note, never an edit.
 *
 * `archivedAt` is deliberately **not** a status. Filing a document away is an
 * operational act, and an archived tax invoice is still an issued tax invoice
 * as far as the tax authority is concerned. Folding archival into the status
 * would make "is this document legally in force" unanswerable from the status
 * alone — which is the one question the status exists to answer.
 */
export interface Invoice {
  id: string
  organizationId: string
  propertyId: string
  bookingId: string
  kind: InvoiceKind
  status: InvoiceStatus
  /** Numbering runs per series and per calendar year. */
  series: string
  year: number
  /** Allocated at issue, never before, never reused. */
  number: number | null
  /** What is printed: `2026-000184`. */
  displayNumber: string | null

  /** Snapshotted. The guest may correct their name tomorrow; this may not. */
  customerName: string
  customerTaxId: string | null

  /**
   * The itemisation, copied from the booking's finance snapshot.
   *
   * `subtotalAgorot` is the sum of the non-tax lines and `taxAgorot` the sum
   * of the tax lines, so the printed total is explicable line by line rather
   * than being a number that happens to sit beside an explanation.
   */
  lines: readonly PriceLine[]
  subtotalAgorot: Agorot
  taxAgorot: Agorot
  /** Always `subtotalAgorot + taxAgorot`. Never assembled independently. */
  totalAgorot: Agorot
  /** Basis points, so 18% is 1800 and a tax rate is never a float. */
  taxRateBps: number | null
  touristVatExempt: boolean
  currency: Currency

  issuedAt: Date | null
  cancelledAt: Date | null
  cancellationReason: string | null
  /** Filed away. Not a legal status — see the note above. */
  archivedAt: Date | null

  /** The payments this document accounts for. */
  paymentIds: readonly string[]
  /**
   * The snapshot the lines came from, so the two can be tied back together.
   *
   * Nullable, because `invoices.snapshot_captured_at` is. 0016 added it to a
   * table that already held documents, without a backfill and without `not
   * null` — so every invoice issued before that migration has none, and so does
   * any document composed from a booking that was never snapshotted. It was
   * typed as a plain `string` here and read with `asTimestamp`, which refuses
   * null: one such row made `loadInvoicesForBooking` throw before it returned
   * anything, and a deployment holding one could not render its invoices at
   * all. `null` is the honest answer — "this document cannot be tied back to a
   * capture" — and is a different statement from a capture at the epoch.
   */
  snapshotCapturedAt: string | null
}

/**
 * The instrument that corrects an issued invoice.
 *
 * Its own series and number, for the same reason an invoice has one. The
 * amount is always positive: the direction is the document type, not the sign,
 * and a negative credit note is a refund of a refund.
 */
export interface CreditNote {
  id: string
  organizationId: string
  propertyId: string
  invoiceId: string
  bookingId: string
  status: InvoiceStatus
  series: string
  year: number
  number: number | null
  displayNumber: string | null
  /** The explanation, when the credit is itemised rather than a lump sum. */
  lines: readonly PriceLine[]
  amountAgorot: Agorot
  taxAgorot: Agorot
  currency: Currency
  /** Required. A credit note with no stated reason is unauditable. */
  reason: string
  issuedAt: Date | null
}

// ── Expenses ──────────────────────────────────────────────────────────────

export const EXPENSE_KINDS = ['fixed', 'variable'] as const

export type ExpenseKind = (typeof EXPENSE_KINDS)[number]

export const EXPENSE_FREQUENCIES = [
  'one_time',
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
] as const

export type ExpenseFrequency = (typeof EXPENSE_FREQUENCIES)[number]

export const EXPENSE_SCOPE_KINDS = [
  'organization',
  'property',
  'unit',
  'booking',
] as const

export type ExpenseScopeKind = (typeof EXPENSE_SCOPE_KINDS)[number]

export interface ExpenseScope {
  kind: ExpenseScopeKind
  propertyId?: string | null
  unitId?: string | null
  bookingId?: string | null
}

/**
 * How a cost that belongs to a period is attributed to the stays inside it.
 *
 * Seven methods, because businesses genuinely differ and the wrong one is not
 * a rounding problem — it changes which bookings look profitable. A monthly
 * insurance premium spread `per_day` says the cost exists whether or not
 * anyone stayed; spread `per_occupied_night` it says the opposite. Both are
 * defensible; the product's job is to let the business say which, and then to
 * be consistent about it for ever.
 */
export const ALLOCATION_METHODS = [
  'per_day',
  'per_occupied_night',
  'per_booking',
  'per_guest',
  'by_revenue',
  'by_unit',
  'custom',
] as const

export type AllocationMethod = (typeof ALLOCATION_METHODS)[number]

/**
 * A variable cost, as a closed set of formulas.
 *
 * Deliberately not an expression the customer types. A string evaluated at
 * runtime is a remote code execution hole wearing a spreadsheet's clothes, and
 * a formula nobody can enumerate is a formula nobody can test. These five
 * cover what the specification asks for; a sixth is a code change, reviewed.
 */
export type VariableFormula =
  | { kind: 'per_night'; rateAgorot: Agorot }
  | { kind: 'per_guest_night'; rateAgorot: Agorot }
  | { kind: 'per_booking'; rateAgorot: Agorot }
  | { kind: 'per_guest'; rateAgorot: Agorot }
  | { kind: 'percent_of_revenue'; percent: number }

export interface ExpenseRule {
  id: string
  organizationId: string
  /** Bumped on every edit. What a snapshot records, so drift is detectable. */
  version: number
  label: string
  category: string
  kind: ExpenseKind
  scope: ExpenseScope
  frequency: ExpenseFrequency
  /** The periodic amount, for a `fixed` rule. Zero for a variable one. */
  amountAgorot: Agorot
  /** The calculation, for a `variable` rule. `null` for a fixed one. */
  formula: VariableFormula | null
  allocation: AllocationMethod
  /** Inclusive. A rule does not apply to a stay that started before it existed. */
  effectiveFrom: string
  /** Exclusive. `null` means still in force. */
  effectiveTo: string | null
  approvalRequired: boolean
}

/** One stay, as the expense allocator needs to see it. */
export interface AllocatableBooking {
  bookingId: string
  unitId: string
  propertyId: string | null
  range: DateRange
  nights: number
  guests: number
  /** Net revenue, for `by_revenue`. Already computed by the P&L, not re-derived. */
  netRevenueAgorot: Agorot
}

export interface AllocationShare {
  bookingId: string
  amountAgorot: Agorot
  /** The weight this booking contributed, for the explanation on screen. */
  weight: number
}

export interface AllocationResult {
  method: AllocationMethod
  totalAgorot: Agorot
  shares: readonly AllocationShare[]
  /**
   * What could not be attributed to any booking.
   *
   * Never silently dropped and never forced onto an arbitrary stay. A month
   * with no bookings still incurs the insurance premium, and the property P&L
   * has to carry it.
   */
  unallocatedAgorot: Agorot
  /** Hebrew, one line, explaining the split to whoever queries it. */
  basis: string
}

// ── Commissions ───────────────────────────────────────────────────────────

/**
 * What the business agreed to pay a seller, and on what.
 *
 * `basis` matters more than it looks: a percentage of the gross is a different
 * number from a percentage of the net once a discount is applied, and the
 * dispute that follows is unwinnable without having written down which was
 * agreed.
 */
/**
 * Defined once, in `contracts/states`. Four modules once declared this list
 * independently and no two agreed, so the same written rule could pay
 * different amounts depending on which module happened to evaluate it.
 *
 * `CommissionBasis` is finance's local name for it, kept because it reads
 * better beside `basis:` on a rule.
 */
export { COMMISSION_BASES, COMMISSION_BASE_LABEL } from '../contracts/states'
import type { CommissionBase as CommissionBasis } from '../contracts/states'
export type { CommissionBasis }

export interface CommissionRule {
  basis: CommissionBasis
  kind: 'percent' | 'fixed'
  /** Percentage points for `percent`; agorot for `fixed`. */
  value: number
  label: string
}

export interface Commission {
  id: string
  organizationId: string
  propertyId: string
  bookingId: string
  /**
   * One of the two is required, never neither.
   *
   * An agency keeps the commercial relationship when the individual leaves,
   * which is why a commission can be owed to an agency with no named person.
   */
  agentUserId: string | null
  agencyId: string | null
  status: CommissionStatus
  /**
   * What the commission was computed on, and at what rate.
   *
   * Kept beside the amount rather than derivable from it: a commission nobody
   * can recompute is a commission nobody can defend in an argument, and the
   * argument happens two years later when the agreement has been renegotiated
   * twice.
   */
  basisAgorot: Agorot
  /** Basis points — 12% is 1200. `null` for a fixed-amount commission. */
  rateBps: number | null
  /** Computed from the snapshotted rule. Never from the live agreement. */
  amountAgorot: Agorot
  rule: CommissionRule
  statementId: string | null
  payoutBatchId: string | null
  becameEligibleAt: Date | null
  approvedByUserId: string | null
  paidAt: Date | null
  cancelledReason: string | null
  /**
   * The booking was refunded after the commission had been paid out.
   *
   * A paid commission cannot be cancelled — the money has left the business —
   * so the honest record is a flag that somebody must claw it back, not a
   * status change that pretends the payment never happened.
   */
  clawbackRequired: boolean
  createdAt: Date
  version: number
}

export interface CommissionStatement {
  id: string
  organizationId: string
  agentUserId: string
  periodStart: string
  periodEnd: string
  commissionIds: readonly string[]
  totalAgorot: Agorot
  issuedAt: Date
}

export interface PayoutBatch {
  id: string
  organizationId: string
  commissionIds: readonly string[]
  totalAgorot: Agorot
  approvedByUserId: string
  createdAt: Date
  paidAt: Date | null
}
