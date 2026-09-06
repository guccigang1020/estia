/**
 * "סדר לי את היום", checked against the failure it exists to prevent.
 *
 * Not "did it list everything" — an exhaustive list is easy and useless. The
 * assertions here are about compression and honesty: four connected alarms are
 * one line, forty problems do not produce forty lines, and what did not fit is
 * counted out loud rather than dropped.
 */

import { describe, expect, it } from 'vitest'

import type { AutopilotDomain } from '../../contracts/states'
import type { Decision, ProposedAction, Signal } from '../types'

import { DEFAULT_PLAN_LIMIT, planDay } from './plan'
import { decide, type ProposalContext } from './propose'

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

const ACTION: ProposedAction = {
  kind: 'exception.raise',
  reason: 'סיבה',
  confidence: 'high',
  input: {},
  idempotencyKey: 'k',
}

function decision(item: Signal, priority: number): Decision {
  return { signal: item, actions: [ACTION], priority }
}

/** The header's chain, already triaged: arrival is worst, laundry is root. */
function chain(): readonly Decision[] {
  const laundry = signal({
    dedupeKey: 'laundry.late',
    domain: 'laundry',
    title: 'אספקת הכביסה מתעכבת',
  })
  const shortage = signal({
    dedupeKey: 'inventory.short',
    domain: 'inventory',
    causedBy: 'laundry.late',
  })
  const preparation = signal({
    dedupeKey: 'preparation.blocked',
    domain: 'preparation',
    causedBy: 'inventory.short',
  })
  const arrival = signal({
    dedupeKey: 'arrival.risk',
    domain: 'arrival_risk',
    risk: 'critical',
    causedBy: 'preparation.blocked',
  })

  // Priorities as `decide` would number them: triage order.
  return [
    decision(arrival, 0),
    decision(preparation, 1),
    decision(shortage, 2),
    decision(laundry, 3),
  ]
}

const CONTEXT: ProposalContext = {
  entitlements: ['core', 'operations', 'laundry', 'autopilot'],
  trigger: 'sweep-1',
}

/* ---------------------------------------------------------------- tests -- */

describe('grouping', () => {
  it('turns four connected alarms into one line', () => {
    const plan = planDay(chain())

    expect(plan.items).toHaveLength(1)
    expect(plan.items[0].decision.signal.dedupeKey).toBe('laundry.late')
    expect(plan.items[0].consequences).toHaveLength(3)
    expect(plan.covered).toBe(4)
    expect(plan.deferred).toBe(0)
  })

  it('says which consequence is why the root is where it is', () => {
    const plan = planDay(chain())

    // The line is about the laundry, and the reason it is first is the 15:00
    // arrival hanging off it.
    expect(plan.items[0].drivenBy.dedupeKey).toBe('arrival.risk')
  })

  it('leaves the root as the driver when nothing downstream outranks it', () => {
    const root = signal({ dedupeKey: 'safety.gas', domain: 'safety' })
    const child = signal({
      dedupeKey: 'opt.idea',
      domain: 'optimization',
      causedBy: 'safety.gas',
    })

    const plan = planDay([decision(root, 0), decision(child, 1)])

    expect(plan.items[0].drivenBy.dedupeKey).toBe('safety.gas')
  })

  it('offers the first proposal as the button', () => {
    const plan = planDay(chain())
    expect(plan.items[0].next).toBe(ACTION)
  })
})

describe('the cap', () => {
  function manyDecisions(count: number): readonly Decision[] {
    const domains: readonly AutopilotDomain[] = [
      'preparation',
      'maintenance',
      'inventory',
    ]
    return Array.from({ length: count }, (unused, index) =>
      decision(
        signal({
          dedupeKey: `problem.${String(index).padStart(3, '0')}`,
          domain: domains[index % domains.length],
        }),
        index,
      ),
    )
  }

  it('does not produce a plan of forty items', () => {
    const plan = planDay(manyDecisions(40))

    expect(plan.items).toHaveLength(DEFAULT_PLAN_LIMIT)
    expect(plan.deferred).toBe(40 - DEFAULT_PLAN_LIMIT)
  })

  it('counts what did not fit rather than dropping it silently', () => {
    const plan = planDay(manyDecisions(40))

    expect(plan.headline).toContain(String(40 - DEFAULT_PLAN_LIMIT))
  })

  it('honours a caller that wants a different length', () => {
    expect(planDay(manyDecisions(40), { limit: 3 }).items).toHaveLength(3)
    expect(planDay(manyDecisions(40), { limit: 0 }).items).toHaveLength(0)
    expect(planDay(manyDecisions(40), { limit: 0 }).deferred).toBe(40)
  })

  it('numbers the positions from one, contiguously', () => {
    const plan = planDay(manyDecisions(40))
    expect(plan.items.map((item) => item.position)).toEqual(
      Array.from({ length: DEFAULT_PLAN_LIMIT }, (unused, i) => i + 1),
    )
  })

  it('keeps the most urgent incidents when it has to choose', () => {
    const plan = planDay(
      [
        decision(signal({ dedupeKey: 'a', domain: 'optimization' }), 2),
        decision(signal({ dedupeKey: 'b', domain: 'safety' }), 0),
        decision(signal({ dedupeKey: 'c', domain: 'payment_risk' }), 1),
      ],
      { limit: 1 },
    )

    expect(plan.items[0].decision.signal.dedupeKey).toBe('b')
    expect(plan.deferred).toBe(2)
  })
})

describe('the headline', () => {
  it('says so when there is nothing open', () => {
    expect(planDay([]).headline).toBe('אין נושאים פתוחים. היום נראה מסודר.')
  })

  it('does not say "1 נושאים"', () => {
    const plan = planDay([decision(signal({ dedupeKey: 'only' }), 0)])
    expect(plan.headline).toContain('נושא אחד')
    expect(plan.headline).not.toContain('1 נושאים')
  })

  it('mentions the grouping only when there was grouping', () => {
    expect(planDay(chain()).headline).toContain('4')
    expect(
      planDay([decision(signal({ dedupeKey: 'only' }), 0)]).headline,
    ).not.toContain('המכסים')
  })
})

describe('what it surfaces rather than swallows', () => {
  it('reports a detector cycle instead of hiding it', () => {
    const a = signal({ dedupeKey: 'a', causedBy: 'b' })
    const b = signal({ dedupeKey: 'b', causedBy: 'a' })

    const plan = planDay([decision(a, 0), decision(b, 1)])

    expect(plan.cycles).toHaveLength(1)
    expect(plan.items).toHaveLength(1)
  })

  it('reports a cause raised before this batch', () => {
    const orphan = signal({ dedupeKey: 'child', causedBy: 'yesterday' })

    const plan = planDay([decision(orphan, 0)])

    expect(plan.dangling).toEqual([
      { dedupeKey: 'child', missingCause: 'yesterday' },
    ])
    expect(plan.items).toHaveLength(1)
  })
})

describe('end to end', () => {
  it('runs from raw signals through decide to a plan', () => {
    const raw = [
      signal({ dedupeKey: 'laundry.late', domain: 'laundry' }),
      signal({ dedupeKey: 'laundry.late', domain: 'laundry' }),
      signal({
        dedupeKey: 'inventory.short',
        domain: 'inventory',
        causedBy: 'laundry.late',
      }),
      signal({ dedupeKey: 'safety.gas', domain: 'safety', risk: 'critical' }),
    ]

    const decided = decide(raw, CONTEXT, {
      observedAt: '2026-09-06T06:00:00Z',
    })
    const plan = planDay(decided.decisions)

    expect(decided.collapsed).toBe(1)
    expect(plan.items).toHaveLength(2)
    expect(plan.items[0].decision.signal.dedupeKey).toBe('safety.gas')
    expect(plan.items[1].consequences).toHaveLength(1)
    expect(plan.covered).toBe(3)
    for (const item of plan.items) expect(item.next).not.toBeNull()
  })
})
