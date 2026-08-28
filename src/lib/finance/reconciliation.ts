/**
 * Reconciliation — comparing our ledger against the processor's.
 *
 * The purpose of this file is to **report differences, never to hide them**.
 * It is tempting to write a reconciler that "fixes" what it finds, and every
 * such reconciler eventually silently overwrites a real payment with a stale
 * provider row, or vice versa. So nothing here mutates a payment. It produces
 * a report; a person, or an explicit operation with an audit trail, acts on it.
 *
 * ── What is compared, and what is deliberately not ────────────────────────
 *
 * Only payments the provider could possibly know about. Cash at the desk and a
 * bank transfer entered by hand have no counterpart in a processor's file, and
 * reporting them as "missing at the provider" would produce a page of
 * differences on every reconciliation run — which is the same as producing
 * none, because nobody reads a report that is always red.
 *
 * ── The differences that matter most ──────────────────────────────────────
 *
 * `status_unknown` is listed first and is not really a difference at all: it
 * is our own record admitting it does not know. Those are the payments where a
 * provider timed out, and reconciliation is the process that closes them. A
 * run that finds one has found the thing it exists to find.
 *
 * `missing_internally` is the dangerous one in the other direction: the
 * processor took money we have no record of. Left alone, that money is never
 * attributed to a booking and never appears on a guest's balance.
 */

import type { Agorot } from '../booking/types'
import { formatAgorot } from '../plans/plan'
import { sumAgorot } from './money'
import type { ProviderTransaction } from './provider'
import { settledAgorot, type Payment } from './types'

// ── The report ────────────────────────────────────────────────────────────

export const DIFFERENCE_KINDS = [
  'status_unknown',
  'missing_at_provider',
  'missing_internally',
  'amount_mismatch',
  'refund_mismatch',
  'unlinked',
] as const

export type DifferenceKind = (typeof DIFFERENCE_KINDS)[number]

export interface ReconciliationDifference {
  kind: DifferenceKind
  paymentId: string | null
  providerRef: string | null
  bookingId: string | null
  /** What our ledger says moved, net. */
  internalAgorot: Agorot
  /** What the provider says moved, net. */
  providerAgorot: Agorot
  /** Their difference, signed: positive means we claim more than they do. */
  deltaAgorot: Agorot
  /** Hebrew, written for whoever has to work the queue. */
  message: string
}

export interface ReconciliationReport {
  from: Date
  to: Date
  /** Payments that matched the provider exactly, to the agora. */
  matchedCount: number
  matchedAgorot: Agorot
  /** Excluded from comparison because the provider cannot know about them. */
  offProviderCount: number
  offProviderAgorot: Agorot
  differences: readonly ReconciliationDifference[]
  /** The absolute money in dispute. The headline figure of the run. */
  differenceAgorot: Agorot
  balanced: boolean
}

export interface ReconciliationInput {
  from: Date
  to: Date
  payments: readonly Payment[]
  providerTransactions: readonly ProviderTransaction[]
}

/** A payment the provider could know about at all. */
function isProviderCollected(payment: Payment): boolean {
  return payment.providerId !== null && payment.channel !== 'manual'
}

/**
 * Compare the two ledgers.
 *
 * Matching is by `providerRef`, which is the only identifier both sides agree
 * on. A payment with no reference that nevertheless claims to have captured
 * money through a provider is its own difference (`unlinked`) rather than
 * being quietly skipped — it is unreconcilable, and that is worth saying.
 */
export function reconcile(input: ReconciliationInput): ReconciliationReport {
  const differences: ReconciliationDifference[] = []

  const byRef = new Map<string, ProviderTransaction>(
    input.providerTransactions.map((transaction) => [
      transaction.providerRef,
      transaction,
    ]),
  )
  const seenRefs = new Set<string>()

  const offProvider = input.payments.filter(
    (payment) => !isProviderCollected(payment),
  )
  const comparable = input.payments.filter(isProviderCollected)

  let matchedCount = 0
  let matchedAgorot = 0

  for (const payment of comparable) {
    const internal = settledAgorot(payment)

    // Our own record says we do not know. Reconciliation is exactly the
    // process that closes these, so they lead the report.
    if (payment.status === 'unknown') {
      const transaction =
        payment.providerRef === null ? null : byRef.get(payment.providerRef)
      if (transaction) seenRefs.add(transaction.providerRef)

      const providerNet = transaction
        ? transaction.capturedAgorot - transaction.refundedAgorot
        : 0

      differences.push({
        kind: 'status_unknown',
        paymentId: payment.id,
        providerRef: payment.providerRef,
        bookingId: payment.bookingId,
        internalAgorot: internal,
        providerAgorot: providerNet,
        deltaAgorot: internal - providerNet,
        message: transaction
          ? `תשלום במצב "לא ידוע". אצל חברת הסליקה רשום ` +
            `${formatAgorot(providerNet)} — יש ליישב את הרשומה.`
          : 'תשלום במצב "לא ידוע" ואין לו רישום אצל חברת הסליקה. ' +
            'ככל הנראה החיוב לא בוצע.',
      })
      continue
    }

    if (payment.providerRef === null) {
      if (internal === 0) continue
      differences.push({
        kind: 'unlinked',
        paymentId: payment.id,
        providerRef: null,
        bookingId: payment.bookingId,
        internalAgorot: internal,
        providerAgorot: 0,
        deltaAgorot: internal,
        message:
          `תשלום של ${formatAgorot(internal)} נרשם כנגבה דרך חברת סליקה ` +
          'אך אין לו מזהה עסקה, ולכן לא ניתן להתאים אותו.',
      })
      continue
    }

    const transaction = byRef.get(payment.providerRef)
    if (!transaction) {
      differences.push({
        kind: 'missing_at_provider',
        paymentId: payment.id,
        providerRef: payment.providerRef,
        bookingId: payment.bookingId,
        internalAgorot: internal,
        providerAgorot: 0,
        deltaAgorot: internal,
        message:
          `אצלנו רשום ${formatAgorot(internal)} ואצל חברת הסליקה אין ` +
          'עסקה תואמת בתקופה הזו.',
      })
      continue
    }

    seenRefs.add(transaction.providerRef)

    // Captures and refunds are compared separately rather than only on the
    // net. A payment where both are ₪200 too high nets to zero, and netting
    // would report it as a match — while the guest was charged and refunded
    // twice, which is a real event somebody must look at.
    if (payment.capturedAgorot !== transaction.capturedAgorot) {
      differences.push({
        kind: 'amount_mismatch',
        paymentId: payment.id,
        providerRef: payment.providerRef,
        bookingId: payment.bookingId,
        internalAgorot: payment.capturedAgorot,
        providerAgorot: transaction.capturedAgorot,
        deltaAgorot: payment.capturedAgorot - transaction.capturedAgorot,
        message:
          `הסכום שנגבה אצלנו הוא ${formatAgorot(payment.capturedAgorot)} ` +
          `ואצל חברת הסליקה ${formatAgorot(transaction.capturedAgorot)}.`,
      })
      continue
    }

    if (payment.refundedAgorot !== transaction.refundedAgorot) {
      differences.push({
        kind: 'refund_mismatch',
        paymentId: payment.id,
        providerRef: payment.providerRef,
        bookingId: payment.bookingId,
        internalAgorot: payment.refundedAgorot,
        providerAgorot: transaction.refundedAgorot,
        deltaAgorot: payment.refundedAgorot - transaction.refundedAgorot,
        message:
          `הסכום שהוחזר אצלנו הוא ${formatAgorot(payment.refundedAgorot)} ` +
          `ואצל חברת הסליקה ${formatAgorot(transaction.refundedAgorot)}.`,
      })
      continue
    }

    matchedCount += 1
    matchedAgorot += internal
  }

  // Anything the provider has that we never saw. Money taken from a guest with
  // no record on our side is the worst outcome in this file, so it is reported
  // even when the amount is zero — a transaction we do not know about is a
  // fact regardless of its size.
  for (const transaction of input.providerTransactions) {
    if (seenRefs.has(transaction.providerRef)) continue
    const providerNet = transaction.capturedAgorot - transaction.refundedAgorot
    differences.push({
      kind: 'missing_internally',
      paymentId: null,
      providerRef: transaction.providerRef,
      bookingId: null,
      internalAgorot: 0,
      providerAgorot: providerNet,
      deltaAgorot: -providerNet,
      message:
        `אצל חברת הסליקה רשומה עסקה של ${formatAgorot(providerNet)} ` +
        'שאין לה רישום אצלנו.',
    })
  }

  const differenceAgorot = sumAgorot(
    differences.map((difference) => Math.abs(difference.deltaAgorot)),
  )

  return {
    from: input.from,
    to: input.to,
    matchedCount,
    matchedAgorot,
    offProviderCount: offProvider.length,
    offProviderAgorot: sumAgorot(offProvider.map(settledAgorot)),
    differences,
    differenceAgorot,
    balanced: differences.length === 0,
  }
}

/**
 * A one-line Hebrew summary of a run.
 *
 * For the notification. A reconciliation that balanced should say so plainly —
 * "0 הפרשים" is the outcome a finance manager wants to see and stop reading.
 */
export function describeReconciliation(report: ReconciliationReport): string {
  if (report.balanced) {
    return (
      `ההתאמה הושלמה: ${report.matchedCount} תשלומים תואמים ` +
      `(${formatAgorot(report.matchedAgorot)}), ללא הפרשים.`
    )
  }
  return (
    `ההתאמה מצאה ${report.differences.length} הפרשים בסך ` +
    `${formatAgorot(report.differenceAgorot)}. ` +
    `${report.matchedCount} תשלומים תאמו במלואם.`
  )
}
