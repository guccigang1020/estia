/**
 * Commission — what the business owes an outsider, and when.
 *
 * This is money, so it follows the money rules: integer agorot, one rounding
 * decision made once, explicit state transitions, and a record that can still
 * answer **"why did I get less than we agreed?"** about a booking from last
 * year whose terms have changed twice since.
 *
 * That last question is the reason a commission is a *row* and not a computed
 * field. A figure derived on demand from today's rule is a figure that changes
 * behind an agent's back the day somebody edits the agreement, and the argument
 * that follows cannot be settled because nothing recorded what the deal was at
 * the time. So a commission stores the rule it came from, the base it was taken
 * on, the amount, and a sentence explaining the arithmetic.
 *
 * ── The base is the whole argument ────────────────────────────────────────
 *
 * "Ten per cent" without a stated base is two different numbers held by two
 * people who both think they agreed. The agent counts the whole invoice; the
 * business counts the accommodation. Nobody notices until the first payment.
 * `CommissionBase` makes the answer part of the rule rather than part of the
 * conversation, and it is stored on the commission so it cannot be reread
 * differently later.
 *
 * ── Eligibility is policy, not code ───────────────────────────────────────
 *
 * A commission is created when the booking is, and is a promise rather than a
 * debt until the business's own conditions hold — the guest paid, the
 * cancellation window closed, the stay finished. Which conditions apply is data
 * on the rule. Paying on `estimated` means paying for stays that never happened.
 */

import { roundAgorot } from '../booking/pricing'
import type { Agorot, PriceLine } from '../booking/types'
import { COMMISSION_STATUSES, type CommissionStatus } from '../contracts/states'
import { BusinessRuleError } from '../errors'

// ── How much ──────────────────────────────────────────────────────────────

/**
 * One bracket of a tiered rule.
 *
 * `fromAgorot` is the inclusive lower bound of the bracket, measured on the
 * commission base. The lowest tier must start at zero — a ladder with a hole at
 * the bottom silently pays nothing on small bookings.
 */
export interface CommissionTier {
  fromAgorot: Agorot
  percent: number
}

/**
 * How a tiered rule reads its brackets.
 *
 * Both exist because both are real deals and they pay very differently, and a
 * product that supports one silently is a product that pays the wrong number.
 *
 *   `marginal` — each bracket's rate applies to the part of the base inside it,
 *     the way income tax works. No cliff: one agora more never costs anybody.
 *   `whole` — the rate of the highest bracket reached applies to the entire
 *     base. This is the common volume incentive, and it has a cliff on purpose:
 *     crossing the threshold is meant to be worth crossing.
 */
export type CommissionTierMode = 'marginal' | 'whole'

export type CommissionRule =
  /** An agent with no commission. A real arrangement, and not the same as zero. */
  | { kind: 'none' }
  | { kind: 'percentage'; percent: number }
  | { kind: 'fixed'; amountAgorot: Agorot }
  | {
      kind: 'tiered'
      mode: CommissionTierMode
      tiers: readonly CommissionTier[]
    }

export const COMMISSION_RULE_KINDS = [
  'none',
  'percentage',
  'fixed',
  'tiered',
] as const

// ── On what ───────────────────────────────────────────────────────────────

/**
 * The base is defined once, in `contracts/states`. It was previously declared
 * here, in finance and in preparation — four lists, no two the same — so the
 * identical rule would have paid different amounts depending on which module
 * evaluated it.
 *
 * This module supports two of the six: `stay_total`, everything the guest pays
 * for the stay, and `accommodation_only`, the nights alone without extras,
 * taxes, cleaning fee or deposit. `BASE_INCLUDES` below is what makes that
 * true, and a base it does not list is refused rather than silently treated as
 * gross.
 *
 * A refundable deposit is excluded from both — nobody earns commission on
 * money going back to the guest — and so is a previously written commission
 * line, so recalculating cannot pay commission on commission.
 */
import {
  COMMISSION_BASES,
  COMMISSION_BASE_LABEL,
  type CommissionBase,
} from '../contracts/states'

export { COMMISSION_BASES, COMMISSION_BASE_LABEL }
export type { CommissionBase }

/**
 * Line kinds each base counts. Data, so the rule can be read rather than traced.
 *
 * `Partial`, because the catalogue holds six bases and agent commission is
 * defined for two of them. The others are finance and preparation concepts —
 * net of channel fees, net of direct costs — that cannot be computed from
 * price lines alone. A base absent here is refused rather than quietly
 * treated as gross, which would pay an agent on money the business never saw.
 */
const BASE_INCLUDES: Partial<
  Record<CommissionBase, ReadonlySet<PriceLine['kind']>>
> = {
  stay_total: new Set<PriceLine['kind']>([
    'accommodation',
    'extra_guest',
    'addon',
    'cleaning_fee',
    'discount',
    'promotion',
    'tax',
  ]),
  // Discounts and promotions are counted here even though they may have been
  // given on an extra: a reduction the business actually granted reduces what
  // it actually earned, and the alternative — commission on a price nobody
  // paid — is the version an agent cannot defend either.
  accommodation_only: new Set<PriceLine['kind']>([
    'accommodation',
    'extra_guest',
    'discount',
    'promotion',
  ]),
}

/**
 * The amount the percentage is taken on.
 *
 * Never negative: a stay discounted below zero is not a debt owed to the agent.
 */
export function commissionBaseAmount(
  lines: readonly PriceLine[],
  base: CommissionBase,
): Agorot {
  const included = BASE_INCLUDES[base]

  // Refuse loudly rather than fall back. A base this module cannot compute is
  // a misconfigured commission rule, and defaulting to "count everything"
  // would pay an agent on revenue the business never received — silently, and
  // correctly-looking, every month until somebody audited it.
  if (!included) {
    throw new BusinessRuleError({
      code: 'commission_base_unsupported',
      message: `Commission base "${base}" is not computable from price lines`,
      userMessage: `בסיס העמלה "${COMMISSION_BASE_LABEL[base]}" אינו נתמך בחישוב עמלת סוכן.`,
    })
  }

  const total = lines.reduce(
    (sum, line) => (included.has(line.kind) ? sum + line.amount : sum),
    0,
  )
  return Math.max(0, total)
}

// ── The arithmetic ────────────────────────────────────────────────────────

export interface CommissionCalculation {
  amountAgorot: Agorot
  baseAgorot: Agorot
  /** Hebrew, and specific enough to settle an argument with. */
  explanation: string
}

/**
 * Work out the money.
 *
 * Rounded once, at the end, half away from zero — the same rule and the same
 * function the guest's invoice uses, so a commission and the price it came from
 * never disagree about the last agora.
 */
export function calculateCommission(
  rule: CommissionRule,
  baseAgorot: Agorot,
): CommissionCalculation {
  const base = Math.max(0, Math.round(baseAgorot))

  switch (rule.kind) {
    case 'none':
      return { amountAgorot: 0, baseAgorot: base, explanation: 'ללא עמלה.' }

    case 'percentage':
      return {
        amountAgorot: roundAgorot((base * rule.percent) / 100),
        baseAgorot: base,
        explanation: `${formatPercent(rule.percent)}% מתוך ${formatAgorot(base)}.`,
      }

    case 'fixed':
      return {
        amountAgorot: Math.round(rule.amountAgorot),
        baseAgorot: base,
        explanation: `סכום קבוע של ${formatAgorot(Math.round(rule.amountAgorot))} להזמנה.`,
      }

    case 'tiered':
      return calculateTiered(rule.tiers, rule.mode, base)

    default:
      // Deny by default. An unrecognised rule pays nothing rather than
      // guessing, because guessing here is guessing with somebody's money.
      return {
        amountAgorot: 0,
        baseAgorot: base,
        explanation: 'כלל עמלה לא מזוהה — לא חושבה עמלה.',
      }
  }
}

function calculateTiered(
  tiers: readonly CommissionTier[],
  mode: CommissionTierMode,
  base: Agorot,
): CommissionCalculation {
  const ordered = [...tiers].sort((a, b) => a.fromAgorot - b.fromAgorot)

  if (ordered.length === 0 || ordered[0].fromAgorot > 0) {
    throw new BusinessRuleError({
      code: 'commission.tiers_incomplete',
      message: 'A tiered commission rule must have a bracket starting at zero',
      userMessage:
        'מדרגות העמלה אינן שלמות: המדרגה הראשונה חייבת להתחיל מאפס. תקן את ההסכם.',
    })
  }

  if (mode === 'whole') {
    const reached = [...ordered]
      .reverse()
      .find((tier) => base >= tier.fromAgorot)
    // Unreachable while the zero bracket exists, and kept so a future edit
    // cannot turn a missing bracket into a silent full-rate payment.
    const percent = reached?.percent ?? 0
    return {
      amountAgorot: roundAgorot((base * percent) / 100),
      baseAgorot: base,
      explanation:
        `מדרגה שלמה: ${formatPercent(percent)}% על כל ${formatAgorot(base)} ` +
        `(המדרגה שנפתחה מ-${formatAgorot(reached?.fromAgorot ?? 0)}).`,
    }
  }

  // Marginal. Accumulated exactly and rounded once at the end, so a base that
  // straddles four brackets is not rounded four times.
  let exact = 0
  const parts: string[] = []
  for (let index = 0; index < ordered.length; index += 1) {
    const tier = ordered[index]
    const upper = ordered[index + 1]?.fromAgorot ?? Number.POSITIVE_INFINITY
    const portion = Math.max(0, Math.min(base, upper) - tier.fromAgorot)
    if (portion === 0) continue
    exact += (portion * tier.percent) / 100
    parts.push(`${formatPercent(tier.percent)}% על ${formatAgorot(portion)}`)
  }

  return {
    amountAgorot: roundAgorot(exact),
    baseAgorot: base,
    explanation: `מדרגות: ${parts.join(' + ')}.`,
  }
}

// ── Where a rule applies ──────────────────────────────────────────────────

/**
 * The dimensions §8 names: property, unit, period, rate plan.
 *
 * `null` means "any", which is not the same as an empty array. An empty array
 * matches nothing, and that distinction is the difference between "this rule
 * covers every property" and "somebody saved the property picker with nothing
 * selected".
 */
export interface CommissionScope {
  propertyIds: readonly string[] | null
  unitIds: readonly string[] | null
  ratePlanIds: readonly string[] | null
  /** Stays arriving inside this window. Inclusive at both ends. */
  period: { from: string; to: string } | null
}

export const ANY_SCOPE: CommissionScope = {
  propertyIds: null,
  unitIds: null,
  ratePlanIds: null,
  period: null,
}

export interface CommissionContext {
  organizationId: string
  agentUserId: string
  agencyId: string | null
  propertyId: string | null
  unitId: string
  ratePlanId: string | null
  /** The stay's arrival date, which is what `period` is measured against. */
  checkIn: string
}

export function scopeMatches(
  scope: CommissionScope,
  context: CommissionContext,
): boolean {
  if (!listMatches(scope.propertyIds, context.propertyId)) return false
  if (!listMatches(scope.unitIds, context.unitId)) return false
  if (!listMatches(scope.ratePlanIds, context.ratePlanId)) return false

  if (scope.period !== null) {
    if (context.checkIn < scope.period.from) return false
    if (context.checkIn > scope.period.to) return false
  }

  return true
}

function listMatches(
  allowed: readonly string[] | null,
  value: string | null,
): boolean {
  if (allowed === null) return true
  if (value === null) return false
  return allowed.includes(value)
}

/** How many dimensions a scope pins down. Used to break a priority tie. */
export function scopeSpecificity(scope: CommissionScope): number {
  let count = 0
  if (scope.propertyIds !== null) count += 1
  if (scope.unitIds !== null) count += 1
  if (scope.ratePlanIds !== null) count += 1
  if (scope.period !== null) count += 1
  return count
}

// ── When it becomes real ──────────────────────────────────────────────────

export const COMMISSION_CONDITIONS = [
  'deposit_received',
  'payment_received',
  'guest_arrived',
  'stay_completed',
  'cancellation_window_passed',
] as const

export type CommissionCondition = (typeof COMMISSION_CONDITIONS)[number]

export const COMMISSION_CONDITION_LABEL: Record<CommissionCondition, string> = {
  deposit_received: 'התקבלה מקדמה',
  payment_received: 'התקבל תשלום',
  guest_arrived: 'האורח הגיע',
  stay_completed: 'השהות הסתיימה',
  cancellation_window_passed: 'חלון הביטול עבר',
}

/** All of them must hold. An empty list means eligible as soon as it is pending. */
export interface CommissionEligibility {
  conditions: readonly CommissionCondition[]
}

export type CommissionFacts = Record<CommissionCondition, boolean>

export const NO_FACTS: CommissionFacts = {
  deposit_received: false,
  payment_received: false,
  guest_arrived: false,
  stay_completed: false,
  cancellation_window_passed: false,
}

/** What is still missing. Returned rather than a boolean so a person can be told. */
export function unmetConditions(
  eligibility: CommissionEligibility,
  facts: CommissionFacts,
): readonly CommissionCondition[] {
  return eligibility.conditions.filter((condition) => facts[condition] !== true)
}

export function isCommissionEligible(
  eligibility: CommissionEligibility,
  facts: CommissionFacts,
): boolean {
  return unmetConditions(eligibility, facts).length === 0
}

// ── The rule record ───────────────────────────────────────────────────────

/**
 * A commission rule as it is stored.
 *
 * `version` is not decoration. Editing a rule writes a new version rather than
 * overwriting, and a commission points at the version it was computed under, so
 * last year's booking still explains itself under last year's terms.
 */
export interface CommissionRuleRecord {
  id: string
  organizationId: string
  /** The agent this rule is for, or `null` when it is the agency's. */
  agentUserId: string | null
  agencyId: string | null
  rule: CommissionRule
  base: CommissionBase
  scope: CommissionScope
  eligibility: CommissionEligibility
  /** Higher wins. Equal priorities are broken by specificity, then by id. */
  priority: number
  /** ISO dates bounding when the rule may be applied at all. */
  effectiveFrom: string | null
  effectiveUntil: string | null
  version: number
}

/**
 * The one rule that governs this booking, or `null`.
 *
 * Deterministic on purpose, and tie-broken all the way down to the id: two
 * rules that both match and both look equally good must not pay different
 * amounts depending on the order a query happened to return them.
 *
 * An agent-specific rule beats the agency's, because the specific arrangement
 * is the one that was negotiated with this person.
 */
export function selectCommissionRule(
  rules: readonly CommissionRuleRecord[],
  context: CommissionContext,
  on: string,
): CommissionRuleRecord | null {
  const candidates = rules.filter((record) => {
    if (record.organizationId !== context.organizationId) return false
    if (record.effectiveFrom !== null && on < record.effectiveFrom) return false
    if (record.effectiveUntil !== null && on > record.effectiveUntil) {
      return false
    }
    if (record.agentUserId !== null) {
      if (record.agentUserId !== context.agentUserId) return false
    } else if (record.agencyId !== null) {
      if (record.agencyId !== context.agencyId) return false
    } else {
      // Neither: a rule that belongs to nobody governs nobody.
      return false
    }
    return scopeMatches(record.scope, context)
  })

  if (candidates.length === 0) return null

  return candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    const specific = scopeSpecificity(b.scope) - scopeSpecificity(a.scope)
    if (specific !== 0) return specific
    // An agent's own rule outranks the agency's at equal weight.
    const personal =
      Number(b.agentUserId !== null) - Number(a.agentUserId !== null)
    if (personal !== 0) return personal
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })[0]
}

// ── The commission record ─────────────────────────────────────────────────

/**
 * A commission, shaped to `public.commissions` in migration 0011.
 *
 * The field names track the columns so that persisting one is a mapping rather
 * than a translation. Four of that table's constraints are business rules this
 * module has to honour rather than discover at insert time:
 *
 *   · `commissions_approved_has_moment` — `approved` requires both a moment
 *     and an approver, so recording who approved is not optional;
 *   · `commissions_cancelled_has_reason` — a cancelled commission carries a
 *     non-blank reason. Money written off without one cannot be explained
 *     afterwards, and "why was I not paid for this?" is the question the whole
 *     record exists to answer;
 *   · `commissions_booking_agent_idx` — one live commission per booking per
 *     payee. Recalculating means cancelling and replacing, never inserting a
 *     second;
 *   · `property_id` is `not null`, because the booking foreign key is a
 *     composite over `(id, organization_id, property_id)`.
 *
 * `ruleId`, `ruleVersion`, `explanation` and `eligibility` have no columns of
 * their own and belong in `metadata`. See the note at the foot of this file.
 */
export interface Commission {
  id: string
  organizationId: string
  /** Not null in the table: the booking foreign key is composite over it. */
  propertyId: string
  bookingId: string
  /**
   * The named person owed the money, or `null` when an agency is.
   *
   * Nullable because `commissions.agent_user_id` is, and because the reason it
   * is nullable is a real commercial fact rather than a schema accident: an
   * agency keeps the relationship when the individual who sold the stay
   * leaves, and `commissions_has_a_payee` says only that *one of the two* is
   * present. `Commission` in `src/lib/finance/commissions.ts` has always
   * modelled it this way; this is the agent domain catching up rather than a
   * new possibility being introduced.
   */
  agentUserId: string | null
  agencyId: string | null
  /** The rule and the version it was computed under. Never re-derived. */
  ruleId: string | null
  ruleVersion: number | null
  status: CommissionStatus
  base: CommissionBase
  /** `basis_agorot` — what the rate was taken on. */
  basisAgorot: Agorot
  /**
   * `rate_bps` — the rate as basis points, when a single rate is true.
   *
   * Null for a fixed amount and for a tiered rule. Storing `1000` for "the ten
   * per cent tier" of a marginal calculation would be a number that does not
   * reproduce the amount sitting beside it, which is worse than storing none.
   */
  rateBps: number | null
  amountAgorot: Agorot
  currency: string
  /** The arithmetic, in Hebrew, frozen at creation. */
  explanation: string
  eligibility: CommissionEligibility
  createdAt: string
  eligibleAt: string | null
  approvedAt: string | null
  approvedByUserId: string | null
  paidAt: string | null
  /** `payout_reference` — the business's own reference for the payment. */
  payoutReference: string | null
  cancelledAt: string | null
  cancellationReason: string | null
  version: number
}

export interface CreateCommissionInput {
  id: string
  organizationId: string
  propertyId: string
  bookingId: string
  /** `null` when the payee is the agency. One of the two must be present. */
  agentUserId: string | null
  agencyId: string | null
  lines: readonly PriceLine[]
  rule: CommissionRuleRecord | null
  now: Date
}

/** The single rate a rule implies, in basis points, or null when none does. */
function rateBpsFor(rule: CommissionRule | undefined): number | null {
  if (rule === undefined) return null
  return rule.kind === 'percentage' ? Math.round(rule.percent * 100) : null
}

/**
 * The commission a booking produces, at `estimated`.
 *
 * A booking with no matching rule still produces a record, at zero. The
 * alternative — no row — makes "was this sale commissionable?" unanswerable
 * later, and the answer "there was no rule that day" is worth storing.
 *
 * A commission owed to nobody is refused, because `commissions_has_a_payee`
 * refuses it and a record that cannot be written should not be built. Both
 * fields being nullable is the schema saying "one of the two", not "either or
 * neither" — the same guard `commissionFromDraft` makes in the finance
 * domain.
 */
export function createCommission(input: CreateCommissionInput): Commission {
  if (input.agentUserId === null && input.agencyId === null) {
    throw new BusinessRuleError({
      code: 'commission.no_payee',
      message: `Commission ${input.id} names neither an agent nor an agency`,
      userMessage: 'לא ניתן לחשב עמלה בלי לציין למי היא משולמת.',
    })
  }

  const base = input.rule?.base ?? 'stay_total'
  const baseAgorot = commissionBaseAmount(input.lines, base)
  const calculation = calculateCommission(
    input.rule?.rule ?? { kind: 'none' },
    baseAgorot,
  )

  return {
    id: input.id,
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    bookingId: input.bookingId,
    agentUserId: input.agentUserId,
    agencyId: input.agencyId,
    ruleId: input.rule?.id ?? null,
    ruleVersion: input.rule?.version ?? null,
    status: 'estimated',
    base,
    basisAgorot: calculation.baseAgorot,
    rateBps: rateBpsFor(input.rule?.rule),
    amountAgorot: calculation.amountAgorot,
    currency: 'ILS',
    explanation:
      input.rule === null
        ? 'לא נמצא כלל עמלה תקף במועד ההזמנה — לא חושבה עמלה.'
        : `${COMMISSION_BASE_LABEL[base]}: ${calculation.explanation}`,
    eligibility: input.rule?.eligibility ?? { conditions: [] },
    createdAt: input.now.toISOString(),
    eligibleAt: null,
    approvedAt: null,
    approvedByUserId: null,
    paidAt: null,
    payoutReference: null,
    cancelledAt: null,
    cancellationReason: null,
    version: 1,
  }
}

// ── The state machine ─────────────────────────────────────────────────────

/**
 * `ESTIMATED → PENDING → ELIGIBLE → APPROVED → PAID`, or `CANCELLED`.
 *
 * The vocabulary is frozen in `contracts/states.ts`; this is the graph over it.
 * `paid` is terminal in both directions — reversing a payment is a refund, a
 * separate event with its own money movement, and letting it be a transition
 * here would make the ledger unreadable.
 */
export const COMMISSION_TRANSITIONS: Record<
  CommissionStatus,
  readonly CommissionStatus[]
> = {
  estimated: ['pending', 'cancelled'],
  pending: ['eligible', 'cancelled'],
  eligible: ['approved', 'cancelled'],
  approved: ['paid', 'cancelled'],
  paid: [],
  cancelled: [],
}

export const COMMISSION_STATUS_LABEL: Record<CommissionStatus, string> = {
  estimated: 'משוער',
  pending: 'ממתין',
  eligible: 'זכאי',
  approved: 'מאושר',
  paid: 'שולם',
  cancelled: 'בוטל',
}

export function canTransitionCommission(
  from: CommissionStatus,
  to: CommissionStatus,
): boolean {
  return COMMISSION_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertCommissionTransition(
  from: CommissionStatus,
  to: CommissionStatus,
): void {
  if (canTransitionCommission(from, to)) return
  throw new BusinessRuleError({
    code: 'commission.invalid_transition',
    message: `Commission cannot move from ${from} to ${to}`,
    userMessage:
      `לא ניתן להעביר עמלה מסטטוס "${COMMISSION_STATUS_LABEL[from]}" ` +
      `לסטטוס "${COMMISSION_STATUS_LABEL[to]}".`,
    publicDetails: { from, to },
  })
}

export interface AdvanceCommissionInput {
  to: CommissionStatus
  now: Date
  /** Required when moving to `eligible`. The conditions are checked against it. */
  facts?: CommissionFacts
  /**
   * Who approved it. Required on the `approved` step.
   *
   * `commissions_approved_has_moment` refuses a row that claims an approval
   * without an approver, and the reason is not bookkeeping: an approval nobody
   * signed is money released by nobody.
   */
  approvedByUserId?: string
  /** The payment's own reference, on the `paid` step. */
  payoutReference?: string
  /**
   * Why it was written off. Required on the `cancelled` step.
   *
   * `commissions_cancelled_has_reason` refuses a blank one. This is the field
   * that answers "why was I not paid for this?" a year later.
   */
  reason?: string
}

/**
 * Move a commission, or refuse.
 *
 * Three of the steps carry a condition beyond the graph, and all three are
 * checked here rather than by the caller. Eligibility is the whole reason that
 * status exists, so a caller able to set it directly would be a caller able to
 * pay for a stay nobody turned up to; and the approver and the cancellation
 * reason are refused by the database anyway, where the failure would surface as
 * an unreadable constraint violation instead of a sentence.
 */
export function advanceCommission(
  commission: Commission,
  input: AdvanceCommissionInput,
): Commission {
  assertCommissionTransition(commission.status, input.to)

  if (input.to === 'eligible') {
    const facts = input.facts ?? NO_FACTS
    const missing = unmetConditions(commission.eligibility, facts)
    if (missing.length > 0) {
      throw new BusinessRuleError({
        code: 'commission.conditions_not_met',
        message: `Commission ${commission.id} not eligible: ${missing.join(', ')}`,
        userMessage:
          'העמלה עדיין אינה זכאית. חסר: ' +
          missing.map((c) => COMMISSION_CONDITION_LABEL[c]).join(', ') +
          '.',
        publicDetails: { missing },
      })
    }
  }

  if (input.to === 'approved' && !isPresent(input.approvedByUserId)) {
    throw new BusinessRuleError({
      code: 'commission.approver_required',
      message: `Approving commission ${commission.id} requires an approver`,
      userMessage: 'אישור עמלה מחייב לרשום מי אישר אותה.',
    })
  }

  if (input.to === 'cancelled' && !isPresent(input.reason)) {
    throw new BusinessRuleError({
      code: 'commission.cancellation_reason_required',
      message: `Cancelling commission ${commission.id} requires a reason`,
      userMessage:
        'ביטול עמלה מחייב סיבה. הסבר בקצרה — זו התשובה לשאלה "למה לא קיבלתי".',
    })
  }

  const stamp = input.now.toISOString()
  return {
    ...commission,
    status: input.to,
    eligibleAt: input.to === 'eligible' ? stamp : commission.eligibleAt,
    approvedAt: input.to === 'approved' ? stamp : commission.approvedAt,
    approvedByUserId:
      input.to === 'approved'
        ? (input.approvedByUserId ?? null)
        : commission.approvedByUserId,
    paidAt: input.to === 'paid' ? stamp : commission.paidAt,
    payoutReference:
      input.to === 'paid'
        ? (input.payoutReference ?? commission.payoutReference)
        : commission.payoutReference,
    cancelledAt: input.to === 'cancelled' ? stamp : commission.cancelledAt,
    cancellationReason:
      input.to === 'cancelled'
        ? (input.reason?.trim() ?? null)
        : commission.cancellationReason,
    version: commission.version + 1,
  }
}

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0
}

/**
 * Every commission whose conditions now hold, moved to `eligible`.
 *
 * The job the notification "your commission became eligible" hangs off. Written
 * as a fold over records rather than a query so the condition is evaluated by
 * the same function everywhere — a `WHERE` clause that drifts from
 * `unmetConditions` would pay early and nothing would notice.
 */
export function sweepEligible(
  commissions: readonly Commission[],
  factsFor: (commission: Commission) => CommissionFacts,
  now: Date,
): Commission[] {
  return commissions.map((commission) => {
    if (commission.status !== 'pending') return commission
    if (!isCommissionEligible(commission.eligibility, factsFor(commission))) {
      return commission
    }
    return advanceCommission(commission, {
      to: 'eligible',
      now,
      facts: factsFor(commission),
    })
  })
}

// ── Statements and payouts ────────────────────────────────────────────────

export interface AgentStatementLine {
  commissionId: string
  bookingId: string
  status: CommissionStatus
  amountAgorot: Agorot
  explanation: string
}

export interface AgentStatement {
  id: string
  organizationId: string
  agentUserId: string
  /** Inclusive ISO dates. */
  periodFrom: string
  periodTo: string
  lines: readonly AgentStatementLine[]
  totalAgorot: Agorot
  issuedAt: string
}

/** Statuses that belong on a statement: promised money, not speculative money. */
const STATEMENT_STATUSES: ReadonlySet<CommissionStatus> =
  new Set<CommissionStatus>(['eligible', 'approved', 'paid'])

/**
 * The period statement for one agent.
 *
 * `estimated` and `pending` are excluded deliberately. A statement is a
 * document an agent will treat as a promise, and putting a commission on it for
 * a stay that has not happened invites exactly the argument the whole module
 * exists to prevent.
 */
export function buildAgentStatement(input: {
  id: string
  organizationId: string
  agentUserId: string
  periodFrom: string
  periodTo: string
  commissions: readonly Commission[]
  now: Date
}): AgentStatement {
  const lines = input.commissions
    .filter(
      (commission) =>
        commission.organizationId === input.organizationId &&
        commission.agentUserId === input.agentUserId &&
        STATEMENT_STATUSES.has(commission.status) &&
        commission.createdAt.slice(0, 10) >= input.periodFrom &&
        commission.createdAt.slice(0, 10) <= input.periodTo,
    )
    .map((commission) => ({
      commissionId: commission.id,
      bookingId: commission.bookingId,
      status: commission.status,
      amountAgorot: commission.amountAgorot,
      explanation: commission.explanation,
    }))

  return {
    id: input.id,
    organizationId: input.organizationId,
    agentUserId: input.agentUserId,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    lines,
    totalAgorot: lines.reduce((sum, line) => sum + line.amountAgorot, 0),
    issuedAt: input.now.toISOString(),
  }
}

export interface PayoutBatch {
  id: string
  organizationId: string
  agentUserId: string
  /** The business's own reference. Unique per organization; the retry key. */
  reference: string
  commissionIds: readonly string[]
  totalAgorot: Agorot
  createdAt: string
}

/**
 * Group approved commissions into one payment.
 *
 * Only `approved`. Refusing anything else is the point: a batch that quietly
 * skipped an ineligible line would pay a different total than the one the
 * approver signed off, and a batch that included one would pay for a stay
 * nobody has confirmed happened.
 *
 * A commission already in a batch is refused rather than silently dropped. Paid
 * twice is the failure this guard exists for, and quietly ignoring a duplicate
 * is how it happens with nobody noticing.
 */
export function buildPayoutBatch(input: {
  id: string
  organizationId: string
  agentUserId: string
  reference: string
  commissions: readonly Commission[]
  now: Date
}): PayoutBatch {
  for (const commission of input.commissions) {
    if (commission.organizationId !== input.organizationId) {
      throw new BusinessRuleError({
        code: 'commission.cross_organization',
        message: `Commission ${commission.id} belongs to another organization`,
        userMessage: 'אחת העמלות שייכת לארגון אחר ולכן לא ניתן לשלם אותה כאן.',
      })
    }
    if (commission.agentUserId !== input.agentUserId) {
      throw new BusinessRuleError({
        code: 'commission.wrong_agent',
        message: `Commission ${commission.id} belongs to another agent`,
        userMessage: 'אחת העמלות שייכת לסוכן אחר. תשלום מרוכז הוא לסוכן אחד.',
      })
    }
    if (commission.status !== 'approved') {
      throw new BusinessRuleError({
        code: 'commission.not_approved',
        message: `Commission ${commission.id} is ${commission.status}, not approved`,
        userMessage:
          `לא ניתן לשלם עמלה בסטטוס "${COMMISSION_STATUS_LABEL[commission.status]}". ` +
          'רק עמלות מאושרות נכנסות לתשלום.',
        publicDetails: { status: commission.status },
      })
    }
    if (commission.payoutReference !== null) {
      throw new BusinessRuleError({
        code: 'commission.already_in_batch',
        message:
          `Commission ${commission.id} already carries payout reference ` +
          `${commission.payoutReference}`,
        userMessage: 'אחת העמלות כבר נכללת בתשלום אחר. רענן את הרשימה.',
      })
    }
  }

  return {
    id: input.id,
    organizationId: input.organizationId,
    agentUserId: input.agentUserId,
    reference: input.reference,
    commissionIds: input.commissions.map((commission) => commission.id),
    totalAgorot: input.commissions.reduce(
      (sum, commission) => sum + commission.amountAgorot,
      0,
    ),
    createdAt: input.now.toISOString(),
  }
}

/**
 * Mark a batch's commissions paid.
 *
 * The batch and the `paid` transitions belong together: a batch that recorded a
 * payment while its lines still read `approved` would show the agent money owed
 * that the business believes it has already sent.
 */
export function applyPayoutBatch(
  batch: PayoutBatch,
  commissions: readonly Commission[],
  now: Date,
): Commission[] {
  const inBatch = new Set(batch.commissionIds)
  return commissions.map((commission) =>
    inBatch.has(commission.id)
      ? advanceCommission(commission, {
          to: 'paid',
          now,
          payoutReference: batch.reference,
        })
      : commission,
  )
}

/** Every status, for exhaustive iteration in tests and in the interface. */
export const ALL_COMMISSION_STATUSES = COMMISSION_STATUSES

// ── Formatting ────────────────────────────────────────────────────────────

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** Agorot to shekels, for the explanation sentence. Display only. */
function formatAgorot(value: Agorot): string {
  return `₪${(value / 100).toLocaleString('he-IL', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`
}

/**
 * ── Notes for whoever owns `supabase/migrations/` ─────────────────────────
 *
 * **1. Four domain fields have no column.** `ruleId`, `ruleVersion`,
 * `explanation` and `eligibility` are what let a commission from last year
 * explain itself under last year's terms, and `public.commissions` has nowhere
 * to put them. They fit in `metadata` today, which works and is untyped and
 * unconstrained — nothing stops a row arriving with no rule reference at all,
 * and the first time that matters is during an argument about money. Four
 * columns would close it: `rule_id uuid`, `rule_version integer`,
 * `explanation text`, `eligibility jsonb not null default '[]'::jsonb`.
 *
 * **2. There is no commission-rule table at all.** `CommissionRuleRecord` is
 * the agreement itself — the rate, the base, the scope, the eligibility policy
 * and the version — and nothing persists it. Until it exists the terms live
 * only inside whatever wrote them, and §8's requirement that a rule be "a
 * record with history" is unmet. It needs `agent_commission_rules`, and it is
 * the largest schema gap in this module.
 *
 * **3. There is no payout batch table.** `PayoutBatch` groups approved
 * commissions into one payment and is currently reconstructed from
 * `payout_reference`, which is a text column with no uniqueness and no row of
 * its own. That is enough to record a payment and not enough to reprint one.
 */
