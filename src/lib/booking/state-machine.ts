/**
 * The booking state machine.
 *
 * Nineteen statuses is not nineteen flags — it is a workflow, and a workflow
 * that lives as scattered `booking.status = 'confirmed'` assignments is a
 * workflow nobody can describe. So every legal move is declared once, here,
 * with the five things the charter demands of a transition: which states it may
 * start from, which permission it needs, which conditions must hold, what else
 * has to happen, and what the audit trail records.
 *
 * Everything not declared is illegal. There is no fallback branch and no
 * "unknown status, allow it" — an unrecognised move is refused with a Hebrew
 * sentence naming both states, because "invalid transition" tells a receptionist
 * nothing they can act on.
 *
 * ── The shape of the graph, and why it is not a straight line ──────────────
 *
 * The happy path is
 *
 *   inquiry → quote → option → awaiting_payment → deposit_paid
 *           → contract_pending → confirmed → pre_arrival
 *           → ready_for_check_in → checked_in → in_house
 *           → checkout_pending → checked_out → inspection
 *           → deposit_release → review_requested → completed
 *
 * but a real desk does not walk it one step at a time, so several deliberate
 * short-cuts and two exits are declared alongside it:
 *
 * **`review_requested` sits before `completed`, not after it.** The contract
 * lists it after `completed` in `BOOKING_STATUSES`, but it also declares
 * `completed` terminal — "nothing further happens to a booking in one of
 * these". Both cannot be true. `TERMINAL_STATUSES` is the stronger statement
 * (it is what the availability engine and every guard read), and
 * `review_requested` is not terminal, so it must have somewhere to go; the only
 * candidate is `completed`. The array's order is therefore a listing, not a
 * sequence. See the note at the foot of this file.
 *
 * **`completed` requires the deposit to be back with the guest.** Rather than
 * hard-wiring "you must pass through deposit_release", the condition is stated
 * as the thing that actually matters: a booking may not be closed while the
 * business is still holding the guest's money. A stay with no deposit reaches
 * `completed` straight from `checked_out`; a stay with one cannot, whichever
 * route it takes.
 *
 * **`no_show` is not a cancellation and is not available early.** It only makes
 * sense for a booking that was committed and whose arrival date has come:
 * marking a guest absent before they were due is a data-entry error, and
 * marking one absent who has already checked in is a contradiction. Anything
 * else that falls apart before arrival is a cancellation, which is a different
 * financial event.
 *
 * **`cancelled` is reachable from most states but never after check-out.**
 * Once the guest has left, the stay happened; erasing it is an accounting
 * fiction, and the correct instruments are a refund and a credit note. Before
 * that — including while the guest is in the unit — cancellation is legitimate
 * and is how an early termination is recorded.
 *
 * **`checked_in` is only reachable from `ready_for_check_in`.** That gate is
 * the reason the status exists: nobody is handed keys to a unit housekeeping
 * has not signed off. A same-day walk-in is served by allowing
 * `confirmed → ready_for_check_in` directly, not by weakening the gate.
 */

import {
  AuthorizationError,
  authorize,
  type Actor,
  type Resource,
} from '../authz/can'
import type { Grant } from '../authz/permissions'
import { BusinessRuleError } from '../errors'
import type { DomainEventName } from '../service'
import { localDate } from './dates'
import type { BookingParty, SleepingRequest } from './party'
import type { EventType } from '../preparation/types'
import {
  TERMINAL_STATUSES,
  type Agorot,
  type BookingAttribution,
  type BookingStatus,
  type PriceLine,
} from './types'

// ── The booking, as the domain sees it ────────────────────────────────────

/**
 * The fields the domain reasons about.
 *
 * Deliberately not the database row. The schema carries timestamps, soft
 * deletes, channel payloads and half a dozen foreign keys that no rule here
 * consults; naming only what the logic reads keeps this file testable with an
 * object literal and keeps the two from drifting into one another.
 */
export interface BookingSnapshot {
  id: string
  organizationId: string
  propertyId: string | null
  unitId: string
  /** The short human number a guest quotes on the phone: `8892`. */
  reference: string
  status: BookingStatus
  /** Inclusive first night. */
  checkIn: string
  /** Exclusive — bookable by the next guest. */
  checkOut: string
  guestName: string
  /**
   * Heads under the roof — adults, children and infants together.
   *
   * Kept alongside `party` rather than replaced by it, because it is the
   * figure every existing screen and report already reads and it round-trips
   * correctly as the sum. `party` is the split those screens could not show.
   */
  guestCount: number
  /**
   * The party as the desk actually recorded it.
   *
   * Optional so that a caller written before 0028 still compiles. Every path
   * through `booking.create` supplies all four.
   */
  party?: BookingParty
  /** Couples, extra beds and cots as *asked for* — not as the plan decided. */
  sleeping?: SleepingRequest
  eventType?: EventType
  /**
   * The guest's own words. Readable wherever `guestNotes` is, and deliberately
   * not behind `booking.note.internal`: a cleaner has to be able to read
   * "שתי מיטות תינוק".
   */
  specialRequests?: string | null
  version: number
  /** What the business asked for up front. Zero when it takes nothing. */
  depositRequiredAgorot: Agorot
  /** What it is holding right now. Zero once released or never taken. */
  depositHeldAgorot: Agorot
  totalAgorot: Agorot
  lines: readonly PriceLine[]
  attribution: BookingAttribution
  createdByUserId: string | null
}

/** The authorization view of a booking. */
export function bookingResource(booking: BookingSnapshot): Resource {
  const resource: Resource = {
    organizationId: booking.organizationId,
    unitId: booking.unitId,
  }
  if (booking.propertyId !== null) resource.propertyId = booking.propertyId
  if (booking.createdByUserId !== null) {
    resource.createdByUserId = booking.createdByUserId
  }
  return resource
}

// ── Hebrew names ──────────────────────────────────────────────────────────

/**
 * What each status is called to a person.
 *
 * Typed as a total record, so adding a status to the contract without naming it
 * fails the build rather than producing a refusal message with a raw enum value
 * in it.
 */
export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  inquiry: 'פנייה',
  quote: 'הצעת מחיר',
  option: 'אופציה',
  awaiting_payment: 'ממתינה לתשלום',
  deposit_paid: 'מקדמה שולמה',
  contract_pending: 'ממתינה לחתימת חוזה',
  confirmed: 'מאושרת',
  pre_arrival: 'לקראת הגעה',
  ready_for_check_in: 'מוכנה לצ׳ק-אין',
  checked_in: 'צ׳ק-אין בוצע',
  in_house: 'אורח בשטח',
  checkout_pending: 'לקראת צ׳ק-אאוט',
  checked_out: 'צ׳ק-אאוט בוצע',
  inspection: 'בבדיקת יחידה',
  deposit_release: 'שחרור פיקדון',
  completed: 'הושלמה',
  review_requested: 'ממתינה לחוות דעת',
  cancelled: 'בוטלה',
  no_show: 'לא הגיע',
}

// ── Side effects ──────────────────────────────────────────────────────────

/**
 * What else a transition sets in motion.
 *
 * Declared as names rather than performed here, because this layer has no
 * database, no mailer and no task board — and should not acquire one. The
 * operation publishes them on the domain event; the subscribers do the work.
 * Naming them on the transition is what stops a side effect from being
 * remembered at one call site and forgotten at the other.
 */
export const BOOKING_SIDE_EFFECTS = [
  'occupy_dates',
  'free_dates',
  'release_holds',
  'request_deposit',
  'issue_contract',
  'notify_guest',
  'notify_agent',
  'open_arrival_task',
  'open_cleaning_task',
  'open_inspection_task',
  'refund_deposit',
  'request_review',
  'charge_cancellation_fee',
  'charge_no_show_fee',
  'close_financials',
] as const

export type BookingSideEffect = (typeof BOOKING_SIDE_EFFECTS)[number]

// ── Conditions ────────────────────────────────────────────────────────────

export interface TransitionContext {
  booking: BookingSnapshot
  now: Date
}

/**
 * A fact that must hold for the move to be legal.
 *
 * The message is Hebrew and explains the fact rather than the rule — "עדיין
 * מוחזק פיקדון" tells the user what to do next, "condition failed" does not.
 */
export interface TransitionCondition {
  code: string
  message: string
  holds(context: TransitionContext): boolean
}

const arrivalDateHasCome: TransitionCondition = {
  code: 'booking.arrival_not_due',
  message:
    'לא ניתן לסמן אי-הגעה לפני מועד ההגעה. אם ההזמנה לא תצא לפועל, בטל אותה.',
  holds: ({ booking, now }) => localDate(now) >= booking.checkIn,
}

const stayHasNotEnded: TransitionCondition = {
  code: 'booking.stay_already_ended',
  message: 'תאריך העזיבה כבר עבר, ולכן לא ניתן לבצע צ׳ק-אין להזמנה הזו.',
  holds: ({ booking, now }) => localDate(now) < booking.checkOut,
}

const depositIsHeld: TransitionCondition = {
  code: 'booking.no_deposit_held',
  message: 'אין פיקדון מוחזק בהזמנה הזו, ולכן אין מה לשחרר.',
  holds: ({ booking }) => booking.depositHeldAgorot > 0,
}

const noDepositStillHeld: TransitionCondition = {
  code: 'booking.deposit_still_held',
  message: 'עדיין מוחזק פיקדון של האורח. שחרר את הפיקדון לפני סגירת ההזמנה.',
  holds: ({ booking }) => booking.depositHeldAgorot === 0,
}

const nothingOwedUpFront: TransitionCondition = {
  code: 'booking.deposit_still_due',
  message: 'ההזמנה דורשת מקדמה שטרם שולמה. אשר אותה רק לאחר קבלת התשלום.',
  holds: ({ booking }) => booking.depositRequiredAgorot === 0,
}

// ── The table ─────────────────────────────────────────────────────────────

export interface BookingTransition {
  to: BookingStatus
  from: readonly BookingStatus[]
  permission: Grant
  /** Demands a stated justification on top of the permission. */
  requiresReason: boolean
  conditions: readonly TransitionCondition[]
  sideEffects: readonly BookingSideEffect[]
  /** The `action` column of the audit row, so a timeline can be filtered. */
  auditAction: string
  event: DomainEventName
}

/**
 * Every legal move in the product.
 *
 * One entry per target status, except where the same target is reached under
 * different conditions from different places — `confirmed` has two entries
 * because confirming a booking that owes a deposit and one that never did are
 * genuinely different moves, and folding them together would mean either
 * blocking the second or waving through the first.
 *
 * Permissions: ordinary progression is `booking.change_status`. Two moves are
 * named separately because they are the two that cost somebody money —
 * `booking.cancel` and `deposit.release` — and the permission catalogue already
 * separates them for exactly that reason.
 */
export const BOOKING_TRANSITIONS: readonly BookingTransition[] = [
  {
    to: 'quote',
    // Back from `option` as well: an option that lapses without the deal dying
    // returns the dates to sale and keeps the lead alive.
    from: ['inquiry', 'option'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    sideEffects: ['free_dates', 'release_holds', 'notify_guest'],
    auditAction: 'booking.quoted',
    event: 'quote.sent',
  },
  {
    to: 'option',
    from: ['inquiry', 'quote'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    // An option occupies the calendar. That is the point of it, and it is why
    // `OCCUPYING_STATUSES` includes it.
    sideEffects: ['occupy_dates', 'notify_agent'],
    auditAction: 'booking.optioned',
    event: 'booking.optioned',
  },
  {
    to: 'awaiting_payment',
    from: ['quote', 'option'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    sideEffects: ['occupy_dates', 'request_deposit', 'notify_guest'],
    auditAction: 'booking.payment_requested',
    event: 'payment.link_sent',
  },
  {
    to: 'deposit_paid',
    from: ['awaiting_payment'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    sideEffects: ['occupy_dates', 'notify_guest'],
    auditAction: 'booking.deposit_paid',
    event: 'booking.deposit_paid',
  },
  {
    to: 'contract_pending',
    from: ['deposit_paid'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    sideEffects: ['issue_contract', 'notify_guest'],
    auditAction: 'booking.contract_sent',
    event: 'contract.sent',
  },
  {
    to: 'confirmed',
    from: ['deposit_paid', 'contract_pending'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    sideEffects: ['occupy_dates', 'notify_guest', 'notify_agent'],
    auditAction: 'booking.confirmed',
    event: 'booking.confirmed',
  },
  {
    // The business that takes no money up front. Forcing it through
    // `awaiting_payment → deposit_paid` would mean recording a payment that
    // never happened, and a false payment is worse than a missing one.
    to: 'confirmed',
    from: ['option', 'awaiting_payment'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [nothingOwedUpFront],
    sideEffects: ['occupy_dates', 'notify_guest', 'notify_agent'],
    auditAction: 'booking.confirmed',
    event: 'booking.confirmed',
  },
  {
    to: 'pre_arrival',
    from: ['confirmed'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    sideEffects: ['notify_guest', 'open_arrival_task'],
    auditAction: 'booking.pre_arrival',
    event: 'booking.pre_arrival',
  },
  {
    // Straight from `confirmed` for the walk-in confirmed at the desk: there is
    // no "coming soon" phase for a guest already standing there.
    to: 'ready_for_check_in',
    from: ['confirmed', 'pre_arrival'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    sideEffects: ['notify_guest'],
    auditAction: 'booking.ready_for_check_in',
    event: 'booking.ready_for_check_in',
  },
  {
    to: 'checked_in',
    from: ['ready_for_check_in'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [stayHasNotEnded],
    sideEffects: ['occupy_dates', 'notify_guest'],
    auditAction: 'booking.checked_in',
    event: 'booking.checked_in',
  },
  {
    to: 'in_house',
    from: ['checked_in'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    sideEffects: ['occupy_dates'],
    auditAction: 'booking.in_house',
    event: 'booking.in_house',
  },
  {
    // From `checked_in` too, for the one-night stay whose "in house" phase is
    // a few hours long and whose departure morning arrives next.
    to: 'checkout_pending',
    from: ['in_house', 'checked_in'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    sideEffects: ['notify_guest', 'open_cleaning_task'],
    auditAction: 'booking.checkout_pending',
    event: 'booking.checkout_pending',
  },
  {
    // Directly from `in_house` for a self-checkout unit, where nobody is at the
    // desk to mark the intermediate state.
    to: 'checked_out',
    from: ['checkout_pending', 'in_house'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    // The dates stop being occupied here: `checked_out` is not in
    // `OCCUPYING_STATUSES`, so the unit is sellable again from this moment.
    sideEffects: ['free_dates', 'open_cleaning_task', 'open_inspection_task'],
    auditAction: 'booking.checked_out',
    event: 'booking.checked_out',
  },
  {
    to: 'inspection',
    from: ['checked_out'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    sideEffects: ['open_inspection_task'],
    auditAction: 'booking.inspection',
    event: 'booking.inspection',
  },
  {
    // Only after an inspection. Returning a security deposit before anyone has
    // looked at the unit is how a business pays for its own damage.
    to: 'deposit_release',
    from: ['inspection'],
    permission: 'deposit.release',
    requiresReason: true,
    conditions: [depositIsHeld],
    sideEffects: ['refund_deposit', 'notify_guest'],
    auditAction: 'booking.deposit_released',
    event: 'deposit.released',
  },
  {
    to: 'review_requested',
    from: ['checked_out', 'inspection', 'deposit_release'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [],
    sideEffects: ['request_review', 'notify_guest'],
    auditAction: 'booking.review_requested',
    event: 'booking.review_requested',
  },
  {
    to: 'completed',
    from: ['checked_out', 'inspection', 'deposit_release', 'review_requested'],
    permission: 'booking.change_status',
    requiresReason: false,
    conditions: [noDepositStillHeld],
    sideEffects: ['close_financials'],
    auditAction: 'booking.completed',
    event: 'booking.completed',
  },
  {
    // Everything up to and including the guest being in the unit. Not
    // `checked_out` and not anything after it — see the header.
    to: 'cancelled',
    from: [
      'inquiry',
      'quote',
      'option',
      'awaiting_payment',
      'deposit_paid',
      'contract_pending',
      'confirmed',
      'pre_arrival',
      'ready_for_check_in',
      'checked_in',
      'in_house',
      'checkout_pending',
    ],
    permission: 'booking.cancel',
    requiresReason: true,
    conditions: [],
    sideEffects: [
      'free_dates',
      'release_holds',
      'notify_guest',
      'notify_agent',
      'charge_cancellation_fee',
    ],
    auditAction: 'booking.cancelled',
    event: 'booking.cancelled',
  },
  {
    to: 'no_show',
    from: ['confirmed', 'pre_arrival', 'ready_for_check_in'],
    permission: 'booking.change_status',
    requiresReason: true,
    conditions: [arrivalDateHasCome],
    sideEffects: ['free_dates', 'release_holds', 'charge_no_show_fee'],
    auditAction: 'booking.no_show',
    event: 'booking.no_show',
  },
]

// ── Asking the machine ────────────────────────────────────────────────────

export type TransitionRefusal =
  | { kind: 'terminal'; code: string; message: string }
  | { kind: 'illegal'; code: string; message: string }
  | { kind: 'not_permitted'; permission: Grant; error: AuthorizationError }
  | { kind: 'condition'; code: string; message: string }

export type TransitionCheck =
  | { ok: true; transition: BookingTransition }
  | { ok: false; refusal: TransitionRefusal }

const TERMINAL = new Set<BookingStatus>(TERMINAL_STATUSES)

/** The declared move from one status to another, or `null`. */
export function findTransition(
  from: BookingStatus,
  to: BookingStatus,
): BookingTransition | null {
  return (
    BOOKING_TRANSITIONS.find(
      (transition) => transition.to === to && transition.from.includes(from),
    ) ?? null
  )
}

/**
 * Decide, without throwing.
 *
 * The order is the point. Legality first, because an undeclared move has no
 * permission to check. Then the permission, *before* any condition — so a
 * cleaner attempting to release a deposit is told they may not, rather than
 * being told the deposit has already gone, which is a fact about the booking
 * they were not entitled to learn.
 */
export function evaluateTransition(
  actor: Actor,
  to: BookingStatus,
  context: TransitionContext,
): TransitionCheck {
  const from = context.booking.status

  if (TERMINAL.has(from)) {
    return {
      ok: false,
      refusal: {
        kind: 'terminal',
        code: 'booking.terminal_status',
        message:
          `ההזמנה נמצאת במצב "${BOOKING_STATUS_LABEL[from]}" ` +
          'ולא ניתן לשנות אותה יותר.',
      },
    }
  }

  if (from === to) {
    return {
      ok: false,
      refusal: {
        kind: 'illegal',
        code: 'booking.same_status',
        message: `ההזמנה כבר נמצאת במצב "${BOOKING_STATUS_LABEL[to]}".`,
      },
    }
  }

  const transition = findTransition(from, to)
  if (!transition) {
    return {
      ok: false,
      refusal: {
        kind: 'illegal',
        code: 'booking.illegal_transition',
        message:
          `לא ניתן להעביר הזמנה ממצב "${BOOKING_STATUS_LABEL[from]}" ` +
          `למצב "${BOOKING_STATUS_LABEL[to]}".`,
      },
    }
  }

  const decision = authorize(
    actor,
    transition.permission,
    bookingResource(context.booking),
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

/**
 * The enforcing form.
 *
 * An illegal move throws a `BusinessRuleError` carrying both statuses, so the
 * interface can say what happened and offer what is actually possible next.
 * A refusal for lack of permission throws the authorization engine's own error
 * rather than a domain one — the two failures mean different things to the
 * caller and must not be flattened into one.
 */
export function assertTransition(
  actor: Actor,
  to: BookingStatus,
  context: TransitionContext,
): BookingTransition {
  const check = evaluateTransition(actor, to, context)
  if (check.ok) return check.transition

  const { refusal } = check
  if (refusal.kind === 'not_permitted') throw refusal.error

  throw new BusinessRuleError({
    code: refusal.code,
    userMessage: refusal.message,
    message:
      `Illegal booking transition ${context.booking.status} → ${to} ` +
      `(${refusal.code})`,
    publicDetails: {
      from: context.booking.status,
      to,
      allowed: legalNextStatuses(actor, context),
    },
  })
}

/**
 * What this actor can do with this booking right now.
 *
 * The interface builds its buttons from this rather than from a status
 * comparison, which is what keeps the screen and the server agreeing about
 * what is possible.
 */
export function legalNextStatuses(
  actor: Actor,
  context: TransitionContext,
): BookingStatus[] {
  const seen = new Set<BookingStatus>()
  for (const transition of BOOKING_TRANSITIONS) {
    if (seen.has(transition.to)) continue
    if (evaluateTransition(actor, transition.to, context).ok) {
      seen.add(transition.to)
    }
  }
  return [...seen]
}

/**
 * ── A note for whoever owns `types.ts` ────────────────────────────────────
 *
 * `BOOKING_STATUSES` lists `completed` before `review_requested`, while
 * `TERMINAL_STATUSES` declares `completed` terminal. Read as a sequence the two
 * contradict each other. This file treats the array as an unordered catalogue
 * and `TERMINAL_STATUSES` as the law, which puts `review_requested` before
 * `completed`. If the intent was the opposite — that a completed stay can still
 * be asked for a review — then `completed` is not terminal and both this table
 * and the availability engine's reading of terminality need to change together.
 */
