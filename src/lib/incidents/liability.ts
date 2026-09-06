/**
 * Who pays, decided by a person, in integer agorot.
 *
 * ══ THE RULE THIS FILE EXISTS TO MAKE UNBYPASSABLE ═════════════════════════
 *
 * **A comparison never asserts liability. A person decides.**
 *
 * Two photographs of the same worktop, one from Tuesday and one from Friday,
 * are a difference. A difference is evidence. The sentence "the guest owes
 * ₪1,400 for the worktop" is a judgement about a person's conduct with money
 * attached, and there is no arrangement of pixels, timestamps or inventory
 * counts that produces it. Somebody with a name has to look at the difference
 * and say so.
 *
 * That is stated three ways here, because a rule stated once is a rule the
 * next person deletes by accident:
 *
 *   1. `LiabilityDecision.decidedByUserId` is `string` and not
 *      `string | null`. A decision with no decider does not typecheck.
 *   2. `LIABILITY_BASES` contains six things a person can have done and no
 *      value meaning "automatic", "photo comparison" or "detected". A
 *      comparison cannot even name itself as the basis, so a caller trying to
 *      record one has nothing to put in the field.
 *   3. `evaluateLiability` refuses at runtime what the types would let past a
 *      determined caller: a blank decider, a blank rationale, and a decider
 *      whose audit actor type is `system` or `ai_agent`. The nightly job and
 *      the agent can open cases, add evidence and chase vendors; neither can
 *      say whose fault it was.
 *
 * There is deliberately **no** function in this module from differences to a
 * decision. `describeSupport` goes the other way: it takes what a comparison
 * found and produces a citation for a decision a person is making. Nothing in
 * this file can be called with a comparison and return an outcome.
 *
 * ══ AND THE OTHER RULE: THIS MODULE NEVER TAKES MONEY ══════════════════════
 *
 * Applying a security deposit is `money_access_cancellation` in the sense the
 * autopilot catalogue uses the phrase — the most dangerous class of action in
 * the product, the one pinned at `ask_approval` for every customer on every
 * plan. So `planSettlement` produces a *plan*: this much comes off the
 * deposit, this much has to be collected in addition, this much goes back. It
 * captures nothing, charges nothing and calls nothing. The plan is executed by
 * `src/lib/payments` through `resolveCollectionPolicy` and the `deposit.hold`
 * / `deposit.release` / `payment.capture` grants, which is where the guest's
 * agreement, the collection policy and the processor actually live.
 *
 * There is no exported function in this module whose name is `capture`,
 * `charge` or `collect`, and `index.test.ts` asserts that there never is.
 *
 * Pure. No database, no clock, no client.
 */

import type { ActorType } from '../audit/events'
import type { Agorot } from '../booking/types'

/* ----------------------------------------------------------- cost lines -- */

/**
 * The kinds of money a damage case accumulates.
 *
 * Separate kinds rather than one `amount`, because the same case carries an
 * estimate of ₪1,200, a quote of ₪1,650 and an invoice for ₪1,410, and every
 * argument about a deposit is an argument about which of those three the guest
 * is being shown. A single total would have quietly picked one.
 */
export const COST_LINE_KINDS = [
  /** What somebody thought it would cost before anybody quoted. */
  'estimated_damage',
  /** A vendor's written quote. */
  'repair_quote',
  /** What was actually paid to fix it. The only one an invoice backs. */
  'actual_repair',
  /** Buying the thing again rather than repairing it. */
  'replacement',
  /** Extra cleaning beyond a turnover. */
  'extra_cleaning',
  /** A night that could not be sold because the unit was out of service. */
  'lost_revenue',
  'other',
] as const

export type CostLineKind = (typeof COST_LINE_KINDS)[number]

export const COST_LINE_KIND_LABEL: Record<CostLineKind, string> = {
  estimated_damage: 'הערכת נזק',
  repair_quote: 'הצעת מחיר',
  actual_repair: 'עלות תיקון בפועל',
  replacement: 'החלפה',
  extra_cleaning: 'ניקיון נוסף',
  lost_revenue: 'הכנסה שאבדה',
  other: 'אחר',
}

/**
 * The kinds that are somebody's opinion rather than somebody's receipt.
 *
 * Read by `assessedTotal` below: a case is assessed on what it cost, and an
 * estimate is what is shown while nobody knows yet. Summing an estimate
 * together with the invoice that replaced it would double the damage.
 */
export const PROVISIONAL_COST_KINDS: readonly CostLineKind[] = [
  'estimated_damage',
  'repair_quote',
]

/**
 * One line of money on a case.
 *
 * `amountAgorot` is an integer number of agorot and never a float. A shekel
 * value never appears in this module: `1450` is ₪14.50, and the formatting
 * belongs to the screen.
 */
export interface CaseCostLine {
  id: string
  organizationId: string
  caseId: string
  kind: CostLineKind
  description: string
  amountAgorot: Agorot
  /** The day the money was spent or the quote was given. */
  incurredOn: string | null
  /** The invoice or estimate that backs it, when there is one. */
  evidenceId: string | null
  recordedByUserId: string | null
  recordedAt: Date
}

export interface CaseCostLineDraft {
  organizationId: string
  caseId: string
  kind: CostLineKind
  description: string
  amountAgorot: Agorot
  incurredOn: string | null
  evidenceId: string | null
  recordedByUserId: string | null
}

/**
 * Add lines up.
 *
 * A total is a sum of lines and is never stored. The moment a total is a
 * column, it is a column that disagrees with the lines the first time somebody
 * corrects one.
 */
export function sumLines(lines: readonly CaseCostLine[]): Agorot {
  return lines.reduce((total, line) => total + line.amountAgorot, 0)
}

/**
 * What this case actually cost, as opposed to what it was feared to cost.
 *
 * Receipts if there are any; the provisional lines only while there are none.
 * That is the honest reading, and it is the figure a deposit may be argued
 * against.
 */
export function assessedTotal(lines: readonly CaseCostLine[]): Agorot {
  const settled = lines.filter(
    (line) => !PROVISIONAL_COST_KINDS.includes(line.kind),
  )
  return settled.length > 0 ? sumLines(settled) : sumLines(lines)
}

/** The provisional figure, shown while nothing has been invoiced. */
export function provisionalTotal(lines: readonly CaseCostLine[]): Agorot {
  return sumLines(
    lines.filter((line) => PROVISIONAL_COST_KINDS.includes(line.kind)),
  )
}

/* -------------------------------------------------------- the decision --- */

/**
 * Who ends up carrying the cost.
 *
 * `undetermined` is a real outcome and not an absence of one: a person looked,
 * could not tell, and recorded that. It is different from a case with no
 * decision, and the difference is the whole reason it is in the list — a
 * business that absorbs a cost because it could not prove otherwise has made a
 * decision, and it should be able to count how often it makes it.
 */
export const LIABILITY_OUTCOMES = [
  'guest_responsible',
  'owner_responsible',
  'business_expense',
  'shared',
  'undetermined',
] as const

export type LiabilityOutcome = (typeof LIABILITY_OUTCOMES)[number]

export const LIABILITY_OUTCOME_LABEL: Record<LiabilityOutcome, string> = {
  guest_responsible: 'האורח נושא בעלות',
  owner_responsible: 'הבעלים נושא בעלות',
  business_expense: 'הוצאה של העסק',
  shared: 'חלוקה',
  undetermined: 'לא ניתן להכריע',
}

/**
 * On what grounds.
 *
 * Every value is something a person did. There is no `photo_comparison`, no
 * `automatic` and no `detected`, and adding one would be the bypass this file
 * exists to prevent — see the header. A comparison is cited *inside* a
 * decision through `supportingEvidenceIds`, which is a reference to what was
 * looked at, not a claim about what it proved.
 */
export const LIABILITY_BASES = [
  /** Somebody reviewed the evidence on the case and formed a view. */
  'evidence_reviewed',
  /** The guest said it was theirs, in writing, and the statement is attached. */
  'guest_admission',
  /** A vendor's written finding about cause. */
  'vendor_report',
  /** The booking terms, the house rules, the signed contract. */
  'contract_terms',
  /** Somebody asked the people involved and wrote down what they found. */
  'staff_investigation',
  /** No proof either way, and a manager decided anyway. Named as such. */
  'management_judgment',
] as const

export type LiabilityBasis = (typeof LIABILITY_BASES)[number]

export const LIABILITY_BASIS_LABEL: Record<LiabilityBasis, string> = {
  evidence_reviewed: 'עיון בראיות',
  guest_admission: 'הודאת האורח',
  vendor_report: 'חוות דעת ספק',
  contract_terms: 'תנאי ההזמנה',
  staff_investigation: 'בירור מול הצוות',
  management_judgment: 'שיקול דעת של ההנהלה',
}

/**
 * A decision, recorded.
 *
 * Note what is not nullable. `decidedByUserId`, `decidedAt`, `basis` and
 * `rationale` are all required, and that is the type-level half of the rule in
 * the header: there is no way to construct this object without a person, a
 * moment, a ground and a sentence.
 *
 * The three allocation figures sum to `assessedTotalAgorot` exactly.
 * `checkAllocation` enforces it and `evaluateLiability` refuses a draft that
 * breaks it, because a decision that allocates ₪1,410 of a ₪1,400 cost is a
 * decision somebody will discover when a guest disputes ten agorot.
 */
export interface LiabilityDecision {
  id: string
  organizationId: string
  caseId: string
  outcome: LiabilityOutcome
  /** The person. Never null, never a job, never an agent. */
  decidedByUserId: string
  decidedAt: Date
  basis: LiabilityBasis
  /** Why, in words, from the person who decided. Never generated. */
  rationale: string
  /** What the decision is about. Integer agorot. */
  assessedTotalAgorot: Agorot
  guestChargeAgorot: Agorot
  ownerChargeAgorot: Agorot
  businessAbsorbedAgorot: Agorot
  /** What was looked at. A citation, never a justification on its own. */
  supportingEvidenceIds: readonly string[]
  /** Set when this replaces an earlier decision, which is never deleted. */
  supersedesDecisionId: string | null
}

/**
 * What a caller offers, before it is a decision.
 *
 * The nullable fields are nullable *here* on purpose. A form posts what it
 * has, and the refusal has to be a sentence the person reads — not a type
 * error in a server action they cannot see. Everything the output type
 * demands, this type permits to be missing, and `evaluateLiability` is the
 * one place that turns the second into the first.
 */
export interface LiabilityInput {
  organizationId: string
  caseId: string
  outcome: LiabilityOutcome
  decidedByUserId: string | null
  /** The audit actor type of whoever is asking. `user` or nothing. */
  deciderType: ActorType
  decidedAt: Date
  basis: LiabilityBasis | null
  rationale: string | null
  assessedTotalAgorot: Agorot
  guestChargeAgorot: Agorot
  ownerChargeAgorot: Agorot
  businessAbsorbedAgorot: Agorot
  supportingEvidenceIds: readonly string[]
  supersedesDecisionId: string | null
}

/** What a repository is handed. Everything required, nothing derived. */
export type LiabilityDecisionDraft = Omit<LiabilityDecision, 'id'>

/* ------------------------------------------------------------- refusals -- */

export type LiabilityProblem =
  | 'no_decider'
  | 'not_a_person'
  | 'no_basis'
  | 'no_rationale'
  | 'allocation_mismatch'
  | 'negative_amount'
  | 'fractional_amount'
  | 'guest_charge_without_guest_outcome'

export const LIABILITY_PROBLEM_MESSAGE: Record<LiabilityProblem, string> = {
  no_decider: 'הכרעה חייבת לשאת את שמו של מי שהכריע.',
  not_a_person:
    'הכרעת אחריות היא החלטה של אדם. תהליך אוטומטי או סוכן בינה מלאכותית אינם יכולים לקבוע מי אחראי — הם יכולים להציג את ההפרש, וההכרעה נשארת של אדם.',
  no_basis: 'יש לציין על סמך מה הוכרע.',
  no_rationale: 'יש לנמק את ההכרעה במילים.',
  allocation_mismatch:
    'חלוקת הסכומים אינה מסתכמת בסכום שנבחן. הסכומים חייבים להתאים בדיוק.',
  negative_amount: 'סכום שלילי אינו אפשרי בהכרעה.',
  fractional_amount: 'סכומים נשמרים באגורות שלמות.',
  guest_charge_without_guest_outcome:
    'לא ניתן לחייב את האורח בהכרעה שאינה קובעת שהוא נושא בעלות.',
}

export type LiabilityCheck =
  | { ok: true; decision: LiabilityDecisionDraft }
  | { ok: false; problems: readonly LiabilityProblem[] }

/**
 * The allocation, checked on its own.
 *
 * Separate from `evaluateLiability` so a screen can show the shortfall while
 * somebody is still typing, without pretending to submit anything.
 */
export function checkAllocation(input: {
  assessedTotalAgorot: Agorot
  guestChargeAgorot: Agorot
  ownerChargeAgorot: Agorot
  businessAbsorbedAgorot: Agorot
}): { ok: true } | { ok: false; differenceAgorot: number } {
  const allocated =
    input.guestChargeAgorot +
    input.ownerChargeAgorot +
    input.businessAbsorbedAgorot
  const difference = allocated - input.assessedTotalAgorot
  return difference === 0
    ? { ok: true }
    : { ok: false, differenceAgorot: difference }
}

/**
 * Turn an offer into a decision, or say why it is not one.
 *
 * The only constructor of a `LiabilityDecisionDraft` in the product. Every
 * refusal is collected rather than thrown on the first, because a form must
 * not reveal its problems one at a time — the same rule the service pipeline
 * follows for validation.
 */
export function evaluateLiability(input: LiabilityInput): LiabilityCheck {
  const problems: LiabilityProblem[] = []

  const decider = input.decidedByUserId?.trim() ?? ''
  if (decider.length === 0) problems.push('no_decider')

  // The runtime half of the rule. A `system` or `ai_agent` actor may do
  // everything else on a case; it may not be the one who decided.
  if (input.deciderType !== 'user' && input.deciderType !== 'platform_staff') {
    problems.push('not_a_person')
  }

  if (input.basis === null) problems.push('no_basis')

  const rationale = input.rationale?.trim() ?? ''
  if (rationale.length < MIN_RATIONALE_LENGTH) problems.push('no_rationale')

  const amounts = [
    input.assessedTotalAgorot,
    input.guestChargeAgorot,
    input.ownerChargeAgorot,
    input.businessAbsorbedAgorot,
  ]
  if (amounts.some((amount) => amount < 0)) problems.push('negative_amount')
  if (amounts.some((amount) => !Number.isInteger(amount))) {
    problems.push('fractional_amount')
  }

  if (!checkAllocation(input).ok) problems.push('allocation_mismatch')

  // Charging the guest under an outcome that does not say they are
  // responsible is the shape a mistake takes when somebody edits the amounts
  // after picking the outcome.
  if (
    input.guestChargeAgorot > 0 &&
    input.outcome !== 'guest_responsible' &&
    input.outcome !== 'shared'
  ) {
    problems.push('guest_charge_without_guest_outcome')
  }

  if (problems.length > 0) return { ok: false, problems }

  // Every field the output type demands has been established above. The casts
  // are narrowing what the checks already proved, not asserting past them.
  const basis = input.basis
  if (basis === null) return { ok: false, problems: ['no_basis'] }

  return {
    ok: true,
    decision: {
      organizationId: input.organizationId,
      caseId: input.caseId,
      outcome: input.outcome,
      decidedByUserId: decider,
      decidedAt: input.decidedAt,
      basis,
      rationale,
      assessedTotalAgorot: input.assessedTotalAgorot,
      guestChargeAgorot: input.guestChargeAgorot,
      ownerChargeAgorot: input.ownerChargeAgorot,
      businessAbsorbedAgorot: input.businessAbsorbedAgorot,
      supportingEvidenceIds: input.supportingEvidenceIds,
      supersedesDecisionId: input.supersedesDecisionId,
    },
  }
}

/** Short enough that nobody is blocked, long enough that "ok" is refused. */
export const MIN_RATIONALE_LENGTH = 10

/* --------------------------------------------------------- the citation -- */

/**
 * What a comparison contributes to a decision: a citation, and nothing else.
 *
 * This is the *only* function in the module that touches comparison output,
 * and note its return type. It produces a list of evidence ids and a count of
 * differences. It does not produce an outcome, an amount, a basis or a
 * suggestion, and it cannot be composed into one — `evaluateLiability` demands
 * three things this has no way to supply.
 */
export interface LiabilitySupport {
  /** How many differences the comparison found. A count, not a verdict. */
  differenceCount: number
  /** The evidence a decision may cite. */
  evidenceIds: readonly string[]
}

export function describeSupport(input: {
  differenceCount: number
  evidenceIds: readonly string[]
}): LiabilitySupport {
  return {
    differenceCount: input.differenceCount,
    evidenceIds: [...input.evidenceIds],
  }
}

/* --------------------------------------------------------- the deposit --- */

/**
 * What the money would have to do, if somebody decides to do it.
 *
 * Every field is a number and an instruction to a different module. Nothing
 * here moves anything: see the header. `requiresPaymentFlow` is always true
 * and is in the type so that a caller reading this object cannot come away
 * believing the settlement has happened.
 */
export interface SettlementPlan {
  /** What the decision says the guest owes. */
  guestChargeAgorot: Agorot
  /** What is currently held as a deposit against this stay. */
  depositHeldAgorot: Agorot
  /** How much of the charge the held deposit covers. */
  fromDepositAgorot: Agorot
  /** What is still owed after the deposit is applied. */
  additionalCollectionAgorot: Agorot
  /** What goes back to the guest. */
  releaseToGuestAgorot: Agorot
  /**
   * Always `true`. Applying a deposit is `money_access_cancellation`: it goes
   * through `src/lib/payments` and the `deposit.hold` / `deposit.release` /
   * `payment.capture` grants, and never through this module.
   */
  requiresPaymentFlow: true
}

/**
 * Split a charge against a held deposit.
 *
 * Integer arithmetic throughout — no division, no rounding, no rate. Three
 * subtractions and a clamp, which is why there is no case where a shekel
 * appears or disappears.
 */
export function planSettlement(input: {
  guestChargeAgorot: Agorot
  depositHeldAgorot: Agorot
}): SettlementPlan {
  const charge = Math.max(0, Math.trunc(input.guestChargeAgorot))
  const held = Math.max(0, Math.trunc(input.depositHeldAgorot))

  const fromDeposit = Math.min(charge, held)

  return {
    guestChargeAgorot: charge,
    depositHeldAgorot: held,
    fromDepositAgorot: fromDeposit,
    additionalCollectionAgorot: charge - fromDeposit,
    releaseToGuestAgorot: held - fromDeposit,
    requiresPaymentFlow: true,
  }
}

/**
 * The sentence a screen prints beside a settlement plan.
 *
 * Written here rather than in a component because the words are the rule: a
 * reader must not be able to look at this panel and think the deposit has been
 * taken.
 */
export const SETTLEMENT_NOT_EXECUTED_NOTE =
  'זהו חישוב בלבד. חיוב פיקדון, גבייה נוספת או החזר מתבצעים דרך מסלול התשלומים ' +
  'ובהרשאות שלו, ולא מהמסך הזה.'
