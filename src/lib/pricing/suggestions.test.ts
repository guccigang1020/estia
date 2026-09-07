import { describe, expect, it } from 'vitest'

import { blockerMessage } from './labels'
import {
  approvalBlockers,
  autoApplyDecision,
  suggestionDeltaBps,
  suggestionExpiry,
} from './suggestions'
import type { DynamicPricingPolicy, RateSuggestion } from './types'

/**
 * The boundary between the probabilistic and the deterministic, tested from
 * the refusing side.
 *
 * Every case here is a way a machine could have moved a price without a
 * person, and every assertion is that it did not.
 */

const NOW = new Date('2026-10-01T08:00:00.000Z')

function suggestion(overrides: Partial<RateSuggestion> = {}): RateSuggestion {
  return {
    id: 'suggestion-1',
    unitId: 'unit-1',
    ratePlanId: 'plan-1',
    date: '2026-10-03',
    deterministicAgorot: 140_000,
    suggestedAgorot: 161_000,
    confidenceBps: 7_800,
    rationale: 'ביקוש גבוה מהרגיל לשמחת תורה',
    inputsHash: 'a1b2c3d4',
    status: 'pending',
    expiresAt: '2026-10-02T08:00:00.000Z',
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    ...overrides,
  }
}

function policy(
  overrides: Partial<DynamicPricingPolicy> = {},
): DynamicPricingPolicy {
  return {
    id: 'policy-1',
    propertyId: null,
    autoApply: true,
    maxDeltaBps: 2_000,
    maxDailyChanges: 1,
    floorAgorot: 90_000,
    ceilingAgorot: 220_000,
    enabledByUserId: 'user-shai',
    enabledAt: '2026-09-01T08:00:00.000Z',
    ...overrides,
  }
}

const CLEAR = { nightIsSold: false, changesToday: 0, now: NOW }

describe('the gap between a proposal and the deterministic price', () => {
  it('is basis points against the deterministic figure', () => {
    expect(suggestionDeltaBps(suggestion())).toEqual({
      known: true,
      value: 1_500,
    })
  })

  it('is signed, so a proposal below the engine reads as negative', () => {
    expect(
      suggestionDeltaBps(suggestion({ suggestedAgorot: 119_000 })),
    ).toEqual({ known: true, value: -1_500 })
  })

  /**
   * A figure with no source is absent, with its reason — never zero and never
   * an estimate. A unit priced at nothing has no percentage to be a multiple
   * of, and both `0%` and `∞%` would be inventions a business could act on.
   */
  it('is unmeasurable against a deterministic price of zero', () => {
    expect(suggestionDeltaBps(suggestion({ deterministicAgorot: 0 }))).toEqual({
      known: false,
      reason: 'no_denominator',
    })
  })
})

describe('automatic application (spec §6 rule 26)', () => {
  it('applies only when every condition holds', () => {
    expect(autoApplyDecision(suggestion(), policy(), CLEAR)).toEqual({
      apply: true,
    })
  })

  it('refuses without a policy at all', () => {
    const decision = autoApplyDecision(suggestion(), null, CLEAR)
    expect(decision.apply).toBe(false)
    if (decision.apply) return
    expect(decision.blockers).toContainEqual({ code: 'no_policy' })
  })

  it('refuses when the policy is switched off', () => {
    const decision = autoApplyDecision(
      suggestion(),
      policy({ autoApply: false }),
      CLEAR,
    )
    expect(decision.apply).toBe(false)
    if (decision.apply) return
    expect(decision.blockers).toContainEqual({ code: 'policy_disabled' })
  })

  /**
   * 🔒 The one that matters most. A policy with nobody behind it could not
   * write `on_behalf_of_user_id`, and an automatic price change whose only
   * explanation is "the system did it" is the failure this whole subsystem is
   * designed around. The database refuses to store such a policy; this refuses
   * to act on one even if a future migration relaxed that.
   */
  it('refuses a policy with nobody behind it', () => {
    const decision = autoApplyDecision(
      suggestion(),
      policy({ enabledByUserId: null }),
      CLEAR,
    )
    expect(decision.apply).toBe(false)
    if (decision.apply) return
    expect(decision.blockers).toContainEqual({ code: 'policy_unattributed' })
  })

  it('refuses on a night that has already been sold (spec §6 rule 25)', () => {
    const decision = autoApplyDecision(suggestion(), policy(), {
      ...CLEAR,
      nightIsSold: true,
    })
    expect(decision.apply).toBe(false)
    if (decision.apply) return
    expect(decision.blockers).toContainEqual({ code: 'night_is_sold' })
  })

  it('refuses a gap wider than the policy allows, and names both numbers', () => {
    const decision = autoApplyDecision(
      suggestion({ suggestedAgorot: 210_000 }),
      policy(),
      CLEAR,
    )
    expect(decision.apply).toBe(false)
    if (decision.apply) return
    expect(decision.blockers).toContainEqual({
      code: 'delta_exceeded',
      deltaBps: 5_000,
      maxDeltaBps: 2_000,
    })
  })

  /**
   * Unmeasurable is a refusal, not a pass. A gap that cannot be measured
   * cannot be shown to be inside the limit, and on a path that spends money
   * "we could not tell" must never resolve to "go ahead".
   */
  it('refuses when the gap cannot be measured at all', () => {
    const decision = autoApplyDecision(
      suggestion({ deterministicAgorot: 0 }),
      policy(),
      CLEAR,
    )
    expect(decision.apply).toBe(false)
    if (decision.apply) return
    expect(decision.blockers).toContainEqual({ code: 'delta_unmeasurable' })
  })

  it('refuses below the policy floor and above its ceiling', () => {
    const low = autoApplyDecision(
      suggestion({ deterministicAgorot: 89_000, suggestedAgorot: 88_000 }),
      policy(),
      CLEAR,
    )
    const high = autoApplyDecision(
      suggestion({ deterministicAgorot: 219_000, suggestedAgorot: 230_000 }),
      policy(),
      CLEAR,
    )
    expect(low.apply).toBe(false)
    expect(high.apply).toBe(false)
    if (low.apply || high.apply) return
    expect(low.blockers).toContainEqual({
      code: 'below_floor',
      floorAgorot: 90_000,
    })
    expect(high.blockers).toContainEqual({
      code: 'above_ceiling',
      ceilingAgorot: 220_000,
    })
  })

  it('refuses once the daily change allowance is used', () => {
    const decision = autoApplyDecision(suggestion(), policy(), {
      ...CLEAR,
      changesToday: 1,
    })
    expect(decision.apply).toBe(false)
    if (decision.apply) return
    expect(decision.blockers).toContainEqual({
      code: 'daily_changes_used',
      used: 1,
      allowed: 1,
    })
  })

  it('refuses an expired proposal', () => {
    const decision = autoApplyDecision(suggestion(), policy(), {
      ...CLEAR,
      now: new Date('2026-10-03T08:00:00.000Z'),
    })
    expect(decision.apply).toBe(false)
    if (decision.apply) return
    expect(decision.blockers).toContainEqual({ code: 'expired' })
  })

  /**
   * All the reasons, not the first. Somebody fixing one blocker and
   * rediscovering the next is somebody who stops reading the screen.
   */
  it('reports every reason at once', () => {
    const decision = autoApplyDecision(
      suggestion({ suggestedAgorot: 400_000 }),
      policy({ autoApply: false }),
      { ...CLEAR, nightIsSold: true, changesToday: 9 },
    )
    expect(decision.apply).toBe(false)
    if (decision.apply) return
    expect(decision.blockers.map((blocker) => blocker.code).sort()).toEqual(
      [
        'above_ceiling',
        'daily_changes_used',
        'delta_exceeded',
        'night_is_sold',
        'policy_disabled',
      ].sort(),
    )
  })

  it('gives every refusal a Hebrew sentence a person can act on', () => {
    const decision = autoApplyDecision(
      suggestion({ suggestedAgorot: 400_000 }),
      policy({ autoApply: false }),
      { ...CLEAR, nightIsSold: true },
    )
    expect(decision.apply).toBe(false)
    if (decision.apply) return
    for (const blocker of decision.blockers) {
      const message = blockerMessage(blocker)
      expect(message.length).toBeGreaterThan(10)
      // Hebrew, not a code and not an English fallback.
      expect(message).toMatch(/[֐-׿]/)
    }
  })
})

describe('approval by a person', () => {
  /**
   * A shorter list than the automatic gate, deliberately. A person may approve
   * a proposal far from the deterministic price — that is what judgement is,
   * and the screen shows them the gap, the floor and the ceiling. What they
   * may not do is re-price a night that has already been sold.
   */
  it('allows a gap a policy would have refused', () => {
    expect(
      approvalBlockers(suggestion({ suggestedAgorot: 400_000 }), {
        nightIsSold: false,
        now: NOW,
      }),
    ).toEqual([])
  })

  it('still refuses a sold night', () => {
    expect(
      approvalBlockers(suggestion(), { nightIsSold: true, now: NOW }),
    ).toContainEqual({ code: 'night_is_sold' })
  })

  it('still refuses a proposal that was already decided', () => {
    expect(
      approvalBlockers(suggestion({ status: 'rejected' }), {
        nightIsSold: false,
        now: NOW,
      }),
    ).toContainEqual({ code: 'not_pending' })
  })
})

describe('expiry', () => {
  it('is twenty-four hours after the proposal was made', () => {
    expect(suggestionExpiry(NOW).toISOString()).toBe('2026-10-02T08:00:00.000Z')
  })
})
