/**
 * Discounts.
 *
 * The rule under test is a product decision as much as a technical one:
 * exceeding the cap **raises an approval rather than refusing**. A refusal ends
 * the negotiation inside the product and restarts it on WhatsApp, where there
 * is no record, no real price in the system, and nothing anybody can settle an
 * argument with later.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DISCOUNT_APPROVAL_MINUTES,
  NO_DISCOUNT_ALLOWED,
  decideDiscountApproval,
  discountDecision,
  evaluateAgentDiscount,
  expireDiscountApproval,
  isDiscountApprovalOpen,
  withdrawDiscountApproval,
  type AgentDiscountCap,
  type EvaluateDiscountInput,
} from './discounts'
import { BusinessRuleError, ValidationError } from '../errors'

const NOW = new Date('2026-09-01T10:00:00.000Z')
const AGENT = 'agent-1'
const OWNER = 'owner-1'

const CAP: AgentDiscountCap = { maxPercent: 5, maxAgorot: null }

function input(
  over: Partial<EvaluateDiscountInput> = {},
): EvaluateDiscountInput {
  return {
    approvalId: 'approval-1',
    organizationId: 'org-a',
    agentUserId: AGENT,
    bookingId: 'booking-1',
    bookingReference: 'BK-1043',
    currentTotalAgorot: 640_000, // ₪6,400
    discountAgorot: 32_000, // ₪320 = exactly 5%
    cap: CAP,
    commissionRule: { kind: 'percentage', percent: 10 },
    commissionBaseAgorot: 640_000,
    reason: 'הלקוח מזמין שלוש יחידות',
    now: NOW,
    ...over,
  }
}

// ── Inside the cap ────────────────────────────────────────────────────────

describe('a discount within the cap', () => {
  it('is simply applied', () => {
    const decision = evaluateAgentDiscount(input({ discountAgorot: 20_000 }))
    expect(decision.outcome).toBe('within_cap')
    // 640000 − 20000 = 620000
    expect(decision.newTotalAgorot).toBe(620_000)
  })

  it('allows a discount of exactly the cap', () => {
    // ₪320 of ₪6,400 is exactly 5%.
    const decision = evaluateAgentDiscount(input())
    expect(decision.outcome).toBe('within_cap')
    expect(decision.discountPercent).toBeCloseTo(5, 10)
  })

  it('is not escalated by a rounding artefact at the boundary', () => {
    // 10% of ₪6,433 is ₪643.30, which as an integer number of agorot is
    // fractionally over 10%. Escalating that teaches an owner to approve
    // without reading.
    const decision = evaluateAgentDiscount(
      input({
        currentTotalAgorot: 643_300,
        discountAgorot: 64_330,
        cap: { maxPercent: 10, maxAgorot: null },
      }),
    )
    expect(decision.outcome).toBe('within_cap')
  })

  it('needs no reason, because the common case must not be a form', () => {
    const decision = evaluateAgentDiscount(
      input({ discountAgorot: 10_000, reason: '' }),
    )
    expect(decision.outcome).toBe('within_cap')
  })
})

// ── Over the cap ──────────────────────────────────────────────────────────

describe('a discount over the cap', () => {
  const over = () => evaluateAgentDiscount(input({ discountAgorot: 76_800 })) // 12%

  it('raises an approval and does not refuse', () => {
    const decision = over()
    expect(decision.outcome).toBe('requires_approval')
  })

  it('shows the owner the booking, both prices, and the commission', () => {
    const decision = over()
    if (decision.outcome !== 'requires_approval')
      throw new Error('expected escalation')

    const { view } = decision.approval
    expect(view.bookingReference).toBe('BK-1043')
    expect(view.currentTotalAgorot).toBe(640_000)
    expect(view.requestedTotalAgorot).toBe(563_200) // 640000 − 76800
    expect(view.discountAgorot).toBe(76_800)
    expect(view.capPercent).toBe(5)

    // The figure that makes the decision real. 10% of the base before and
    // after: 64000 → 56320.
    expect(view.commissionBeforeAgorot).toBe(64_000)
    expect(view.commissionAfterAgorot).toBe(56_320)
  })

  it('shows what the business actually loses, not just the discount', () => {
    // The discount costs ₪768; the commission it no longer owes gives ₪76.80
    // back. −76800 + (64000 − 56320) = −69120.
    const decision = over()
    if (decision.outcome !== 'requires_approval')
      throw new Error('expected escalation')
    expect(decision.approval.view.marginDeltaAgorot).toBe(-69_120)
  })

  it('carries the ask and the ceiling as basis points for the row', () => {
    const decision = over()
    if (decision.outcome !== 'requires_approval')
      throw new Error('expected escalation')
    expect(decision.approval.view.requestedValueBps).toBe(1200)
    expect(decision.approval.view.limitValueBps).toBe(500)
  })

  it('writes a Hebrew summary a person can act on', () => {
    const decision = over()
    if (decision.outcome !== 'requires_approval')
      throw new Error('expected escalation')
    const { summary } = decision.approval.view
    expect(summary).toContain('BK-1043')
    expect(summary).toContain('12%')
    expect(summary).toContain('5%')
  })

  it('demands a reason, because the database and the owner both need one', () => {
    expect(() =>
      evaluateAgentDiscount(input({ discountAgorot: 76_800, reason: '   ' })),
    ).toThrow(ValidationError)
  })

  it('escalates on the absolute ceiling even when the percentage is fine', () => {
    // 2% of a large booking is still ₪2,000 in cash.
    const decision = evaluateAgentDiscount(
      input({
        currentTotalAgorot: 10_000_000,
        discountAgorot: 200_000,
        cap: { maxPercent: 5, maxAgorot: 100_000 },
      }),
    )
    expect(decision.outcome).toBe('requires_approval')
  })

  it('escalates everything when the agent may discount nothing', () => {
    // `maxPercent: 0` is the conservative default and is meaningful: this agent
    // asks about every discount. It is not the same as having no cap.
    const decision = evaluateAgentDiscount(
      input({ discountAgorot: 100, cap: NO_DISCOUNT_ALLOWED }),
    )
    expect(decision.outcome).toBe('requires_approval')
  })

  it('gives the request a mandatory expiry', () => {
    const decision = over()
    if (decision.outcome !== 'requires_approval')
      throw new Error('expected escalation')
    const expected = new Date(
      NOW.getTime() + DEFAULT_DISCOUNT_APPROVAL_MINUTES * 60_000,
    ).toISOString()
    expect(decision.approval.expiresAt).toBe(expected)
  })
})

// ── Not a discount at all ─────────────────────────────────────────────────

describe('what is refused outright', () => {
  it('refuses a negative amount', () => {
    expect(() =>
      evaluateAgentDiscount(input({ discountAgorot: -100 })),
    ).toThrow(BusinessRuleError)
  })

  it('refuses a discount larger than the price', () => {
    // A refund wearing a discount's clothes. A price calculator does not get to
    // invent one.
    expect(() =>
      evaluateAgentDiscount(input({ discountAgorot: 700_000 })),
    ).toThrow(BusinessRuleError)
  })

  it('allows a discount down to exactly zero', () => {
    const decision = evaluateAgentDiscount(
      input({
        discountAgorot: 640_000,
        cap: { maxPercent: 100, maxAgorot: null },
      }),
    )
    expect(decision.outcome).toBe('within_cap')
    expect(decision.newTotalAgorot).toBe(0)
  })
})

// ── As an authorization decision ──────────────────────────────────────────

describe('the decision handed to the service layer', () => {
  it('reports requires_approval as a denial, so callers fail closed', () => {
    // `can()` stays false. A caller that forgets to read the reason refuses the
    // discount — it does not apply it.
    const decision = discountDecision(CAP, 76_800, 640_000)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('requires_approval')
  })

  it('allows a discount inside the cap', () => {
    expect(discountDecision(CAP, 20_000, 640_000).allowed).toBe(true)
  })

  it('never reports requires_approval as permission', () => {
    const decision = discountDecision(NO_DISCOUNT_ALLOWED, 1, 640_000)
    expect(decision.allowed).toBe(false)
  })
})

// ── Deciding ──────────────────────────────────────────────────────────────

describe('deciding a request', () => {
  function pending() {
    const decision = evaluateAgentDiscount(input({ discountAgorot: 76_800 }))
    if (decision.outcome !== 'requires_approval')
      throw new Error('expected escalation')
    return decision.approval
  }

  it('approves it', () => {
    const decided = decideDiscountApproval(pending(), {
      approved: true,
      decidedByUserId: OWNER,
      now: NOW,
    })
    expect(decided.status).toBe('approved')
    expect(decided.decidedByUserId).toBe(OWNER)
    expect(decided.decidedAt).toBe(NOW.toISOString())
  })

  it('rejects it', () => {
    const decided = decideDiscountApproval(pending(), {
      approved: false,
      decidedByUserId: OWNER,
      now: NOW,
      note: 'המרווח נמוך מדי',
    })
    expect(decided.status).toBe('rejected')
    expect(decided.decisionNote).toBe('המרווח נמוך מדי')
  })

  it('refuses to let the requester approve their own request', () => {
    // The rule the whole mechanism rests on. An agent who can approve their own
    // request has a cap in name only — and the database refuses the row too,
    // where it would surface as an unreadable constraint violation.
    expect(() =>
      decideDiscountApproval(pending(), {
        approved: true,
        decidedByUserId: AGENT,
        now: NOW,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses to decide the same request twice', () => {
    const decided = decideDiscountApproval(pending(), {
      approved: true,
      decidedByUserId: OWNER,
      now: NOW,
    })
    expect(() =>
      decideDiscountApproval(decided, {
        approved: false,
        decidedByUserId: OWNER,
        now: NOW,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses to decide an expired request', () => {
    const later = new Date(NOW.getTime() + 25 * 60 * 60_000)
    expect(() =>
      decideDiscountApproval(pending(), {
        approved: true,
        decidedByUserId: OWNER,
        now: later,
      }),
    ).toThrow(BusinessRuleError)
  })
})

// ── Expiry ────────────────────────────────────────────────────────────────

describe('an unanswered request', () => {
  function pending() {
    const decision = evaluateAgentDiscount(input({ discountAgorot: 76_800 }))
    if (decision.outcome !== 'requires_approval')
      throw new Error('expected escalation')
    return decision.approval
  }

  it('is open while its time stands', () => {
    expect(isDiscountApprovalOpen(pending(), NOW)).toBe(true)
  })

  it('is closed once its time passes, whether or not a job has run', () => {
    const later = new Date(NOW.getTime() + 25 * 60 * 60_000)
    expect(isDiscountApprovalOpen(pending(), later)).toBe(false)
  })

  it('treats an unparseable expiry as expired', () => {
    // The reading that closes a stale request is safer than the one that leaves
    // it open for somebody to approve.
    const broken = { ...pending(), expiresAt: 'not a date' }
    expect(isDiscountApprovalOpen(broken, NOW)).toBe(false)
  })

  it('expires without claiming anybody decided it', () => {
    // `approvals_decided_pair` makes `decided_at is not null` exactly equivalent
    // to approved-or-rejected. Running out of time is neither.
    const later = new Date(NOW.getTime() + 25 * 60 * 60_000)
    const expired = expireDiscountApproval(pending(), later)
    expect(expired.status).toBe('expired')
    expect(expired.decidedAt).toBeNull()
    expect(expired.decidedByUserId).toBeNull()
  })

  it('leaves a request that is still open alone', () => {
    const untouched = expireDiscountApproval(pending(), NOW)
    expect(untouched.status).toBe('requested')
  })

  it('is idempotent once expired', () => {
    const later = new Date(NOW.getTime() + 25 * 60 * 60_000)
    const once = expireDiscountApproval(pending(), later)
    const twice = expireDiscountApproval(once, later)
    expect(twice).toEqual(once)
  })

  it('can be withdrawn by the agent, also without a decision stamp', () => {
    const withdrawn = withdrawDiscountApproval(pending())
    expect(withdrawn.status).toBe('withdrawn')
    expect(withdrawn.decidedAt).toBeNull()
  })

  it('cannot be withdrawn once decided', () => {
    const decided = decideDiscountApproval(pending(), {
      approved: true,
      decidedByUserId: OWNER,
      now: NOW,
    })
    expect(() => withdrawDiscountApproval(decided)).toThrow(BusinessRuleError)
  })
})
