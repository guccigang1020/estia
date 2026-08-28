/**
 * Payments — creating them, moving them, and surviving the provider.
 *
 * The state machine next door decides what is legal. This file decides what
 * the outside world's messages *mean*, which is the harder half. Three rules
 * govern all of it:
 *
 * **A webhook carries totals, not deltas.** `captured: 40000` means "this
 * transaction has now captured ₪400 in all", not "capture another ₪400".
 * Every real processor can be adapted to that reading, and it is the only one
 * that survives redelivery and reordering: applying a total twice is a no-op,
 * applying a delta twice is a double charge. Where a provider genuinely only
 * emits deltas, the adapter accumulates and this domain never learns about it.
 *
 * **Every provider message is identified and time-stamped by the provider.**
 * `eventId` makes a redelivery recognisable; `occurredAt` makes an out-of-order
 * delivery recognisable. Both are recorded on the payment — `appliedEventIds`
 * and `lastProviderEventAt` — because the question "have I already seen this"
 * must be answerable in the same read that loads the record it would change.
 * A separate table would be a second source of truth with its own race.
 *
 * **`unknown` is never resolved by guessing.** A payment that timed out leaves
 * `unknown` only through `resolveUnknownPayment`, which takes the provider's
 * own record of the transaction as evidence. There is deliberately no path
 * from `unknown` back to `pending`: retrying a payment that may already have
 * gone through is the double charge the whole design exists to prevent.
 *
 * Nothing here mutates. Every function returns a new payment, so an operation
 * can decide whether to write it, and a test can assert on both the before and
 * the after.
 */

import { addDays } from '../booking/dates'
import type { Agorot } from '../booking/types'
import type { Actor } from '../authz/can'
import type { DomainEventName } from '../contracts/events'
import type { PaymentMethod, PaymentStatus } from '../contracts/states'
import { BusinessRuleError } from '../errors'
import { allocateEvenly, assertSumsExactly, CURRENCY, sumAgorot } from './money'
import {
  assertPaymentTransition,
  paymentEventFor,
  type PaymentAnomaly,
  type PaymentTransition,
} from './payment-state-machine'
import type {
  ProviderResult,
  ProviderTransaction,
  ProviderWebhookEvent,
} from './provider'
import {
  settledAgorot,
  type CollectionChannel,
  type InstalmentCadence,
  type Payment,
  type PaymentAmounts,
  type PaymentAttention,
  type Deposit,
  type PaymentPurpose,
  type PaymentSchedule,
  type ScheduledInstalment,
} from './types'

// ── Creation ──────────────────────────────────────────────────────────────

export interface PaymentDraft {
  id: string
  organizationId: string
  propertyId?: string | null
  bookingId: string
  purpose: PaymentPurpose
  method: PaymentMethod
  channel: CollectionChannel
  amountAgorot: Agorot
  providerId?: string | null
  scheduleId?: string | null
  instalmentNumber?: number | null
  dueOn?: string | null
  createdByUserId?: string | null
}

/**
 * A payment that has been asked for and not yet answered.
 *
 * Born `pending` with every amount at zero, including its own. A record that
 * started life claiming to have captured something would make the very first
 * assertion in this module — that `capturedAgorot` is the only basis for a
 * refund — untrue before anybody touched it.
 */
export function createPayment(draft: PaymentDraft, now: Date): Payment {
  if (!Number.isInteger(draft.amountAgorot) || draft.amountAgorot <= 0) {
    throw new BusinessRuleError({
      code: 'finance.invalid_amount',
      userMessage: 'סכום התשלום חייב להיות מספר שלם של אגורות, וגדול מאפס.',
      message: `Refusing to create a payment for ${draft.amountAgorot} agorot`,
    })
  }

  return {
    id: draft.id,
    organizationId: draft.organizationId,
    propertyId: draft.propertyId ?? null,
    bookingId: draft.bookingId,
    purpose: draft.purpose,
    method: draft.method,
    channel: draft.channel,
    status: 'pending',
    currency: CURRENCY,
    amountAgorot: draft.amountAgorot,
    authorizedAgorot: 0,
    capturedAgorot: 0,
    refundedAgorot: 0,
    providerId: draft.providerId ?? null,
    providerRef: null,
    scheduleId: draft.scheduleId ?? null,
    instalmentNumber: draft.instalmentNumber ?? null,
    dueOn: draft.dueOn ?? null,
    appliedEventIds: [],
    lastProviderEventAt: null,
    requiresAttention: null,
    unknownSince: null,
    createdAt: now,
    updatedAt: now,
    createdByUserId: draft.createdByUserId ?? null,
    version: 1,
  }
}

// ── Moving a payment ──────────────────────────────────────────────────────

export interface PaymentChange {
  payment: Payment
  transition: PaymentTransition
  /** The catalogue event to publish, or `null` where there is none yet. */
  event: DomainEventName | null
  anomaly: PaymentAnomaly | null
}

export interface MoveOptions {
  now: Date
  providerRef?: string | null
  /** The provider event that caused the move, recorded against the payment. */
  eventId?: string | null
  attention?: PaymentAttention | null
}

/**
 * The status a set of amounts implies.
 *
 * Read top down: refunds outrank captures, captures outrank authorisations.
 * The statuses that are *not* implied by money — `failed`, `cancelled`,
 * `unknown`, `pending` — are absent on purpose. They are statements about what
 * the provider said, not about what the balances are, so a caller has to name
 * them explicitly rather than have them inferred from an absence.
 */
export function deriveStatusFromAmounts(
  amounts: PaymentAmounts,
  current: PaymentStatus,
): PaymentStatus {
  const { amountAgorot, authorizedAgorot, capturedAgorot, refundedAgorot } =
    amounts

  if (capturedAgorot > 0 && refundedAgorot >= capturedAgorot) return 'refunded'
  if (refundedAgorot > 0) return 'partially_refunded'
  if (capturedAgorot >= amountAgorot && capturedAgorot > 0) return 'paid'
  if (capturedAgorot > 0) return 'partially_paid'
  if (authorizedAgorot > 0) return 'authorized'
  return current
}

/**
 * Apply a move through the machine.
 *
 * The amounts are validated by the transition's conditions *before* anything
 * is written, which is why they are passed as `next` rather than applied and
 * then checked. An over-refund is refused here, with the money untouched.
 */
export function movePaymentTo(
  actor: Actor,
  payment: Payment,
  to: PaymentStatus,
  next: PaymentAmounts,
  options: MoveOptions,
): PaymentChange {
  const transition = assertPaymentTransition(actor, to, {
    payment,
    next,
    now: options.now,
  })

  const overpaid = next.capturedAgorot > next.amountAgorot
  const anomaly: PaymentAnomaly | null =
    transition.anomaly ?? (overpaid ? 'captured_more_than_requested' : null)

  const attention: PaymentAttention | null =
    options.attention !== undefined
      ? options.attention
      : attentionFor(transition, overpaid, payment.requiresAttention)

  const moved: Payment = {
    ...payment,
    ...next,
    status: to,
    providerRef: options.providerRef ?? payment.providerRef,
    appliedEventIds: withEventId(payment.appliedEventIds, options.eventId),
    lastProviderEventAt: payment.lastProviderEventAt,
    requiresAttention: attention,
    unknownSince:
      to === 'unknown' ? (payment.unknownSince ?? options.now) : null,
    updatedAt: options.now,
    version: payment.version + 1,
  }

  return {
    payment: moved,
    transition,
    event: paymentEventFor(transition, moved),
    anomaly,
  }
}

/**
 * Attention is sticky.
 *
 * A flag raised because money arrived for a cancelled booking is not cleared
 * by the next ordinary event; only a person closing the loop clears it, by
 * passing `attention: null` explicitly. Automation that could clear its own
 * alarms is automation whose alarms mean nothing.
 */
function attentionFor(
  transition: PaymentTransition,
  overpaid: boolean,
  current: PaymentAttention | null,
): PaymentAttention | null {
  if (transition.anomaly === 'payment_after_cancellation') {
    return 'refund_after_cancellation'
  }
  if (transition.to === 'unknown') return 'reconcile_unknown'
  if (overpaid) return 'overpaid'
  return current
}

function withEventId(
  applied: readonly string[],
  eventId: string | null | undefined,
): readonly string[] {
  if (!eventId || applied.includes(eventId)) return applied
  return [...applied, eventId]
}

function sameAmounts(a: PaymentAmounts, b: PaymentAmounts): boolean {
  return (
    a.amountAgorot === b.amountAgorot &&
    a.authorizedAgorot === b.authorizedAgorot &&
    a.capturedAgorot === b.capturedAgorot &&
    a.refundedAgorot === b.refundedAgorot
  )
}

function amountsOf(payment: Payment): PaymentAmounts {
  return {
    amountAgorot: payment.amountAgorot,
    authorizedAgorot: payment.authorizedAgorot,
    capturedAgorot: payment.capturedAgorot,
    refundedAgorot: payment.refundedAgorot,
  }
}

// ── Provider results ──────────────────────────────────────────────────────

export type ProviderCallKind = 'authorize' | 'capture' | 'refund' | 'void'

/**
 * Turn a synchronous provider answer into a move.
 *
 * The `unknown` branch is the one worth reading. Nothing about the amounts
 * changes — we do not know what they are — the status becomes `unknown`, the
 * clock starts on `unknownSince`, and the payment joins the reconciliation
 * queue. It is emphatically not `failed`, which would invite the retry that
 * charges the card a second time.
 */
export function applyProviderResult(
  actor: Actor,
  payment: Payment,
  kind: ProviderCallKind,
  result: ProviderResult,
  now: Date,
): PaymentChange {
  const current = amountsOf(payment)

  if (result.outcome === 'unknown') {
    return movePaymentTo(actor, payment, 'unknown', current, {
      now,
      providerRef: result.providerRef,
      attention: 'reconcile_unknown',
    })
  }

  if (result.outcome === 'failed') {
    return movePaymentTo(actor, payment, 'failed', current, {
      now,
      providerRef: result.providerRef,
    })
  }

  switch (kind) {
    case 'authorize': {
      const next: PaymentAmounts = {
        ...current,
        authorizedAgorot: result.amountAgorot,
      }
      return movePaymentTo(actor, payment, 'authorized', next, {
        now,
        providerRef: result.providerRef,
      })
    }
    case 'capture': {
      const next: PaymentAmounts = {
        ...current,
        capturedAgorot: current.capturedAgorot + result.amountAgorot,
        authorizedAgorot: Math.max(
          0,
          current.authorizedAgorot - result.amountAgorot,
        ),
      }
      return movePaymentTo(
        actor,
        payment,
        deriveStatusFromAmounts(next, payment.status),
        next,
        { now, providerRef: result.providerRef },
      )
    }
    case 'refund': {
      const next: PaymentAmounts = {
        ...current,
        refundedAgorot: current.refundedAgorot + result.amountAgorot,
      }
      return movePaymentTo(
        actor,
        payment,
        deriveStatusFromAmounts(next, payment.status),
        next,
        { now, providerRef: result.providerRef },
      )
    }
    case 'void': {
      const next: PaymentAmounts = { ...current, authorizedAgorot: 0 }
      return movePaymentTo(actor, payment, 'cancelled', next, {
        now,
        providerRef: result.providerRef,
      })
    }
    default: {
      // Deny by default: an unrecognised call kind changes nothing.
      throw new BusinessRuleError({
        code: 'finance.unknown_provider_call',
        userMessage: 'אירעה תקלה בעיבוד התשלום. פנה לתמיכה.',
        message: `Unrecognised provider call kind: ${String(kind)}`,
      })
    }
  }
}

// ── Webhooks ──────────────────────────────────────────────────────────────

export type WebhookOutcome =
  /** The payment moved. */
  | 'applied'
  /** Seen before. Nothing happened, and nothing should have. */
  | 'duplicate'
  /** Older than what has already been applied. Recorded, not applied. */
  | 'stale'
  /** About a different transaction. Never applied to this payment. */
  | 'mismatched_reference'
  /** Legal to receive, but implies no change to this payment. */
  | 'ignored'

export interface WebhookApplication {
  outcome: WebhookOutcome
  payment: Payment
  transition: PaymentTransition | null
  event: DomainEventName | null
  anomaly: PaymentAnomaly | null
  /** Hebrew, for the operator, when nothing was applied. */
  note: string | null
}

/**
 * Apply one verified provider event.
 *
 * The order of the guards is the design:
 *
 *   1. **Reference.** An event about another transaction never touches this
 *      payment, however plausible its contents.
 *   2. **Duplicate.** An `eventId` already applied is a no-op. This is what
 *      stops a redelivered refund from refunding twice — and it is checked
 *      before staleness, because a redelivery of the newest event is not
 *      stale, it is a duplicate.
 *   3. **Staleness.** An event the provider says happened *before* the newest
 *      one we have applied is recorded — so a third delivery of it is a
 *      duplicate rather than a fresh reordering — and is not applied. A
 *      `captured` arriving after a `refunded` must not un-refund the payment.
 *
 * Only then is the event interpreted, and interpretation is total: amounts are
 * absolute, so applying the newest event is always sufficient.
 */
export function applyWebhook(
  actor: Actor,
  payment: Payment,
  event: ProviderWebhookEvent,
  now: Date,
): WebhookApplication {
  const unchanged = (
    outcome: WebhookOutcome,
    note: string,
    next: Payment = payment,
  ): WebhookApplication => ({
    outcome,
    payment: next,
    transition: null,
    event: null,
    anomaly: null,
    note,
  })

  if (
    payment.providerRef !== null &&
    payment.providerRef !== event.providerRef
  ) {
    return unchanged(
      'mismatched_reference',
      'ההודעה מחברת הסליקה מתייחסת לעסקה אחרת ולכן לא הוחלה.',
    )
  }

  if (payment.appliedEventIds.includes(event.eventId)) {
    return unchanged('duplicate', 'ההודעה הזו כבר טופלה. לא בוצעה פעולה נוספת.')
  }

  if (
    payment.lastProviderEventAt !== null &&
    event.occurredAt < payment.lastProviderEventAt
  ) {
    // Recorded but not applied: a later redelivery of the same stale event
    // must be recognisable as a duplicate rather than looking new again.
    return unchanged(
      'stale',
      'ההודעה ישנה יותר מהמצב הידוע של התשלום ולכן נרשמה בלבד.',
      {
        ...payment,
        appliedEventIds: withEventId(payment.appliedEventIds, event.eventId),
        updatedAt: now,
        version: payment.version + 1,
      },
    )
  }

  const current = amountsOf(payment)
  let next: PaymentAmounts = current
  let target: PaymentStatus

  switch (event.type) {
    case 'authorized':
      next = { ...current, authorizedAgorot: event.amountAgorot }
      target = 'authorized'
      break
    case 'captured':
      next = {
        ...current,
        capturedAgorot: event.amountAgorot,
        authorizedAgorot: 0,
      }
      target = deriveStatusFromAmounts(next, payment.status)
      break
    case 'partially_captured':
      next = {
        ...current,
        capturedAgorot: event.amountAgorot,
        authorizedAgorot: Math.max(
          0,
          current.authorizedAgorot - event.amountAgorot,
        ),
      }
      target = deriveStatusFromAmounts(next, payment.status)
      break
    case 'refunded':
    case 'partially_refunded':
      next = { ...current, refundedAgorot: event.amountAgorot }
      target = deriveStatusFromAmounts(next, payment.status)
      break
    case 'chargeback':
      // The bank took the money back without anyone asking. It is a refund in
      // every respect that matters to the ledger, and it is capped at what was
      // captured so the balance cannot go negative.
      next = {
        ...current,
        refundedAgorot: Math.min(
          current.capturedAgorot,
          current.refundedAgorot + event.amountAgorot,
        ),
      }
      target = deriveStatusFromAmounts(next, payment.status)
      break
    case 'failed':
      target = 'failed'
      break
    case 'voided':
      next = { ...current, authorizedAgorot: 0 }
      target = 'cancelled'
      break
    default:
      return unchanged(
        'ignored',
        'סוג ההודעה מחברת הסליקה אינו משפיע על התשלום.',
      )
  }

  // Compared by **value**, not by identity. Because webhook amounts are
  // totals, a provider that redelivers the same state under a new event id —
  // which they do, routinely, after a reconnect — produces amounts that are
  // equal to the ones already stored but held in a fresh object. Comparing
  // references would send that through the state machine, which would refuse
  // it as a move to the status the payment is already in, and a harmless
  // duplicate would surface to an operator as a business rule violation.
  if (target === payment.status && sameAmounts(next, current)) {
    return unchanged('ignored', 'ההודעה אינה משנה את מצב התשלום.', {
      ...payment,
      appliedEventIds: withEventId(payment.appliedEventIds, event.eventId),
      lastProviderEventAt: event.occurredAt,
      updatedAt: now,
      version: payment.version + 1,
    })
  }

  const change = movePaymentTo(actor, payment, target, next, {
    now,
    providerRef: event.providerRef,
    eventId: event.eventId,
  })

  return {
    outcome: 'applied',
    payment: { ...change.payment, lastProviderEventAt: event.occurredAt },
    transition: change.transition,
    event: change.event,
    anomaly: change.anomaly,
    note: null,
  }
}

// ── Reconciling the unknown ───────────────────────────────────────────────

/**
 * Close out a payment whose outcome was never learned.
 *
 * Takes the provider's own record as the evidence, which is the only thing
 * that settles it. `null` means the provider has no such transaction: the
 * charge never happened, and the payment is `cancelled` rather than `failed` —
 * nothing was attempted successfully enough to have failed.
 */
export function resolveUnknownPayment(
  actor: Actor,
  payment: Payment,
  truth: ProviderTransaction | null,
  now: Date,
): PaymentChange {
  if (payment.status !== 'unknown') {
    throw new BusinessRuleError({
      code: 'finance.payment_not_unknown',
      userMessage:
        'התשלום אינו במצב "לא ידוע" ולכן אין מה ליישב מול חברת הסליקה.',
      message: `resolveUnknownPayment called on status ${payment.status}`,
    })
  }

  const current = amountsOf(payment)

  if (truth === null) {
    return movePaymentTo(actor, payment, 'cancelled', current, {
      now,
      attention: null,
    })
  }

  const next: PaymentAmounts = {
    ...current,
    capturedAgorot: truth.capturedAgorot,
    refundedAgorot: truth.refundedAgorot,
    authorizedAgorot: 0,
  }

  const target =
    truth.capturedAgorot === 0
      ? 'failed'
      : deriveStatusFromAmounts(next, payment.status)

  return movePaymentTo(actor, payment, target, next, {
    now,
    providerRef: truth.providerRef,
    attention: null,
  })
}

// ── Instalments ───────────────────────────────────────────────────────────

export interface InstalmentPlanRequest {
  scheduleId: string
  organizationId: string
  bookingId: string
  totalAgorot: Agorot
  /** How many payments in all, including the deposit when there is one. */
  count: number
  /** The date the first payment falls due. */
  firstDueOn: string
  cadence: InstalmentCadence
  /** Taken first, off the top. The rest is split evenly over `count - 1`. */
  depositAgorot?: Agorot
}

/**
 * Split a total into instalments that add back to it exactly.
 *
 * The deposit comes off the top and the remainder is split by
 * `allocateEvenly`, so a ₪1,000 stay with a ₪300 deposit over three payments
 * is 300 + 350 + 350, and a ₪1,000 stay over three payments is
 * 333.34 + 333.33 + 333.33. Never three times ₪333.33 with an agora quietly
 * discarded — the guest's payments must add to the guest's bill.
 */
export function planInstalments(
  request: InstalmentPlanRequest,
): PaymentSchedule {
  const { totalAgorot, count, depositAgorot = 0 } = request

  if (!Number.isInteger(count) || count < 1) {
    throw new BusinessRuleError({
      code: 'finance.invalid_instalment_count',
      userMessage: 'מספר התשלומים חייב להיות מספר שלם וגדול מאפס.',
      message: `Invalid instalment count: ${count}`,
    })
  }
  if (depositAgorot < 0 || depositAgorot > totalAgorot) {
    throw new BusinessRuleError({
      code: 'finance.invalid_deposit',
      userMessage: 'המקדמה חייבת להיות בין אפס לסכום המלא של ההזמנה.',
      message: `Invalid deposit ${depositAgorot} of ${totalAgorot}`,
    })
  }
  if (depositAgorot > 0 && count < 2) {
    throw new BusinessRuleError({
      code: 'finance.deposit_needs_balance',
      userMessage: 'תשלום עם מקדמה מחייב לפחות שני תשלומים — המקדמה והיתרה.',
      message: 'A deposit requires at least two instalments',
    })
  }

  const withDeposit = depositAgorot > 0
  const remainingCount = withDeposit ? count - 1 : count
  const remainder = totalAgorot - depositAgorot
  const parts = allocateEvenly(remainder, remainingCount)

  const amounts: Agorot[] = withDeposit ? [depositAgorot, ...parts] : parts
  assertSumsExactly('planInstalments', amounts, totalAgorot)

  const instalments: ScheduledInstalment[] = amounts.map((amount, index) => ({
    instalmentNumber: index + 1,
    amountAgorot: amount,
    dueOn: dueDate(request.firstDueOn, request.cadence, index),
    purpose:
      withDeposit && index === 0
        ? 'deposit'
        : index === amounts.length - 1 && amounts.length > 1
          ? 'balance'
          : 'instalment',
  }))

  return {
    id: request.scheduleId,
    organizationId: request.organizationId,
    bookingId: request.bookingId,
    totalAgorot,
    instalments,
  }
}

/**
 * The nth due date.
 *
 * Monthly steps clamp to the end of the month, so a plan starting on the 31st
 * falls due on the 28th of February rather than silently landing in March and
 * shifting every later instalment with it.
 */
function dueDate(
  firstDueOn: string,
  cadence: InstalmentCadence,
  step: number,
): string {
  if (step === 0) return firstDueOn
  if (cadence === 'weekly') return addDays(firstDueOn, step * 7)

  const [year, month, day] = firstDueOn.split('-').map(Number)
  const targetMonthIndex = month - 1 + step
  const targetYear = year + Math.floor(targetMonthIndex / 12)
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate()
  const clamped = Math.min(day, lastDay)

  return [
    String(targetYear).padStart(4, '0'),
    String(targetMonth + 1).padStart(2, '0'),
    String(clamped).padStart(2, '0'),
  ].join('-')
}

// ── Balance ───────────────────────────────────────────────────────────────

export interface BookingBalance {
  /** What the booking's finance snapshot says the guest owes in all. */
  billedAgorot: Agorot
  capturedAgorot: Agorot
  refundedAgorot: Agorot
  /** Captured less refunded. What the business is actually holding. */
  settledAgorot: Agorot
  /** Billed less settled. Never reduced by money in an undecided state. */
  outstandingAgorot: Agorot
  /** Reserved on a card and not taken — a live security deposit. */
  depositHeldAgorot: Agorot
  /**
   * Money whose fate the provider never told us.
   *
   * Reported separately and counted as neither paid nor outstanding, because
   * it is genuinely neither. A screen that folded it into "outstanding" would
   * invite a second charge; folding it into "paid" would invite a check-in on
   * money that never arrived.
   */
  unknownAgorot: Agorot
}

/**
 * What a booking owes, and what is in flight.
 *
 * The deposit is passed in rather than derived from the payments, because it
 * is its own record — see `deposits.ts`. Deriving it here would mean two
 * places in the product could answer "how much of the guest's money are we
 * holding", and the booking state machine refuses to complete a stay on the
 * strength of that number. It must have exactly one source.
 */
export function bookingBalance(
  billedAgorot: Agorot,
  payments: readonly Payment[],
  deposit?: Deposit | null,
): BookingBalance {
  const captured = sumAgorot(payments.map((p) => p.capturedAgorot))
  const refunded = sumAgorot(payments.map((p) => p.refundedAgorot))
  const settled = sumAgorot(payments.map(settledAgorot))

  const depositHeld =
    deposit == null
      ? 0
      : deposit.heldAgorot - deposit.releasedAgorot - deposit.forfeitedAgorot
  const unknown = sumAgorot(
    payments.filter((p) => p.status === 'unknown').map((p) => p.amountAgorot),
  )

  return {
    billedAgorot,
    capturedAgorot: captured,
    refundedAgorot: refunded,
    settledAgorot: settled,
    outstandingAgorot: billedAgorot - settled,
    depositHeldAgorot: depositHeld,
    unknownAgorot: unknown,
  }
}
