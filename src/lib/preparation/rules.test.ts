/**
 * The evaluator.
 *
 * Three claims worth proving separately from the plan they end up in: a
 * quantity is arithmetic over data, a buffer always rounds up, and a
 * conditional rule fires exactly at its threshold and not a guest before.
 *
 * The threshold cases are table-driven around the boundary on purpose. An
 * off-by-one in a comparator is invisible in a happy-path test and shows up
 * later as a house that ordered four packs of toilet paper for nineteen
 * people and none for twenty.
 */

import { describe, expect, it } from 'vitest'
import {
  applyBuffer,
  effectiveOn,
  evaluateCondition,
  factValue,
  resolveQuantity,
} from './rules'
import { FACT_BASES, type PreparationFacts, type RuleCondition } from './types'

const FACTS: PreparationFacts = {
  guests: 25,
  adults: 20,
  children: 5,
  nights: 2,
  bedrooms: 5,
  bathrooms: 3,
  permanentCapacity: 10,
  sleepingPlaces: 25,
  extraBeds: 15,
  booking: 1,
  eventType: 'shabbat',
  flags: { pool: true, outdoor: false },
}

function facts(overrides: Partial<PreparationFacts>): PreparationFacts {
  return { ...FACTS, ...overrides }
}

// ── Bases ─────────────────────────────────────────────────────────────────

describe('the fact bases', () => {
  it.each(FACT_BASES)('resolves "%s" to a number', (basis) => {
    expect(typeof factValue(basis, FACTS)).toBe('number')
  })

  it('treats a booking as one, so "per event" is plain arithmetic', () => {
    expect(factValue('booking', FACTS)).toBe(1)
  })
})

// ── Quantities ────────────────────────────────────────────────────────────

describe('a quantity', () => {
  it('is the basis when nothing else is said', () => {
    expect(resolveQuantity({ basis: 'guests' }, FACTS)).toBe(25)
  })

  it('multiplies by the factor', () => {
    expect(resolveQuantity({ basis: 'booking', factor: 4 }, FACTS)).toBe(4)
  })

  it('rounds a divisor up, because half a towel is a towel', () => {
    expect(resolveQuantity({ basis: 'guests', divisor: 2 }, FACTS)).toBe(13)
    expect(resolveQuantity({ basis: 'guests', divisor: 4 }, FACTS)).toBe(7)
    expect(resolveQuantity({ basis: 'guests', divisor: 8 }, FACTS)).toBe(4)
  })

  it('adds the flat term after the division', () => {
    expect(
      resolveQuantity({ basis: 'guests', divisor: 2, plus: 3 }, FACTS),
    ).toBe(16)
  })

  it('never returns a negative quantity', () => {
    expect(resolveQuantity({ basis: 'guests', plus: -99 }, FACTS)).toBe(0)
  })

  it('treats a zero divisor as one rather than producing infinity', () => {
    // A misconfigured rule should over-order, not break the plan a cleaner is
    // standing in the house waiting for.
    expect(resolveQuantity({ basis: 'guests', divisor: 0 }, FACTS)).toBe(25)
  })
})

// ── Buffers ───────────────────────────────────────────────────────────────

describe('a buffer', () => {
  it('rounds a percentage up: 25 plus ten percent is 28', () => {
    expect(applyBuffer(25, { kind: 'percent', percent: 10 })).toBe(28)
  })

  it('rounds a percentage up even when it is barely over', () => {
    expect(applyBuffer(10, { kind: 'percent', percent: 1 })).toBe(11)
  })

  it('leaves an exact percentage alone', () => {
    expect(applyBuffer(10, { kind: 'percent', percent: 20 })).toBe(12)
  })

  it('adds a flat buffer: sleeping places plus two', () => {
    expect(applyBuffer(25, { kind: 'flat', amount: 2 })).toBe(27)
  })

  it('leaves a quantity alone when there is no buffer', () => {
    expect(applyBuffer(25, null)).toBe(25)
  })

  it('does not conjure a requirement out of a rule that did not fire', () => {
    expect(applyBuffer(0, { kind: 'percent', percent: 50 })).toBe(0)
    expect(applyBuffer(0, { kind: 'flat', amount: 2 })).toBe(0)
  })
})

// ── Conditions ────────────────────────────────────────────────────────────

describe('a conditional rule', () => {
  const atLeastTwenty: RuleCondition = {
    kind: 'compare',
    basis: 'guests',
    comparator: 'gte',
    value: 20,
  }

  it.each([
    [19, false],
    [20, true],
    [21, true],
  ])('with "at least twenty", %i guests gives %s', (guests, expected) => {
    expect(evaluateCondition(atLeastTwenty, facts({ guests }))).toBe(expected)
  })

  it.each([
    ['lt', 26, true],
    ['lt', 25, false],
    ['lte', 25, true],
    ['lte', 24, false],
    ['eq', 25, true],
    ['eq', 26, false],
    ['gt', 24, true],
    ['gt', 25, false],
  ] as const)(
    'compares %s against %i correctly',
    (comparator, value, expected) => {
      expect(
        evaluateCondition(
          { kind: 'compare', basis: 'guests', comparator, value },
          FACTS,
        ),
      ).toBe(expected)
    },
  )

  it('applies unconditionally when there is no condition', () => {
    expect(evaluateCondition(null, FACTS)).toBe(true)
  })

  it('reads a property flag, and treats an absent flag as false', () => {
    expect(
      evaluateCondition({ kind: 'flag', flag: 'pool', equals: true }, FACTS),
    ).toBe(true)
    expect(
      evaluateCondition({ kind: 'flag', flag: 'sauna', equals: true }, FACTS),
    ).toBe(false)
    expect(
      evaluateCondition({ kind: 'flag', flag: 'sauna', equals: false }, FACTS),
    ).toBe(true)
  })

  it('matches an event type from a list', () => {
    expect(
      evaluateCondition(
        { kind: 'event_type', anyOf: ['shabbat', 'wedding'] },
        FACTS,
      ),
    ).toBe(true)
    expect(
      evaluateCondition({ kind: 'event_type', anyOf: ['wedding'] }, FACTS),
    ).toBe(false)
  })

  it('combines conditions', () => {
    const both: RuleCondition = {
      kind: 'all',
      of: [atLeastTwenty, { kind: 'flag', flag: 'pool', equals: true }],
    }
    const either: RuleCondition = {
      kind: 'any',
      of: [
        { kind: 'compare', basis: 'guests', comparator: 'gt', value: 99 },
        { kind: 'flag', flag: 'pool', equals: true },
      ],
    }

    expect(evaluateCondition(both, FACTS)).toBe(true)
    expect(evaluateCondition(both, facts({ guests: 4 }))).toBe(false)
    expect(evaluateCondition(either, FACTS)).toBe(true)
    expect(evaluateCondition({ kind: 'not', of: either }, FACTS)).toBe(false)
  })
})

// ── Effective dating ──────────────────────────────────────────────────────

describe('effective dating', () => {
  const records = [
    { id: 'old', effectiveFrom: '2025-01-01', effectiveTo: '2026-03-01' },
    { id: 'new', effectiveFrom: '2026-03-01', effectiveTo: null },
  ]

  it('is half-open, so no day belongs to both rules or to neither', () => {
    expect(effectiveOn(records, '2026-02-28').map((r) => r.id)).toEqual(['old'])
    expect(effectiveOn(records, '2026-03-01').map((r) => r.id)).toEqual(['new'])
  })

  it('excludes a rule that had not started yet', () => {
    expect(effectiveOn(records, '2024-12-31')).toEqual([])
  })
})
