/**
 * Dedupe, held to the one guarantee it exists for: never two rows.
 *
 * The tests that matter here are the boring arithmetic ones — what
 * `seen_count` becomes, which of two identical keys survives, and what happens
 * when a clock steps backwards — because those are the ways this quietly goes
 * wrong in production without anything looking broken.
 */

import { describe, expect, it } from 'vitest'

import type { Decision, Signal } from '../types'

import {
  dedupeDecisions,
  dedupeSignals,
  occurrencesByKey,
  type Occurrence,
} from './dedupe'

/* ------------------------------------------------------------- fixtures -- */

function signal(over: Partial<Signal> & { dedupeKey: string }): Signal {
  return {
    code: 'test.signal',
    domain: 'preparation',
    risk: 'at_risk',
    resourceType: 'booking',
    resourceId: 'bk-1',
    propertyId: 'prop-1',
    title: 'כותרת',
    detail: 'פירוט',
    evidence: [],
    ...over,
  }
}

function decision(item: Signal, priority = 0): Decision {
  return { signal: item, actions: [], priority }
}

const NOW = '2026-09-06T06:00:00Z'

/* ---------------------------------------------------------------- tests -- */

describe('collapsing a batch', () => {
  it('returns one row per dedupeKey', () => {
    const result = dedupeSignals(
      [
        signal({ dedupeKey: 'inventory.shortage:towel' }),
        signal({ dedupeKey: 'inventory.shortage:towel' }),
        signal({ dedupeKey: 'laundry.late:order-88' }),
      ],
      { observedAt: NOW },
    )

    expect(result.kept).toHaveLength(2)
    expect(result.collapsed).toBe(1)
    expect(result.occurrences).toHaveLength(2)
  })

  it('keeps the more urgent copy, whatever order it arrived in', () => {
    const mild = signal({ dedupeKey: 'k', risk: 'on_track' })
    const severe = signal({ dedupeKey: 'k', risk: 'critical' })

    expect(dedupeSignals([mild, severe], { observedAt: NOW }).kept).toEqual([
      severe,
    ])
    expect(dedupeSignals([severe, mild], { observedAt: NOW }).kept).toEqual([
      severe,
    ])
  })

  it('counts one pass as one sighting even when a detector emits twice', () => {
    const result = dedupeSignals(
      [
        signal({ dedupeKey: 'k' }),
        signal({ dedupeKey: 'k' }),
        signal({ dedupeKey: 'k' }),
      ],
      { observedAt: NOW },
    )

    expect(result.occurrences).toEqual([
      { dedupeKey: 'k', seenCount: 1, firstSeenAt: NOW, lastSeenAt: NOW },
    ])
  })
})

describe('merging with what the store already holds', () => {
  it('increments seenCount and moves lastSeenAt, keeping firstSeenAt', () => {
    const known: Occurrence = {
      dedupeKey: 'k',
      seenCount: 71,
      firstSeenAt: '2026-09-06T00:05:00Z',
      lastSeenAt: '2026-09-06T05:55:00Z',
    }

    const result = dedupeSignals([signal({ dedupeKey: 'k' })], {
      observedAt: NOW,
      known: [known],
    })

    expect(result.occurrences).toEqual([
      {
        dedupeKey: 'k',
        seenCount: 72,
        firstSeenAt: '2026-09-06T00:05:00Z',
        lastSeenAt: NOW,
      },
    ])
  })

  it('never rewinds lastSeenAt when the clock steps backwards', () => {
    const known: Occurrence = {
      dedupeKey: 'k',
      seenCount: 3,
      firstSeenAt: '2026-09-06T00:00:00Z',
      lastSeenAt: '2026-09-06T08:00:00Z',
    }

    const result = dedupeSignals([signal({ dedupeKey: 'k' })], {
      observedAt: NOW,
      known: [known],
    })

    expect(result.occurrences[0].lastSeenAt).toBe('2026-09-06T08:00:00Z')
    expect(result.occurrences[0].seenCount).toBe(4)
  })

  it('moves firstSeenAt earlier when a late-delivered old pass arrives', () => {
    const known: Occurrence = {
      dedupeKey: 'k',
      seenCount: 2,
      firstSeenAt: '2026-09-06T07:00:00Z',
      lastSeenAt: '2026-09-06T07:30:00Z',
    }

    const result = dedupeSignals([signal({ dedupeKey: 'k' })], {
      observedAt: NOW,
      known: [known],
    })

    expect(result.occurrences[0].firstSeenAt).toBe(NOW)
    expect(result.occurrences[0].lastSeenAt).toBe('2026-09-06T07:30:00Z')
  })

  it('prefers the timestamp that parses over one that does not', () => {
    const known: Occurrence = {
      dedupeKey: 'k',
      seenCount: 1,
      firstSeenAt: 'corrupt',
      lastSeenAt: 'corrupt',
    }

    const result = dedupeSignals([signal({ dedupeKey: 'k' })], {
      observedAt: NOW,
      known: [known],
    })

    expect(result.occurrences[0].firstSeenAt).toBe(NOW)
    expect(result.occurrences[0].lastSeenAt).toBe(NOW)
  })

  it('ignores stored keys that are not in this batch', () => {
    const result = dedupeSignals([signal({ dedupeKey: 'here' })], {
      observedAt: NOW,
      known: [
        {
          dedupeKey: 'elsewhere',
          seenCount: 9,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      ],
    })

    expect(result.occurrences.map((o) => o.dedupeKey)).toEqual(['here'])
  })
})

describe('decisions', () => {
  it('collapses by the signal underneath, keeping the worse one', () => {
    const mild = decision(signal({ dedupeKey: 'k', risk: 'on_track' }), 4)
    const severe = decision(signal({ dedupeKey: 'k', risk: 'critical' }), 1)

    const result = dedupeDecisions([mild, severe], { observedAt: NOW })

    expect(result.kept).toEqual([severe])
    expect(result.collapsed).toBe(1)
  })
})

describe('occurrencesByKey', () => {
  it('indexes the counters for a screen that shows them', () => {
    const result = dedupeSignals(
      [signal({ dedupeKey: 'a' }), signal({ dedupeKey: 'b' })],
      { observedAt: NOW },
    )

    const index = occurrencesByKey(result.occurrences)

    expect(index.get('a')?.seenCount).toBe(1)
    expect(index.get('b')?.seenCount).toBe(1)
    expect(index.get('missing')).toBeUndefined()
  })
})

describe('an empty batch', () => {
  it('collapses to nothing without complaint', () => {
    expect(dedupeSignals([], { observedAt: NOW })).toEqual({
      kept: [],
      occurrences: [],
      collapsed: 0,
    })
  })
})
