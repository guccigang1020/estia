/**
 * Triage, checked against the contract rather than against a copy of it.
 *
 * The domain-order test reads `AUTOPILOT_DOMAINS` and asserts the triage
 * reproduces it. It deliberately does NOT list the eleven domains in the
 * expected order: a test that restated the order would pass on the day
 * somebody reordered the tuple and the comparator together and would still be
 * asserting the old product. Reading the tuple means the test asserts the
 * relationship — "triage order IS the tuple order" — which is the actual claim.
 */

import { describe, expect, it } from 'vitest'

import {
  AUTOPILOT_DOMAINS,
  AUTOPILOT_RISK_STATES,
  type AutopilotDomain,
  type AutopilotRiskState,
} from '../../contracts/states'
import type { Signal } from '../types'

import {
  compareSignals,
  deadlineOf,
  domainPriority,
  riskPriority,
  triage,
  triageRank,
} from './triage'

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

/**
 * A deterministic shuffle.
 *
 * Reverse, then rotate by three — enough to guarantee the input order is not
 * the expected output order, and reproducible, because a test that fails one
 * run in twenty tells nobody anything.
 */
function scrambled<T>(items: readonly T[]): readonly T[] {
  const reversed = [...items].reverse()
  return [...reversed.slice(3), ...reversed.slice(0, 3)]
}

/* ---------------------------------------------------------------- tests -- */

describe('domain order', () => {
  it('reproduces AUTOPILOT_DOMAINS exactly', () => {
    const scrambledDomains = scrambled(AUTOPILOT_DOMAINS)
    const signals = scrambledDomains.map((domain) =>
      signal({ dedupeKey: `k.${domain}`, domain }),
    )

    const ordered = triage(signals).map((item) => item.domain)

    expect(ordered).toEqual([...AUTOPILOT_DOMAINS])
    // Guard the guard: if the scramble ever became a no-op the assertion above
    // would pass without the comparator doing anything.
    expect(scrambledDomains).not.toEqual([...AUTOPILOT_DOMAINS])
  })

  it('puts safety first and optimization last, per the tuple', () => {
    const first = AUTOPILOT_DOMAINS[0]
    const last = AUTOPILOT_DOMAINS[AUTOPILOT_DOMAINS.length - 1]

    expect(first).toBe('safety')
    expect(last).toBe('optimization')
    expect(domainPriority(first)).toBeLessThan(domainPriority(last))
  })

  it('sorts an unknown domain last rather than throwing', () => {
    const rogue = 'invented_by_a_detector' as AutopilotDomain
    expect(domainPriority(rogue)).toBeGreaterThanOrEqual(
      AUTOPILOT_DOMAINS.length,
    )
  })
})

describe('risk within a domain', () => {
  it('orders worst first, mirroring AUTOPILOT_RISK_STATES', () => {
    const signals = AUTOPILOT_RISK_STATES.map((risk) =>
      signal({ dedupeKey: `k.${risk}`, domain: 'inventory', risk }),
    )

    const ordered = triage(signals).map((item) => item.risk)

    expect(ordered).toEqual([...AUTOPILOT_RISK_STATES].reverse())
  })

  it('never lets risk outrank the domain', () => {
    const criticalOptimization = signal({
      dedupeKey: 'k.opt',
      domain: 'optimization',
      risk: 'critical',
    })
    const readySafety = signal({
      dedupeKey: 'k.safety',
      domain: 'safety',
      risk: 'ready',
    })

    expect(triage([criticalOptimization, readySafety])[0]).toBe(readySafety)
  })

  it('sorts an unknown risk last', () => {
    const rogue = 'catastrophic' as AutopilotRiskState
    expect(riskPriority(rogue)).toBeGreaterThanOrEqual(
      AUTOPILOT_RISK_STATES.length,
    )
  })
})

describe('deadline', () => {
  it('prefers dueAt over the thresholds on the way to it', () => {
    const item = signal({
      dedupeKey: 'k.1',
      dueAt: '2026-09-06T15:00:00Z',
      criticalAt: '2026-09-06T13:00:00Z',
      warnAt: '2026-09-06T11:00:00Z',
    })
    expect(deadlineOf(item)).toBe(Date.parse('2026-09-06T15:00:00Z'))
  })

  it('falls back to criticalAt, then warnAt', () => {
    const critical = signal({
      dedupeKey: 'k.2',
      criticalAt: '2026-09-06T13:00:00Z',
      warnAt: '2026-09-06T11:00:00Z',
    })
    const warn = signal({ dedupeKey: 'k.3', warnAt: '2026-09-06T11:00:00Z' })

    expect(deadlineOf(critical)).toBe(Date.parse('2026-09-06T13:00:00Z'))
    expect(deadlineOf(warn)).toBe(Date.parse('2026-09-06T11:00:00Z'))
  })

  it('orders the soonest deadline first within one domain and risk', () => {
    const late = signal({ dedupeKey: 'k.late', dueAt: '2026-09-06T18:00:00Z' })
    const soon = signal({ dedupeKey: 'k.soon', dueAt: '2026-09-06T09:00:00Z' })

    expect(triage([late, soon])).toEqual([soon, late])
  })

  it('places a signal with no deadline after one with a deadline', () => {
    const none = signal({ dedupeKey: 'a.none' })
    const dated = signal({
      dedupeKey: 'z.dated',
      dueAt: '2027-01-01T00:00:00Z',
    })

    // `a.none` would win the alphabetical tiebreak, so this fails if the
    // deadline rule is dropped.
    expect(triage([none, dated])).toEqual([dated, none])
  })

  it('treats an unparseable timestamp as absent rather than as NaN', () => {
    const broken = signal({ dedupeKey: 'k.broken', dueAt: 'yesterday-ish' })
    const dated = signal({
      dedupeKey: 'k.dated',
      dueAt: '2026-09-06T09:00:00Z',
    })

    expect(deadlineOf(broken)).toBe(Number.POSITIVE_INFINITY)
    expect(triage([broken, dated])).toEqual([dated, broken])
  })
})

describe('determinism', () => {
  it('breaks a full tie on dedupeKey, so passes do not reshuffle', () => {
    const b = signal({ dedupeKey: 'b.key' })
    const a = signal({ dedupeKey: 'a.key' })

    expect(triage([b, a])).toEqual([a, b])
    expect(triage([a, b])).toEqual([a, b])
    expect(compareSignals(a, a)).toBe(0)
  })

  it('does not mutate the caller array', () => {
    const first = signal({ dedupeKey: 'z', domain: 'optimization' })
    const second = signal({ dedupeKey: 'a', domain: 'safety' })
    const input = [first, second]

    triage(input)

    expect(input).toEqual([first, second])
  })
})

describe('triageRank', () => {
  it('reports the three ordinals for a single signal', () => {
    const item = signal({
      dedupeKey: 'k.rank',
      domain: 'safety',
      risk: 'critical',
      dueAt: '2026-09-06T09:00:00Z',
    })

    expect(triageRank(item)).toEqual({
      domain: 0,
      risk: 0,
      deadline: Date.parse('2026-09-06T09:00:00Z'),
    })
  })
})
