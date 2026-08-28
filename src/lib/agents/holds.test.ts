/**
 * Hold limits and reputation.
 *
 * A hold is the business's inventory taken off sale for nothing. These tests
 * are about the two directions that can go wrong: an agent who locks up a
 * calendar, and an agent locked out of their own work by holds that expired
 * last week.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_HOLD_LIMITS,
  assertAgentExtensionAllowed,
  assertAgentHoldWithinLimits,
  effectiveHoldLimits,
  holdsStartedOn,
  planAgentHold,
  recordExtension,
  reputationScore,
  reputationTierFor,
  type AgentHoldLedgerEntry,
  type PlanAgentHoldInput,
} from './holds'
import { isHoldLive } from '../booking/holds'
import type { Hold } from '../booking/types'
import { BusinessRuleError } from '../errors'

const NOW = new Date('2026-09-01T12:00:00.000Z')
const ORG = 'org-a'
const AGENT = 'agent-1'

function allowance(
  over: Partial<Parameters<typeof assertAgentHoldWithinLimits>[0]> = {},
) {
  return {
    limits: DEFAULT_AGENT_HOLD_LIMITS,
    liveHoldCount: 0,
    holdsStartedToday: 0,
    ...over,
  }
}

// ── The ceilings ──────────────────────────────────────────────────────────

describe('the concurrent ceiling', () => {
  it('lets an agent below the limit through', () => {
    expect(() =>
      assertAgentHoldWithinLimits(allowance({ liveHoldCount: 2 })),
    ).not.toThrow()
  })

  it('refuses an agent at the limit', () => {
    // Three is the default, so the third live hold is the last one.
    expect(() =>
      assertAgentHoldWithinLimits(allowance({ liveHoldCount: 3 })),
    ).toThrow(BusinessRuleError)
  })

  it('tells them what they can do about it', () => {
    try {
      assertAgentHoldWithinLimits(allowance({ liveHoldCount: 3 }))
      expect.unreachable('should have refused')
    } catch (error) {
      const rule = error as BusinessRuleError
      expect(rule.code).toBe('agent_hold.concurrent_limit')
      // Actionable: release one, or wait for it to lapse.
      expect(rule.userMessage).toContain('שחרר')
    }
  })
})

describe('the daily ceiling', () => {
  it('catches the pattern the concurrent cap cannot', () => {
    // Hold, release, hold, release — forty times, walking the calendar to read
    // it. Never more than one live hold, and never a legitimate use.
    expect(() =>
      assertAgentHoldWithinLimits(
        allowance({ liveHoldCount: 0, holdsStartedToday: 10 }),
      ),
    ).toThrow(BusinessRuleError)
  })

  it('reports the concurrent limit first, because it is the actionable one', () => {
    // At both ceilings at once. "Release a hold" is something they can do now;
    // "wait until tomorrow" is not.
    try {
      assertAgentHoldWithinLimits(
        allowance({ liveHoldCount: 3, holdsStartedToday: 10 }),
      )
      expect.unreachable('should have refused')
    } catch (error) {
      expect((error as BusinessRuleError).code).toBe(
        'agent_hold.concurrent_limit',
      )
    }
  })

  it('counts holds started today in the property’s day, not in UTC', () => {
    // A cap that rolls over at two in the morning local time would reset an
    // agent's allowance mid-conversation.
    const ledger: readonly AgentHoldLedgerEntry[] = [
      entry('h1', '2026-09-01T05:00:00.000Z'), // 08:00 Jerusalem, same day
      entry('h2', '2026-09-01T20:30:00.000Z'), // 23:30 Jerusalem, same day
      entry('h3', '2026-08-31T22:00:00.000Z'), // 01:00 Jerusalem, next day → the 1st
      entry('h4', '2026-08-30T10:00:00.000Z'), // clearly another day
    ]
    expect(holdsStartedOn(ledger, AGENT, NOW)).toBe(3)
  })

  it('counts only this agent’s holds', () => {
    const ledger = [
      entry('h1', '2026-09-01T05:00:00.000Z'),
      { ...entry('h2', '2026-09-01T05:00:00.000Z'), agentUserId: 'agent-2' },
    ]
    expect(holdsStartedOn(ledger, AGENT, NOW)).toBe(1)
  })

  it('ignores an unparseable timestamp rather than counting it', () => {
    const ledger = [entry('h1', 'not a date')]
    expect(holdsStartedOn(ledger, AGENT, NOW)).toBe(0)
  })
})

describe('the extension ceiling', () => {
  it('allows a renewal while the agent is under the cap', () => {
    expect(() =>
      assertAgentExtensionAllowed(entry('h1'), DEFAULT_AGENT_HOLD_LIMITS),
    ).not.toThrow()
  })

  it('refuses a hold that has used its renewals', () => {
    // Renewing one deal five times keeps a single unit off sale all afternoon,
    // which is why this is counted per hold and not per agent.
    const used = { ...entry('h1'), extensionCount: 1 }
    expect(() =>
      assertAgentExtensionAllowed(used, DEFAULT_AGENT_HOLD_LIMITS),
    ).toThrow(BusinessRuleError)
  })

  it('says something different when renewals are disabled entirely', () => {
    try {
      assertAgentExtensionAllowed(entry('h1'), {
        ...DEFAULT_AGENT_HOLD_LIMITS,
        maxExtensions: 0,
      })
      expect.unreachable('should have refused')
    } catch (error) {
      expect((error as BusinessRuleError).userMessage).toContain(
        'לא ניתן להאריך',
      )
    }
  })

  it('counts up without mutating the entry it was given', () => {
    const before = entry('h1')
    const after = recordExtension(before)
    expect(before.extensionCount).toBe(0)
    expect(after.extensionCount).toBe(1)
  })
})

// ── Reputation ────────────────────────────────────────────────────────────

describe('reputation', () => {
  it('is zero until there is enough evidence', () => {
    // One hold converted once is a hundred per cent, and would buy the top
    // tier on the first afternoon.
    expect(
      reputationScore({ holdsCreated: 1, holdsConverted: 1, holdsExpired: 0 }),
    ).toBe(0)
    expect(
      reputationScore({ holdsCreated: 9, holdsConverted: 9, holdsExpired: 0 }),
    ).toBe(0)
  })

  it('scores a perfect record at a hundred', () => {
    expect(
      reputationScore({
        holdsCreated: 10,
        holdsConverted: 10,
        holdsExpired: 0,
      }),
    ).toBe(100)
  })

  it('scores a mixed record by hand-worked arithmetic', () => {
    // (12 − 6/2) / 20 = 9/20 = 0.45 → 45
    expect(
      reputationScore({
        holdsCreated: 20,
        holdsConverted: 12,
        holdsExpired: 6,
      }),
    ).toBe(45)
  })

  it('penalises a lapsed hold more than a released one', () => {
    // An agent who releases dates when a deal dies has behaved well and is
    // merely not rewarded; one who lets them run out took inventory off sale
    // for the whole window.
    const released = reputationScore({
      holdsCreated: 20,
      holdsConverted: 10,
      holdsExpired: 0,
    })
    const lapsed = reputationScore({
      holdsCreated: 20,
      holdsConverted: 10,
      holdsExpired: 10,
    })
    expect(released).toBe(50)
    expect(lapsed).toBe(25)
  })

  it('never goes below zero or above a hundred', () => {
    expect(
      reputationScore({
        holdsCreated: 10,
        holdsConverted: 0,
        holdsExpired: 10,
      }),
    ).toBe(0)
    expect(
      reputationScore({
        holdsCreated: 10,
        holdsConverted: 20,
        holdsExpired: 0,
      }),
    ).toBe(100)
  })

  it('places a score in the right tier', () => {
    expect(reputationTierFor(0).name).toBe('new')
    expect(reputationTierFor(49).name).toBe('new')
    expect(reputationTierFor(50).name).toBe('proven')
    expect(reputationTierFor(74).name).toBe('proven')
    expect(reputationTierFor(75).name).toBe('trusted')
    expect(reputationTierFor(89).name).toBe('trusted')
    expect(reputationTierFor(90).name).toBe('preferred')
    expect(reputationTierFor(100).name).toBe('preferred')
  })

  it('widens the allowance as an agent proves themselves', () => {
    // Additive, so an owner reading the screen can do the arithmetic: three
    // plus two, because he is proven.
    const base = DEFAULT_AGENT_HOLD_LIMITS
    expect(effectiveHoldLimits(base, 0).maxConcurrent).toBe(3)
    expect(effectiveHoldLimits(base, 50).maxConcurrent).toBe(5)
    expect(effectiveHoldLimits(base, 75).maxConcurrent).toBe(8)
    expect(effectiveHoldLimits(base, 95).maxConcurrent).toBe(13)

    expect(effectiveHoldLimits(base, 95).maxPerDay).toBe(40)
    expect(effectiveHoldLimits(base, 95).maxExtensions).toBe(4)
  })

  it('lets a manager override win outright rather than stack', () => {
    // An owner who types "this one may hold twenty" means twenty.
    const limits = effectiveHoldLimits(DEFAULT_AGENT_HOLD_LIMITS, 95, {
      maxConcurrent: 20,
    })
    expect(limits.maxConcurrent).toBe(20)
    // The rest still comes from the tier.
    expect(limits.maxPerDay).toBe(40)
  })

  it('does not change the duration bounds, which are not earned', () => {
    const limits = effectiveHoldLimits(DEFAULT_AGENT_HOLD_LIMITS, 100)
    expect(limits.defaultMinutes).toBe(DEFAULT_AGENT_HOLD_LIMITS.defaultMinutes)
    expect(limits.maxMinutes).toBe(DEFAULT_AGENT_HOLD_LIMITS.maxMinutes)
  })

  it('treats a nonsense score as untrusted rather than trusted', () => {
    expect(reputationTierFor(Number.NaN).name).toBe('new')
    expect(reputationTierFor(-50).name).toBe('new')
  })
})

// ── Planning a hold ───────────────────────────────────────────────────────

describe('planning a hold', () => {
  const range = { checkIn: '2026-09-12', checkOut: '2026-09-15' }

  function plan(over: Partial<PlanAgentHoldInput> = {}) {
    return planAgentHold({
      organizationId: ORG,
      unitId: 'unit-1',
      range,
      agentUserId: AGENT,
      now: NOW,
      allowance: allowance(),
      ...over,
    })
  }

  it('produces a draft with a mandatory expiry', () => {
    // An unbounded hold is not representable, and this is where that starts.
    const draft = plan()
    expect(draft.expiresAt).toBe('2026-09-01T12:30:00.000Z')
    expect(draft.reason).toBe('agent_quote')
    expect(draft.heldByUserId).toBe(AGENT)
    expect(draft.releasedAt).toBeNull()
    expect(draft.convertedToBookingId).toBeNull()
  })

  it('honours a requested duration within the ceiling', () => {
    expect(plan({ minutes: 15 }).expiresAt).toBe('2026-09-01T12:15:00.000Z')
  })

  it('refuses a duration beyond the agent’s ceiling', () => {
    expect(() => plan({ minutes: 121 })).toThrow(BusinessRuleError)
  })

  it('refuses before it plans, when the agent is at their limit', () => {
    expect(() => plan({ allowance: allowance({ liveHoldCount: 3 }) })).toThrow(
      BusinessRuleError,
    )
  })

  it('gives a proven agent the longer allowance the tier earned', () => {
    // Four live holds refuses a new agent and passes a proven one.
    expect(() => plan({ allowance: allowance({ liveHoldCount: 4 }) })).toThrow(
      BusinessRuleError,
    )

    expect(() =>
      plan({
        allowance: {
          limits: effectiveHoldLimits(DEFAULT_AGENT_HOLD_LIMITS, 50),
          liveHoldCount: 4,
          holdsStartedToday: 0,
        },
      }),
    ).not.toThrow()
  })
})

// ── Expiry frees inventory and allowance together ─────────────────────────

describe('an expired hold', () => {
  function hold(expiresAt: string): Hold {
    return {
      id: 'hold-1',
      organizationId: ORG,
      unitId: 'unit-1',
      checkIn: '2026-09-12',
      checkOut: '2026-09-15',
      reason: 'agent_quote',
      heldByUserId: AGENT,
      expiresAt,
      releasedAt: null,
      convertedToBookingId: null,
    }
  }

  it('stops blocking the calendar the moment its time passes', () => {
    const expiring = hold('2026-09-01T12:00:00.000Z')
    expect(isHoldLive(expiring, new Date('2026-09-01T11:59:59.000Z'))).toBe(
      true,
    )
    // Strict: a hold expiring at 12:00:00 does not block at 12:00:00.
    expect(isHoldLive(expiring, NOW)).toBe(false)
  })

  it('consumes none of the agent’s concurrent allowance', () => {
    // The reason expiry matters twice. An expired hold that still counted would
    // lock the agent out rather than the calendar — and a sweeper that quietly
    // stopped running would do it silently.
    const live = [hold('2999-01-01T00:00:00.000Z')]
    const expired = [hold('2020-01-01T00:00:00.000Z')]

    const liveCount = live.filter((h) => isHoldLive(h, NOW)).length
    const expiredCount = expired.filter((h) => isHoldLive(h, NOW)).length
    expect(liveCount).toBe(1)
    expect(expiredCount).toBe(0)

    expect(() =>
      assertAgentHoldWithinLimits(
        allowance({
          liveHoldCount: expiredCount,
          limits: { ...DEFAULT_AGENT_HOLD_LIMITS, maxConcurrent: 1 },
        }),
      ),
    ).not.toThrow()
  })

  it('still counts towards the daily maximum, because it was still taken', () => {
    // The daily cap measures what an agent removed from sale today, whatever
    // became of it afterwards.
    const ledger = [entry('expired-one', '2026-09-01T06:00:00.000Z')]
    expect(holdsStartedOn(ledger, AGENT, NOW)).toBe(1)
  })
})

// ── Helpers ───────────────────────────────────────────────────────────────

function entry(
  holdId: string,
  createdAt = '2026-09-01T06:00:00.000Z',
): AgentHoldLedgerEntry {
  return {
    holdId,
    organizationId: ORG,
    agentUserId: AGENT,
    createdAt,
    extensionCount: 0,
  }
}
