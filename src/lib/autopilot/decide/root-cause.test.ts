/**
 * The four-alarm morning, and the two ways the graph breaks in production.
 *
 * The central test is the real chain from the module header — laundry delay →
 * inventory shortage → preparation risk → arrival risk — and it asserts ONE
 * incident with THREE consequences. Four rows in, one incident out. If that
 * ever becomes two incidents, the 06:00 screen is back to showing unrelated
 * alarms and the whole file has stopped earning its place.
 */

import { describe, expect, it } from 'vitest'

import type { Signal } from '../types'

import { incidentSignals, rootCause, rootKeyBySignal } from './root-cause'

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

/** The chain from the header, root first. */
const LAUNDRY_DELAY = signal({
  dedupeKey: 'laundry.delivery_late:order-88',
  code: 'laundry.delivery_late',
  domain: 'laundry',
  risk: 'at_risk',
  title: 'אספקת הכביסה מתעכבת',
})

const SHORTAGE = signal({
  dedupeKey: 'inventory.shortage:towel:prop-1',
  code: 'inventory.shortage',
  domain: 'inventory',
  risk: 'at_risk',
  title: 'חוסר צפוי במגבות',
  causedBy: LAUNDRY_DELAY.dedupeKey,
})

const PREPARATION = signal({
  dedupeKey: 'preparation.blocked:prop-1',
  code: 'preparation.blocked',
  domain: 'preparation',
  risk: 'at_risk',
  title: 'ההכנה חסומה',
  causedBy: SHORTAGE.dedupeKey,
})

const ARRIVAL = signal({
  dedupeKey: 'arrival.at_risk:bk-1',
  code: 'arrival.at_risk',
  domain: 'arrival_risk',
  risk: 'critical',
  title: 'ההגעה ב-15:00 בסיכון',
  dueAt: '2026-09-06T15:00:00Z',
  causedBy: PREPARATION.dedupeKey,
})

const CHAIN = [ARRIVAL, PREPARATION, SHORTAGE, LAUNDRY_DELAY]

/* ---------------------------------------------------------------- tests -- */

describe('a four-level chain', () => {
  it('is one incident with three consequences, not four alarms', () => {
    const result = rootCause(CHAIN)

    expect(result.incidents).toHaveLength(1)

    const incident = result.incidents[0]
    expect(incident.root.dedupeKey).toBe(LAUNDRY_DELAY.dedupeKey)
    expect(incident.consequences).toHaveLength(3)
    expect(result.cycles).toEqual([])
    expect(result.dangling).toEqual([])
  })

  it('records the depth and the immediate cause of each consequence', () => {
    const [incident] = rootCause(CHAIN).incidents

    expect(
      incident.consequences.map((c) => [
        c.signal.dedupeKey,
        c.depth,
        c.causedBy,
      ]),
    ).toEqual([
      [SHORTAGE.dedupeKey, 1, LAUNDRY_DELAY.dedupeKey],
      [PREPARATION.dedupeKey, 2, SHORTAGE.dedupeKey],
      [ARRIVAL.dedupeKey, 3, PREPARATION.dedupeKey],
    ])
  })

  it('gives the same answer whatever order the detectors emitted', () => {
    const forwards = rootCause([LAUNDRY_DELAY, SHORTAGE, PREPARATION, ARRIVAL])
    const backwards = rootCause(CHAIN)

    expect(forwards).toEqual(backwards)
  })

  it('lists every member through incidentSignals, root first', () => {
    const [incident] = rootCause(CHAIN).incidents

    expect(incidentSignals(incident).map((s) => s.dedupeKey)).toEqual([
      LAUNDRY_DELAY.dedupeKey,
      SHORTAGE.dedupeKey,
      PREPARATION.dedupeKey,
      ARRIVAL.dedupeKey,
    ])
  })

  it('maps every member back to the root', () => {
    const map = rootKeyBySignal(rootCause(CHAIN))

    for (const member of CHAIN) {
      expect(map.get(member.dedupeKey)).toBe(LAUNDRY_DELAY.dedupeKey)
    }
  })
})

describe('cycles are a detector bug, not a crash', () => {
  it('drops the back-edge of a three-node cycle and reports it', () => {
    const a = signal({ dedupeKey: 'a', causedBy: 'c' })
    const b = signal({ dedupeKey: 'b', causedBy: 'a' })
    const c = signal({ dedupeKey: 'c', causedBy: 'b' })

    const result = rootCause([a, b, c])

    expect(result.cycles).toHaveLength(1)
    expect([...result.cycles[0].members].sort()).toEqual(['a', 'b', 'c'])

    // Every member survives: a cycle loses one edge, never three problems.
    const present = result.incidents.flatMap((incident) =>
      incidentSignals(incident).map((s) => s.dedupeKey),
    )
    expect([...present].sort()).toEqual(['a', 'b', 'c'])
  })

  it('treats a self-reference as the degenerate cycle', () => {
    const lonely = signal({ dedupeKey: 'x', causedBy: 'x' })

    const result = rootCause([lonely])

    expect(result.cycles).toEqual([
      { members: ['x'], droppedFrom: 'x', droppedTo: 'x' },
    ])
    expect(result.incidents).toHaveLength(1)
    expect(result.incidents[0].root.dedupeKey).toBe('x')
  })

  it('keeps a branch hanging off a cycle attached to it', () => {
    const a = signal({ dedupeKey: 'a', causedBy: 'b' })
    const b = signal({ dedupeKey: 'b', causedBy: 'a' })
    const leaf = signal({ dedupeKey: 'leaf', causedBy: 'a' })

    const result = rootCause([a, b, leaf])

    expect(result.cycles).toHaveLength(1)
    const keys = result.incidents.flatMap((incident) =>
      incidentSignals(incident).map((s) => s.dedupeKey),
    )
    expect([...keys].sort()).toEqual(['a', 'b', 'leaf'])
    expect(result.incidents).toHaveLength(1)
  })

  it('does not hang on a long chain that closes on itself', () => {
    const size = 500
    const ring = Array.from({ length: size }, (unused, index) =>
      signal({
        dedupeKey: `n${index}`,
        causedBy: `n${(index + size - 1) % size}`,
      }),
    )

    const result = rootCause(ring)

    expect(result.cycles).toHaveLength(1)
    expect(
      result.incidents.reduce(
        (total, incident) => total + incidentSignals(incident).length,
        0,
      ),
    ).toBe(size)
  })
})

describe('a cause outside the batch', () => {
  it('keeps the child as its own root and reports the missing cause', () => {
    const orphan = signal({
      dedupeKey: 'inventory.shortage:towel:prop-1',
      domain: 'inventory',
      causedBy: 'laundry.delivery_late:order-from-yesterday',
    })

    const result = rootCause([orphan])

    expect(result.dangling).toEqual([
      {
        dedupeKey: 'inventory.shortage:towel:prop-1',
        missingCause: 'laundry.delivery_late:order-from-yesterday',
      },
    ])
    expect(result.incidents).toHaveLength(1)
    expect(result.incidents[0].root).toBe(orphan)
    expect(result.incidents[0].consequences).toEqual([])
  })
})

describe('ordering', () => {
  it('places an incident by its most urgent member, not by its root', () => {
    // The laundry root sits near the bottom of AUTOPILOT_DOMAINS; the arrival
    // it is about to cost sits near the top. Ordering on the root alone would
    // bury the most important thing in the day.
    const standalone = signal({
      dedupeKey: 'maintenance.open:prop-2',
      domain: 'maintenance',
      risk: 'critical',
    })

    const result = rootCause([...CHAIN, standalone])

    expect(result.incidents).toHaveLength(2)
    expect(result.incidents[0].root.dedupeKey).toBe(LAUNDRY_DELAY.dedupeKey)
    expect(result.incidents[1].root.dedupeKey).toBe(standalone.dedupeKey)
  })

  it('orders sibling consequences by triage within their level', () => {
    const root = signal({ dedupeKey: 'root', domain: 'laundry' })
    const low = signal({
      dedupeKey: 'low',
      domain: 'optimization',
      causedBy: 'root',
    })
    const high = signal({
      dedupeKey: 'high',
      domain: 'safety',
      causedBy: 'root',
    })

    const [incident] = rootCause([root, low, high]).incidents

    expect(incident.consequences.map((c) => c.signal.dedupeKey)).toEqual([
      'high',
      'low',
    ])
  })
})

describe('a batch that skipped dedupe', () => {
  it('keeps the more urgent copy and names the repeated key', () => {
    const mild = signal({ dedupeKey: 'dup', risk: 'on_track' })
    const severe = signal({ dedupeKey: 'dup', risk: 'critical' })

    const result = rootCause([mild, severe])

    expect(result.duplicateKeys).toEqual(['dup'])
    expect(result.incidents).toHaveLength(1)
    expect(result.incidents[0].root).toBe(severe)
  })
})

describe('an empty batch', () => {
  it('is an empty forest rather than an error', () => {
    expect(rootCause([])).toEqual({
      incidents: [],
      cycles: [],
      dangling: [],
      duplicateKeys: [],
    })
  })
})
