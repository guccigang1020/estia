/**
 * The evidence must be the dictionary's own arithmetic, not a paraphrase.
 *
 * The claim this file exists to hold up: for every metric, recomputing the
 * figure from the operands `FORMULA` declares reproduces
 * `METRICS[id].compute(facts)` exactly. A transcription that drifts — a
 * denominator that becomes "occupied" when the dictionary divides by "sold" —
 * would put a checkable-looking line under a number it does not produce, which
 * is worse than showing no line at all.
 */

import { describe, expect, it } from 'vitest'

import {
  METRICS,
  METRIC_IDS,
  aggregateFacts,
  formatMetricValue,
  makeBooking,
  makeUnit,
  type MetricFacts,
  type MetricId,
  type MetricResult,
} from '../metrics'

import {
  FORMULA,
  arithmeticLine,
  baselineEvidence,
  metricEvidence,
} from './evidence'

const RANGE = { start: '2026-03-01', end: '2026-04-01' }
const SCOPE = {
  organizationId: 'org-a',
  propertyIds: null,
  unitIds: null,
} as const

function facts(): MetricFacts {
  return aggregateFacts({
    range: RANGE,
    scope: SCOPE,
    units: [
      makeUnit({ unitId: 'unit-1' }),
      makeUnit({ unitId: 'unit-2' }),
      makeUnit({ unitId: 'unit-3', propertyId: 'prop-2' }),
    ],
    outOfService: [
      {
        unitId: 'unit-2',
        propertyId: 'prop-1',
        from: '2026-03-10',
        to: '2026-03-15',
      },
    ],
    bookings: [
      makeBooking({
        bookingId: 'sold',
        unitId: 'unit-1',
        checkIn: '2026-03-01',
        checkOut: '2026-03-05',
        roomRevenue: 100_000,
        ancillaryRevenue: 20_000,
        commission: 5_000,
        collected: 60_000,
        source: 'booking_com',
      }),
      makeBooking({
        bookingId: 'comp',
        unitId: 'unit-3',
        propertyId: 'prop-2',
        checkIn: '2026-03-08',
        checkOut: '2026-03-10',
        roomRevenue: 0,
        collected: 0,
        isComplimentary: true,
      }),
      makeBooking({
        bookingId: 'cancelled',
        unitId: 'unit-1',
        status: 'cancelled',
        checkIn: '2026-03-20',
        checkOut: '2026-03-22',
        cancelledOn: '2026-03-01',
      }),
    ],
  })
}

/** Redo the arithmetic the operands describe, in the order they describe it. */
function recompute(id: MetricId, from: MetricFacts): number | null {
  const operands = FORMULA[id].operands(from)

  let total = operands[0].value
  for (const operand of operands.slice(1)) {
    if (operand.join === '÷') {
      if (operand.value === 0) return null
      total = total / operand.value
    } else if (operand.join === '+') {
      total += operand.value
    } else if (operand.join === '−') {
      total -= operand.value
    }
  }

  return total
}

describe('every operand list reproduces the dictionary formula', () => {
  it.each(METRIC_IDS.map((id) => [id] as const))('%s', (id) => {
    const world = facts()
    const expected = METRICS[id].compute(world)
    const actual = recompute(id, world)

    if (expected === null) {
      expect(actual).toBeNull()
      return
    }

    expect(actual).not.toBeNull()

    // Percentages and currency are rounded once by the dictionary; the raw
    // division here is compared to that rounding rather than to itself, so a
    // formula that divides the wrong pair still fails.
    const unit = METRICS[id].unit
    const scale = unit === 'percentage' ? 100 : 1
    expect((actual as number) * scale).toBeCloseTo(expected, 0)
  })
})

describe('the arithmetic line is checkable by eye', () => {
  it('spells out a ratio and its answer', () => {
    expect(
      arithmeticLine(
        [
          { label: 'a', unit: 'count', value: 775 },
          { label: 'b', unit: 'count', value: 1240, join: '÷' },
        ],
        '62.5%',
      ),
    ).toBe('775 ÷ 1,240 = 62.5%')
  })

  it('does not restate a single term as its own answer', () => {
    expect(
      arithmeticLine([{ label: 'a', unit: 'count', value: 12 }], '12'),
    ).toBe('12')
  })
})

function result(
  id: MetricId,
  overrides: Partial<MetricResult> = {},
): MetricResult {
  const definition = METRICS[id]
  const value = definition.compute(facts())
  return {
    id,
    name: definition.name,
    description: definition.description,
    unit: definition.unit,
    value,
    formatted: formatMetricValue(definition.unit, value),
    comparison: null,
    trend: 'unknown',
    state: 'neutral',
    detailAvailable: false,
    ...overrides,
  }
}

describe('metric evidence', () => {
  it('carries the formatting the dashboard already produced', () => {
    const evidence = metricEvidence(result('occupancy'), facts())
    expect(evidence.formatted).toBe(result('occupancy').formatted)
    expect(evidence.arithmetic).toContain('÷')
    expect(evidence.arithmetic.endsWith(evidence.formatted)).toBe(true)
  })

  it('names the nights that occupancy counts and ADR does not', () => {
    const evidence = metricEvidence(result('adr'), facts())
    expect(evidence.note).toContain('לא נמכרו')
  })
})

describe('baseline evidence', () => {
  it('renders a baseline that held no rows as a dash, never a zero', () => {
    const withEmptyBaseline = result('occupancy', {
      comparison: {
        basis: 'previous_period',
        range: { start: '2026-02-01', end: '2026-03-01' },
        value: null,
        delta: null,
        deltaPercent: null,
        direction: 'unknown',
        empty: true,
        comparable: true,
        nights: 31,
        baselineNights: 28,
      },
    })

    const evidence = baselineEvidence(withEmptyBaseline, facts())
    expect(evidence.formatted).toBe('—')
    expect(evidence.formatted).not.toBe('0%')
  })
})
