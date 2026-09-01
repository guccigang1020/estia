/**
 * The life of an order, and the two things that are never allowed to happen
 * to one.
 *
 *   1. **A total that is not the sum of its lines.** `orderTotalAgorot` is the
 *      only arithmetic in this module, and the database recomputes the same
 *      figure from the stored rows on every line write — see
 *      `tg_store_order_totals` in 0032. Nothing here re-derives a total from a
 *      rate, a percentage or a catalogue price.
 *
 *   2. **A silent edit to something a guest has been told.** From `confirmed`
 *      onward — `COMMITTED_STORE_ORDER_STATUSES` — a change is an amendment
 *      with its own row, its own reason and, where it costs more, the guest's
 *      consent. `tg_store_order_lines_frozen` refuses the UPDATE outright.
 *
 * ── Not every workflow uses every state ───────────────────────────────────
 *
 * `STORE_ORDER_STATUSES` is deliberately longer than most businesses will
 * use. A bottle of wine goes `pending → confirmed → completed`; a DJ goes
 * through approval, a provider request and a fulfilment window. The transition
 * table below permits both without forcing either, which is why it is a graph
 * rather than a sequence.
 */

import { BusinessRuleError } from '../errors'
import type { Agorot } from '../booking/types'
import {
  COMMITTED_STORE_ORDER_STATUSES,
  TERMINAL_STORE_ORDER_STATUSES,
  type StoreOrderStatus,
  type StorePaymentMode,
} from '../contracts/states'
import type { LineSnapshotDraft } from './snapshot'
import type { StoreOrder, StoreOrderAmendment, StoreSettings } from './types'

/* ---------------------------------------------------------- state machine -- */

/**
 * Which statuses may follow which.
 *
 * Read as data so that a transition nobody intended is impossible rather than
 * merely unlikely, and so the whole graph can be read in one screen. The
 * absences matter as much as the entries: nothing leads out of `completed`,
 * `cancelled` or `refunded`, and nothing leads back into `draft`.
 */
const TRANSITIONS: Readonly<
  Record<StoreOrderStatus, readonly StoreOrderStatus[]>
> = {
  // A cart that has not been sent. The guest's own working copy.
  draft: ['pending', 'cancelled'],
  // Sent. Which of the three it goes to next is the workflow's choice.
  pending: ['awaiting_approval', 'awaiting_payment', 'confirmed', 'cancelled'],
  awaiting_approval: ['awaiting_payment', 'confirmed', 'cancelled'],
  awaiting_payment: ['confirmed', 'cancelled'],
  // Committed from here on. A guest has been told something.
  confirmed: ['in_preparation', 'ready', 'fulfilled', 'cancelled'],
  in_preparation: ['ready', 'fulfilled', 'cancelled'],
  ready: ['fulfilled', 'cancelled'],
  fulfilled: ['completed', 'refunded'],
  completed: ['refunded'],
  cancelled: ['refunded'],
  refunded: [],
}

export function canTransition(
  from: StoreOrderStatus,
  to: StoreOrderStatus,
): boolean {
  return TRANSITIONS[from].includes(to)
}

export function isTerminal(status: StoreOrderStatus): boolean {
  return TERMINAL_STORE_ORDER_STATUSES.includes(status)
}

export function isCommitted(status: StoreOrderStatus): boolean {
  return COMMITTED_STORE_ORDER_STATUSES.includes(status)
}

/**
 * Refuse a transition the graph does not allow.
 *
 * Throws rather than returning false, because every caller is a domain rule
 * inside `defineOperation` and a rule that returns a boolean is a rule
 * somebody forgets to read.
 */
export function assertTransition(
  from: StoreOrderStatus,
  to: StoreOrderStatus,
): void {
  if (canTransition(from, to)) return

  throw new BusinessRuleError({
    code: 'store_order_invalid_transition',
    userMessage: isTerminal(from)
      ? 'ההזמנה הזו כבר סגורה, ולכן אי אפשר לשנות את מצבה.'
      : 'לא ניתן להעביר את ההזמנה למצב הזה מהמצב הנוכחי. רענן את הדף ונסה שוב.',
    message: `store order cannot move from '${from}' to '${to}'`,
    publicDetails: { from, to },
  })
}

/**
 * Where a freshly created order starts.
 *
 * Three inputs, in this order of authority: the product's own
 * `requiresApproval`, then the organization default, then the payment mode.
 * `approval_first` forces approval regardless, because that is what the words
 * mean and a business that chose it would be astonished to find an order
 * confirmed without one.
 */
export function initialStatusFor(input: {
  requiresApproval: boolean | null
  settings: Pick<StoreSettings, 'approvalRequiredDefault'>
  paymentMode: StorePaymentMode
}): StoreOrderStatus {
  if (input.paymentMode === 'approval_first') return 'awaiting_approval'

  const needsApproval =
    input.requiresApproval ?? input.settings.approvalRequiredDefault

  if (needsApproval) return 'awaiting_approval'
  if (input.paymentMode === 'pay_now') return 'awaiting_payment'
  return 'pending'
}

/* ------------------------------------------------------------------ money -- */

/**
 * The total. The sum of the lines, less the order discount, plus tax.
 *
 * The discount is clamped to the subtotal, so a total is never negative: an
 * order the business owes the guest money on is a refund, which is a different
 * act with a different grant, and dressing it as a negative order total would
 * hide it from every report that sums orders.
 */
export function orderTotalAgorot(input: {
  lines: readonly { lineTotalAgorot: Agorot }[]
  discountAgorot?: Agorot
  taxAgorot?: Agorot
}): {
  subtotalAgorot: Agorot
  discountAgorot: Agorot
  taxAgorot: Agorot
  totalAgorot: Agorot
} {
  const subtotal = input.lines.reduce(
    (sum, line) => sum + line.lineTotalAgorot,
    0,
  )
  const discount = Math.min(Math.max(0, input.discountAgorot ?? 0), subtotal)
  const tax = Math.max(0, input.taxAgorot ?? 0)

  return {
    subtotalAgorot: subtotal,
    discountAgorot: discount,
    taxAgorot: tax,
    totalAgorot: subtotal - discount + tax,
  }
}

/** The same, for a set of drafts that has not been written yet. */
export function draftOrderTotals(
  lines: readonly LineSnapshotDraft[],
  discountAgorot = 0,
) {
  return orderTotalAgorot({ lines, discountAgorot })
}

/* ------------------------------------------------------------- amendments -- */

export type AmendmentProposal = {
  kind:
    | 'quantity'
    | 'add_line'
    | 'remove_line'
    | 'date'
    | 'price'
    | 'guest_count'
    | 'cancel_line'
  beforeState: Record<string, unknown>
  afterState: Record<string, unknown>
  /** Signed. Positive means the guest owes more. */
  deltaAgorot: Agorot
  reason: string
}

/**
 * Turn a proposed change into an amendment row, with consent decided here and
 * not by the caller.
 *
 * `consentRequired` is derived from the delta rather than passed in, which is
 * the whole safety property: a screen cannot forget to ask. The database says
 * the same thing twice — `store_order_amendments_costlier_asks` refuses a
 * positive delta without the flag, and
 * `store_order_amendments_consent_required` refuses to apply one without the
 * consent.
 */
export function proposeAmendment(
  order: Pick<StoreOrder, 'id' | 'status'>,
  proposal: AmendmentProposal,
): Omit<StoreOrderAmendment, 'id' | 'createdAt'> {
  if (isTerminal(order.status)) {
    throw new BusinessRuleError({
      code: 'store_order_closed',
      userMessage: 'ההזמנה סגורה, ולכן אי אפשר לתקן אותה.',
      message: `cannot amend a store order in terminal status '${order.status}'`,
    })
  }

  if (proposal.reason.trim().length === 0) {
    throw new BusinessRuleError({
      code: 'store_amendment_reason_required',
      userMessage: 'תיקון של הזמנה שכבר אושרה דורש נימוק. כתוב בקצרה מה השתנה.',
      message: 'proposeAmendment was given a blank reason',
    })
  }

  const consentRequired = proposal.deltaAgorot > 0

  return {
    orderId: order.id,
    kind: proposal.kind,
    // A change that costs nothing more may be applied immediately; one that
    // costs more waits for the guest, in a state that says so.
    status: consentRequired ? 'awaiting_consent' : 'proposed',
    beforeState: proposal.beforeState,
    afterState: proposal.afterState,
    deltaAgorot: proposal.deltaAgorot,
    reason: proposal.reason.trim(),
    consentRequired,
    consentGivenAt: null,
    appliedAt: null,
  }
}

/** May this amendment be applied now? The consent rule, in one place. */
export function assertAmendable(
  amendment: Pick<
    StoreOrderAmendment,
    'consentRequired' | 'consentGivenAt' | 'status'
  >,
): void {
  if (amendment.status === 'applied') {
    throw new BusinessRuleError({
      code: 'store_amendment_already_applied',
      userMessage: 'התיקון הזה כבר בוצע.',
      message: 'assertAmendable called on an applied amendment',
    })
  }

  if (amendment.consentRequired && amendment.consentGivenAt === null) {
    throw new BusinessRuleError({
      code: 'store_amendment_awaiting_consent',
      userMessage:
        'התיקון מייקר את ההזמנה, ולכן הוא ממתין לאישור האורח. אחרי שיאשר אפשר יהיה להחיל אותו.',
      message: 'assertAmendable called before the guest consented',
    })
  }
}

/* ------------------------------------------------------------- fulfilment -- */

/**
 * Is this order overdue?
 *
 * The service moment, less the lead time that was PROMISED — the snapshot on
 * the line, never the catalogue's current figure. A product whose lead time
 * was shortened last week must not retroactively make March's orders look
 * punctual.
 */
export function isOverdue(input: {
  status: StoreOrderStatus
  requestedForDate: string | null
  now: Date
}): boolean {
  if (isTerminal(input.status)) return false
  if (input.status === 'fulfilled') return false
  if (!input.requestedForDate) return false

  const due = Date.parse(`${input.requestedForDate}T23:59:59Z`)
  if (Number.isNaN(due)) return false

  return input.now.getTime() > due
}

/**
 * What an order needs from a person right now.
 *
 * Returned as a small vocabulary rather than as a sentence, so the owner's
 * order list can group by it and the dashboard can count it. The Hebrew lives
 * in `labels.ts`.
 */
export type OrderAttention =
  | 'awaiting_approval'
  | 'awaiting_payment'
  | 'awaiting_provider'
  | 'overdue'
  | 'ready_to_fulfil'
  | 'none'

export function orderAttention(input: {
  status: StoreOrderStatus
  requestedForDate: string | null
  hasUnconfirmedProvider: boolean
  now: Date
}): OrderAttention {
  if (input.status === 'awaiting_approval') return 'awaiting_approval'
  if (input.status === 'awaiting_payment') return 'awaiting_payment'
  if (isOverdue(input)) return 'overdue'
  if (input.hasUnconfirmedProvider) return 'awaiting_provider'
  if (input.status === 'ready') return 'ready_to_fulfil'
  return 'none'
}
