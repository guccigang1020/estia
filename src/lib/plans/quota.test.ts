/**
 * Quotas.
 *
 * The commercially important guarantee in this file is negative: growing past
 * the plan's unit or property allowance must never stop the business serving a
 * guest. Only actions that can safely wait are refused.
 */

import { describe, expect, it } from 'vitest'
import {
  QUOTA_BLOCKS_ACTION,
  checkQuota,
  isBlockedByQuota,
  type QuotaKey,
  type QuotaState,
} from './quota'
import type { PlanLimits } from './entitlements'

// ── Helpers ───────────────────────────────────────────────────────────────

const PRO_LIMITS: PlanLimits = {
  properties: 5,
  units: 15,
  members: 10,
  storageGb: 50,
}

const UNLIMITED: PlanLimits = {
  properties: null,
  units: null,
  members: null,
  storageGb: null,
}

function limits(overrides: Partial<PlanLimits>): PlanLimits {
  return { ...PRO_LIMITS, ...overrides }
}

/** The Pro limits with a single key rewritten, for table-driven cases. */
function limitFor(key: QuotaKey, value: number | null): PlanLimits {
  return { ...PRO_LIMITS, [key]: value }
}

const ALL_KEYS: readonly QuotaKey[] = ['properties', 'units', 'members', 'storageGb']

// ── Unlimited ─────────────────────────────────────────────────────────────

describe('an unlimited allowance', () => {
  it.each(ALL_KEYS)('treats a null limit on "%s" as unlimited', (key) => {
    const state = checkQuota(key, 999_999, UNLIMITED)

    expect(state).toEqual({
      key,
      current: 999_999,
      limit: null,
      withinLimit: true,
      inOverage: false,
      approaching: false,
    })
  })

  it('never warns that an unlimited allowance is being approached', () => {
    expect(checkQuota('members', 10_000, UNLIMITED).approaching).toBe(false)
  })

  it('never blocks an action on an unlimited allowance, even for a blocking key', () => {
    expect(isBlockedByQuota(checkQuota('members', 10_000, UNLIMITED))).toBe(false)
  })
})

// ── Within, approaching, over ─────────────────────────────────────────────

describe('the three states of a limited allowance', () => {
  it('reports a comfortable count as within the limit and not approaching it', () => {
    const state = checkQuota('units', 5, PRO_LIMITS)

    expect(state.withinLimit).toBe(true)
    expect(state.inOverage).toBe(false)
    expect(state.approaching).toBe(false)
  })

  it('reports a count equal to the limit as within it, not over it', () => {
    const state = checkQuota('units', 15, PRO_LIMITS)

    expect(state.withinLimit).toBe(true)
    expect(state.inOverage).toBe(false)
  })

  it('reports a count above the limit as in overage', () => {
    const state = checkQuota('units', 16, PRO_LIMITS)

    expect(state.withinLimit).toBe(false)
    expect(state.inOverage).toBe(true)
  })

  it('reports the actual count and the limit back to the caller, so a message can be written', () => {
    const state = checkQuota('properties', 4, PRO_LIMITS)

    expect(state.key).toBe('properties')
    expect(state.current).toBe(4)
    expect(state.limit).toBe(5)
  })
})

describe('the approaching warning', () => {
  it('warns once the customer reaches 80 percent of the allowance', () => {
    // Ten members: the warning is due at eight.
    expect(checkQuota('members', 8, limits({ members: 10 })).approaching).toBe(true)
  })

  it('stays quiet just below 80 percent of the allowance', () => {
    expect(checkQuota('members', 7, limits({ members: 10 })).approaching).toBe(false)
  })

  const ratios: ReadonlyArray<{ limit: number; current: number; expected: boolean }> = [
    { limit: 15, current: 11, expected: false },
    { limit: 15, current: 12, expected: true },
    { limit: 15, current: 15, expected: true },
    { limit: 50, current: 39, expected: false },
    { limit: 50, current: 40, expected: true },
    { limit: 5, current: 3, expected: false },
    { limit: 5, current: 4, expected: true },
  ]

  it.each(ratios)(
    'reports approaching=$expected at $current of $limit',
    ({ limit, current, expected }) => {
      expect(checkQuota('units', current, limits({ units: limit })).approaching).toBe(
        expected,
      )
    },
  )

  it('stops warning once the line has actually been crossed, because overage is a different message', () => {
    const state = checkQuota('units', 20, limits({ units: 15 }))

    expect(state.approaching).toBe(false)
    expect(state.inOverage).toBe(true)
  })
})

// ── The commercial guarantee ──────────────────────────────────────────────

describe('overage never stops the day\'s work', () => {
  it('does not block a business that is over its unit allowance', () => {
    const state = checkQuota('units', 20, PRO_LIMITS)

    expect(state.inOverage).toBe(true)
    expect(isBlockedByQuota(state)).toBe(false)
  })

  it('does not block a business that is over its property allowance', () => {
    const state = checkQuota('properties', 9, PRO_LIMITS)

    expect(state.inOverage).toBe(true)
    expect(isBlockedByQuota(state)).toBe(false)
  })

  it('blocks inviting another member once the member allowance is exceeded, because that can wait', () => {
    const state = checkQuota('members', 11, PRO_LIMITS)

    expect(state.inOverage).toBe(true)
    expect(isBlockedByQuota(state)).toBe(true)
  })

  it('blocks further storage once the storage allowance is exceeded', () => {
    const state = checkQuota('storageGb', 51, PRO_LIMITS)

    expect(state.inOverage).toBe(true)
    expect(isBlockedByQuota(state)).toBe(true)
  })

  const blocking: ReadonlyArray<{ key: QuotaKey; blocks: boolean }> = [
    { key: 'properties', blocks: false },
    { key: 'units', blocks: false },
    { key: 'members', blocks: true },
    { key: 'storageGb', blocks: true },
  ]

  it.each(blocking)('blocks "$key" in overage: $blocks', ({ key, blocks }) => {
    const state = checkQuota(key, 100, limitFor(key, 1))

    expect(state.inOverage).toBe(true)
    expect(isBlockedByQuota(state)).toBe(blocks)
  })

  it.each(ALL_KEYS)('never blocks "%s" while the customer is within the limit', (key) => {
    expect(isBlockedByQuota(checkQuota(key, 1, PRO_LIMITS))).toBe(false)
  })

  it.each(ALL_KEYS)(
    'never blocks "%s" merely because the limit is being approached',
    (key) => {
      const state = checkQuota(key, 8, limitFor(key, 10))

      expect(state.approaching).toBe(true)
      expect(isBlockedByQuota(state)).toBe(false)
    },
  )
})

describe('the blocking table', () => {
  it('states a decision for every quota key, so a new limit cannot default silently', () => {
    expect(Object.keys(QUOTA_BLOCKS_ACTION).sort()).toEqual([...ALL_KEYS].sort())
  })

  it('leaves the two growth limits non-blocking', () => {
    expect(QUOTA_BLOCKS_ACTION.properties).toBe(false)
    expect(QUOTA_BLOCKS_ACTION.units).toBe(false)
  })

  it('keeps the two deferrable limits blocking', () => {
    expect(QUOTA_BLOCKS_ACTION.members).toBe(true)
    expect(QUOTA_BLOCKS_ACTION.storageGb).toBe(true)
  })

  it('refuses nothing on a state that is not in overage, whatever the key says', () => {
    const notOver: QuotaState = {
      key: 'members',
      current: 3,
      limit: 10,
      withinLimit: true,
      inOverage: false,
      approaching: false,
    }

    expect(isBlockedByQuota(notOver)).toBe(false)
  })
})

// ── Edges ─────────────────────────────────────────────────────────────────

describe('edges of the allowance arithmetic', () => {
  it('treats an empty account as within any allowance', () => {
    const state = checkQuota('units', 0, PRO_LIMITS)

    expect(state.withinLimit).toBe(true)
    expect(state.inOverage).toBe(false)
  })

  it('treats a limit of one as crossed only at two', () => {
    expect(checkQuota('properties', 1, limits({ properties: 1 })).inOverage).toBe(false)
    expect(checkQuota('properties', 2, limits({ properties: 1 })).inOverage).toBe(true)
  })

  it('reports a limit of zero as immediately approached but not exceeded at zero', () => {
    const state = checkQuota('members', 0, limits({ members: 0 }))

    expect(state.withinLimit).toBe(true)
    expect(state.inOverage).toBe(false)
    expect(state.approaching).toBe(true)
    expect(isBlockedByQuota(state)).toBe(false)
  })
})
