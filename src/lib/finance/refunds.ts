/**
 * Refunds.
 *
 * One rule dominates the file and is enforced in three independent places,
 * deliberately: **a refund can never exceed what was captured.**
 *
 *   1. `assertRefundable` refuses the request before a `Refund` row exists.
 *   2. The payment state machine's `refundWithinCapture` condition refuses the
 *      move even if a caller assembled the amounts by hand.
 *   3. The provider's own ledger refuses it at the processor.
 *
 * Three checks for one rule looks like duplication and is not. The first gives
 * the user a Hebrew sentence they can act on. The second is what protects the
 * database from a code path nobody anticipated — a bulk import, a support
 * script, a future operation. The third is the only one an attacker cannot
 * reach. Removing any of them leaves a hole the other two do not cover.
 *
 * The ceiling is measured against `capturedAgorot`, never against the status.
 * A `partially_paid` deposit where ₪300 of ₪1,000 was deducted can be refunded
 * by at most ₪300 — a status-based check would offer ₪1,000 of money that was
 * never taken.
 *
 * ── Approval ──────────────────────────────────────────────────────────────
 *
 * `payment.refund` is already in `SENSITIVE_ACTIONS`, so the service pipeline
 * demands a stated reason on every refund without this file asking. What this
 * file adds is the *second signature*: above a threshold the business sets, or
 * for reasons it names, the refund is `requested` and waits for somebody
 * holding `approval.decide`. The approval rides on the frozen
 * `APPROVAL_STATUSES` rather than a private enum, so an approvals inbox does
 * not need to learn a second vocabulary for money.
 */

import type { Actor } from '../authz/can'
import type { Agorot } from '../booking/types'
import { BusinessRuleError } from '../errors'
import { formatAgorot } from '../plans/plan'
import { movePaymentTo, type PaymentChange } from './payments'
import { deriveStatusFromAmounts } from './payments'
import { sumAgorot } from './money'
import type {
  Payment,
  PaymentAmounts,
  Refund,
  RefundReason,
  RefundStatus,
} from './types'

// ── The ceiling ───────────────────────────────────────────────────────────

/** What is still returnable. The only figure a refund may be measured against. */
export function maxRefundableAgorot(payment: Payment): Agorot {
  return Math.max(0, payment.capturedAgorot - payment.refundedAgorot)
}

/**
 * Refuse a refund that cannot be honoured.
 *
 * The Hebrew message quotes both figures, because "לא ניתן" on its own leaves
 * the operator guessing at how much they *can* return, and they will guess
 * high and try again.
 */
export function assertRefundable(payment: Payment, amountAgorot: Agorot): void {
  if (!Number.isInteger(amountAgorot) || amountAgorot <= 0) {
    throw new BusinessRuleError({
      code: 'finance.invalid_refund_amount',
      userMessage: 'סכום ההחזר חייב להיות מספר שלם של אגורות, וגדול מאפס.',
      message: `Invalid refund amount: ${amountAgorot}`,
    })
  }

  const ceiling = maxRefundableAgorot(payment)
  if (amountAgorot <= ceiling) return

  throw new BusinessRuleError({
    code: 'finance.refund_exceeds_capture',
    userMessage:
      `לא ניתן להחזיר ${formatAgorot(amountAgorot)} — ` +
      `הסכום שנגבה ועדיין ניתן להחזרה הוא ${formatAgorot(ceiling)}.`,
    message:
      `Refund of ${amountAgorot} exceeds refundable ${ceiling} on ` +
      `payment ${payment.id}`,
    publicDetails: { requested: amountAgorot, refundable: ceiling },
  })
}

// ── Approval policy ───────────────────────────────────────────────────────

export interface RefundApprovalPolicy {
  /** At or below this, a holder of `payment.refund` may act alone. */
  autoApproveUpToAgorot: Agorot
  /** Reasons that always need a second person, whatever the amount. */
  alwaysApproveReasons: readonly RefundReason[]
}

/** A conservative default: nothing above ₪500, and never goodwill alone. */
export const DEFAULT_REFUND_POLICY: RefundApprovalPolicy = {
  autoApproveUpToAgorot: 50_000,
  alwaysApproveReasons: ['goodwill', 'business_cancellation'],
}

export function refundNeedsApproval(
  amountAgorot: Agorot,
  reason: RefundReason,
  policy: RefundApprovalPolicy = DEFAULT_REFUND_POLICY,
): boolean {
  if (policy.alwaysApproveReasons.includes(reason)) return true
  return amountAgorot > policy.autoApproveUpToAgorot
}

// ── Requesting ────────────────────────────────────────────────────────────

export interface RefundRequestInput {
  id: string
  payment: Payment
  amountAgorot: Agorot
  reason: RefundReason
  reasonText: string
  requestedByUserId: string | null
  requestedAt: Date
  policy?: RefundApprovalPolicy
}

/**
 * Turn an intention into a record, or refuse it.
 *
 * A refund that needs approval is born `requested`/`requested`; one that does
 * not is born `approved`/`approved` and is ready to send to the provider. The
 * two statuses are separate — `status` is where the money is,
 * `approvalStatus` is where the decision is — because a rejected refund and a
 * failed refund are entirely different conversations with the guest.
 */
export function requestRefund(input: RefundRequestInput): Refund {
  assertRefundable(input.payment, input.amountAgorot)

  if (input.reasonText.trim().length === 0) {
    throw new BusinessRuleError({
      code: 'finance.refund_needs_reason',
      userMessage: 'החזר כספי דורש נימוק. הסבר בקצרה מדוע הוא מבוצע.',
      message: 'requestRefund called without a stated reason',
    })
  }

  const needsApproval = refundNeedsApproval(
    input.amountAgorot,
    input.reason,
    input.policy,
  )

  return {
    id: input.id,
    organizationId: input.payment.organizationId,
    paymentId: input.payment.id,
    bookingId: input.payment.bookingId,
    amountAgorot: input.amountAgorot,
    reason: input.reason,
    reasonText: input.reasonText,
    status: needsApproval ? 'requested' : 'approved',
    approvalStatus: needsApproval ? 'requested' : 'approved',
    approvedByUserId: needsApproval ? null : input.requestedByUserId,
    requestedByUserId: input.requestedByUserId,
    providerRef: null,
    settledByEventId: null,
    requestedAt: input.requestedAt,
    processedAt: null,
  }
}

// ── Deciding ──────────────────────────────────────────────────────────────

export function approveRefund(
  refund: Refund,
  approvedByUserId: string,
): Refund {
  assertPending(refund, 'לאשר')
  if (approvedByUserId === refund.requestedByUserId) {
    // Whoever asked does not also decide. The whole point of a second
    // signature is that it belongs to a second person.
    throw new BusinessRuleError({
      code: 'finance.refund_self_approval',
      userMessage:
        'מי שביקש את ההחזר אינו יכול לאשר אותו. נדרש אישור של אדם נוסף.',
      message: `Self-approval attempted on refund ${refund.id}`,
    })
  }
  return {
    ...refund,
    status: 'approved',
    approvalStatus: 'approved',
    approvedByUserId,
  }
}

export function rejectRefund(refund: Refund): Refund {
  assertPending(refund, 'לדחות')
  return { ...refund, status: 'rejected', approvalStatus: 'rejected' }
}

function assertPending(refund: Refund, verb: string): void {
  if (refund.approvalStatus === 'requested') return
  throw new BusinessRuleError({
    code: 'finance.refund_already_decided',
    userMessage: `כבר התקבלה החלטה על ההחזר הזה, ולכן לא ניתן ${verb} אותו.`,
    message: `Refund ${refund.id} is already ${refund.approvalStatus}`,
  })
}

// ── Settling ──────────────────────────────────────────────────────────────

export interface RefundSettlement {
  refund: Refund
  change: PaymentChange
}

/**
 * Move the money, once.
 *
 * `settledByEventId` is the guard. A provider event that already settled this
 * refund settles nothing further, which is what makes a redelivered refund
 * webhook harmless at the refund level as well as at the payment level. Both
 * guards exist because they close different windows: the payment's
 * `appliedEventIds` stops the same delivery being re-applied, and this stops a
 * *different* delivery from settling a refund that is already settled.
 */
export function settleRefund(
  actor: Actor,
  payment: Payment,
  refund: Refund,
  options: { now: Date; providerRef?: string | null; eventId?: string | null },
): RefundSettlement | null {
  if (refund.status === 'processed') return null
  if (refund.approvalStatus !== 'approved') {
    throw new BusinessRuleError({
      code: 'finance.refund_not_approved',
      userMessage: 'ההחזר טרם אושר, ולכן לא ניתן לבצע אותו.',
      message: `Refund ${refund.id} is ${refund.approvalStatus}`,
    })
  }

  assertRefundable(payment, refund.amountAgorot)

  const next: PaymentAmounts = {
    amountAgorot: payment.amountAgorot,
    authorizedAgorot: payment.authorizedAgorot,
    capturedAgorot: payment.capturedAgorot,
    refundedAgorot: payment.refundedAgorot + refund.amountAgorot,
  }

  const change = movePaymentTo(
    actor,
    payment,
    deriveStatusFromAmounts(next, payment.status),
    next,
    {
      now: options.now,
      providerRef: options.providerRef ?? payment.providerRef,
      eventId: options.eventId ?? null,
    },
  )

  return {
    refund: {
      ...refund,
      status: 'processed' as RefundStatus,
      providerRef: options.providerRef ?? refund.providerRef,
      settledByEventId: options.eventId ?? refund.settledByEventId,
      processedAt: options.now,
    },
    change,
  }
}

/**
 * The ledger check.
 *
 * Processed refunds must add up to the payment's `refundedAgorot` exactly. A
 * chargeback breaks that equality legitimately — the bank refunded without a
 * `Refund` row — so the difference is reported rather than thrown, and the
 * reconciliation report is where an operator sees it.
 */
export function refundLedgerDifference(
  payment: Payment,
  refunds: readonly Refund[],
): Agorot {
  const processed = sumAgorot(
    refunds
      .filter(
        (refund) =>
          refund.paymentId === payment.id && refund.status === 'processed',
      )
      .map((refund) => refund.amountAgorot),
  )
  return payment.refundedAgorot - processed
}
