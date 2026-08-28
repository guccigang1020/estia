/**
 * The payment state machine.
 *
 * Nine statuses, declared once, with the five things the charter demands of a
 * transition: legal source states, the permission it needs, the conditions
 * that must hold, what else it sets in motion, and what the audit trail
 * records. Everything not declared is illegal — there is no fallback branch,
 * because the branch that quietly allows an unrecognised move is the branch
 * that lets a refunded payment become paid again.
 *
 * ── The three moves that are not obvious ──────────────────────────────────
 *
 * **`unknown` is reachable from anywhere money was in flight, and is left only
 * by reconciliation.** A provider that times out has either charged the card
 * or not. The transitions out of `unknown` are marked `reconciliation: true`
 * and demand evidence — the provider's own record of the transaction — rather
 * than a person's opinion. Treating a timeout as a failure and retrying is the
 * single most expensive bug this domain can have, so the machine makes it
 * unrepresentable: there is no `unknown → pending`.
 *
 * **`cancelled → paid` is legal, and is flagged as an anomaly.** A guest
 * completes the hosted page thirty seconds after the desk cancelled the
 * booking. The money is real: refusing the transition would leave the ledger
 * claiming nothing arrived while the bank says otherwise. So it is applied,
 * the payment carries `requiresAttention: 'refund_after_cancellation'`, and
 * somebody is told. Swallowing it silently — the tempting alternative — is how
 * a guest is charged for a stay that will not happen.
 *
 * **`failed → paid` is legal too.** Providers reverse themselves: a decline
 * followed by a late settlement is common with 3-D Secure. A machine that
 * treats `failed` as terminal forces the operator to create a second payment
 * for money that was already taken once.
 *
 * `refunded` is the only terminal status. Everything else can still move,
 * because everything else still has money that can move.
 */

import {
  AuthorizationError,
  authorize,
  type Actor,
  type Resource,
} from '../authz/can'
import type { Grant } from '../authz/permissions'
import type { DomainEventName } from '../contracts/events'
import { PAYMENT_STATUSES, type PaymentStatus } from '../contracts/states'
import { BusinessRuleError } from '../errors'
import type { Payment, PaymentAmounts } from './types'

// ── Naming ────────────────────────────────────────────────────────────────

/**
 * What each status is called to a person.
 *
 * A total record, so adding a status to the frozen contract without naming it
 * fails the build rather than putting a raw enum value in a Hebrew sentence.
 */
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'ממתין לתשלום',
  authorized: 'מאושר ומוקפא',
  paid: 'שולם',
  partially_paid: 'שולם חלקית',
  failed: 'נכשל',
  refunded: 'הוחזר במלואו',
  partially_refunded: 'הוחזר חלקית',
  cancelled: 'בוטל',
  unknown: 'לא ידוע — דורש בירור',
}

/** Nothing further happens to a payment in one of these. */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = ['refunded']

const TERMINAL = new Set<PaymentStatus>(TERMINAL_PAYMENT_STATUSES)

// ── Side effects ──────────────────────────────────────────────────────────

/**
 * What else a transition sets in motion.
 *
 * Named rather than performed: this layer has no mailer, no ledger writer and
 * no task board, and must not acquire one. Declaring them on the transition is
 * what stops "issue the invoice" from being remembered at one call site and
 * forgotten at the other.
 */
export const PAYMENT_SIDE_EFFECTS = [
  'issue_invoice',
  'issue_credit_note',
  'notify_guest',
  'notify_finance',
  'advance_booking',
  'release_hold',
  'open_reconciliation_task',
  'evaluate_commission',
  'cancel_commission',
] as const

export type PaymentSideEffect = (typeof PAYMENT_SIDE_EFFECTS)[number]

/** Money in a state that is nobody's fault and still needs a person. */
export const PAYMENT_ANOMALIES = [
  'payment_after_cancellation',
  'provider_outcome_unknown',
  'captured_more_than_requested',
] as const

export type PaymentAnomaly = (typeof PAYMENT_ANOMALIES)[number]

// ── Conditions ────────────────────────────────────────────────────────────

/**
 * The move is evaluated against the amounts it would *produce*, not against
 * the ones on the record now.
 *
 * That is the difference between a machine that can be asked "may I apply this
 * capture" and one that can only be told "I already did". `next` is what the
 * caller intends to write; the conditions decide whether the resulting record
 * would be coherent.
 */
export interface PaymentTransitionContext {
  payment: Payment
  next: PaymentAmounts
  now: Date
}

export interface PaymentCondition {
  code: string
  /** Hebrew, and about the fact rather than the rule. */
  message: string
  holds(context: PaymentTransitionContext): boolean
}

const refundWithinCapture: PaymentCondition = {
  code: 'finance.refund_exceeds_capture',
  message: 'לא ניתן להחזיר סכום גדול ממה שנגבה בפועל בתשלום הזה.',
  holds: ({ next }) => next.refundedAgorot <= next.capturedAgorot,
}

const somethingWasCaptured: PaymentCondition = {
  code: 'finance.nothing_captured',
  message: 'לא נגבה כסף בתשלום הזה, ולכן אין מה להחזיר.',
  holds: ({ next }) => next.capturedAgorot > 0,
}

const fullyCaptured: PaymentCondition = {
  code: 'finance.not_fully_captured',
  message:
    'הסכום שנגבה קטן מהסכום שנדרש, ולכן התשלום אינו "שולם" אלא "שולם חלקית".',
  holds: ({ next }) => next.capturedAgorot >= next.amountAgorot,
}

const partiallyCaptured: PaymentCondition = {
  code: 'finance.not_partially_captured',
  message: 'תשלום חלקי מחייב סכום שנגבה גדול מאפס וקטן מהסכום שנדרש.',
  holds: ({ next }) =>
    next.capturedAgorot > 0 && next.capturedAgorot < next.amountAgorot,
}

const fullyRefunded: PaymentCondition = {
  code: 'finance.not_fully_refunded',
  message: 'החזר מלא מחייב שהסכום שהוחזר יהיה שווה לסכום שנגבה.',
  holds: ({ next }) =>
    next.capturedAgorot > 0 && next.refundedAgorot === next.capturedAgorot,
}

const partiallyRefunded: PaymentCondition = {
  code: 'finance.not_partially_refunded',
  message: 'החזר חלקי מחייב סכום שהוחזר גדול מאפס וקטן מהסכום שנגבה.',
  holds: ({ next }) =>
    next.refundedAgorot > 0 && next.refundedAgorot < next.capturedAgorot,
}

const nothingCaptured: PaymentCondition = {
  code: 'finance.already_captured',
  message: 'כבר נגבה כסף בתשלום הזה, ולכן לא ניתן לבטל אותו. יש לבצע החזר.',
  holds: ({ next }) => next.capturedAgorot === 0,
}

const authorizationHeld: PaymentCondition = {
  code: 'finance.no_authorization',
  message: 'אין סכום מוקפא בכרטיס, ולכן לא ניתן לסמן את התשלום כמאושר.',
  holds: ({ next }) => next.authorizedAgorot > 0,
}

// ── The table ─────────────────────────────────────────────────────────────

export interface PaymentTransition {
  to: PaymentStatus
  from: readonly PaymentStatus[]
  permission: Grant
  requiresReason: boolean
  conditions: readonly PaymentCondition[]
  sideEffects: readonly PaymentSideEffect[]
  auditAction: string
  /**
   * The catalogue event, or `null` where the frozen catalogue has none.
   *
   * `null` is honest rather than convenient: inventing `payment.cancelled`
   * here would produce an event name nothing can subscribe to and would put
   * this module's vocabulary at odds with `contracts/events.ts`. The gaps are
   * listed at the foot of this file, for whoever owns that contract.
   */
  event: DomainEventName | null
  /** The event to raise instead when the payment is a security deposit. */
  depositEvent?: DomainEventName
  /** Money in a state that needs a person, not a retry. */
  anomaly?: PaymentAnomaly
  /**
   * This move may only be made on the strength of the provider's own record.
   *
   * The reconciliation path out of `unknown`. Marked so that a caller cannot
   * offer it as an ordinary button on a screen.
   */
  reconciliation?: boolean
}

export const PAYMENT_TRANSITIONS: readonly PaymentTransition[] = [
  // ── Collection ──────────────────────────────────────────────────────────
  {
    to: 'authorized',
    from: ['pending', 'failed'],
    permission: 'payment.create',
    requiresReason: false,
    conditions: [authorizationHeld],
    sideEffects: ['notify_guest'],
    auditAction: 'payment.authorized',
    event: null,
    depositEvent: 'deposit.authorized',
  },
  {
    to: 'paid',
    from: ['pending', 'authorized', 'partially_paid', 'failed'],
    permission: 'payment.create',
    requiresReason: false,
    conditions: [fullyCaptured],
    sideEffects: [
      'issue_invoice',
      'notify_guest',
      'advance_booking',
      'release_hold',
      'evaluate_commission',
    ],
    auditAction: 'payment.received',
    event: 'payment.received',
    depositEvent: 'deposit.captured',
  },
  {
    to: 'partially_paid',
    from: ['pending', 'authorized', 'failed'],
    permission: 'payment.create',
    requiresReason: false,
    conditions: [partiallyCaptured],
    sideEffects: ['notify_finance', 'evaluate_commission'],
    auditAction: 'payment.partially_received',
    event: 'payment.received',
    depositEvent: 'deposit.captured',
  },
  {
    to: 'failed',
    from: ['pending', 'authorized'],
    permission: 'payment.create',
    requiresReason: false,
    conditions: [],
    sideEffects: ['notify_guest', 'notify_finance'],
    auditAction: 'payment.failed',
    event: 'payment.failed',
  },

  // ── The honest third outcome ────────────────────────────────────────────
  {
    to: 'unknown',
    from: ['pending', 'authorized', 'partially_paid', 'paid'],
    permission: 'payment.create',
    requiresReason: false,
    conditions: [],
    sideEffects: ['open_reconciliation_task', 'notify_finance'],
    auditAction: 'payment.outcome_unknown',
    event: null,
    anomaly: 'provider_outcome_unknown',
  },
  {
    to: 'paid',
    from: ['unknown'],
    permission: 'payment.capture',
    requiresReason: false,
    conditions: [fullyCaptured],
    sideEffects: ['issue_invoice', 'advance_booking', 'evaluate_commission'],
    auditAction: 'payment.reconciled_as_received',
    event: 'payment.received',
    depositEvent: 'deposit.captured',
    reconciliation: true,
  },
  {
    to: 'partially_paid',
    from: ['unknown'],
    permission: 'payment.capture',
    requiresReason: false,
    conditions: [partiallyCaptured],
    sideEffects: ['notify_finance', 'evaluate_commission'],
    auditAction: 'payment.reconciled_as_partial',
    event: 'payment.received',
    reconciliation: true,
  },
  {
    to: 'failed',
    from: ['unknown'],
    permission: 'payment.capture',
    requiresReason: false,
    conditions: [nothingCaptured],
    sideEffects: ['notify_finance'],
    auditAction: 'payment.reconciled_as_failed',
    event: 'payment.failed',
    reconciliation: true,
  },

  // ── Money going back ────────────────────────────────────────────────────
  {
    to: 'partially_refunded',
    from: ['paid', 'partially_paid'],
    permission: 'payment.refund',
    requiresReason: true,
    conditions: [somethingWasCaptured, refundWithinCapture, partiallyRefunded],
    sideEffects: ['issue_credit_note', 'notify_guest', 'notify_finance'],
    auditAction: 'payment.partially_refunded',
    event: 'payment.refunded',
    depositEvent: 'deposit.released',
  },
  {
    to: 'refunded',
    from: ['paid', 'partially_paid', 'partially_refunded'],
    permission: 'payment.refund',
    requiresReason: true,
    conditions: [somethingWasCaptured, refundWithinCapture, fullyRefunded],
    sideEffects: [
      'issue_credit_note',
      'notify_guest',
      'notify_finance',
      'cancel_commission',
    ],
    auditAction: 'payment.refunded',
    event: 'payment.refunded',
    depositEvent: 'deposit.released',
  },

  // ── Giving up on money that never moved ─────────────────────────────────
  {
    to: 'cancelled',
    from: ['pending', 'authorized', 'failed'],
    permission: 'payment.void',
    requiresReason: true,
    conditions: [nothingCaptured],
    sideEffects: ['notify_finance', 'cancel_commission'],
    auditAction: 'payment.cancelled',
    event: null,
    depositEvent: 'deposit.released',
  },
  {
    to: 'cancelled',
    from: ['unknown'],
    permission: 'payment.void',
    requiresReason: true,
    conditions: [nothingCaptured],
    sideEffects: ['notify_finance'],
    auditAction: 'payment.reconciled_as_cancelled',
    event: null,
    reconciliation: true,
  },

  // ── The one that must never be swallowed ────────────────────────────────
  {
    to: 'paid',
    from: ['cancelled'],
    permission: 'payment.create',
    requiresReason: false,
    conditions: [fullyCaptured],
    sideEffects: ['notify_finance', 'open_reconciliation_task'],
    auditAction: 'payment.received_after_cancellation',
    event: 'payment.received',
    anomaly: 'payment_after_cancellation',
  },
  {
    to: 'partially_paid',
    from: ['cancelled'],
    permission: 'payment.create',
    requiresReason: false,
    conditions: [partiallyCaptured],
    sideEffects: ['notify_finance', 'open_reconciliation_task'],
    auditAction: 'payment.received_after_cancellation',
    event: 'payment.received',
    anomaly: 'payment_after_cancellation',
  },

  // ── Retry ───────────────────────────────────────────────────────────────
  {
    // A declined card can be tried again. Deliberately not reachable from
    // `unknown`: retrying a payment that may already have gone through is the
    // double charge this whole design exists to prevent.
    to: 'pending',
    from: ['failed', 'cancelled'],
    permission: 'payment.create',
    requiresReason: false,
    conditions: [nothingCaptured],
    sideEffects: ['notify_guest'],
    auditAction: 'payment.retried',
    event: 'payment.link_sent',
  },
]

// ── The authorization view ────────────────────────────────────────────────

export function paymentResource(payment: Payment): Resource {
  const resource: Resource = { organizationId: payment.organizationId }
  if (payment.propertyId !== null) resource.propertyId = payment.propertyId
  if (payment.createdByUserId !== null) {
    resource.createdByUserId = payment.createdByUserId
  }
  return resource
}

// ── Asking the machine ────────────────────────────────────────────────────

export type PaymentRefusal =
  | { kind: 'terminal'; code: string; message: string }
  | { kind: 'illegal'; code: string; message: string }
  | { kind: 'not_permitted'; permission: Grant; error: AuthorizationError }
  | { kind: 'condition'; code: string; message: string }

export type PaymentTransitionCheck =
  | { ok: true; transition: PaymentTransition }
  | { ok: false; refusal: PaymentRefusal }

/**
 * The declared move, or `null`.
 *
 * Several targets have more than one entry — `paid` is reached from ordinary
 * collection, from reconciliation and from after a cancellation, and the three
 * are genuinely different moves with different side effects. The first entry
 * whose `from` contains the source status wins, and the table is ordered so
 * the ordinary path is found first.
 */
export function findPaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): PaymentTransition | null {
  return (
    PAYMENT_TRANSITIONS.find(
      (transition) => transition.to === to && transition.from.includes(from),
    ) ?? null
  )
}

/**
 * Decide, without throwing.
 *
 * Legality, then permission, then conditions — the same order as the booking
 * machine and for the same reason. A cleaner attempting a refund is told they
 * may not, rather than being told the payment was never captured, which is a
 * fact about the business's money they were not entitled to learn.
 */
export function evaluatePaymentTransition(
  actor: Actor,
  to: PaymentStatus,
  context: PaymentTransitionContext,
): PaymentTransitionCheck {
  const from = context.payment.status

  if (TERMINAL.has(from)) {
    return {
      ok: false,
      refusal: {
        kind: 'terminal',
        code: 'finance.payment_terminal',
        message:
          `התשלום נמצא במצב "${PAYMENT_STATUS_LABEL[from]}" ` +
          'ולא ניתן לשנות אותו יותר.',
      },
    }
  }

  if (from === to) {
    return {
      ok: false,
      refusal: {
        kind: 'illegal',
        code: 'finance.payment_same_status',
        message: `התשלום כבר נמצא במצב "${PAYMENT_STATUS_LABEL[to]}".`,
      },
    }
  }

  const transition = findPaymentTransition(from, to)
  if (!transition) {
    return {
      ok: false,
      refusal: {
        kind: 'illegal',
        code: 'finance.illegal_payment_transition',
        message:
          `לא ניתן להעביר תשלום ממצב "${PAYMENT_STATUS_LABEL[from]}" ` +
          `למצב "${PAYMENT_STATUS_LABEL[to]}".`,
      },
    }
  }

  const decision = authorize(
    actor,
    transition.permission,
    paymentResource(context.payment),
  )
  if (!decision.allowed) {
    return {
      ok: false,
      refusal: {
        kind: 'not_permitted',
        permission: transition.permission,
        error: new AuthorizationError(decision, transition.permission),
      },
    }
  }

  for (const condition of transition.conditions) {
    if (!condition.holds(context)) {
      return {
        ok: false,
        refusal: {
          kind: 'condition',
          code: condition.code,
          message: condition.message,
        },
      }
    }
  }

  return { ok: true, transition }
}

/** The enforcing form. */
export function assertPaymentTransition(
  actor: Actor,
  to: PaymentStatus,
  context: PaymentTransitionContext,
): PaymentTransition {
  const check = evaluatePaymentTransition(actor, to, context)
  if (check.ok) return check.transition

  const { refusal } = check
  if (refusal.kind === 'not_permitted') throw refusal.error

  throw new BusinessRuleError({
    code: refusal.code,
    userMessage: refusal.message,
    message:
      `Illegal payment transition ${context.payment.status} → ${to} ` +
      `(${refusal.code})`,
    publicDetails: { from: context.payment.status, to },
  })
}

/** What this actor may do with this payment right now. */
export function legalNextPaymentStatuses(
  actor: Actor,
  context: PaymentTransitionContext,
): PaymentStatus[] {
  const allowed: PaymentStatus[] = []
  for (const status of PAYMENT_STATUSES) {
    if (evaluatePaymentTransition(actor, status, context).ok) {
      allowed.push(status)
    }
  }
  return allowed
}

/**
 * The event this transition raises for this payment.
 *
 * A security deposit raises `deposit.*` rather than `payment.*`, because the
 * automations that react to a deposit being held are not the ones that react
 * to a stay being paid for.
 */
export function paymentEventFor(
  transition: PaymentTransition,
  payment: Payment,
): DomainEventName | null {
  if (payment.purpose === 'security_deposit' && transition.depositEvent) {
    return transition.depositEvent
  }
  return transition.event
}

/**
 * ── A note for whoever owns `contracts/events.ts` ─────────────────────────
 *
 * Three transitions here have no catalogue event and carry `null`:
 *
 *   · a payment being cancelled or voided — `payment.cancelled`;
 *   · a provider outcome becoming unknown — `payment.outcome_unknown`, which
 *     is the one an operations dashboard most needs, since it is the queue a
 *     person has to work;
 *   · a payment authorised but not captured — `payment.authorized`, for
 *     non-deposit authorisations.
 *
 * All three are business facts somebody wants to react to. They are not
 * invented here because the catalogue is frozen and a name nothing subscribes
 * to is worse than an acknowledged gap. `payment.outcome_unknown` also belongs
 * in `ALERT_EVENTS`: it is money in an undecided state, which is precisely the
 * class of thing that must reach a person rather than only a log.
 */
