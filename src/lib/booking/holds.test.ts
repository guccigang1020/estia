/**
 * Holds.
 *
 * The safeguards in `docs/ARCHITECTURE.md` §12 exist because a hold is
 * inventory removed from sale for free, and the two ways it goes wrong point in
 * opposite directions: a hold that outlives its purpose locks a business's
 * calendar, and a hold that is honoured after it should have lapsed does the
 * same thing while looking correct in the database.
 *
 * So the load-bearing tests here are about expiry being decided against the
 * clock on every read — not by a sweeper, not by a column somebody remembered
 * to update — and about a converted hold ceasing to block the booking it just
 * became.
 */

import { describe, expect, it } from 'vitest'
import { BusinessRuleError } from '../errors'
import {
  HOLD_POLICY,
  assertHoldCovers,
  assertHoldIsLive,
  convertHold,
  countLiveHoldsBy,
  expiryFrom,
  extendHold,
  holdCovers,
  holdOverlaps,
  holdPolicyFor,
  isHoldLive,
  liveHolds,
  planHold,
  releaseHold,
} from './holds'
import { HOLD_REASONS, type Hold } from './types'

const ORG = 'org-a'
const UNIT = 'unit-1'
const AGENT = 'user-agent'
const NOW = new Date('2026-08-20T09:00:00.000Z')

function hold(overrides: Partial<Hold> = {}): Hold {
  return {
    id: 'hold-1',
    organizationId: ORG,
    unitId: UNIT,
    checkIn: '2026-09-03',
    checkOut: '2026-09-06',
    reason: 'agent_quote',
    heldByUserId: AGENT,
    expiresAt: '2026-08-20T09:30:00.000Z',
    releasedAt: null,
    convertedToBookingId: null,
    ...overrides,
  }
}

// ── Liveness ──────────────────────────────────────────────────────────────

describe('liveness', () => {
  it('is live while its time has not run out', () => {
    expect(isHoldLive(hold(), NOW)).toBe(true)
  })

  it('is not live once the expiry has passed', () => {
    expect(isHoldLive(hold(), new Date('2026-08-20T09:31:00.000Z'))).toBe(false)
  })

  it('is not live at the exact moment it expires', () => {
    // Strict, so a test at the boundary is not a coin flip and inventory is
    // not held for an extra tick for nobody's benefit.
    expect(isHoldLive(hold(), new Date('2026-08-20T09:30:00.000Z'))).toBe(false)
  })

  it('is not live once released, even with time left', () => {
    expect(
      isHoldLive(hold({ releasedAt: '2026-08-20T09:05:00.000Z' }), NOW),
    ).toBe(false)
  })

  it('is not live once it has become a booking', () => {
    expect(isHoldLive(hold({ convertedToBookingId: 'bk-1' }), NOW)).toBe(false)
  })

  it('treats an unparseable expiry as expired, freeing the dates', () => {
    // The safe reading of bad data is the one that returns inventory to sale,
    // not the one that locks a calendar until somebody notices.
    expect(isHoldLive(hold({ expiresAt: 'not-a-date' }), NOW)).toBe(false)
  })

  it('filters a mixed list down to what actually blocks', () => {
    const holds = [
      hold({ id: 'live' }),
      hold({ id: 'expired', expiresAt: '2026-08-20T08:00:00.000Z' }),
      hold({ id: 'released', releasedAt: '2026-08-20T08:30:00.000Z' }),
      hold({ id: 'converted', convertedToBookingId: 'bk-2' }),
    ]

    expect(liveHolds(holds, NOW).map((entry) => entry.id)).toEqual(['live'])
  })
})

// ── The concurrency cap ───────────────────────────────────────────────────

describe('the concurrency cap', () => {
  function agentHolds(count: number, overrides: Partial<Hold> = {}): Hold[] {
    return Array.from({ length: count }, (_, index) =>
      hold({ id: `hold-${index}`, ...overrides }),
    )
  }

  it('counts only this person’s live holds', () => {
    const holds = [
      ...agentHolds(2),
      hold({ id: 'other', heldByUserId: 'user-someone-else' }),
      hold({ id: 'expired', expiresAt: '2026-08-20T08:00:00.000Z' }),
    ]

    expect(countLiveHoldsBy(holds, AGENT, NOW)).toBe(2)
  })

  it('refuses an agent already at the limit', () => {
    const error = refusal(() =>
      planHold({
        organizationId: ORG,
        unitId: UNIT,
        range: { checkIn: '2026-09-10', checkOut: '2026-09-12' },
        reason: 'agent_quote',
        heldByUserId: AGENT,
        now: NOW,
        liveHoldCount: HOLD_POLICY.agent_quote.maxConcurrent,
      }),
    )

    expect(error.code).toBe('hold.limit_reached')
    expect(error.userMessage).toContain(
      String(HOLD_POLICY.agent_quote.maxConcurrent),
    )
  })

  it('allows the hold that takes them exactly to the limit', () => {
    const draft = planHold({
      organizationId: ORG,
      unitId: UNIT,
      range: { checkIn: '2026-09-10', checkOut: '2026-09-12' },
      reason: 'agent_quote',
      heldByUserId: AGENT,
      now: NOW,
      liveHoldCount: HOLD_POLICY.agent_quote.maxConcurrent - 1,
    })

    expect(draft.unitId).toBe(UNIT)
  })

  it('does not let an expired hold consume the allowance', () => {
    // The reason liveness is computed rather than stored: an agent locked out
    // by holds that lapsed last week is the same outage seen from the inside.
    const expired = agentHolds(HOLD_POLICY.agent_quote.maxConcurrent, {
      expiresAt: '2026-08-20T08:00:00.000Z',
    })

    expect(countLiveHoldsBy(expired, AGENT, NOW)).toBe(0)
  })

  it('gives each reason its own allowance', () => {
    expect(holdPolicyFor('guest_checkout').maxConcurrent).toBeLessThan(
      holdPolicyFor('agent_quote').maxConcurrent,
    )
    expect(holdPolicyFor('maintenance_block').maxConcurrent).toBeGreaterThan(
      holdPolicyFor('agent_quote').maxConcurrent,
    )
  })

  it('accepts an earned allowance for a proven agent', () => {
    const draft = planHold({
      organizationId: ORG,
      unitId: UNIT,
      range: { checkIn: '2026-09-10', checkOut: '2026-09-12' },
      reason: 'agent_quote',
      heldByUserId: AGENT,
      now: NOW,
      liveHoldCount: 8,
      policy: { maxConcurrent: 12 },
    })

    expect(draft.heldByUserId).toBe(AGENT)
  })
})

// ── Duration ──────────────────────────────────────────────────────────────

describe('duration', () => {
  it('gives every reason a bounded default', () => {
    for (const reason of HOLD_REASONS) {
      const policy = holdPolicyFor(reason)
      expect(policy.defaultMinutes).toBeGreaterThan(0)
      expect(policy.defaultMinutes).toBeLessThanOrEqual(policy.maxMinutes)
    }
  })

  it('always writes an expiry, so an unbounded hold cannot exist', () => {
    for (const reason of HOLD_REASONS) {
      const draft = planHold({
        organizationId: ORG,
        unitId: UNIT,
        range: { checkIn: '2026-09-10', checkOut: '2026-09-12' },
        reason,
        heldByUserId: AGENT,
        now: NOW,
        liveHoldCount: 0,
      })

      expect(Date.parse(draft.expiresAt)).toBeGreaterThan(NOW.getTime())
    }
  })

  it('uses the requested duration when it is within policy', () => {
    const draft = planHold({
      organizationId: ORG,
      unitId: UNIT,
      range: { checkIn: '2026-09-10', checkOut: '2026-09-12' },
      reason: 'agent_quote',
      heldByUserId: AGENT,
      now: NOW,
      minutes: 45,
      liveHoldCount: 0,
    })

    expect(draft.expiresAt).toBe(expiryFrom(NOW, 45))
  })

  it('refuses a duration beyond the policy for its reason', () => {
    const error = refusal(() =>
      planHold({
        organizationId: ORG,
        unitId: UNIT,
        range: { checkIn: '2026-09-10', checkOut: '2026-09-12' },
        reason: 'guest_checkout',
        heldByUserId: AGENT,
        now: NOW,
        minutes: 600,
        liveHoldCount: 0,
      }),
    )

    expect(error.code).toBe('hold.duration_too_long')
  })

  it.each([0, -30])('refuses a duration of %s minutes', (minutes) => {
    const error = refusal(() =>
      planHold({
        organizationId: ORG,
        unitId: UNIT,
        range: { checkIn: '2026-09-10', checkOut: '2026-09-12' },
        reason: 'agent_quote',
        heldByUserId: AGENT,
        now: NOW,
        minutes,
        liveHoldCount: 0,
      }),
    )

    expect(error.code).toBe('hold.invalid_duration')
  })
})

// ── Extending ─────────────────────────────────────────────────────────────

describe('extending', () => {
  it('pushes the expiry out from now', () => {
    const later = new Date('2026-08-20T09:20:00.000Z')
    const extended = extendHold(hold(), { now: later, minutes: 30 })

    expect(extended.expiresAt).toBe(expiryFrom(later, 30))
  })

  it('does not mutate the hold it was given', () => {
    const original = hold()
    extendHold(original, { now: NOW, minutes: 30 })

    expect(original.expiresAt).toBe('2026-08-20T09:30:00.000Z')
  })

  it('refuses to revive an expired hold', () => {
    // Its dates went back on sale and may already be sold. Reviving it would
    // be a second claim on inventory somebody else now holds.
    const error = refusal(() =>
      extendHold(hold(), {
        now: new Date('2026-08-20T10:00:00.000Z'),
        minutes: 30,
      }),
    )

    expect(error.code).toBe('hold.not_live')
    expect(error.userMessage).toContain('פג')
  })

  it('refuses an extension beyond the policy window', () => {
    const error = refusal(() => extendHold(hold(), { now: NOW, minutes: 5000 }))

    expect(error.code).toBe('hold.duration_too_long')
  })
})

// ── Releasing ─────────────────────────────────────────────────────────────

describe('releasing', () => {
  it('stamps the release and stops the hold blocking', () => {
    const released = releaseHold(hold(), NOW)

    expect(released.releasedAt).toBe(NOW.toISOString())
    expect(isHoldLive(released, NOW)).toBe(false)
  })

  it('tolerates releasing a hold that had already expired', () => {
    // Tidying up. Refusing would leave rows nobody can ever close.
    const expired = hold({ expiresAt: '2026-08-20T08:00:00.000Z' })

    expect(releaseHold(expired, NOW).releasedAt).toBe(NOW.toISOString())
  })

  it('refuses a second release', () => {
    const error = refusal(() =>
      releaseHold(hold({ releasedAt: '2026-08-20T09:05:00.000Z' }), NOW),
    )

    expect(error.code).toBe('hold.already_released')
  })

  it('refuses to release a hold that has become a booking', () => {
    const error = refusal(() =>
      releaseHold(hold({ convertedToBookingId: 'bk-3' }), NOW),
    )

    expect(error.code).toBe('hold.already_converted')
  })
})

// ── Converting ────────────────────────────────────────────────────────────

describe('converting', () => {
  it('stops the hold blocking the booking it just became', () => {
    // The failure this prevents: a live hold overlapping its own booking, and
    // the database's exclusion constraint rejecting the very thing the hold
    // existed to protect.
    const converted = convertHold(hold(), 'bk-42', NOW)

    expect(converted.convertedToBookingId).toBe('bk-42')
    expect(converted.releasedAt).toBe(NOW.toISOString())
    expect(isHoldLive(converted, NOW)).toBe(false)
  })

  it('refuses to convert a hold whose time ran out', () => {
    const error = refusal(() =>
      convertHold(hold(), 'bk-42', new Date('2026-08-20T10:00:00.000Z')),
    )

    expect(error.code).toBe('hold.not_live')
  })

  it('refuses to convert the same hold twice', () => {
    const error = refusal(() =>
      convertHold(hold({ convertedToBookingId: 'bk-1' }), 'bk-2', NOW),
    )

    expect(error.code).toBe('hold.not_live')
  })
})

// ── Coverage of dates ─────────────────────────────────────────────────────

describe('what a hold covers', () => {
  it('covers a stay inside its own range', () => {
    expect(
      holdCovers(hold(), { checkIn: '2026-09-04', checkOut: '2026-09-05' }),
    ).toBe(true)
  })

  it('covers a stay identical to itself', () => {
    expect(
      holdCovers(hold(), { checkIn: '2026-09-03', checkOut: '2026-09-06' }),
    ).toBe(true)
  })

  it('does not cover a stay that runs past it', () => {
    // Two cheap nights held, a fortnight booked: inventory taken that was
    // never claimed.
    expect(
      holdCovers(hold(), { checkIn: '2026-09-03', checkOut: '2026-09-17' }),
    ).toBe(false)
  })

  it('refuses a conversion the hold does not cover', () => {
    const error = refusal(() =>
      assertHoldCovers(hold(), {
        checkIn: '2026-09-01',
        checkOut: '2026-09-06',
      }),
    )

    expect(error.code).toBe('hold.does_not_cover_dates')
  })

  it('overlaps on the half-open convention, like everything else', () => {
    expect(
      holdOverlaps(hold(), { checkIn: '2026-09-06', checkOut: '2026-09-08' }),
    ).toBe(false)
    expect(
      holdOverlaps(hold(), { checkIn: '2026-09-05', checkOut: '2026-09-08' }),
    ).toBe(true)
  })

  it('explains an expired hold in Hebrew when asserted', () => {
    const error = refusal(() =>
      assertHoldIsLive(hold(), new Date('2026-08-20T10:00:00.000Z')),
    )

    expect(error.userMessage).toMatch(/[֐-׿]/)
  })
})

// ── Helpers ───────────────────────────────────────────────────────────────

function refusal(run: () => unknown): BusinessRuleError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessRuleError)
    return error as BusinessRuleError
  }
  throw new Error('expected the hold operation to be refused, but it succeeded')
}
