/**
 * The IF clause.
 *
 * The tests worth writing here are the ones about absence and about coercion,
 * because those are the two ways a rules engine fires on rows it should not.
 * A `not_equals` that evaluates true against a field the event never carried
 * is how "cancel fee unless the guest asked" charges every cancellation, and a
 * `>` that coerces `'12'` to `12` is how a rule written for a number quietly
 * starts matching a string column.
 */

import { describe, expect, it } from 'vitest'

import {
  describeCondition,
  evaluateConditions,
  type ConditionResult,
} from './conditions'
import type { AutomationCondition } from './types'

function evaluate(
  condition: AutomationCondition,
  facts: Record<string, string | number | boolean | null>,
): ConditionResult {
  return evaluateConditions([condition], facts)
}

describe('an empty IF clause', () => {
  it('is met, which is how "on every occurrence" is written', () => {
    expect(evaluateConditions([], {})).toEqual({ met: true, failures: [] })
  })
})

describe('a fact the event did not carry', () => {
  it('makes equals unmet and names the missing field', () => {
    const result = evaluate(
      { kind: 'equals', field: 'source', value: 'direct_website' },
      {},
    )

    expect(result.met).toBe(false)
    expect(result.failures[0].reason).toBe('missing_fact')
    expect(result.failures[0].field).toBe('source')
  })

  it('makes not_equals unmet rather than vacuously true', () => {
    // The whole point. `reason !== 'guest_request'` must not hold for an event
    // that said nothing at all about the reason.
    const result = evaluate(
      { kind: 'not_equals', field: 'reason', value: 'guest_request' },
      {},
    )

    expect(result.met).toBe(false)
    expect(result.failures[0].reason).toBe('missing_fact')
  })

  it('makes a numeric comparison unmet rather than NaN-true', () => {
    expect(
      evaluate({ kind: 'at_least', field: 'nights', value: 2 }, {}).met,
    ).toBe(false)
  })

  it('satisfies is_absent, which is the one condition absence is meant for', () => {
    expect(evaluate({ kind: 'is_absent', field: 'cancelled_at' }, {}).met).toBe(
      true,
    )
    expect(
      evaluate(
        { kind: 'is_absent', field: 'cancelled_at' },
        { cancelled_at: null },
      ).met,
    ).toBe(true)
    expect(
      evaluate(
        { kind: 'is_absent', field: 'cancelled_at' },
        { cancelled_at: '2026-01-01' },
      ).met,
    ).toBe(false)
  })

  it('does not satisfy is_present when the value is null', () => {
    expect(
      evaluate({ kind: 'is_present', field: 'phone' }, { phone: null }).met,
    ).toBe(false)
    expect(
      evaluate({ kind: 'is_present', field: 'phone' }, { phone: '050' }).met,
    ).toBe(true)
  })
})

describe('comparisons do not coerce', () => {
  it('reports a string fact against a numeric condition as not comparable', () => {
    const result = evaluate(
      { kind: 'greater_than', field: 'nights', value: 5 },
      // `numeric` arrives from PostgREST as a string. JavaScript would answer
      // `'12' > 5` happily and wrongly.
      { nights: '12' },
    )

    expect(result.met).toBe(false)
    expect(result.failures[0].reason).toBe('not_comparable')
  })

  it('does not treat a numeric string as equal to a number', () => {
    expect(
      evaluate({ kind: 'equals', field: 'guests', value: 3 }, { guests: '3' })
        .met,
    ).toBe(false)
  })
})

describe('the operators', () => {
  const cases: ReadonlyArray<
    [
      AutomationCondition,
      Record<string, string | number | boolean | null>,
      boolean,
    ]
  > = [
    [{ kind: 'equals', field: 'a', value: 'x' }, { a: 'x' }, true],
    [{ kind: 'equals', field: 'a', value: 'x' }, { a: 'y' }, false],
    [{ kind: 'not_equals', field: 'a', value: 'x' }, { a: 'y' }, true],
    [{ kind: 'greater_than', field: 'n', value: 2 }, { n: 3 }, true],
    [{ kind: 'greater_than', field: 'n', value: 2 }, { n: 2 }, false],
    [{ kind: 'at_least', field: 'n', value: 2 }, { n: 2 }, true],
    [{ kind: 'less_than', field: 'n', value: 2 }, { n: 1 }, true],
    [{ kind: 'at_most', field: 'n', value: 2 }, { n: 2 }, true],
    [{ kind: 'one_of', field: 'a', values: ['x', 'y'] }, { a: 'y' }, true],
    [{ kind: 'one_of', field: 'a', values: ['x', 'y'] }, { a: 'z' }, false],
    [{ kind: 'equals', field: 'b', value: false }, { b: false }, true],
  ]

  for (const [condition, facts, expected] of cases) {
    it(`${describeCondition(condition)} against ${JSON.stringify(facts)} is ${expected}`, () => {
      expect(evaluate(condition, facts).met).toBe(expected)
    })
  }
})

describe('every failure is reported, not the first', () => {
  it('collects all of them so a card lists them at once', () => {
    const result = evaluateConditions(
      [
        { kind: 'equals', field: 'source', value: 'direct_website' },
        { kind: 'at_least', field: 'nights', value: 2 },
        { kind: 'is_present', field: 'guest_email' },
      ],
      { source: 'booking_com', nights: 1, guest_email: null },
    )

    expect(result.met).toBe(false)
    expect(result.failures).toHaveLength(3)
    expect(result.failures.map((entry) => entry.field)).toEqual([
      'source',
      'nights',
      'guest_email',
    ])
  })
})

describe('describeCondition', () => {
  it('renders every kind without falling through to an empty string', () => {
    const all: readonly AutomationCondition[] = [
      { kind: 'equals', field: 'a', value: 1 },
      { kind: 'not_equals', field: 'a', value: null },
      { kind: 'greater_than', field: 'a', value: 1 },
      { kind: 'at_least', field: 'a', value: 1 },
      { kind: 'less_than', field: 'a', value: 1 },
      { kind: 'at_most', field: 'a', value: 1 },
      { kind: 'one_of', field: 'a', values: [1, 2] },
      { kind: 'is_present', field: 'a' },
      { kind: 'is_absent', field: 'a' },
    ]

    for (const condition of all) {
      expect(describeCondition(condition).length).toBeGreaterThan(0)
    }
  })
})
