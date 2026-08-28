/**
 * Security deposits.
 *
 * A deposit is money held and not earned, and it is its own record rather than
 * a payment with a flag on it — because it is four facts, not one:
 *
 *   · `requiredAgorot`  — what the business asked the guest to put up.
 *   · `heldAgorot`      — what was actually reserved on the card.
 *   · `releasedAgorot`  — what has gone back to the guest.
 *   · `forfeitedAgorot` — what was kept, for damage.
 *
 * The four operations the product needs map onto those without inventing
 * anything:
 *
 *   **authorise** → the card is reserved. `held` rises. Status `authorized`.
 *   **forfeit in full** → everything held is kept. Status `paid`.
 *   **partial deduction** → part is kept, **and the remainder is released in
 *     the same movement**. A business that deducts ₪300 of a ₪1,000 hold must
 *     not go on reserving the other ₪700 against the guest's credit limit for
 *     another month. That release is not optional and is not a second step
 *     somebody can forget. Status `partially_paid`.
 *   **release** → nothing kept, everything given back. Status `cancelled` —
 *     the frozen vocabulary's word for money that was reserved and never
 *     taken.
 *
 * Two invariants hold at every point, and both are asserted rather than
 * assumed:
 *
 *   1. `released + forfeited ≤ held`. Nothing leaves a deposit that never
 *      entered it.
 *   2. Keeping a guest's money **requires a stated reason**. It is the single
 *      most disputed act in this product, and a reason recorded months later
 *      is a reason invented months later. Enforced here and again by the
 *      database, because a support script is a code path too.
 *
 * The booking state machine refuses to complete a stay while
 * `depositHeldAgorot > 0`. This file is what makes that figure true.
 */

import { assertCan, type Actor, type Resource } from '../authz/can'
import type { Agorot } from '../booking/types'
import type { DomainEventName } from '../contracts/events'
import type { PaymentMethod, PaymentStatus } from '../contracts/states'
import { BusinessRuleError } from '../errors'
import { formatAgorot } from '../plans/plan'
import { CURRENCY } from './money'
import type { Deposit } from './types'

// ── The authorization view ────────────────────────────────────────────────

export function depositResource(deposit: Deposit): Resource {
  return {
    organizationId: deposit.organizationId,
    propertyId: deposit.propertyId,
  }
}

// ── Creation ──────────────────────────────────────────────────────────────

export interface DepositDraft {
  id: string
  organizationId: string
  propertyId: string
  bookingId: string
  requiredAgorot: Agorot
  method?: PaymentMethod | null
}

/**
 * A deposit that has been asked for and not yet taken.
 *
 * Born `pending`, holding nothing. `requiredAgorot` may be zero — plenty of
 * businesses take no deposit — and a zero deposit is a real record rather than
 * an absence, so a screen can say "no deposit required" instead of leaving the
 * question open.
 */
export function createDeposit(draft: DepositDraft, now: Date): Deposit {
  if (!Number.isInteger(draft.requiredAgorot) || draft.requiredAgorot < 0) {
    throw new BusinessRuleError({
      code: 'finance.invalid_deposit_amount',
      userMessage: 'סכום הפיקדון חייב להיות מספר שלם של אגורות, ולא שלילי.',
      message: `Invalid required deposit: ${draft.requiredAgorot}`,
    })
  }

  return {
    id: draft.id,
    organizationId: draft.organizationId,
    propertyId: draft.propertyId,
    bookingId: draft.bookingId,
    status: 'pending',
    method: draft.method ?? null,
    requiredAgorot: draft.requiredAgorot,
    heldAgorot: 0,
    releasedAgorot: 0,
    forfeitedAgorot: 0,
    currency: CURRENCY,
    paymentId: null,
    forfeitReason: null,
    authorizedAt: null,
    capturedAt: null,
    releasedAt: null,
    releasedByUserId: null,
    forfeitedAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  }
}

// ── Position ──────────────────────────────────────────────────────────────

export interface DepositPosition {
  requiredAgorot: Agorot
  /** Still reserved. What stops the booking from completing. */
  outstandingHoldAgorot: Agorot
  releasedAgorot: Agorot
  forfeitedAgorot: Agorot
  /** Nothing is reserved any more. The stay can close. */
  settled: boolean
}

export function depositPosition(deposit: Deposit): DepositPosition {
  const outstanding = availableHold(deposit)
  return {
    requiredAgorot: deposit.requiredAgorot,
    outstandingHoldAgorot: outstanding,
    releasedAgorot: deposit.releasedAgorot,
    forfeitedAgorot: deposit.forfeitedAgorot,
    settled: outstanding === 0,
  }
}

/** What is still reserved and undisbursed. */
export function availableHold(deposit: Deposit): Agorot {
  return deposit.heldAgorot - deposit.releasedAgorot - deposit.forfeitedAgorot
}

/** The invariant, checked on every movement rather than trusted. */
function assertWithinHold(deposit: Deposit): void {
  const disbursed = deposit.releasedAgorot + deposit.forfeitedAgorot
  if (disbursed <= deposit.heldAgorot) return
  throw new BusinessRuleError({
    code: 'finance.deposit_over_disbursed',
    userMessage: 'אירעה תקלה בחישוב הפיקדון. פנה לתמיכה.',
    message:
      `Deposit ${deposit.id} disburses ${disbursed} agorot from a hold of ` +
      `${deposit.heldAgorot}`,
  })
}

// ── The result of a movement ──────────────────────────────────────────────

export interface DepositChange {
  deposit: Deposit
  /** The catalogue event to publish after the transaction commits. */
  event: DomainEventName
  /** The Hebrew sentence for the audit trail, built where the meaning is. */
  summary: string
}

function moved(
  deposit: Deposit,
  patch: Partial<Deposit>,
  status: PaymentStatus,
  now: Date,
): Deposit {
  return {
    ...deposit,
    ...patch,
    status,
    updatedAt: now,
    version: deposit.version + 1,
  }
}

// ── Authorise ─────────────────────────────────────────────────────────────

/**
 * Reserve the deposit on the card.
 *
 * `heldAgorot` is what the provider says it reserved, not what we asked for.
 * Providers reduce an authorisation for their own reasons, and recording our
 * request as though it were their answer is how a business comes to believe it
 * is holding ₪1,000 that was never held.
 */
export function authorizeDeposit(
  actor: Actor,
  deposit: Deposit,
  heldAgorot: Agorot,
  options: { now: Date; paymentId?: string | null },
): DepositChange {
  assertCan(actor, 'deposit.hold', depositResource(deposit))

  if (!Number.isInteger(heldAgorot) || heldAgorot <= 0) {
    throw new BusinessRuleError({
      code: 'finance.invalid_authorization',
      userMessage: 'סכום ההקפאה בכרטיס חייב להיות מספר שלם וגדול מאפס.',
      message: `Invalid deposit authorization: ${heldAgorot}`,
    })
  }
  if (deposit.heldAgorot > 0) {
    throw new BusinessRuleError({
      code: 'finance.deposit_already_held',
      userMessage: 'כבר מוקפא פיקדון בהזמנה הזו. שחרר אותו לפני הקפאה חדשה.',
      message: `Deposit ${deposit.id} already holds ${deposit.heldAgorot}`,
    })
  }

  const next = moved(
    deposit,
    {
      heldAgorot,
      paymentId: options.paymentId ?? deposit.paymentId,
      authorizedAt: options.now,
    },
    'authorized',
    options.now,
  )
  assertWithinHold(next)

  return {
    deposit: next,
    event: 'deposit.authorized',
    summary: `הוקפא פיקדון ביטחון של ${formatAgorot(heldAgorot)} בכרטיס האורח.`,
  }
}

// ── Forfeit, in whole or in part ──────────────────────────────────────────

/**
 * Keep part or all of the deposit, and give back the rest.
 *
 * The remainder is released in the same movement — see the header. A forfeit
 * equal to the whole hold leaves nothing to release and lands on `paid`; a
 * smaller one lands on `partially_paid`, which is precisely what that status
 * is for.
 *
 * The reason is required, not encouraged.
 */
export function forfeitDeposit(
  actor: Actor,
  deposit: Deposit,
  amountAgorot: Agorot,
  options: { now: Date; reason: string; paymentId?: string | null },
): DepositChange {
  // Keeping a guest's money is a capture, so it needs the capture right — not
  // the right to place a hold, which costs the guest nothing permanent.
  assertCan(actor, 'payment.capture', depositResource(deposit))

  const available = availableHold(deposit)

  if (!Number.isInteger(amountAgorot) || amountAgorot <= 0) {
    throw new BusinessRuleError({
      code: 'finance.invalid_deposit_forfeit',
      userMessage: 'סכום הניכוי מהפיקדון חייב להיות מספר שלם וגדול מאפס.',
      message: `Invalid deposit forfeit: ${amountAgorot}`,
    })
  }
  if (options.reason.trim().length === 0) {
    throw new BusinessRuleError({
      code: 'finance.deposit_forfeit_needs_reason',
      userMessage:
        'ניכוי מפיקדון דורש נימוק. פרט מה נמצא ומה העלות, כדי שהאורח יקבל הסבר.',
      message: 'forfeitDeposit called without a stated reason',
    })
  }
  if (amountAgorot > available) {
    throw new BusinessRuleError({
      code: 'finance.deposit_forfeit_exceeds_hold',
      userMessage:
        `לא ניתן לנכות ${formatAgorot(amountAgorot)} — ` +
        `הסכום המוקפא בכרטיס הוא ${formatAgorot(available)}.`,
      message:
        `Deposit forfeit ${amountAgorot} exceeds available ${available} on ` +
        `deposit ${deposit.id}`,
      publicDetails: { requested: amountAgorot, held: available },
    })
  }

  const remainder = available - amountAgorot

  const next = moved(
    deposit,
    {
      forfeitedAgorot: deposit.forfeitedAgorot + amountAgorot,
      // The untouched remainder goes back now, not eventually.
      releasedAgorot: deposit.releasedAgorot + remainder,
      forfeitReason: options.reason,
      forfeitedAt: options.now,
      capturedAt: options.now,
      releasedAt: remainder > 0 ? options.now : deposit.releasedAt,
      paymentId: options.paymentId ?? deposit.paymentId,
    },
    remainder === 0 ? 'paid' : 'partially_paid',
    options.now,
  )
  assertWithinHold(next)

  return {
    deposit: next,
    event: 'deposit.captured',
    summary:
      `נוכה מהפיקדון ${formatAgorot(amountAgorot)} (${options.reason})` +
      (remainder > 0 ? `, ויתרת ${formatAgorot(remainder)} שוחררה.` : '.'),
  }
}

// ── Release ───────────────────────────────────────────────────────────────

/**
 * Give the hold back untouched.
 *
 * Only legal while nothing has been forfeited. Once a deduction has been made
 * the instrument is a refund against the charge that took it, not a release,
 * and the two are different documents to a guest.
 */
export function releaseDeposit(
  actor: Actor,
  deposit: Deposit,
  options: { now: Date },
): DepositChange {
  assertCan(actor, 'deposit.release', depositResource(deposit))

  const available = availableHold(deposit)

  if (deposit.forfeitedAgorot > 0) {
    throw new BusinessRuleError({
      code: 'finance.deposit_already_forfeited',
      userMessage:
        'כבר נוכה סכום מהפיקדון הזה, ולכן לא ניתן לשחרר אותו. יש לבצע החזר.',
      message: `Deposit ${deposit.id} has ${deposit.forfeitedAgorot} forfeited`,
    })
  }
  if (available === 0) {
    throw new BusinessRuleError({
      code: 'finance.no_deposit_held',
      userMessage: 'אין פיקדון מוקפא בהזמנה הזו, ולכן אין מה לשחרר.',
      message: `Deposit ${deposit.id} holds nothing`,
    })
  }

  const next = moved(
    deposit,
    {
      releasedAgorot: deposit.releasedAgorot + available,
      releasedAt: options.now,
      releasedByUserId: actor.userId,
    },
    'cancelled',
    options.now,
  )
  assertWithinHold(next)

  return {
    deposit: next,
    event: 'deposit.released',
    summary: `שוחרר פיקדון ביטחון של ${formatAgorot(available)} לאורח.`,
  }
}
