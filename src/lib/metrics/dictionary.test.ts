/**
 * The dictionary must stay complete.
 *
 * This file is the reason the dictionary is worth having. A metric added
 * without a Hebrew definition ships a blank tooltip; one added without a unit
 * renders "27143" beside "₪271.43"; one added without a required grant is
 * visible to everybody in the business, including the cleaner. None of those is
 * caught by a type — every one of them is caught here.
 */

import { describe, expect, it } from 'vitest'
import {
  ALL_METRICS,
  formatMetricValue,
  isMetricId,
  METRIC_IDS,
  METRICS,
  NOT_APPLICABLE,
  sourceMix,
  type MetricDefinition,
} from './dictionary'
import {
  FIELD_PERMISSIONS,
  PERMISSIONS,
  type Grant,
} from '../authz/permissions'
import { BOOKING_STATUSES, type BookingStatus } from '../booking/types'
import { REALISED_STATUSES } from './rows'
import { aggregateFacts } from './facts'
import { makeBooking, makeUnit } from './memory-source'
import { METRIC_UNITS, type MetricSentiment } from './types'

const ALL_GRANTS: ReadonlySet<Grant> = new Set<Grant>([
  ...PERMISSIONS,
  ...FIELD_PERMISSIONS,
])

const HEBREW = /[֐-׿]/

const SENTIMENTS: readonly MetricSentiment[] = [
  'higher_is_better',
  'lower_is_better',
  'neutral',
]

/**
 * The measures the specification requires the product to report.
 *
 * Listed literally rather than derived from the dictionary, so that deleting
 * one from the dictionary fails this test instead of quietly shrinking it.
 */
const REQUIRED_BY_SPECIFICATION = [
  'occupancy',
  'adr',
  'revpar',
  'revenue',
  'net_operating_revenue',
  'direct_booking_share',
  'commission_cost',
  'outstanding_balance',
  'collected',
  'average_booking_value',
  'booking_pace',
  'lead_time',
  'length_of_stay',
  'conversion_rate',
  'cancellation_rate',
] as const

describe('the catalogue', () => {
  it('names every metric the specification requires', () => {
    for (const id of REQUIRED_BY_SPECIFICATION) {
      expect(METRIC_IDS).toContain(id)
      expect(METRICS[id]).toBeDefined()
    }
  })

  it('has no duplicate ids', () => {
    expect(new Set(METRIC_IDS).size).toBe(METRIC_IDS.length)
  })

  it('has exactly one definition per id and no orphans', () => {
    expect(Object.keys(METRICS).sort()).toEqual([...METRIC_IDS].sort())
    expect(ALL_METRICS).toHaveLength(METRIC_IDS.length)
  })

  it('recognises its own ids and nothing else', () => {
    expect(isMetricId('occupancy')).toBe(true)
    expect(isMetricId('profit')).toBe(false)
  })
})

describe('every metric carries a complete definition', () => {
  // The sweep. A metric added without any one of these fails here, by name.
  it.each(METRIC_IDS)('%s is fully defined', (id) => {
    const definition: MetricDefinition | undefined = METRICS[id]
    expect(definition, `no definition for ${id}`).toBeDefined()

    expect(definition.id).toBe(id)

    // A Hebrew display name, for the tile.
    expect(definition.name.trim().length).toBeGreaterThan(0)
    expect(definition.name).toMatch(HEBREW)

    // A Hebrew one-liner a non-accountant can read, for the tooltip.
    expect(definition.description.trim().length).toBeGreaterThan(0)
    expect(definition.description).toMatch(HEBREW)
    expect(definition.description).not.toContain('\n')
    expect(definition.description.length).toBeLessThanOrEqual(140)

    expect(METRIC_UNITS).toContain(definition.unit)
    expect(SENTIMENTS).toContain(definition.sentiment)
    expect(typeof definition.extensive).toBe('boolean')

    // The grant required to see it, and it must be a grant that exists.
    expect(ALL_GRANTS.has(definition.requires)).toBe(true)
    if (definition.detailRequires !== undefined) {
      expect(ALL_GRANTS.has(definition.detailRequires)).toBe(true)
    }

    expect(typeof definition.compute).toBe('function')
  })

  it('gives no two metrics the same Hebrew name', () => {
    const names = ALL_METRICS.map((definition) => definition.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('states a threshold only in the direction its meaning allows', () => {
    for (const definition of ALL_METRICS) {
      const thresholds = definition.thresholds
      if (!thresholds) continue
      // A metric where more is better warns when it is low, and the reverse.
      if (definition.sentiment === 'higher_is_better') {
        expect(thresholds.warningAbove).toBeUndefined()
        expect(thresholds.criticalAbove).toBeUndefined()
      }
      if (definition.sentiment === 'lower_is_better') {
        expect(thresholds.warningBelow).toBeUndefined()
        expect(thresholds.criticalBelow).toBeUndefined()
      }
    }
  })
})

describe('every booking status is classified', () => {
  /**
   * Not decoration. `OCCUPYING_STATUSES` answers a forward-looking question
   * and reporting needs a backward-looking one; a status added to the booking
   * contract without a decision here would silently vanish from every revenue
   * figure in the product.
   */
  const DELIBERATELY_EXCLUDED: readonly BookingStatus[] = [
    'inquiry',
    'quote',
    'cancelled',
    'no_show',
  ]

  it.each(BOOKING_STATUSES)('%s is either realised or excluded', (status) => {
    const realised = REALISED_STATUSES.has(status)
    const excluded = DELIBERATELY_EXCLUDED.includes(status)
    expect(realised || excluded).toBe(true)
    expect(realised && excluded).toBe(false)
  })
})

describe('the source mix', () => {
  const facts = aggregateFacts({
    range: { start: '2026-03-01', end: '2026-04-01' },
    scope: { organizationId: 'org-a', propertyIds: null, unitIds: null },
    units: [makeUnit({ unitId: 'unit-1' }), makeUnit({ unitId: 'unit-2' })],
    outOfService: [],
    bookings: [
      makeBooking({
        bookingId: 'a',
        unitId: 'unit-1',
        checkIn: '2026-03-01',
        checkOut: '2026-03-05',
        roomRevenue: 100_000,
        ancillaryRevenue: 20_000,
        source: 'direct_website',
      }),
      makeBooking({
        bookingId: 'b',
        unitId: 'unit-2',
        checkIn: '2026-03-10',
        checkOut: '2026-03-13',
        roomRevenue: 90_000,
        source: 'booking_com',
      }),
    ],
  })

  it('adds to exactly 100%', () => {
    const mix = sourceMix(facts) ?? []
    const tenths = mix.reduce(
      (sum, share) => sum + Math.round(share.share * 10),
      0,
    )
    expect(tenths).toBe(1_000)
  })

  it('agrees with the headline direct share, to the digit', () => {
    const mix = sourceMix(facts) ?? []
    const direct = mix.find((share) => share.source === 'direct_website')
    expect(direct?.share).toBe(METRICS.direct_booking_share.compute(facts))
  })

  it('has no mix to report for a window with no revenue', () => {
    const empty = aggregateFacts({
      range: { start: '2026-03-01', end: '2026-04-01' },
      scope: { organizationId: 'org-a', propertyIds: null, unitIds: null },
      units: [],
      outOfService: [],
      bookings: [],
    })
    expect(sourceMix(empty)).toBeNull()
  })
})

describe('formatting', () => {
  it('renders a value that does not apply as a dash, never as zero', () => {
    expect(formatMetricValue('currency', null)).toBe(NOT_APPLICABLE)
    expect(formatMetricValue('percentage', null)).toBe(NOT_APPLICABLE)
    expect(formatMetricValue('currency', 0)).not.toBe(NOT_APPLICABLE)
  })

  it('converts agorot to shekels only at the very edge', () => {
    expect(formatMetricValue('currency', 27_143)).toContain('271.43')
  })

  it('writes a percentage with its sign', () => {
    expect(formatMetricValue('percentage', 73.3)).toBe('73.3%')
    expect(formatMetricValue('percentage', 100)).toBe('100%')
  })

  it('uses Hebrew wording for nights and days', () => {
    expect(formatMetricValue('nights', 1)).toBe('לילה אחד')
    expect(formatMetricValue('nights', 3.5)).toBe('3.5 לילות')
    expect(formatMetricValue('days', 32.5)).toBe('32.5 ימים')
  })
})
