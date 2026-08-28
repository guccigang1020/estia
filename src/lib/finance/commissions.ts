/**
 * Commissions — what an agent is owed, and how sure we are of it.
 *
 * The frozen ladder says it: `estimated → pending → eligible → approved →
 * paid`, with `cancelled` reachable from anywhere money has not yet left. A
 * commission is a promise long before it is a debt, and paying on `estimated`
 * means paying for stays that never happened.
 *
 * ── What each rung means ──────────────────────────────────────────────────
 *
 *   `estimated` — the booking exists. Nothing is owed yet; this is a forecast.
 *   `pending`   — the booking is committed. A real liability, not yet earned.
 *   `eligible`  — the business's own conditions are met. Now it is earned.
 *   `approved`  — a person with `commission.approve` has said pay it.
 *   `paid`      — the money has left.
 *
 * `eligible` is the rung that matters, and it is not a judgement — it is the
 * conjunction of stated conditions: the guest paid, the free-cancellation
 * window closed, the stay happened. `evaluateEligibility` reports which
 * conditions are unmet, in Hebrew, so an agent asking "why haven't I been paid"
 * gets an answer instead of a shrug.
 *
 * ── The one asymmetry, and why it is deliberate ───────────────────────────
 *
 * **`paid` is terminal. A paid commission is never cancelled.** When a booking
 * is refunded after the agent has been paid, the money has already left the
 * business and pretending otherwise would make the ledger disagree with the
 * bank. The honest record is `clawbackRequired`, a flag that says a person must
 * recover it — which is a conversation, not a status change.
 *
 * Below `paid`, a refund cancels the commission outright.
 *
 * ── A note on packaging ───────────────────────────────────────────────────
 *
 * Nothing here checks a plan. The agent network is an entitlement and the
 * authorization engine already refuses `commission.*` to an organization that
 * has not bought it. What this module must not do — and does not — is assume
 * every organization *has* agents: a booking with no `agentUserId` produces no
 * commission at all, and every P&L path treats a missing commission as zero
 * rather than as an error.
 */

import { assertCan, type Actor, type Resource } from '../authz/can'
import type { Grant } from '../authz/permissions'
import type { BookingStatus } from '../booking/types'
import type { Agorot } from '../booking/types'
import type { DomainEventName } from '../contracts/events'
import { COMMISSION_STATUSES, type CommissionStatus } from '../contracts/states'
import { BusinessRuleError } from '../errors'
import { formatAgorot } from '../plans/plan'
import { sumAgorot } from './money'
import { commissionFromRule } from './pnl'
import type {
  Commission,
  CommissionRule,
  CommissionStatement,
  PayoutBatch,
} from './types'

// ── Naming ────────────────────────────────────────────────────────────────

export const COMMISSION_STATUS_LABEL: Record<CommissionStatus, string> = {
  estimated: 'משוערת',
  pending: 'ממתינה לזכאות',
  eligible: 'זכאית לתשלום',
  approved: 'מאושרת לתשלום',
  paid: 'שולמה',
  cancelled: 'בוטלה',
}

export const TERMINAL_COMMISSION_STATUSES: readonly CommissionStatus[] = [
  'paid',
  'cancelled',
]

const TERMINAL = new Set<CommissionStatus>(TERMINAL_COMMISSION_STATUSES)

export function commissionResource(commission: Commission): Resource {
  return {
    organizationId: commission.organizationId,
    propertyId: commission.propertyId,
  }
}

// ── Eligibility conditions ────────────────────────────────────────────────

/**
 * What the business asks before a commission is earned.
 *
 * Data rather than a chain of `if`s, so a business can require two of the
 * three and the reason an agent has not been paid is a list of unmet named
 * conditions rather than a boolean nobody can explain.
 */
export const COMMISSION_CONDITIONS = [
  'payment_received',
  'cancellation_window_passed',
  'stay_completed',
] as const

export type CommissionConditionCode = (typeof COMMISSION_CONDITIONS)[number]

export interface EligibilityContext {
  bookingStatus: BookingStatus
  /** What the guest has actually paid, net of refunds. */
  settledAgorot: Agorot
  /** What the booking is worth in all. */
  billedAgorot: Agorot
  /** The end of free cancellation. `null` where the business offers none. */
  freeCancellationUntil: Date | null
  now: Date
}

export interface EligibilityPolicy {
  requires: readonly CommissionConditionCode[]
  /**
   * How much of the booking must be settled for `payment_received` to hold.
   *
   * Percent points. The default of 100 is the conservative reading — an agent
   * is paid out of money the business is actually holding. A business that
   * pays on the deposit sets it lower, deliberately.
   */
  settledPercentRequired: number
}

export const DEFAULT_ELIGIBILITY_POLICY: EligibilityPolicy = {
  requires: [
    'payment_received',
    'cancellation_window_passed',
    'stay_completed',
  ],
  settledPercentRequired: 100,
}

export interface UnmetCondition {
  code: CommissionConditionCode
  /** Hebrew, and about the fact rather than the rule. */
  message: string
}

const COMPLETED_STATUSES: ReadonlySet<BookingStatus> = new Set([
  'checked_out',
  'inspection',
  'deposit_release',
  'review_requested',
  'completed',
])

/**
 * Which conditions do not hold yet.
 *
 * An empty list means eligible. The list is the product feature: it is what an
 * agent portal shows beside a commission that has not moved, and it is what
 * stops a support conversation from being a guess.
 */
export function evaluateEligibility(
  context: EligibilityContext,
  policy: EligibilityPolicy = DEFAULT_ELIGIBILITY_POLICY,
): readonly UnmetCondition[] {
  const unmet: UnmetCondition[] = []

  for (const code of policy.requires) {
    switch (code) {
      case 'payment_received': {
        const required = Math.ceil(
          (context.billedAgorot * policy.settledPercentRequired) / 100,
        )
        if (context.settledAgorot < required) {
          unmet.push({
            code,
            message:
              `טרם התקבל מלוא התשלום מההזמנה — התקבלו ` +
              `${formatAgorot(context.settledAgorot)} מתוך ` +
              `${formatAgorot(required)}.`,
          })
        }
        break
      }
      case 'cancellation_window_passed': {
        if (
          context.freeCancellationUntil !== null &&
          context.now < context.freeCancellationUntil
        ) {
          unmet.push({
            code,
            message: 'תקופת הביטול ללא עלות טרם הסתיימה.',
          })
        }
        break
      }
      case 'stay_completed': {
        if (!COMPLETED_STATUSES.has(context.bookingStatus)) {
          unmet.push({ code, message: 'השהות טרם הסתיימה.' })
        }
        break
      }
      default:
        break
    }
  }

  return unmet
}

export function isEligible(
  context: EligibilityContext,
  policy: EligibilityPolicy = DEFAULT_ELIGIBILITY_POLICY,
): boolean {
  return evaluateEligibility(context, policy).length === 0
}

// ── The state machine ─────────────────────────────────────────────────────

export interface CommissionTransition {
  to: CommissionStatus
  from: readonly CommissionStatus[]
  permission: Grant
  requiresReason: boolean
  auditAction: string
  event: DomainEventName
}

/**
 * Every legal move.
 *
 * The permissions are the point. `commission.approve` and `commission.payout`
 * are held by different people from `agent_agreement.manage`, deliberately:
 * whoever writes the commission rule does not also release the money. Both are
 * in `SENSITIVE_ACTIONS`, so the service pipeline demands a stated reason on
 * top of the permission.
 */
export const COMMISSION_TRANSITIONS: readonly CommissionTransition[] = [
  {
    to: 'pending',
    from: ['estimated'],
    permission: 'agent_agreement.manage',
    requiresReason: true,
    auditAction: 'commission.pending',
    event: 'commission.created',
  },
  {
    to: 'eligible',
    from: ['estimated', 'pending'],
    permission: 'agent_agreement.manage',
    requiresReason: true,
    auditAction: 'commission.became_eligible',
    event: 'commission.became_eligible',
  },
  {
    to: 'approved',
    from: ['eligible'],
    permission: 'commission.approve',
    requiresReason: true,
    auditAction: 'commission.approved',
    event: 'commission.approved',
  },
  {
    to: 'paid',
    from: ['approved'],
    permission: 'commission.payout',
    requiresReason: true,
    auditAction: 'commission.paid',
    event: 'commission.paid',
  },
  {
    to: 'cancelled',
    from: ['estimated', 'pending', 'eligible', 'approved'],
    permission: 'agent_agreement.manage',
    requiresReason: true,
    auditAction: 'commission.cancelled',
    event: 'commission.cancelled',
  },
]

export function findCommissionTransition(
  from: CommissionStatus,
  to: CommissionStatus,
): CommissionTransition | null {
  return (
    COMMISSION_TRANSITIONS.find(
      (transition) => transition.to === to && transition.from.includes(from),
    ) ?? null
  )
}

export interface CommissionChange {
  commission: Commission
  transition: CommissionTransition
  event: DomainEventName
  summary: string
}

/**
 * Move a commission, or refuse.
 *
 * Legality first, then permission — the same order as everywhere else in the
 * product, so an agent attempting to approve their own commission is told they
 * may not, rather than being told something about the business's cash position
 * that they were not entitled to learn.
 */
export function moveCommission(
  actor: Actor,
  commission: Commission,
  to: CommissionStatus,
  options: { now: Date; reason?: string | null },
): CommissionChange {
  if (TERMINAL.has(commission.status)) {
    throw new BusinessRuleError({
      code: 'finance.commission_terminal',
      userMessage:
        `העמלה נמצאת במצב "${COMMISSION_STATUS_LABEL[commission.status]}" ` +
        'ולא ניתן לשנות אותה יותר.',
      message: `Commission ${commission.id} is ${commission.status}`,
    })
  }

  const transition = findCommissionTransition(commission.status, to)
  if (!transition) {
    throw new BusinessRuleError({
      code: 'finance.illegal_commission_transition',
      userMessage:
        `לא ניתן להעביר עמלה ממצב ` +
        `"${COMMISSION_STATUS_LABEL[commission.status]}" למצב ` +
        `"${COMMISSION_STATUS_LABEL[to]}".`,
      message: `Illegal commission transition ${commission.status} → ${to}`,
      publicDetails: { from: commission.status, to },
    })
  }

  assertCan(actor, transition.permission, commissionResource(commission))

  const reason = options.reason ?? null
  if (to === 'cancelled' && (reason === null || reason.trim().length === 0)) {
    // The database says the same thing with a CHECK. Saying it here means the
    // user gets a sentence rather than a constraint violation.
    throw new BusinessRuleError({
      code: 'finance.commission_cancel_needs_reason',
      userMessage: 'ביטול עמלה דורש נימוק.',
      message: 'Commission cancellation without a reason',
    })
  }

  const moved: Commission = {
    ...commission,
    status: to,
    becameEligibleAt:
      to === 'eligible' && commission.becameEligibleAt === null
        ? options.now
        : commission.becameEligibleAt,
    approvedByUserId:
      to === 'approved' ? actor.userId : commission.approvedByUserId,
    paidAt: to === 'paid' ? options.now : commission.paidAt,
    cancelledReason: to === 'cancelled' ? reason : commission.cancelledReason,
    version: commission.version + 1,
  }

  return {
    commission: moved,
    transition,
    event: transition.event,
    summary: commissionSummary(moved, to),
  }
}

function commissionSummary(
  commission: Commission,
  to: CommissionStatus,
): string {
  const amount = formatAgorot(commission.amountAgorot)
  switch (to) {
    case 'eligible':
      return `עמלת סוכן בסך ${amount} הפכה לזכאית לתשלום.`
    case 'approved':
      return `עמלת סוכן בסך ${amount} אושרה לתשלום.`
    case 'paid':
      return `עמלת סוכן בסך ${amount} שולמה.`
    case 'cancelled':
      return `עמלת סוכן בסך ${amount} בוטלה: ${commission.cancelledReason}.`
    default:
      return (
        `עמלת סוכן בסך ${amount} עברה למצב ` +
        `"${COMMISSION_STATUS_LABEL[to]}".`
      )
  }
}

// ── Creation ──────────────────────────────────────────────────────────────

export interface CommissionDraft {
  id: string
  organizationId: string
  propertyId: string
  bookingId: string
  agentUserId: string | null
  agencyId?: string | null
  rule: CommissionRule
  /** What the rule is applied to, from the booking's finance snapshot. */
  basisAgorot: Agorot
}

/**
 * A commission, as an estimate.
 *
 * Born `estimated`, always — there is no path that creates one already
 * eligible. `basisAgorot` and `rateBps` are stored beside the amount because a
 * commission nobody can recompute is a commission nobody can defend in an
 * argument, and the argument happens after the agreement has been
 * renegotiated twice.
 */
export function createCommission(
  draft: CommissionDraft,
  now: Date,
): Commission {
  if (draft.agentUserId === null && (draft.agencyId ?? null) === null) {
    throw new BusinessRuleError({
      code: 'finance.commission_has_no_payee',
      userMessage: 'לא ניתן ליצור עמלה ללא סוכן או סוכנות שמקבלים אותה.',
      message: 'createCommission called with neither an agent nor an agency',
    })
  }

  return {
    id: draft.id,
    organizationId: draft.organizationId,
    propertyId: draft.propertyId,
    bookingId: draft.bookingId,
    agentUserId: draft.agentUserId,
    agencyId: draft.agencyId ?? null,
    status: 'estimated',
    basisAgorot: draft.basisAgorot,
    rateBps:
      draft.rule.kind === 'percent' ? Math.round(draft.rule.value * 100) : null,
    amountAgorot: commissionFromRule(draft.rule, draft.basisAgorot),
    rule: draft.rule,
    statementId: null,
    payoutBatchId: null,
    becameEligibleAt: null,
    approvedByUserId: null,
    paidAt: null,
    cancelledReason: null,
    clawbackRequired: false,
    createdAt: now,
    version: 1,
  }
}

// ── Refunds ───────────────────────────────────────────────────────────────

export interface RefundEffect {
  commission: Commission
  /** `null` when the commission was already paid and only a flag was raised. */
  change: CommissionChange | null
  clawbackRequired: boolean
}

/**
 * The booking was refunded. What happens to the agent's money?
 *
 * Below `paid`, the commission is cancelled: nothing was earned on a stay that
 * was given back. At `paid`, it is flagged for clawback and left alone — see
 * the header. Either way the caller is told which happened, because the two
 * demand completely different follow-ups.
 */
export function applyBookingRefundToCommission(
  actor: Actor,
  commission: Commission,
  options: { now: Date; reason: string },
): RefundEffect {
  if (commission.status === 'paid') {
    return {
      commission: {
        ...commission,
        clawbackRequired: true,
        version: commission.version + 1,
      },
      change: null,
      clawbackRequired: true,
    }
  }

  if (commission.status === 'cancelled') {
    return { commission, change: null, clawbackRequired: false }
  }

  const change = moveCommission(actor, commission, 'cancelled', {
    now: options.now,
    reason: options.reason,
  })

  return {
    commission: change.commission,
    change,
    clawbackRequired: false,
  }
}

// ── Statements ────────────────────────────────────────────────────────────

/** Who the money is owed to. An agency keeps the relationship if a person leaves. */
export function payeeKey(commission: Commission): string {
  return commission.agentUserId ?? `agency:${commission.agencyId ?? 'unknown'}`
}

/** Statuses that appear on a statement: earned, whatever has been done since. */
const STATEMENT_STATUSES: ReadonlySet<CommissionStatus> = new Set([
  'eligible',
  'approved',
  'paid',
])

export interface BuildStatementInput {
  id: string
  organizationId: string
  agentUserId: string
  periodStart: string
  periodEnd: string
  commissions: readonly Commission[]
  issuedAt: Date
}

/**
 * What one agent earned in a window.
 *
 * Only commissions that reached `eligible` are listed, and the window is
 * measured on `becameEligibleAt` — the moment the money was earned — rather
 * than on the booking's dates. An agent who sold in January for a stay in
 * August is paid when the conditions are met, not when they sold, and a
 * statement keyed on the stay would show them nothing for months and then
 * everything at once.
 */
export function buildStatement(
  input: BuildStatementInput,
): CommissionStatement {
  const included = input.commissions.filter((commission) => {
    if (commission.organizationId !== input.organizationId) return false
    if (commission.agentUserId !== input.agentUserId) return false
    if (!STATEMENT_STATUSES.has(commission.status)) return false
    if (commission.becameEligibleAt === null) return false
    const on = commission.becameEligibleAt.toISOString().slice(0, 10)
    return on >= input.periodStart && on < input.periodEnd
  })

  return {
    id: input.id,
    organizationId: input.organizationId,
    agentUserId: input.agentUserId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    commissionIds: included.map((commission) => commission.id),
    totalAgorot: sumAgorot(included.map((c) => c.amountAgorot)),
    issuedAt: input.issuedAt,
  }
}

// ── Payout batches ────────────────────────────────────────────────────────

export interface BuildPayoutBatchInput {
  id: string
  organizationId: string
  commissions: readonly Commission[]
  createdAt: Date
}

/**
 * Group approved commissions into one payment run.
 *
 * Every member must already be `approved`. A batch that could quietly include
 * an `eligible` commission would let the approval step be skipped by choosing
 * the right screen, which is the same as not having an approval step.
 */
export function buildPayoutBatch(
  actor: Actor,
  input: BuildPayoutBatchInput,
): PayoutBatch {
  if (input.commissions.length === 0) {
    throw new BusinessRuleError({
      code: 'finance.empty_payout_batch',
      userMessage: 'לא נבחרו עמלות לתשלום.',
      message: 'buildPayoutBatch called with no commissions',
    })
  }

  for (const commission of input.commissions) {
    assertCan(actor, 'commission.payout', commissionResource(commission))
    if (commission.status !== 'approved') {
      throw new BusinessRuleError({
        code: 'finance.commission_not_approved',
        userMessage:
          `עמלה במצב "${COMMISSION_STATUS_LABEL[commission.status]}" ` +
          'אינה יכולה להיכלל במנת תשלום. נדרש אישור תחילה.',
        message: `Commission ${commission.id} is ${commission.status}`,
      })
    }
  }

  return {
    id: input.id,
    organizationId: input.organizationId,
    commissionIds: input.commissions.map((commission) => commission.id),
    totalAgorot: sumAgorot(input.commissions.map((c) => c.amountAgorot)),
    approvedByUserId: actor.userId,
    createdAt: input.createdAt,
    paidAt: null,
  }
}

/** Mark the run as sent, moving every commission in it to `paid`. */
export function payPayoutBatch(
  actor: Actor,
  batch: PayoutBatch,
  commissions: readonly Commission[],
  now: Date,
): { batch: PayoutBatch; changes: readonly CommissionChange[] } {
  const changes = commissions
    .filter((commission) => batch.commissionIds.includes(commission.id))
    .map((commission) =>
      moveCommission(actor, commission, 'paid', {
        now,
        reason: `תשלום במסגרת מנת תשלום ${batch.id}`,
      }),
    )

  return { batch: { ...batch, paidAt: now }, changes }
}

/** The catalogue, for a screen that filters by status. */
export const ALL_COMMISSION_STATUSES = COMMISSION_STATUSES
