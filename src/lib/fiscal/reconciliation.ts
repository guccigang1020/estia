/**
 * Comparing ESTIA's fiscal references against the vendor's own document list.
 *
 * The same discipline `finance/reconciliation.ts` sets out for the payment
 * processor, applied to a second ledger: **it reports differences and never
 * hides or fixes them.** Nothing here mutates a `FiscalDocument`. It produces
 * differences a person resolves, and every difference names the two claims
 * side by side so the person is deciding rather than guessing.
 *
 * ── Why a reconciler that "fixes" things is worse than none ───────────────
 *
 * A tax invoice is numbered by the vendor out of a legal series. If ESTIA
 * silently adopted whatever the vendor's list said, one bad export would
 * rewrite the numbers a business already sent to its guests. If ESTIA silently
 * pushed its own view instead, a document the vendor genuinely issued would
 * disappear from the record while continuing to exist at the tax authority.
 * Both are unrecoverable; a report is not.
 *
 * ── The two differences that matter most ─────────────────────────────────
 *
 * `unknown_locally` is why this file exists. A document ESTIA marked `unknown`
 * — the vendor never answered — is either at the vendor or it is not, and this
 * comparison is the cheapest way to find out. A run that resolves one has done
 * its job.
 *
 * `missing_locally` is the dangerous direction: the vendor issued a numbered
 * legal document that ESTIA has no reference to. That document is real, it is
 * in the business's VAT return, and nothing in this product knows about it.
 * It is reported even when the amount is zero, because a document nobody knows
 * about is a fact regardless of its size.
 *
 * ── What is deliberately not compared ────────────────────────────────────
 *
 * Documents ESTIA never asked for a vendor to issue: everything whose provider
 * is the null one, and everything still `pending` with no attempt made.
 * Reporting those as "missing at the provider" would make every run red, and a
 * report that is always red is a report nobody reads — the argument
 * `finance/reconciliation.ts` makes about cash at the desk, in a second
 * ledger.
 */

import type { Agorot } from '../booking/types'
import { sumAgorot } from '../finance/money'
import { formatAgorot } from '../plans/plan'
import { NULL_FISCAL_PROVIDER } from './null-provider'
import {
  ISSUED_FISCAL_STATUSES,
  type FiscalDocument,
  type ProviderDocumentSummary,
} from './types'

export const FISCAL_DIFFERENCE_KINDS = [
  /** Our record says we do not know whether a document exists. */
  'unknown_locally',
  /** We hold an issued reference; the vendor's list has no such document. */
  'missing_at_provider',
  /** The vendor issued a document we have no reference to. */
  'missing_locally',
  /** Both know it; the totals disagree. */
  'amount_mismatch',
  /** Both know it; the vendor says cancelled and we say issued, or vice versa. */
  'status_mismatch',
  /** We hold an issued reference with no provider id, so it cannot be matched. */
  'unmatchable',
] as const

export type FiscalDifferenceKind = (typeof FISCAL_DIFFERENCE_KINDS)[number]

export interface FiscalDifference {
  kind: FiscalDifferenceKind
  /** ESTIA's document id, when there is a local record. */
  documentId: string | null
  providerDocumentId: string | null
  /** What is printed on the document, from whichever side has it. */
  documentNumber: string | null
  bookingId: string | null
  /** What ESTIA's reference says the document is for. */
  internalAgorot: Agorot
  /** What the vendor says. */
  providerAgorot: Agorot
  /** Signed: positive means we claim more than they do. */
  deltaAgorot: Agorot
  /** Hebrew, written for whoever works the queue. */
  message: string
}

export interface FiscalReconciliationReport {
  from: string
  to: string
  provider: string
  matchedCount: number
  matchedAgorot: Agorot
  /** Excluded from comparison. See the header. */
  notComparedCount: number
  differences: readonly FiscalDifference[]
  /** Absolute money in dispute. The headline figure of the run. */
  differenceAgorot: Agorot
  balanced: boolean
}

export interface FiscalReconciliationInput {
  from: string
  to: string
  provider: string
  documents: readonly FiscalDocument[]
  providerDocuments: readonly ProviderDocumentSummary[]
}

/**
 * A document the vendor could possibly know about.
 *
 * Everything issued through the null provider is excluded by name rather than
 * by a status check: those rows exist precisely because no vendor was asked,
 * and a comparison that reported them would report every row in a deployment
 * with nothing connected.
 */
function isComparable(document: FiscalDocument): boolean {
  if (document.provider === NULL_FISCAL_PROVIDER) return false
  if (document.status === 'pending' && document.attemptCount === 0) return false
  return true
}

export function reconcileFiscalDocuments(
  input: FiscalReconciliationInput,
): FiscalReconciliationReport {
  const differences: FiscalDifference[] = []

  const byProviderId = new Map<string, ProviderDocumentSummary>(
    input.providerDocuments.map((summary) => [
      summary.providerDocumentId,
      summary,
    ]),
  )
  const seen = new Set<string>()

  const comparable = input.documents.filter(isComparable)
  const notComparedCount = input.documents.length - comparable.length

  let matchedCount = 0
  let matchedAgorot = 0

  for (const document of comparable) {
    // Our own record admitting it does not know. These lead the report,
    // because closing them is the reason a person ran this at all.
    if (document.status === 'unknown') {
      const summary =
        document.providerDocumentId === null
          ? null
          : byProviderId.get(document.providerDocumentId)
      if (summary) seen.add(summary.providerDocumentId)

      differences.push({
        kind: 'unknown_locally',
        documentId: document.id,
        providerDocumentId: document.providerDocumentId,
        documentNumber: summary?.providerDocumentNumber ?? null,
        bookingId: document.bookingId,
        internalAgorot: document.amountAgorot,
        providerAgorot: summary?.amountAgorot ?? 0,
        deltaAgorot: document.amountAgorot - (summary?.amountAgorot ?? 0),
        message: summary
          ? `המסמך סומן "לא ידוע" ואצל הספק קיים מסמך ${summary.providerDocumentNumber} ` +
            `על ${formatAgorot(summary.amountAgorot)} — יש לקשר את הרשומה.`
          : 'המסמך סומן "לא ידוע" ואין לו מקבילה ברשימת הספק לתקופה הזו. ' +
            'ככל הנראה לא הופק מסמך.',
      })
      continue
    }

    // Nothing was issued and nothing is claimed to be. There is no document to
    // compare, and a failed or refused attempt is the §148 queue's business
    // rather than this report's.
    if (!ISSUED_FISCAL_STATUSES.includes(document.status)) continue

    if (document.providerDocumentId === null) {
      differences.push({
        kind: 'unmatchable',
        documentId: document.id,
        providerDocumentId: null,
        documentNumber: document.providerDocumentNumber,
        bookingId: document.bookingId,
        internalAgorot: document.amountAgorot,
        providerAgorot: 0,
        deltaAgorot: document.amountAgorot,
        message:
          `רשום אצלנו מסמך שהופק על ${formatAgorot(document.amountAgorot)} ` +
          'אך אין לו מזהה אצל הספק, ולכן לא ניתן להתאים אותו.',
      })
      continue
    }

    const summary = byProviderId.get(document.providerDocumentId)
    if (!summary) {
      differences.push({
        kind: 'missing_at_provider',
        documentId: document.id,
        providerDocumentId: document.providerDocumentId,
        documentNumber: document.providerDocumentNumber,
        bookingId: document.bookingId,
        internalAgorot: document.amountAgorot,
        providerAgorot: 0,
        deltaAgorot: document.amountAgorot,
        message:
          `אצלנו רשום מסמך ${document.providerDocumentNumber ?? '—'} ` +
          'ואצל הספק אין מסמך תואם בתקופה הזו.',
      })
      continue
    }

    seen.add(summary.providerDocumentId)

    if (document.amountAgorot !== summary.amountAgorot) {
      differences.push({
        kind: 'amount_mismatch',
        documentId: document.id,
        providerDocumentId: summary.providerDocumentId,
        documentNumber: summary.providerDocumentNumber,
        bookingId: document.bookingId,
        internalAgorot: document.amountAgorot,
        providerAgorot: summary.amountAgorot,
        deltaAgorot: document.amountAgorot - summary.amountAgorot,
        message:
          `הסכום אצלנו הוא ${formatAgorot(document.amountAgorot)} ` +
          `ואצל הספק ${formatAgorot(summary.amountAgorot)}.`,
      })
      continue
    }

    // `credited` on our side and `issued` on theirs is not a mismatch: a
    // credit document is a second document, and the original stays in force —
    // the argument `finance/types.ts` makes about an issued invoice that has
    // been corrected. Only a genuine cancellation disagreement is reported.
    const providerCancelled = summary.status === 'cancelled'
    const weCancelled = document.status === 'cancelled'
    if (providerCancelled !== weCancelled) {
      differences.push({
        kind: 'status_mismatch',
        documentId: document.id,
        providerDocumentId: summary.providerDocumentId,
        documentNumber: summary.providerDocumentNumber,
        bookingId: document.bookingId,
        internalAgorot: document.amountAgorot,
        providerAgorot: summary.amountAgorot,
        deltaAgorot: 0,
        message: weCancelled
          ? `אצלנו המסמך ${summary.providerDocumentNumber} מבוטל ואצל הספק הוא בתוקף.`
          : `אצל הספק המסמך ${summary.providerDocumentNumber} מבוטל ואצלנו הוא בתוקף.`,
      })
      continue
    }

    matchedCount += 1
    matchedAgorot += document.amountAgorot
  }

  for (const summary of input.providerDocuments) {
    if (seen.has(summary.providerDocumentId)) continue
    differences.push({
      kind: 'missing_locally',
      documentId: null,
      providerDocumentId: summary.providerDocumentId,
      documentNumber: summary.providerDocumentNumber,
      bookingId: null,
      internalAgorot: 0,
      providerAgorot: summary.amountAgorot,
      deltaAgorot: -summary.amountAgorot,
      message:
        `אצל הספק קיים מסמך ${summary.providerDocumentNumber} על ` +
        `${formatAgorot(summary.amountAgorot)} שאין לו רישום אצלנו.`,
    })
  }

  return {
    from: input.from,
    to: input.to,
    provider: input.provider,
    matchedCount,
    matchedAgorot,
    notComparedCount,
    differences,
    differenceAgorot: sumAgorot(
      differences.map((difference) => Math.abs(difference.deltaAgorot)),
    ),
    balanced: differences.length === 0,
  }
}

/** A one-line Hebrew summary of a run, for the panel heading and the alert. */
export function describeFiscalReconciliation(
  report: FiscalReconciliationReport,
): string {
  if (report.balanced) {
    return (
      `ההשוואה הושלמה: ${report.matchedCount} מסמכים תואמים ` +
      `(${formatAgorot(report.matchedAgorot)}), ללא הפרשים.`
    )
  }
  return (
    `ההשוואה מצאה ${report.differences.length} הפרשים בסך ` +
    `${formatAgorot(report.differenceAgorot)}. ` +
    `${report.matchedCount} מסמכים תאמו במלואם.`
  )
}
