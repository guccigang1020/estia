/**
 * The commission engine.
 *
 * Every number in this file was worked out by hand and is written in the test
 * as the arithmetic that produced it. That is deliberate: a test that asserts
 * whatever the code returned proves the code has not changed, not that it is
 * right, and "why did I get less than we agreed?" is a question about
 * rightness.
 */

import { describe, expect, it } from 'vitest'
import {
  ANY_SCOPE,
  advanceCommission,
  applyPayoutBatch,
  assertCommissionTransition,
  buildAgentStatement,
  buildPayoutBatch,
  calculateCommission,
  canTransitionCommission,
  commissionBaseAmount,
  createCommission,
  isCommissionEligible,
  NO_FACTS,
  scopeMatches,
  selectCommissionRule,
  sweepEligible,
  unmetConditions,
  type Commission,
  type CommissionContext,
  type CommissionFacts,
  type CommissionRuleRecord,
} from './commission'
import { COMMISSION_STATUSES, type CommissionStatus } from '../contracts/states'
import type { PriceLine } from '../booking/types'
import { BusinessRuleError } from '../errors'

const NOW = new Date('2026-09-01T10:00:00.000Z')

// ── The base ──────────────────────────────────────────────────────────────

/**
 * A three-night stay, itemised.
 *
 *   accommodation   3 × ₪1,200 = ₪3,600   360000
 *   extra guest                 = ₪300     30000
 *   cleaning fee                = ₪250     25000
 *   addon (breakfast)           = ₪180     18000
 *   discount                    = −₪200   −20000
 *   tax 18% on the rest         = ₪74.34    7434
 *   deposit (refundable)        = ₪1,000  100000
 */
const LINES: readonly PriceLine[] = [
  {
    kind: 'accommodation',
    label: 'לילה 1',
    amount: 120000,
    quantity: 1,
    date: '2026-09-12',
  },
  {
    kind: 'accommodation',
    label: 'לילה 2',
    amount: 120000,
    quantity: 1,
    date: '2026-09-13',
  },
  {
    kind: 'accommodation',
    label: 'לילה 3',
    amount: 120000,
    quantity: 1,
    date: '2026-09-14',
  },
  {
    kind: 'extra_guest',
    label: 'אורח נוסף',
    amount: 30000,
    quantity: 1,
    date: null,
  },
  {
    kind: 'cleaning_fee',
    label: 'דמי ניקיון',
    amount: 25000,
    quantity: 1,
    date: null,
  },
  {
    kind: 'addon',
    label: 'ארוחת בוקר',
    amount: 18000,
    quantity: 1,
    date: null,
  },
  { kind: 'discount', label: 'הנחה', amount: -20000, quantity: 1, date: null },
  { kind: 'tax', label: 'מע״מ', amount: 7434, quantity: 1, date: null },
  { kind: 'deposit', label: 'פיקדון', amount: 100000, quantity: 1, date: null },
]

describe('the commission base', () => {
  it('counts the whole booking, excluding the refundable deposit', () => {
    // 360000 + 30000 + 25000 + 18000 − 20000 + 7434 = 420434
    expect(commissionBaseAmount(LINES, 'stay_total')).toBe(420434)
  })

  it('counts the nights alone: no extras, no tax, no cleaning, no deposit', () => {
    // 360000 + 30000 − 20000 = 370000
    expect(commissionBaseAmount(LINES, 'accommodation_only')).toBe(370000)
  })

  it('is the sentence that prevents the argument', () => {
    // The same "ten per cent" is ₪420.43 to one party and ₪370.00 to the other.
    // That gap is the reason the base is part of the rule and not part of the
    // conversation.
    const whole = calculateCommission(
      { kind: 'percentage', percent: 10 },
      420434,
    )
    const nights = calculateCommission(
      { kind: 'percentage', percent: 10 },
      370000,
    )
    expect(whole.amountAgorot).toBe(42043)
    expect(nights.amountAgorot).toBe(37000)
    expect(whole.amountAgorot - nights.amountAgorot).toBe(5043)
  })

  it('never pays commission on a previously written commission line', () => {
    const withCommission: readonly PriceLine[] = [
      ...LINES,
      {
        kind: 'agent_commission',
        label: 'עמלה',
        amount: 42043,
        quantity: 1,
        date: null,
      },
    ]
    expect(commissionBaseAmount(withCommission, 'stay_total')).toBe(420434)
  })

  it('never goes below zero, however large the discount', () => {
    const overDiscounted: readonly PriceLine[] = [
      {
        kind: 'accommodation',
        label: 'לילה',
        amount: 100000,
        quantity: 1,
        date: null,
      },
      {
        kind: 'discount',
        label: 'הנחה',
        amount: -150000,
        quantity: 1,
        date: null,
      },
    ]
    // A stay discounted past zero is not a debt owed to the agent.
    expect(commissionBaseAmount(overDiscounted, 'stay_total')).toBe(0)
  })
})

// ── The arithmetic ────────────────────────────────────────────────────────

describe('percentage', () => {
  it('12.5% of ₪6,400 is ₪800', () => {
    // 640000 × 0.125 = 80000
    const result = calculateCommission(
      { kind: 'percentage', percent: 12.5 },
      640000,
    )
    expect(result.amountAgorot).toBe(80000)
  })

  it('10% of ₪1,234.56 is ₪123.46, rounded half away from zero', () => {
    // 123456 × 0.10 = 12345.6 → 12346
    expect(
      calculateCommission({ kind: 'percentage', percent: 10 }, 123456)
        .amountAgorot,
    ).toBe(12346)
  })

  it('rounds a half agora up, matching the calculator a person checks with', () => {
    // 333 × 0.15 = 49.95 → 50
    expect(
      calculateCommission({ kind: 'percentage', percent: 15 }, 333)
        .amountAgorot,
    ).toBe(50)
    // 1000 × 0.0505 → 50.5 → 51, not the banker's 50.
    expect(
      calculateCommission({ kind: 'percentage', percent: 5.05 }, 1000)
        .amountAgorot,
    ).toBe(51)
  })

  it('pays nothing on a zero base', () => {
    expect(
      calculateCommission({ kind: 'percentage', percent: 10 }, 0).amountAgorot,
    ).toBe(0)
  })
})

describe('fixed', () => {
  it('pays the same amount whatever the booking is worth', () => {
    const rule = { kind: 'fixed' as const, amountAgorot: 25000 }
    expect(calculateCommission(rule, 100000).amountAgorot).toBe(25000)
    expect(calculateCommission(rule, 9_999_999).amountAgorot).toBe(25000)
    // Even on a zero base — which is what "a fixed fee per booking" means.
    expect(calculateCommission(rule, 0).amountAgorot).toBe(25000)
  })
})

describe('tiered', () => {
  /**
   * 5% to ₪5,000 · 8% to ₪10,000 · 10% above.
   *
   * The two modes are both real deals and they pay very differently, which is
   * why both exist and why neither is a default that could be assumed.
   */
  const TIERS = [
    { fromAgorot: 0, percent: 5 },
    { fromAgorot: 500_000, percent: 8 },
    { fromAgorot: 1_000_000, percent: 10 },
  ]

  it('marginal: ₪12,000 pays ₪850', () => {
    //   ₪5,000 at 5%  =  ₪250     500000 × 0.05 = 25000
    //   ₪5,000 at 8%  =  ₪400     500000 × 0.08 = 40000
    //   ₪2,000 at 10% =  ₪200     200000 × 0.10 = 20000
    //                    ------                  -----
    //                    ₪850                    85000
    const result = calculateCommission(
      { kind: 'tiered', mode: 'marginal', tiers: TIERS },
      1_200_000,
    )
    expect(result.amountAgorot).toBe(85000)
  })

  it('whole: the same ₪12,000 pays ₪1,200', () => {
    // The top bracket reached applies to everything: 1200000 × 0.10 = 120000
    const result = calculateCommission(
      { kind: 'tiered', mode: 'whole', tiers: TIERS },
      1_200_000,
    )
    expect(result.amountAgorot).toBe(120000)
  })

  it('marginal has no cliff: one agora more never pays less', () => {
    const rule = {
      kind: 'tiered' as const,
      mode: 'marginal' as const,
      tiers: TIERS,
    }
    const below = calculateCommission(rule, 999_999).amountAgorot
    const above = calculateCommission(rule, 1_000_001).amountAgorot
    expect(above).toBeGreaterThanOrEqual(below)
  })

  it('whole has a cliff, on purpose: crossing is meant to be worth crossing', () => {
    const rule = {
      kind: 'tiered' as const,
      mode: 'whole' as const,
      tiers: TIERS,
    }
    // 999999 × 0.08 = 79999.92 → 80000
    expect(calculateCommission(rule, 999_999).amountAgorot).toBe(80000)
    // 1000000 × 0.10 = 100000
    expect(calculateCommission(rule, 1_000_000).amountAgorot).toBe(100000)
  })

  it('marginal pays the first bracket only, below the second threshold', () => {
    // 300000 × 0.05 = 15000
    expect(
      calculateCommission(
        { kind: 'tiered', mode: 'marginal', tiers: TIERS },
        300_000,
      ).amountAgorot,
    ).toBe(15000)
  })

  it('accepts brackets in any order', () => {
    const shuffled = [TIERS[2], TIERS[0], TIERS[1]]
    expect(
      calculateCommission(
        { kind: 'tiered', mode: 'marginal', tiers: shuffled },
        1_200_000,
      ).amountAgorot,
    ).toBe(85000)
  })

  it('rounds once at the end, not once per bracket', () => {
    // Three brackets each producing a fraction. Rounding per bracket would
    // accumulate up to 1.5 agorot of drift.
    const odd = [
      { fromAgorot: 0, percent: 3.33 },
      { fromAgorot: 333, percent: 6.66 },
      { fromAgorot: 777, percent: 9.99 },
    ]
    // 333 × 0.0333          = 11.0889
    // (777−333)=444 × .0666 = 29.5704
    // (1000−777)=223 × .0999= 22.2777
    //                         --------
    //                          62.937  → 63
    expect(
      calculateCommission(
        { kind: 'tiered', mode: 'marginal', tiers: odd },
        1000,
      ).amountAgorot,
    ).toBe(63)
  })

  it('refuses a ladder with a hole at the bottom', () => {
    // Brackets starting above zero would silently pay nothing on small
    // bookings, which is a rule nobody wrote and everybody would blame.
    expect(() =>
      calculateCommission(
        {
          kind: 'tiered',
          mode: 'marginal',
          tiers: [{ fromAgorot: 100_000, percent: 5 }],
        },
        50_000,
      ),
    ).toThrow(BusinessRuleError)
  })
})

describe('none', () => {
  it('is a real arrangement, and pays zero', () => {
    const result = calculateCommission({ kind: 'none' }, 500_000)
    expect(result.amountAgorot).toBe(0)
    expect(result.explanation).toBe('ללא עמלה.')
  })
})

// ── Choosing the rule ─────────────────────────────────────────────────────

function rule(
  overrides: Partial<CommissionRuleRecord> = {},
): CommissionRuleRecord {
  return {
    id: 'rule-1',
    organizationId: 'org-a',
    agentUserId: 'agent-1',
    agencyId: null,
    rule: { kind: 'percentage', percent: 10 },
    base: 'stay_total',
    scope: ANY_SCOPE,
    eligibility: { conditions: [] },
    priority: 0,
    effectiveFrom: null,
    effectiveUntil: null,
    version: 1,
    ...overrides,
  }
}

const CONTEXT: CommissionContext = {
  organizationId: 'org-a',
  agentUserId: 'agent-1',
  agencyId: 'agency-1',
  propertyId: 'property-1',
  unitId: 'unit-1',
  ratePlanId: 'plan-standard',
  checkIn: '2026-09-12',
}

describe('scope', () => {
  it('matches anything when every dimension is open', () => {
    expect(scopeMatches(ANY_SCOPE, CONTEXT)).toBe(true)
  })

  it('scopes by property', () => {
    expect(
      scopeMatches({ ...ANY_SCOPE, propertyIds: ['property-1'] }, CONTEXT),
    ).toBe(true)
    expect(
      scopeMatches({ ...ANY_SCOPE, propertyIds: ['property-9'] }, CONTEXT),
    ).toBe(false)
  })

  it('scopes by unit', () => {
    expect(scopeMatches({ ...ANY_SCOPE, unitIds: ['unit-1'] }, CONTEXT)).toBe(
      true,
    )
    expect(scopeMatches({ ...ANY_SCOPE, unitIds: ['unit-9'] }, CONTEXT)).toBe(
      false,
    )
  })

  it('scopes by rate plan', () => {
    expect(
      scopeMatches({ ...ANY_SCOPE, ratePlanIds: ['plan-standard'] }, CONTEXT),
    ).toBe(true)
    expect(
      scopeMatches({ ...ANY_SCOPE, ratePlanIds: ['plan-early-bird'] }, CONTEXT),
    ).toBe(false)
  })

  it('scopes by period, against the arrival date', () => {
    const highSeason = {
      ...ANY_SCOPE,
      period: { from: '2026-07-01', to: '2026-08-31' },
    }
    expect(scopeMatches(highSeason, CONTEXT)).toBe(false)
    expect(
      scopeMatches(highSeason, { ...CONTEXT, checkIn: '2026-07-15' }),
    ).toBe(true)
    // Inclusive at both ends.
    expect(
      scopeMatches(highSeason, { ...CONTEXT, checkIn: '2026-07-01' }),
    ).toBe(true)
    expect(
      scopeMatches(highSeason, { ...CONTEXT, checkIn: '2026-08-31' }),
    ).toBe(true)
  })

  it('treats an empty list as matching nothing, not everything', () => {
    // "Every property" and "somebody saved the picker with nothing selected"
    // are different, and only one of them should pay out.
    expect(scopeMatches({ ...ANY_SCOPE, propertyIds: [] }, CONTEXT)).toBe(false)
  })
})

describe('selecting the governing rule', () => {
  it('returns null when nothing matches, rather than a default', () => {
    expect(
      selectCommissionRule(
        [rule({ agentUserId: 'agent-other' })],
        CONTEXT,
        '2026-09-01',
      ),
    ).toBeNull()
  })

  it('prefers higher priority', () => {
    const chosen = selectCommissionRule(
      [rule({ id: 'low', priority: 1 }), rule({ id: 'high', priority: 5 })],
      CONTEXT,
      '2026-09-01',
    )
    expect(chosen?.id).toBe('high')
  })

  it('breaks a priority tie by specificity', () => {
    const chosen = selectCommissionRule(
      [
        rule({ id: 'broad' }),
        rule({ id: 'narrow', scope: { ...ANY_SCOPE, unitIds: ['unit-1'] } }),
      ],
      CONTEXT,
      '2026-09-01',
    )
    expect(chosen?.id).toBe('narrow')
  })

  it('prefers the agent’s own rule over the agency’s at equal weight', () => {
    const chosen = selectCommissionRule(
      [
        rule({ id: 'agency', agentUserId: null, agencyId: 'agency-1' }),
        rule({ id: 'personal' }),
      ],
      CONTEXT,
      '2026-09-01',
    )
    expect(chosen?.id).toBe('personal')
  })

  it('is deterministic when two rules are genuinely equal', () => {
    // Two equally good rules must not pay different amounts depending on the
    // order a query happened to return them.
    const rules = [rule({ id: 'bbb' }), rule({ id: 'aaa' })]
    const first = selectCommissionRule(rules, CONTEXT, '2026-09-01')
    const second = selectCommissionRule(
      [...rules].reverse(),
      CONTEXT,
      '2026-09-01',
    )
    expect(first?.id).toBe(second?.id)
    expect(first?.id).toBe('aaa')
  })

  it('ignores a rule that had not started yet', () => {
    expect(
      selectCommissionRule(
        [rule({ effectiveFrom: '2026-10-01' })],
        CONTEXT,
        '2026-09-01',
      ),
    ).toBeNull()
  })

  it('ignores a rule that has expired', () => {
    expect(
      selectCommissionRule(
        [rule({ effectiveUntil: '2026-08-31' })],
        CONTEXT,
        '2026-09-01',
      ),
    ).toBeNull()
  })

  it('never crosses organizations', () => {
    expect(
      selectCommissionRule(
        [rule({ organizationId: 'org-b' })],
        CONTEXT,
        '2026-09-01',
      ),
    ).toBeNull()
  })

  it('ignores a rule belonging to nobody', () => {
    expect(
      selectCommissionRule(
        [rule({ agentUserId: null, agencyId: null })],
        CONTEXT,
        '2026-09-01',
      ),
    ).toBeNull()
  })
})

// ── Creating one ──────────────────────────────────────────────────────────

function commission(overrides: Partial<Commission> = {}): Commission {
  return {
    ...createCommission({
      id: 'commission-1',
      organizationId: 'org-a',
      propertyId: 'property-1',
      bookingId: 'booking-1',
      agentUserId: 'agent-1',
      agencyId: null,
      lines: LINES,
      rule: rule(),
      now: NOW,
    }),
    ...overrides,
  }
}

describe('creating a commission', () => {
  it('records the amount, the basis and the rule version together', () => {
    const created = commission()
    expect(created.status).toBe('estimated')
    expect(created.basisAgorot).toBe(420434)
    expect(created.amountAgorot).toBe(42043) // 10% of 420434 = 42043.4 → 42043
    expect(created.ruleId).toBe('rule-1')
    expect(created.ruleVersion).toBe(1)
    expect(created.rateBps).toBe(1000)
  })

  it('freezes an explanation that survives the rule changing later', () => {
    // The answer to "why did I get less than we agreed" about a booking whose
    // terms have been edited twice since.
    const created = commission()
    expect(created.explanation).toContain('סך השהות')
    expect(created.explanation).toContain('10%')
  })

  it('writes a zero record when no rule matched, rather than no record', () => {
    // "There was no rule that day" is worth storing. No row makes "was this
    // sale commissionable?" unanswerable.
    const created = createCommission({
      id: 'commission-2',
      organizationId: 'org-a',
      propertyId: 'property-1',
      bookingId: 'booking-2',
      agentUserId: 'agent-1',
      agencyId: null,
      lines: LINES,
      rule: null,
      now: NOW,
    })
    expect(created.amountAgorot).toBe(0)
    expect(created.ruleId).toBeNull()
    expect(created.explanation).toContain('לא נמצא כלל עמלה')
  })

  it('carries no rate for a tiered rule, because no single rate is true', () => {
    const created = createCommission({
      id: 'commission-3',
      organizationId: 'org-a',
      propertyId: 'property-1',
      bookingId: 'booking-3',
      agentUserId: 'agent-1',
      agencyId: null,
      lines: LINES,
      rule: rule({
        rule: {
          kind: 'tiered',
          mode: 'marginal',
          tiers: [{ fromAgorot: 0, percent: 5 }],
        },
      }),
      now: NOW,
    })
    expect(created.rateBps).toBeNull()
  })
})

// ── Eligibility ───────────────────────────────────────────────────────────

const facts = (over: Partial<CommissionFacts> = {}): CommissionFacts => ({
  ...NO_FACTS,
  ...over,
})

describe('eligibility', () => {
  it('is immediate when no condition is set', () => {
    expect(isCommissionEligible({ conditions: [] }, NO_FACTS)).toBe(true)
  })

  it('requires every condition, not any of them', () => {
    const policy = {
      conditions: ['payment_received', 'cancellation_window_passed'] as const,
    }
    expect(
      isCommissionEligible(policy, facts({ payment_received: true })),
    ).toBe(false)
    expect(
      isCommissionEligible(
        policy,
        facts({ payment_received: true, cancellation_window_passed: true }),
      ),
    ).toBe(true)
  })

  it('names what is still missing, so a person can be told', () => {
    const missing = unmetConditions(
      { conditions: ['payment_received', 'stay_completed'] },
      facts({ payment_received: true }),
    )
    expect(missing).toEqual(['stay_completed'])
  })

  it('refuses the eligible transition until its conditions hold', () => {
    const pending = advanceCommission(
      commission({
        eligibility: { conditions: ['stay_completed'] },
      }),
      { to: 'pending', now: NOW },
    )

    expect(() =>
      advanceCommission(pending, { to: 'eligible', now: NOW, facts: NO_FACTS }),
    ).toThrow(BusinessRuleError)

    const eligible = advanceCommission(pending, {
      to: 'eligible',
      now: NOW,
      facts: facts({ stay_completed: true }),
    })
    expect(eligible.status).toBe('eligible')
    expect(eligible.eligibleAt).toBe(NOW.toISOString())
  })

  it('treats absent facts as unmet, never as met', () => {
    const pending = advanceCommission(
      commission({ eligibility: { conditions: ['payment_received'] } }),
      { to: 'pending', now: NOW },
    )
    // No `facts` supplied at all.
    expect(() =>
      advanceCommission(pending, { to: 'eligible', now: NOW }),
    ).toThrow(BusinessRuleError)
  })

  it('sweeps only the commissions whose conditions now hold', () => {
    const ready = advanceCommission(
      commission({
        id: 'ready',
        eligibility: { conditions: ['payment_received'] },
      }),
      { to: 'pending', now: NOW },
    )
    const waiting = advanceCommission(
      commission({
        id: 'waiting',
        eligibility: { conditions: ['stay_completed'] },
      }),
      { to: 'pending', now: NOW },
    )

    const swept = sweepEligible(
      [ready, waiting],
      () => facts({ payment_received: true }),
      NOW,
    )
    expect(swept.find((c) => c.id === 'ready')?.status).toBe('eligible')
    expect(swept.find((c) => c.id === 'waiting')?.status).toBe('pending')
  })
})

// ── The state machine ─────────────────────────────────────────────────────

describe('the frozen state machine', () => {
  it('walks the whole ladder', () => {
    let c = commission()
    expect(c.status).toBe('estimated')
    c = advanceCommission(c, { to: 'pending', now: NOW })
    c = advanceCommission(c, { to: 'eligible', now: NOW, facts: NO_FACTS })
    c = advanceCommission(c, {
      to: 'approved',
      now: NOW,
      approvedByUserId: 'owner-1',
    })
    c = advanceCommission(c, { to: 'paid', now: NOW, payoutReference: 'PAY-1' })
    expect(c.status).toBe('paid')
    expect(c.approvedByUserId).toBe('owner-1')
    expect(c.payoutReference).toBe('PAY-1')
    expect(c.version).toBe(5)
  })

  it('refuses every illegal transition', () => {
    const legal = new Set([
      'estimated>pending',
      'estimated>cancelled',
      'pending>eligible',
      'pending>cancelled',
      'eligible>approved',
      'eligible>cancelled',
      'approved>paid',
      'approved>cancelled',
    ])
    for (const from of COMMISSION_STATUSES) {
      for (const to of COMMISSION_STATUSES) {
        const expected = legal.has(`${from}>${to}`)
        expect(
          canTransitionCommission(
            from as CommissionStatus,
            to as CommissionStatus,
          ),
          `${from} → ${to}`,
        ).toBe(expected)
      }
    }
  })

  it('never pays without an approval', () => {
    // The rule the whole ladder exists for. Paying on `estimated` means paying
    // for stays that never happened.
    expect(() => assertCommissionTransition('estimated', 'paid')).toThrow(
      BusinessRuleError,
    )
    expect(() => assertCommissionTransition('eligible', 'paid')).toThrow(
      BusinessRuleError,
    )
  })

  it('treats paid as terminal, because reversing a payment is a refund', () => {
    expect(canTransitionCommission('paid', 'cancelled')).toBe(false)
    expect(canTransitionCommission('paid', 'approved')).toBe(false)
  })

  it('refuses an approval that names no approver', () => {
    // The database refuses the row too. Checking here turns an unreadable
    // constraint violation into a sentence.
    const eligible = advanceCommission(
      advanceCommission(commission(), { to: 'pending', now: NOW }),
      { to: 'eligible', now: NOW, facts: NO_FACTS },
    )
    expect(() =>
      advanceCommission(eligible, { to: 'approved', now: NOW }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses a cancellation with no reason', () => {
    // This field is the answer to "why was I not paid for this?" a year later.
    expect(() =>
      advanceCommission(commission(), { to: 'cancelled', now: NOW }),
    ).toThrow(BusinessRuleError)

    expect(() =>
      advanceCommission(commission(), {
        to: 'cancelled',
        now: NOW,
        reason: '   ',
      }),
    ).toThrow(BusinessRuleError)

    const cancelled = advanceCommission(commission(), {
      to: 'cancelled',
      now: NOW,
      reason: 'ההזמנה בוטלה על ידי האורח',
    })
    expect(cancelled.cancellationReason).toBe('ההזמנה בוטלה על ידי האורח')
  })

  it('never mutates the record it was given', () => {
    const before = commission()
    const after = advanceCommission(before, { to: 'pending', now: NOW })
    expect(before.status).toBe('estimated')
    expect(after.status).toBe('pending')
    expect(after).not.toBe(before)
  })
})

// ── Statements ────────────────────────────────────────────────────────────

describe('statements', () => {
  const inPeriod = (id: string, status: CommissionStatus, amount: number) =>
    commission({ id, status, amountAgorot: amount })

  it('lists only money that is actually promised', () => {
    // A statement is a document an agent treats as a promise. Putting an
    // estimate on it invites the argument the module exists to prevent.
    const statement = buildAgentStatement({
      id: 'statement-1',
      organizationId: 'org-a',
      agentUserId: 'agent-1',
      periodFrom: '2026-09-01',
      periodTo: '2026-09-30',
      commissions: [
        inPeriod('a', 'eligible', 10000),
        inPeriod('b', 'approved', 20000),
        inPeriod('c', 'paid', 30000),
        inPeriod('d', 'estimated', 99999),
        inPeriod('e', 'pending', 88888),
        inPeriod('f', 'cancelled', 77777),
      ],
      now: NOW,
    })
    expect(statement.lines.map((l) => l.commissionId).sort()).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(statement.totalAgorot).toBe(60000)
  })

  it('never includes another agent’s line', () => {
    const statement = buildAgentStatement({
      id: 'statement-2',
      organizationId: 'org-a',
      agentUserId: 'agent-1',
      periodFrom: '2026-09-01',
      periodTo: '2026-09-30',
      commissions: [
        inPeriod('mine', 'approved', 10000),
        commission({
          id: 'theirs',
          status: 'approved',
          agentUserId: 'agent-2',
        }),
      ],
      now: NOW,
    })
    expect(statement.lines.map((l) => l.commissionId)).toEqual(['mine'])
  })

  it('never includes another organization’s line', () => {
    const statement = buildAgentStatement({
      id: 'statement-3',
      organizationId: 'org-a',
      agentUserId: 'agent-1',
      periodFrom: '2026-09-01',
      periodTo: '2026-09-30',
      commissions: [
        inPeriod('mine', 'approved', 10000),
        commission({
          id: 'other-org',
          status: 'approved',
          organizationId: 'org-b',
        }),
      ],
      now: NOW,
    })
    expect(statement.lines.map((l) => l.commissionId)).toEqual(['mine'])
  })

  it('excludes commissions outside the period', () => {
    const statement = buildAgentStatement({
      id: 'statement-4',
      organizationId: 'org-a',
      agentUserId: 'agent-1',
      periodFrom: '2026-10-01',
      periodTo: '2026-10-31',
      commissions: [inPeriod('september', 'approved', 10000)],
      now: NOW,
    })
    expect(statement.lines).toEqual([])
    expect(statement.totalAgorot).toBe(0)
  })
})

// ── Payouts ───────────────────────────────────────────────────────────────

describe('payout batches', () => {
  const approved = (id: string, amount: number) =>
    commission({
      id,
      status: 'approved',
      amountAgorot: amount,
      approvedByUserId: 'owner-1',
    })

  it('sums approved commissions for one agent', () => {
    const batch = buildPayoutBatch({
      id: 'batch-1',
      organizationId: 'org-a',
      agentUserId: 'agent-1',
      reference: 'PAY-2026-09',
      commissions: [approved('a', 12500), approved('b', 7500)],
      now: NOW,
    })
    expect(batch.totalAgorot).toBe(20000)
    expect(batch.commissionIds).toEqual(['a', 'b'])
  })

  it('refuses a commission that is not approved', () => {
    // Including one would pay for a stay nobody has confirmed happened;
    // skipping it silently would pay a different total than the one signed off.
    expect(() =>
      buildPayoutBatch({
        id: 'batch-2',
        organizationId: 'org-a',
        agentUserId: 'agent-1',
        reference: 'PAY-2',
        commissions: [
          approved('a', 100),
          commission({ id: 'b', status: 'eligible' }),
        ],
        now: NOW,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses a commission already carrying a payout reference', () => {
    expect(() =>
      buildPayoutBatch({
        id: 'batch-3',
        organizationId: 'org-a',
        agentUserId: 'agent-1',
        reference: 'PAY-3',
        commissions: [
          commission({
            id: 'a',
            status: 'approved',
            approvedByUserId: 'owner-1',
            payoutReference: 'PAY-EARLIER',
          }),
        ],
        now: NOW,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses another agent’s commission', () => {
    expect(() =>
      buildPayoutBatch({
        id: 'batch-4',
        organizationId: 'org-a',
        agentUserId: 'agent-1',
        reference: 'PAY-4',
        commissions: [
          commission({ id: 'a', status: 'approved', agentUserId: 'agent-2' }),
        ],
        now: NOW,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses another organization’s commission', () => {
    expect(() =>
      buildPayoutBatch({
        id: 'batch-5',
        organizationId: 'org-a',
        agentUserId: 'agent-1',
        reference: 'PAY-5',
        commissions: [
          commission({ id: 'a', status: 'approved', organizationId: 'org-b' }),
        ],
        now: NOW,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('marks its lines paid, so the agent is not shown money twice', () => {
    const lines = [approved('a', 12500), approved('b', 7500)]
    const batch = buildPayoutBatch({
      id: 'batch-6',
      organizationId: 'org-a',
      agentUserId: 'agent-1',
      reference: 'PAY-6',
      commissions: lines,
      now: NOW,
    })
    const settled = applyPayoutBatch(batch, lines, NOW)
    expect(settled.every((c) => c.status === 'paid')).toBe(true)
    expect(settled.every((c) => c.payoutReference === 'PAY-6')).toBe(true)
  })
})
