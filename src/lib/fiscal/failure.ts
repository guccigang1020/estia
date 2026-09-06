/**
 * §148 — the payment succeeded and the fiscal provider did not.
 *
 * This is the most common failure in the whole capability and it is not an
 * error condition: money arriving and a vendor issuing a document are two
 * network calls to two companies, and the second one fails on an ordinary
 * Tuesday. What must never happen is that the first one is affected.
 *
 * ══ THE RULE THIS FILE EXISTS TO MAKE STRUCTURAL ═══════════════════════════
 *
 *   A PAYMENT MUST NEVER RENDER AS FISCALLY COMPLETE WHEN IT IS NOT.
 *
 * Not "we are careful about that". The type system refuses it:
 * `FiscalSide` is a discriminated union whose `issued` member **requires**
 * `documentNumber: string`. There is no way to construct the issued case
 * without a number a vendor actually supplied — no default, no empty string
 * that TypeScript would accept as "issued enough". A `FiscalDocument` row
 * carrying `status: 'issued'` and `providerDocumentNumber: null` is a
 * contradiction, and `describeSettlement` resolves it the honest way: it
 * reports `needs_review`, not `issued`. A row like that means somebody's
 * adapter wrote a status without the fact that justifies it, and a screen
 * quietly printing "הופק" over it is how a business tells its accountant a
 * document exists that does not.
 *
 * ══ TWO SIDES, NEVER ONE STATUS ════════════════════════════════════════════
 *
 * `describeSettlement` returns `money` and `fiscal` as separate values and
 * offers no combined status field. That absence is the design. A single
 * `settlementStatus` would need a value for "paid but no document", and
 * whatever that value were called, some list somewhere would group it with
 * either the paid rows or the unpaid ones — and both groupings are wrong. The
 * money is in the bank; the paperwork is not done.
 *
 * `headline` composes the two into the sentence the UI prints —
 * "תשלום נרשם · מסמך חשבונאי ממתין" — with a separator, because a person reads
 * one line and the line has to contain both facts.
 */

import type { Agorot } from '../booking/types'
import {
  SETTLED_PAYMENT_STATUSES,
  type PaymentStatus,
} from '../contracts/states'
import {
  FISCAL_REFUSAL_CODES,
  isRetryableRefusal,
  type FiscalRefusalCode,
} from './provider'
import type { FiscalDocument } from './types'

// ── The money side ────────────────────────────────────────────────────────

/**
 * What is known about the money, and nothing about paperwork.
 *
 * Deliberately a projection of `Payment` rather than the record itself: this
 * function must be callable from a list screen that has four columns, not a
 * fully hydrated payment with its applied event ids. The three fields are the
 * ones `settledAgorot` and the status are built from.
 */
export interface PaymentFiscalFacts {
  paymentId: string
  status: PaymentStatus
  capturedAgorot: Agorot
  refundedAgorot: Agorot
}

export type MoneySide =
  | { state: 'not_received' }
  | { state: 'received'; netAgorot: Agorot }
  | { state: 'refunded'; netAgorot: Agorot }
  /** The processor did not answer. Never counted as either. */
  | { state: 'unknown' }

/**
 * The money, read only from the payment.
 *
 * Nothing about the fiscal document reaches this function, which is why it can
 * be trusted: a fiscal failure cannot change what it returns.
 */
export function moneySideOf(facts: PaymentFiscalFacts): MoneySide {
  if (facts.status === 'unknown') return { state: 'unknown' }

  const net = facts.capturedAgorot - facts.refundedAgorot

  if (facts.status === 'refunded' || (net <= 0 && facts.refundedAgorot > 0)) {
    return { state: 'refunded', netAgorot: net }
  }
  if (SETTLED_PAYMENT_STATUSES.includes(facts.status) && net > 0) {
    return { state: 'received', netAgorot: net }
  }
  return { state: 'not_received' }
}

// ── The fiscal side ───────────────────────────────────────────────────────

/**
 * Where the accounting document stands.
 *
 * The `issued` member is the whole point. It carries `documentNumber: string`,
 * non-nullable, so no caller — including a future one written in a hurry — can
 * assemble a "document is done" value out of a row that has no number.
 */
export type FiscalSide =
  /** This payment is not expected to produce a document at all. */
  | { state: 'not_required'; reason: string }
  /** Asked for, no answer yet. Time is the only thing missing. */
  | { state: 'pending'; since: Date }
  /** Failed, and the queue will try again on its own. */
  | {
      state: 'retrying'
      attempts: number
      nextRetryAt: Date | null
      reason: string
    }
  /** Failed or refused, and no automation will fix it. A person must act. */
  | { state: 'needs_review'; code: string; reason: string }
  /**
   * The vendor did not answer. A document may exist that ESTIA cannot see.
   * Never retried automatically: see `types.ts`.
   */
  | { state: 'unknown'; reason: string }
  | {
      state: 'issued'
      documentNumber: string
      issueDate: string | null
      documentUrl: string | null
    }
  | { state: 'cancelled'; documentNumber: string }
  | { state: 'credited'; documentNumber: string }

/**
 * The row's own account of itself, turned into the state a screen may print.
 *
 * `document` is `null` when nothing has ever been requested — a payment with
 * no fiscal document row at all. That is `pending` when the organization
 * expects documents and `not_required` when it does not, and the caller says
 * which by passing `expected`.
 */
export function fiscalSideOf(args: {
  document: FiscalDocument | null
  /** Does this organization expect an accounting document for this payment? */
  expected: boolean
  now: Date
}): FiscalSide {
  const { document, expected, now } = args

  if (document === null) {
    if (!expected) {
      return {
        state: 'not_required',
        reason: 'לא נדרש מסמך חשבונאי עבור תשלום זה.',
      }
    }
    return { state: 'pending', since: now }
  }

  switch (document.status) {
    case 'pending':
      return {
        state: 'pending',
        since: document.lastAttemptAt ?? document.createdAt,
      }

    case 'issued':
    case 'cancelled':
    case 'credited':
      return settledSide(document)

    case 'unknown':
      return {
        state: 'unknown',
        reason:
          document.failure?.reason ??
          'ספק המסמכים לא השיב, ולכן לא ידוע אם הופק מסמך. יש לבדוק מולו לפני ניסיון נוסף.',
      }

    case 'refused':
      return refusedSide(document)

    case 'failed':
      // A retry that is actually scheduled is `retrying`; a failure with
      // nothing scheduled is a failure nobody is working, and saying
      // "retrying" over it would be a promise the product does not keep.
      if (document.nextRetryAt !== null) {
        return {
          state: 'retrying',
          attempts: document.attemptCount,
          nextRetryAt: document.nextRetryAt,
          reason:
            document.failure?.reason ?? 'הפקת המסמך נכשלה. המערכת תנסה שוב.',
        }
      }
      return {
        state: 'needs_review',
        code: document.failure?.code ?? 'failed',
        reason:
          document.failure?.reason ??
          'הפקת המסמך נכשלה ואין ניסיון נוסף מתוזמן.',
      }
  }
}

/**
 * An `issued`, `cancelled` or `credited` row — but only if it has a number.
 *
 * A row claiming one of those three statuses with `providerDocumentNumber:
 * null` is downgraded to `needs_review`. It is the single most important
 * branch in the file: it is what makes "cannot render as complete when it is
 * not" true against bad *data*, not only against bad calling code.
 */
function settledSide(document: FiscalDocument): FiscalSide {
  const number = document.providerDocumentNumber

  if (number === null || number.trim() === '') {
    return {
      state: 'needs_review',
      code: 'issued_without_number',
      reason:
        'המסמך מסומן כהופק אך לא התקבל ממנו מספר מסמך מהספק. ' +
        'עד לבירור מול הספק אין להתייחס אליו כמסמך שהופק.',
    }
  }

  if (document.status === 'cancelled') {
    return { state: 'cancelled', documentNumber: number }
  }
  if (document.status === 'credited') {
    return { state: 'credited', documentNumber: number }
  }
  return {
    state: 'issued',
    documentNumber: number,
    issueDate: document.issueDate,
    documentUrl: document.documentUrl,
  }
}

function refusedSide(document: FiscalDocument): FiscalSide {
  const code = document.failure?.code ?? 'refused'
  const reason = document.failure?.reason ?? 'ספק המסמכים סירב להפיק את המסמך.'

  if (isKnownRefusalCode(code) && isRetryableRefusal(code)) {
    return {
      state: 'retrying',
      attempts: document.attemptCount,
      nextRetryAt: document.nextRetryAt,
      reason,
    }
  }
  return { state: 'needs_review', code, reason }
}

function isKnownRefusalCode(code: string): code is FiscalRefusalCode {
  return (FISCAL_REFUSAL_CODES as readonly string[]).includes(code)
}

// ── The pair ──────────────────────────────────────────────────────────────

export interface SettlementView {
  paymentId: string
  money: MoneySide
  fiscal: FiscalSide
  /** The one line a list prints. Both facts, separated, never merged. */
  headline: string
  /** A person has to do something about this row. */
  needsPerson: boolean
}

const MONEY_LABEL: Record<MoneySide['state'], string> = {
  not_received: 'תשלום טרם נרשם',
  received: 'תשלום נרשם',
  refunded: 'תשלום הוחזר',
  unknown: 'תשלום במצב לא ידוע',
}

const FISCAL_LABEL: Record<FiscalSide['state'], string> = {
  not_required: 'לא נדרש מסמך חשבונאי',
  pending: 'מסמך חשבונאי ממתין',
  retrying: 'מסמך חשבונאי — ניסיון חוזר',
  needs_review: 'מסמך חשבונאי נכשל — נדרשת בדיקה',
  unknown: 'מסמך חשבונאי במצב לא ידוע',
  issued: 'מסמך חשבונאי הופק',
  cancelled: 'מסמך חשבונאי בוטל',
  credited: 'מסמך חשבונאי זוכה',
}

export function moneyLabel(side: MoneySide): string {
  return MONEY_LABEL[side.state]
}

export function fiscalLabel(side: FiscalSide): string {
  return FISCAL_LABEL[side.state]
}

/**
 * The two sides of one payment, described together and kept apart.
 *
 * The §148 sentence — "תשלום נרשם · מסמך חשבונאי ממתין" — falls out of this
 * without a special case, because it is simply what the two labels say when
 * the money arrived and the paperwork did not.
 */
export function describeSettlement(args: {
  payment: PaymentFiscalFacts
  document: FiscalDocument | null
  expected: boolean
  now: Date
}): SettlementView {
  const money = moneySideOf(args.payment)
  const fiscal = fiscalSideOf({
    document: args.document,
    expected: args.expected,
    now: args.now,
  })

  return {
    paymentId: args.payment.paymentId,
    money,
    fiscal,
    headline: `${moneyLabel(money)} · ${fiscalLabel(fiscal)}`,
    needsPerson:
      money.state === 'unknown' ||
      fiscal.state === 'needs_review' ||
      fiscal.state === 'unknown',
  }
}

/**
 * The only permitted answer to "is the paperwork done for this payment?"
 *
 * A predicate over the union rather than a boolean stored on a record. A
 * stored flag can be written wrong once and then read a thousand times; this
 * is recomputed from the state every time it is asked, and the only state that
 * satisfies it is one that carries a vendor's document number.
 */
export function isFiscallyComplete(view: SettlementView): boolean {
  return view.fiscal.state === 'issued'
}

/**
 * The §148 pair, named: money in, paperwork outstanding.
 *
 * Its own predicate because it is the state the queue is built around and the
 * one a business asks about by name. `not_required` is deliberately excluded —
 * an organization that issues no documents has nothing outstanding.
 */
export function isPaidAndFiscallyPending(view: SettlementView): boolean {
  if (view.money.state !== 'received') return false
  return (
    view.fiscal.state === 'pending' ||
    view.fiscal.state === 'retrying' ||
    view.fiscal.state === 'needs_review' ||
    view.fiscal.state === 'unknown'
  )
}
