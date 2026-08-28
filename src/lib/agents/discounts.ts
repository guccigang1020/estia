/**
 * Discounts — a ceiling that escalates rather than one that refuses.
 *
 * Every agent has a discount cap. Going over it does **not** produce an error;
 * it produces an approval request addressed to the business.
 *
 * That is the sharpest product decision in the module and it is worth stating
 * plainly. A refusal does not end the negotiation — it moves it to WhatsApp.
 * Once it is there, there is no record of what was offered, the system holds a
 * price nobody is selling at, and the argument that follows in a month has no
 * evidence on either side. Escalating keeps the deal inside the product, where
 * it can be approved, declined, priced and audited.
 *
 * ── What the approver is shown ────────────────────────────────────────────
 *
 * The booking, the current price, the requested price — and **the commission
 * that falls out of it**. The commission is not decoration: an eight per cent
 * discount that drops the margin below what the agent is owed is not a deal,
 * and the owner has to see that before approving rather than in next month's
 * report. `DiscountApprovalView` carries the figure for that reason and the
 * request cannot be built without it.
 *
 * ── Unanswered requests expire ────────────────────────────────────────────
 *
 * A request nobody answers must not hold a sale open forever. `expired` is one
 * of the frozen approval statuses precisely for this, and the expiry is decided
 * on read against the clock — the same discipline holds uses — so a stalled
 * background job cannot leave a stale request looking live.
 */

import type { Decision } from '../authz/can'
import type { Agorot } from '../booking/types'
import type { ApprovalStatus, ApprovalType } from '../contracts/states'
import { BusinessRuleError, ValidationError } from '../errors'
import { calculateCommission, type CommissionRule } from './commission'

// ── The cap ───────────────────────────────────────────────────────────────

/**
 * How far this agent may cut a price on their own authority.
 *
 * Two ceilings, and the tighter one wins. A percentage alone is fine on a
 * two-night cabin and alarming on a fortnight in a villa, so a business may
 * also state an absolute number. `maxAgorot: null` means no absolute ceiling.
 *
 * `maxPercent: 0` is meaningful and is the conservative default: this agent
 * discounts nothing without asking. It is not the same as having no cap.
 */
export interface AgentDiscountCap {
  maxPercent: number
  maxAgorot: Agorot | null
}

export const NO_DISCOUNT_ALLOWED: AgentDiscountCap = {
  maxPercent: 0,
  maxAgorot: null,
}

/**
 * How long an unanswered request stands.
 *
 * The specification does not state a number — §15 lists the numeric values
 * among what was not recovered — so this is a default, not a product rule, and
 * it is overridable per request.
 */
export const DEFAULT_DISCOUNT_APPROVAL_MINUTES = 24 * 60

// ── The request ───────────────────────────────────────────────────────────

/** Exactly what §7 says the owner sees, and the commission alongside it. */
export interface DiscountApprovalView {
  bookingReference: string
  currentTotalAgorot: Agorot
  requestedTotalAgorot: Agorot
  discountAgorot: Agorot
  discountPercent: number
  /** The ceiling this request went over, so the decision has its context. */
  capPercent: number
  /**
   * The ask and the ceiling in basis points.
   *
   * `public.approvals` stores `requested_value_bps` and `limit_value_bps` as
   * integers, because a percentage held as a float eventually fails an equality
   * check against itself. Carried here so writing the row is a mapping rather
   * than a conversion somebody has to remember to perform.
   */
  requestedValueBps: number
  limitValueBps: number
  commissionBeforeAgorot: Agorot
  commissionAfterAgorot: Agorot
  /** Negative when the discount costs the business more than it saves. */
  marginDeltaAgorot: Agorot
  /** One Hebrew sentence, for the notification and the audit trail. */
  summary: string
}

export interface DiscountApproval {
  id: string
  organizationId: string
  type: Extract<ApprovalType, 'discount'>
  status: ApprovalStatus
  requestedByUserId: string
  bookingId: string
  /**
   * Why, in the agent's own words. Required, and non-blank.
   *
   * `public.approvals.reason` is `not null` with a length check behind it, and
   * the migration's reasoning is the reasoning here: a request nobody can
   * evaluate is a request that gets approved out of politeness.
   */
  reason: string
  view: DiscountApprovalView
  requestedAt: string
  /** Never null. A request without an expiry is a sale held open forever. */
  expiresAt: string
  /**
   * Set only by an actual decision.
   *
   * `approvals_decided_pair` in the migration makes `decided_at is not null`
   * exactly equivalent to `status in ('approved','rejected')`. Expiry and
   * withdrawal are therefore **not** decisions and leave this null — stamping
   * them would violate the constraint and invent a decider for something nobody
   * decided.
   */
  decidedAt: string | null
  decidedByUserId: string | null
  decisionNote: string | null
}

// ── Evaluating one ────────────────────────────────────────────────────────

export interface EvaluateDiscountInput {
  approvalId: string
  organizationId: string
  agentUserId: string
  bookingId: string
  bookingReference: string
  currentTotalAgorot: Agorot
  /** Positive agorot to come off the price. */
  discountAgorot: Agorot
  cap: AgentDiscountCap
  /** The agent's rule, so the approver sees what the discount costs twice over. */
  commissionRule: CommissionRule
  /** The commission base before the discount. Usually the stay total. */
  commissionBaseAgorot: Agorot
  /**
   * Why the agent wants it. Carried whether or not the cap is exceeded, because
   * whether it will be is not known until the arithmetic is done — and a
   * request that reaches the owner without one cannot be written to
   * `public.approvals` at all.
   */
  reason: string
  now: Date
  expiresAfterMinutes?: number
}

export type DiscountDecision =
  | {
      outcome: 'within_cap'
      discountAgorot: Agorot
      discountPercent: number
      newTotalAgorot: Agorot
    }
  | {
      outcome: 'requires_approval'
      discountAgorot: Agorot
      discountPercent: number
      newTotalAgorot: Agorot
      approval: DiscountApproval
    }

/**
 * Decide what happens to a requested discount.
 *
 * There is no `refused` outcome, and that absence is the design. The only
 * throws here are for a request that is not a discount at all — a negative
 * amount, or one larger than the price, which is a refund wearing a discount's
 * clothes and is not something a price calculator may invent.
 */
export function evaluateAgentDiscount(
  input: EvaluateDiscountInput,
): DiscountDecision {
  const discountAgorot = Math.round(input.discountAgorot)

  if (!Number.isFinite(discountAgorot) || discountAgorot < 0) {
    throw new BusinessRuleError({
      code: 'discount.invalid_amount',
      message: `Discount must be a positive amount, got ${input.discountAgorot}`,
      userMessage: 'סכום ההנחה חייב להיות חיובי.',
    })
  }

  if (discountAgorot > input.currentTotalAgorot) {
    throw new BusinessRuleError({
      code: 'discount.exceeds_total',
      message: `Discount ${discountAgorot} exceeds total ${input.currentTotalAgorot}`,
      userMessage:
        'ההנחה גדולה ממחיר ההזמנה. הנחה יכולה להוריד את המחיר עד אפס, לא מתחת לו.',
    })
  }

  const discountPercent = percentOf(discountAgorot, input.currentTotalAgorot)
  const newTotalAgorot = input.currentTotalAgorot - discountAgorot

  const overPercent = discountPercent > input.cap.maxPercent + PERCENT_EPSILON
  const overAbsolute =
    input.cap.maxAgorot !== null && discountAgorot > input.cap.maxAgorot

  if (!overPercent && !overAbsolute) {
    return {
      outcome: 'within_cap',
      discountAgorot,
      discountPercent,
      newTotalAgorot,
    }
  }

  // Only now, when the request is actually going to a person, is a reason
  // required. Demanding one for every discount would make the common case —
  // an agent applying the discount they were already granted — a form.
  if (input.reason.trim().length === 0) {
    throw new ValidationError([
      {
        field: 'reason',
        code: 'required',
        message:
          'ההנחה חורגת מהתקרה שלך ולכן היא נשלחת לאישור. הסבר בקצרה מדוע.',
        label: 'סיבה',
      },
    ])
  }

  return {
    outcome: 'requires_approval',
    discountAgorot,
    discountPercent,
    newTotalAgorot,
    approval: buildApproval(
      input,
      discountAgorot,
      discountPercent,
      newTotalAgorot,
    ),
  }
}

/**
 * The same answer, shaped as an authorization `Decision`.
 *
 * `authorize()` cannot produce `requires_approval` on its own — it never sees
 * the value being attempted, and teaching it to would turn an authorization
 * engine into a business-rule engine. So the domain evaluates the ceiling and
 * hands back a `Decision` the service layer composes with the grant check.
 *
 * It is a *denial*. `can()` stays false and every boolean call site fails
 * closed; only a caller that reads the reason learns there is a way forward.
 * That asymmetry is the safe one: forgetting to handle `requires_approval`
 * refuses the discount, it does not apply it.
 */
export function discountDecision(
  cap: AgentDiscountCap,
  discountAgorot: Agorot,
  currentTotalAgorot: Agorot,
): Decision {
  const percent = percentOf(discountAgorot, currentTotalAgorot)
  const overPercent = percent > cap.maxPercent + PERCENT_EPSILON
  const overAbsolute = cap.maxAgorot !== null && discountAgorot > cap.maxAgorot

  if (overPercent || overAbsolute) {
    return {
      allowed: false,
      reason: 'requires_approval',
      grant: 'booking.amend_price',
    }
  }
  return { allowed: true }
}

/**
 * Percentages are compared with a hair of tolerance.
 *
 * Ten per cent of ₪6,433 is ₪643.30, which rounds to an integer number of
 * agorot that is fractionally more than ten per cent. Without this, an agent
 * asking for exactly their cap is escalated for a rounding artefact, and the
 * owner learns to approve without reading.
 */
const PERCENT_EPSILON = 0.0001

function percentOf(part: Agorot, whole: Agorot): number {
  if (whole <= 0) return 0
  return (part * 100) / whole
}

function buildApproval(
  input: EvaluateDiscountInput,
  discountAgorot: Agorot,
  discountPercent: number,
  newTotalAgorot: Agorot,
): DiscountApproval {
  const before = calculateCommission(
    input.commissionRule,
    input.commissionBaseAgorot,
  ).amountAgorot

  // The discount comes off the base the commission is taken on. Anything else
  // would pay the agent commission on money the business did not receive.
  const after = calculateCommission(
    input.commissionRule,
    Math.max(0, input.commissionBaseAgorot - discountAgorot),
  ).amountAgorot

  // What the business keeps changes by the discount it gave *and* by the
  // commission it no longer owes. Both, because either alone misleads.
  const marginDeltaAgorot = -discountAgorot + (before - after)

  const view: DiscountApprovalView = {
    bookingReference: input.bookingReference,
    currentTotalAgorot: input.currentTotalAgorot,
    requestedTotalAgorot: newTotalAgorot,
    discountAgorot,
    discountPercent,
    capPercent: input.cap.maxPercent,
    requestedValueBps: Math.round(discountPercent * 100),
    limitValueBps: Math.round(input.cap.maxPercent * 100),
    commissionBeforeAgorot: before,
    commissionAfterAgorot: after,
    marginDeltaAgorot,
    summary:
      `בקשת הנחה על הזמנה ${input.bookingReference}: ` +
      `${shekels(input.currentTotalAgorot)} → ${shekels(newTotalAgorot)} ` +
      `(הנחה של ${formatPercent(discountPercent)}%, התקרה היא ${formatPercent(input.cap.maxPercent)}%). ` +
      `העמלה תרד מ-${shekels(before)} ל-${shekels(after)}.`,
  }

  const minutes = input.expiresAfterMinutes ?? DEFAULT_DISCOUNT_APPROVAL_MINUTES

  return {
    id: input.approvalId,
    organizationId: input.organizationId,
    type: 'discount',
    status: 'requested',
    requestedByUserId: input.agentUserId,
    bookingId: input.bookingId,
    reason: input.reason.trim(),
    view,
    requestedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + minutes * 60_000).toISOString(),
    decidedAt: null,
    decidedByUserId: null,
    decisionNote: null,
  }
}

// ── Deciding one ──────────────────────────────────────────────────────────

/**
 * Is this request still answerable?
 *
 * Computed against the clock on every read, never trusted from the stored
 * status. A sweeper that stops running would otherwise leave requests looking
 * open for as long as nobody noticed — and somebody would approve one.
 */
export function isDiscountApprovalOpen(
  approval: DiscountApproval,
  now: Date,
): boolean {
  if (approval.status !== 'requested') return false
  const expires = Date.parse(approval.expiresAt)
  // An unparseable expiry is treated as expired: the reading that closes a
  // stale request is safer than the one that leaves it open.
  if (Number.isNaN(expires)) return false
  return expires > now.getTime()
}

export interface DiscountDecisionInput {
  approved: boolean
  decidedByUserId: string
  now: Date
  note?: string | null
}

export function decideDiscountApproval(
  approval: DiscountApproval,
  input: DiscountDecisionInput,
): DiscountApproval {
  if (approval.status !== 'requested') {
    throw new BusinessRuleError({
      code: 'approval.already_decided',
      message: `Approval ${approval.id} is already ${approval.status}`,
      userMessage: 'הבקשה כבר טופלה. רענן את הרשימה כדי לראות את ההחלטה.',
      publicDetails: { status: approval.status },
    })
  }

  if (!isDiscountApprovalOpen(approval, input.now)) {
    throw new BusinessRuleError({
      code: 'approval.expired',
      message: `Approval ${approval.id} expired at ${approval.expiresAt}`,
      userMessage:
        'תוקף בקשת ההנחה פג. אם העסקה עדיין רלוונטית, בקש מהסוכן להגיש בקשה חדשה.',
    })
  }

  // The rule the whole mechanism rests on, and the one the database also
  // refuses through `approvals_no_self_approval`. An agent who can approve
  // their own request has a discount cap in name only — and checking it only in
  // the database would surface as an unreadable constraint violation rather
  // than as a sentence, so it is checked in both places on purpose.
  if (input.decidedByUserId === approval.requestedByUserId) {
    throw new BusinessRuleError({
      code: 'approval.self_approval',
      message: `User ${input.decidedByUserId} cannot decide their own request`,
      userMessage: 'לא ניתן לאשר בקשה שהגשת בעצמך. הבקשה ממתינה לבעל העסק.',
    })
  }

  return {
    ...approval,
    status: input.approved ? 'approved' : 'rejected',
    decidedAt: input.now.toISOString(),
    decidedByUserId: input.decidedByUserId,
    decisionNote: input.note ?? null,
  }
}

/** Close a request nobody answered. Idempotent: an already-closed one is returned. */
export function expireDiscountApproval(
  approval: DiscountApproval,
  now: Date,
): DiscountApproval {
  if (approval.status !== 'requested') return approval
  if (isDiscountApprovalOpen(approval, now)) return approval
  // `decidedAt` stays null. Running out of time is not a decision, and
  // `approvals_decided_pair` in the migration would reject the row that claimed
  // it was — the constraint and this line are the same sentence.
  return { ...approval, status: 'expired' }
}

/**
 * The agent withdrew it — the guest booked elsewhere, or changed their mind.
 *
 * Takes no clock, deliberately. Withdrawal is not a decision and stamps no
 * moment, so there is nothing here for a clock to be used for, and a parameter
 * that exists but is never read is a parameter somebody will one day assume is.
 */
export function withdrawDiscountApproval(
  approval: DiscountApproval,
): DiscountApproval {
  if (approval.status !== 'requested') {
    throw new BusinessRuleError({
      code: 'approval.already_decided',
      message: `Approval ${approval.id} is already ${approval.status}`,
      userMessage: 'הבקשה כבר טופלה ולא ניתן למשוך אותה.',
    })
  }
  return { ...approval, status: 'withdrawn' }
}

// ── Formatting ────────────────────────────────────────────────────────────

function shekels(value: Agorot): string {
  return `₪${(value / 100).toLocaleString('he-IL', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
