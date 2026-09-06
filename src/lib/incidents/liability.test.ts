/**
 * A person decides. A comparison does not.
 *
 * This is the file the whole module is built around, so the tests are written
 * as the attempts somebody would actually make: post the decision without a
 * decider, post it as the nightly job, post it as an AI agent, and try to
 * assemble one out of what a photo comparison produced. All four are refused,
 * and the fourth is refused by there being nothing to call.
 */

import { describe, expect, it } from 'vitest'

import * as liability from './liability'
import {
  MIN_RATIONALE_LENGTH,
  assessedTotal,
  checkAllocation,
  describeSupport,
  evaluateLiability,
  planSettlement,
  provisionalTotal,
  sumLines,
  type CaseCostLine,
  type LiabilityInput,
} from './liability'

const ORG = 'org-1'
const CASE = 'case-1'
const AT = new Date('2026-04-10T09:00:00.000Z')

function input(overrides: Partial<LiabilityInput> = {}): LiabilityInput {
  return {
    organizationId: ORG,
    caseId: CASE,
    outcome: 'guest_responsible',
    decidedByUserId: 'user-manager',
    deciderType: 'user',
    decidedAt: AT,
    basis: 'evidence_reviewed',
    rationale: 'הכיריים היו תקינות בבדיקה שלפני הכניסה ושרוטות ביציאה.',
    assessedTotalAgorot: 141_000,
    guestChargeAgorot: 141_000,
    ownerChargeAgorot: 0,
    businessAbsorbedAgorot: 0,
    supportingEvidenceIds: ['ev-1', 'ev-2'],
    supersedesDecisionId: null,
    ...overrides,
  }
}

function line(overrides: Partial<CaseCostLine> = {}): CaseCostLine {
  return {
    id: 'cost-1',
    organizationId: ORG,
    caseId: CASE,
    kind: 'actual_repair',
    description: 'החלפת משטח עבודה',
    amountAgorot: 141_000,
    incurredOn: '2026-04-08',
    evidenceId: 'ev-3',
    recordedByUserId: 'user-manager',
    recordedAt: AT,
    ...overrides,
  }
}

/* ──────────────────────── the rule, four ways ───────────────────────────── */

describe('a liability decision without a decider', () => {
  it('is refused', () => {
    const result = evaluateLiability(input({ decidedByUserId: null }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain('no_decider')
  })

  it('is refused when the decider is whitespace', () => {
    const result = evaluateLiability(input({ decidedByUserId: '   ' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain('no_decider')
  })

  it('cannot be constructed with a null decider at the type level either', () => {
    // `LiabilityDecision.decidedByUserId` is `string`, not `string | null`. The
    // only constructor in the product is `evaluateLiability`, and it produced
    // nothing above. This asserts the successful path does fill it.
    const result = evaluateLiability(input())
    expect(result.ok).toBe(true)
    expect(result.ok === true && result.decision.decidedByUserId).toBe(
      'user-manager',
    )
  })
})

describe('a decision recorded by something that is not a person', () => {
  it('is refused for a scheduled job', () => {
    const result = evaluateLiability(input({ deciderType: 'system' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain('not_a_person')
  })

  it('is refused for an AI agent', () => {
    const result = evaluateLiability(input({ deciderType: 'ai_agent' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain('not_a_person')
  })

  it('is refused for the guest themselves', () => {
    // A guest admission is a *basis* a person may decide on, attached as
    // evidence. It is not the guest deciding their own liability.
    const result = evaluateLiability(input({ deciderType: 'guest' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain('not_a_person')
  })
})

describe('a photo comparison alone', () => {
  it('cannot name itself as a basis, because no such basis exists', () => {
    expect(liability.LIABILITY_BASES).not.toContain('photo_comparison')
    expect(liability.LIABILITY_BASES).not.toContain('automatic')
    for (const basis of liability.LIABILITY_BASES) {
      expect(basis).not.toMatch(/auto|comparison|detect|ai|model/i)
    }
  })

  it('produces a citation and never an outcome', () => {
    const support = describeSupport({
      differenceCount: 3,
      evidenceIds: ['ev-1', 'ev-2'],
    })

    expect(Object.keys(support).sort()).toEqual([
      'differenceCount',
      'evidenceIds',
    ])
    for (const forbidden of [
      'outcome',
      'basis',
      'amount',
      'liable',
      'charge',
    ]) {
      expect(Object.keys(support)).not.toContain(forbidden)
    }
  })

  it('cannot be assembled into a decision — there is nothing to supply', () => {
    // The only path to a decision demands three things a comparison has no
    // way to produce: a person, a basis and a sentence. Handing it the
    // comparison's output and nothing else is refused on all three.
    const support = describeSupport({
      differenceCount: 3,
      evidenceIds: ['ev-1', 'ev-2'],
    })

    const attempt = evaluateLiability(
      input({
        decidedByUserId: null,
        deciderType: 'ai_agent',
        basis: null,
        rationale: null,
        supportingEvidenceIds: support.evidenceIds,
      }),
    )

    expect(attempt.ok).toBe(false)
    expect(attempt.ok === false && [...attempt.problems].sort()).toEqual([
      'no_basis',
      'no_decider',
      'no_rationale',
      'not_a_person',
    ])
  })

  it('has no function in the module that turns differences into a verdict', () => {
    const exported = Object.keys(liability)
    for (const name of exported) {
      expect(name).not.toMatch(/^(infer|assert|decideFrom|liabilityFrom)/)
    }
  })
})

describe('a decision with no reasoning', () => {
  it('is refused for a blank rationale', () => {
    const result = evaluateLiability(input({ rationale: '   ' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain('no_rationale')
  })

  it('is refused for "ok"', () => {
    const result = evaluateLiability(input({ rationale: 'בסדר' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain('no_rationale')
    expect(MIN_RATIONALE_LENGTH).toBeGreaterThan(2)
  })
})

/* ────────────────────────────── the money ───────────────────────────────── */

describe('the arithmetic', () => {
  it('refuses an allocation that does not sum to what was assessed', () => {
    const result = evaluateLiability(
      input({ guestChargeAgorot: 141_010, assessedTotalAgorot: 141_000 }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain(
      'allocation_mismatch',
    )
    expect(
      checkAllocation({
        assessedTotalAgorot: 141_000,
        guestChargeAgorot: 141_010,
        ownerChargeAgorot: 0,
        businessAbsorbedAgorot: 0,
      }),
    ).toEqual({ ok: false, differenceAgorot: 10 })
  })

  it('refuses a fractional amount, because money is integer agorot', () => {
    const result = evaluateLiability(
      input({ guestChargeAgorot: 141_000.5, assessedTotalAgorot: 141_000.5 }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain(
      'fractional_amount',
    )
  })

  it('refuses a negative amount', () => {
    const result = evaluateLiability(
      input({
        outcome: 'shared',
        guestChargeAgorot: 200_000,
        ownerChargeAgorot: -59_000,
        assessedTotalAgorot: 141_000,
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain('negative_amount')
  })

  it('refuses charging the guest under an outcome that clears them', () => {
    const result = evaluateLiability(
      input({ outcome: 'business_expense', guestChargeAgorot: 141_000 }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain(
      'guest_charge_without_guest_outcome',
    )
  })

  it('allows a shared outcome to split it', () => {
    const result = evaluateLiability(
      input({
        outcome: 'shared',
        guestChargeAgorot: 70_500,
        businessAbsorbedAgorot: 70_500,
      }),
    )
    expect(result.ok).toBe(true)
  })
})

describe('the total', () => {
  it('is a sum of lines and is never stored', () => {
    const lines = [line(), line({ id: 'cost-2', amountAgorot: 8_900 })]
    expect(sumLines(lines)).toBe(149_900)
  })

  it('prefers receipts over estimates once there are any', () => {
    // An estimate of ₪1,200 and an invoice for ₪1,410 summed together would be
    // a ₪2,610 case, and somebody would argue about the number.
    const lines = [
      line({ id: 'c1', kind: 'estimated_damage', amountAgorot: 120_000 }),
      line({ id: 'c2', kind: 'actual_repair', amountAgorot: 141_000 }),
    ]
    expect(assessedTotal(lines)).toBe(141_000)
    expect(provisionalTotal(lines)).toBe(120_000)
  })

  it('falls back to the estimate while nothing has been invoiced', () => {
    const lines = [
      line({ id: 'c1', kind: 'estimated_damage', amountAgorot: 120_000 }),
    ]
    expect(assessedTotal(lines)).toBe(120_000)
  })
})

/* ──────────────────────────── the deposit ───────────────────────────────── */

describe('applying a deposit', () => {
  it('produces a plan and never a movement', () => {
    const plan = planSettlement({
      guestChargeAgorot: 141_000,
      depositHeldAgorot: 100_000,
    })

    expect(plan.fromDepositAgorot).toBe(100_000)
    expect(plan.additionalCollectionAgorot).toBe(41_000)
    expect(plan.releaseToGuestAgorot).toBe(0)
    // The field exists so a reader of the object cannot come away believing
    // the money moved.
    expect(plan.requiresPaymentFlow).toBe(true)
  })

  it('returns the remainder when the deposit covers the charge', () => {
    const plan = planSettlement({
      guestChargeAgorot: 30_000,
      depositHeldAgorot: 100_000,
    })
    expect(plan.fromDepositAgorot).toBe(30_000)
    expect(plan.additionalCollectionAgorot).toBe(0)
    expect(plan.releaseToGuestAgorot).toBe(70_000)
  })

  it('never invents or loses an agora', () => {
    for (const charge of [0, 1, 99, 100_000, 141_000, 999_999]) {
      for (const held of [0, 1, 50_000, 141_000]) {
        const plan = planSettlement({
          guestChargeAgorot: charge,
          depositHeldAgorot: held,
        })
        expect(plan.fromDepositAgorot + plan.additionalCollectionAgorot).toBe(
          charge,
        )
        expect(plan.fromDepositAgorot + plan.releaseToGuestAgorot).toBe(held)
        expect(Number.isInteger(plan.fromDepositAgorot)).toBe(true)
      }
    }
  })

  it('exports nothing that takes money', () => {
    // Charging a deposit is `money_access_cancellation`. It goes through
    // `src/lib/payments` and its grants, and there is no door out of this
    // module.
    for (const name of Object.keys(liability)) {
      expect(name).not.toMatch(/^(capture|charge|collect|refund|takePayment)/i)
    }
  })
})
