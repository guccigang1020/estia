/**
 * The formulas, against arithmetic a person can check.
 *
 * Every expected number in this file is worked by hand in the comment beside
 * it. A test that asserts whatever the implementation happened to return proves
 * only that the implementation is consistent with itself, which is exactly the
 * property a wrong formula also has.
 */

import { describe, expect, it } from 'vitest'
import { aggregateFacts, type MetricFacts } from './facts'
import { METRICS } from './dictionary'
import { makeBooking, makeUnit } from './memory-source'
import type { BookingFactRow, OutOfServiceRow, UnitInventoryRow } from './rows'
import type { ResolvedScope } from './scope'
import type { MetricRange } from './types'

// ── Fixtures ──────────────────────────────────────────────────────────────

/** March 2026: thirty-one nights, 1 March to 1 April exclusive. */
const MARCH: MetricRange = { start: '2026-03-01', end: '2026-04-01' }

const WHOLE_ORG: ResolvedScope = {
  organizationId: 'org-a',
  propertyIds: null,
  unitIds: null,
}

/** Two units, in service throughout. 2 × 31 = 62 available unit-nights. */
const TWO_UNITS: readonly UnitInventoryRow[] = [
  makeUnit({ unitId: 'unit-1' }),
  makeUnit({ unitId: 'unit-2' }),
]

function facts(
  options: {
    range?: MetricRange
    units?: readonly UnitInventoryRow[]
    outOfService?: readonly OutOfServiceRow[]
    bookings?: readonly BookingFactRow[]
    scope?: ResolvedScope
  } = {},
): MetricFacts {
  return aggregateFacts({
    range: options.range ?? MARCH,
    scope: options.scope ?? WHOLE_ORG,
    units: options.units ?? TWO_UNITS,
    outOfService: options.outOfService ?? [],
    bookings: options.bookings ?? [],
  })
}

/**
 * The worked example every assertion below refers back to.
 *
 *   A · unit-1, 1–5 March      → 4 nights, ₪1,000 room, ₪200 fees, direct
 *   B · unit-2, 10–13 March    → 3 nights, ₪900 room, ₪135 commission, Booking.com
 *
 *   available   = 2 units × 31 nights = 62
 *   occupied    = 4 + 3               =  7
 *   room        = 100,000 + 90,000    = 190,000 agorot
 */
const BOOKING_A = makeBooking({
  bookingId: 'a',
  unitId: 'unit-1',
  checkIn: '2026-03-01',
  checkOut: '2026-03-05',
  createdOn: '2026-02-01',
  committedOn: '2026-02-01',
  roomRevenue: 100_000,
  ancillaryRevenue: 20_000,
  collected: 60_000,
  source: 'direct_website',
})

const BOOKING_B = makeBooking({
  bookingId: 'b',
  unitId: 'unit-2',
  checkIn: '2026-03-10',
  checkOut: '2026-03-13',
  createdOn: '2026-02-01',
  committedOn: '2026-02-01',
  roomRevenue: 90_000,
  ancillaryRevenue: 0,
  commission: 13_500,
  collected: 0,
  source: 'booking_com',
})

const WORKED = [BOOKING_A, BOOKING_B]

// ── Occupancy, ADR, RevPAR ────────────────────────────────────────────────

describe('the three formulas the specification states literally', () => {
  it('computes occupancy as occupied unit-nights ÷ available unit-nights', () => {
    // 7 ÷ 62 = 0.112903… → 11.3%
    expect(METRICS.occupancy.compute(facts({ bookings: WORKED }))).toBe(11.3)
  })

  it('computes ADR as room revenue ÷ sold nights', () => {
    // 190,000 ÷ 7 = 27,142.857… agorot → 27,143 (₪271.43)
    expect(METRICS.adr.compute(facts({ bookings: WORKED }))).toBe(27_143)
  })

  it('computes RevPAR as room revenue ÷ available nights', () => {
    // 190,000 ÷ 62 = 3,064.516… agorot → 3,065 (₪30.65)
    expect(METRICS.revpar.compute(facts({ bookings: WORKED }))).toBe(3_065)
  })

  it('keeps RevPAR below ADR, because empty nights are in the denominator', () => {
    const measured = facts({ bookings: WORKED })
    const adr = METRICS.adr.compute(measured) ?? 0
    const revpar = METRICS.revpar.compute(measured) ?? 0
    expect(revpar).toBeLessThan(adr)
  })
})

// ── The rest of the dictionary, on the same example ───────────────────────

describe('the money metrics on the worked example', () => {
  const measured = facts({ bookings: WORKED })

  it('sums revenue as room nights plus fees on arrival', () => {
    // 190,000 room + 20,000 fees = 210,000
    expect(METRICS.revenue.compute(measured)).toBe(210_000)
  })

  it('takes commission off for net operating revenue', () => {
    // 210,000 − 13,500 = 196,500
    expect(METRICS.net_operating_revenue.compute(measured)).toBe(196_500)
  })

  it('reports commission cost as a positive number', () => {
    expect(METRICS.commission_cost.compute(measured)).toBe(13_500)
  })

  it('computes the direct share over all revenue, not only the room', () => {
    // direct = 100,000 room + 20,000 fees = 120,000; 120,000 ÷ 210,000 = 57.14…
    expect(METRICS.direct_booking_share.compute(measured)).toBe(57.1)
  })

  it('reports what was collected and what is still owed', () => {
    // billed 210,000, collected 60,000 → outstanding 150,000
    expect(METRICS.collected.compute(measured)).toBe(60_000)
    expect(METRICS.outstanding_balance.compute(measured)).toBe(150_000)
  })

  it('averages booking value over the bookings that arrive in the window', () => {
    // 210,000 ÷ 2 bookings = 105,000
    expect(METRICS.average_booking_value.compute(measured)).toBe(105_000)
  })
})

describe('the behavioural metrics on the worked example', () => {
  const measured = facts({ bookings: WORKED })

  it('averages length of stay over whole stays, not clipped ones', () => {
    // (4 + 3) ÷ 2 = 3.5 nights
    expect(METRICS.length_of_stay.compute(measured)).toBe(3.5)
  })

  it('averages lead time in days from creation to arrival', () => {
    // 1 Feb → 1 Mar is 28 days; 1 Feb → 10 Mar is 37; mean 32.5
    expect(METRICS.lead_time.compute(measured)).toBe(32.5)
  })

  it('counts pace from the bookings committed inside the window', () => {
    // Both were committed on 1 February, so March's pace is zero — a real
    // zero, not a missing value.
    expect(METRICS.booking_pace.compute(measured)).toBe(0)

    const committedInMarch = facts({
      bookings: [
        BOOKING_A,
        makeBooking({ ...BOOKING_B, committedOn: '2026-03-04' }),
      ],
    })
    expect(METRICS.booking_pace.compute(committedInMarch)).toBe(1)
  })

  it('measures conversion over the cohort created in the window', () => {
    const measuredCohort = facts({
      bookings: [
        makeBooking({
          bookingId: 'c1',
          createdOn: '2026-03-02',
          committedOn: '2026-05-01',
          checkIn: '2026-06-01',
          checkOut: '2026-06-03',
        }),
        makeBooking({
          bookingId: 'c2',
          createdOn: '2026-03-02',
          committedOn: null,
          status: 'quote',
          checkIn: '2026-06-01',
          checkOut: '2026-06-03',
        }),
        makeBooking({
          bookingId: 'c3',
          createdOn: '2026-03-02',
          committedOn: null,
          status: 'inquiry',
          checkIn: '2026-06-01',
          checkOut: '2026-06-03',
        }),
      ],
    })
    // 1 of 3 committed → 33.3%. A booking committed in May still counts:
    // the cohort is defined by when the enquiry arrived.
    expect(METRICS.conversion_rate.compute(measuredCohort)).toBe(33.3)
  })

  it('measures cancellation against the stays that should have started', () => {
    const withCancellation = facts({
      bookings: [
        ...WORKED,
        makeBooking({
          bookingId: 'x',
          status: 'cancelled',
          cancelledOn: '2026-02-20',
          checkIn: '2026-03-20',
          checkOut: '2026-03-22',
        }),
      ],
    })
    // 1 cancelled of 3 arrivals → 33.3%
    expect(METRICS.cancellation_rate.compute(withCancellation)).toBe(33.3)
  })
})

// ── Zero denominators ─────────────────────────────────────────────────────

describe('a denominator of zero is null, never zero and never NaN', () => {
  const empty = facts({ units: [], bookings: [] })

  it('has no occupancy when there are no available nights', () => {
    expect(empty.availableUnitNights).toBe(0)
    expect(METRICS.occupancy.compute(empty)).toBeNull()
  })

  it('has no ADR, RevPAR, average value, lead time or rates', () => {
    expect(METRICS.adr.compute(empty)).toBeNull()
    expect(METRICS.revpar.compute(empty)).toBeNull()
    expect(METRICS.average_booking_value.compute(empty)).toBeNull()
    expect(METRICS.lead_time.compute(empty)).toBeNull()
    expect(METRICS.length_of_stay.compute(empty)).toBeNull()
    expect(METRICS.conversion_rate.compute(empty)).toBeNull()
    expect(METRICS.cancellation_rate.compute(empty)).toBeNull()
    expect(METRICS.direct_booking_share.compute(empty)).toBeNull()
  })

  it('still reports a real zero for the sums, which did happen', () => {
    // Nothing was earned. That is a measurement, not an absence — and it must
    // not be confused with the nulls above.
    expect(METRICS.revenue.compute(empty)).toBe(0)
    expect(METRICS.collected.compute(empty)).toBe(0)
    expect(METRICS.outstanding_balance.compute(empty)).toBe(0)
    expect(METRICS.booking_pace.compute(empty)).toBe(0)
  })

  it('never produces NaN or Infinity from an empty window', () => {
    for (const definition of Object.values(METRICS)) {
      const value = definition.compute(empty)
      if (value !== null) expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('distinguishes an empty property from a full one at 0%', () => {
    // Inventory exists, nothing sold. This is 0%, and it means something very
    // different from the null above.
    expect(METRICS.occupancy.compute(facts({ bookings: [] }))).toBe(0)
  })
})

// ── The decisions ─────────────────────────────────────────────────────────

describe('a complimentary night occupies but does not sell', () => {
  const comp = makeBooking({
    bookingId: 'comp',
    unitId: 'unit-1',
    checkIn: '2026-03-20',
    checkOut: '2026-03-22',
    roomRevenue: 0,
    ancillaryRevenue: 0,
    collected: 0,
    isComplimentary: true,
  })

  const measured = facts({ bookings: [...WORKED, comp] })

  it('counts the nights in occupancy', () => {
    // 7 + 2 = 9 of 62 → 14.5%
    expect(measured.occupiedUnitNights).toBe(9)
    expect(METRICS.occupancy.compute(measured)).toBe(14.5)
  })

  it('keeps them out of the ADR denominator', () => {
    // Still 190,000 ÷ 7. Two free nights must not report the business as
    // having cut its nightly rate by a fifth.
    expect(measured.soldUnitNights).toBe(7)
    expect(METRICS.adr.compute(measured)).toBe(27_143)
    expect(measured.complimentaryUnitNights).toBe(2)
  })

  it('lets RevPAR fall, because the night existed and earned nothing', () => {
    expect(METRICS.revpar.compute(measured)).toBe(3_065)
  })
})

describe('a held option occupies but does not sell', () => {
  const option = makeBooking({
    bookingId: 'opt',
    unitId: 'unit-2',
    status: 'option',
    checkIn: '2026-03-20',
    checkOut: '2026-03-25',
    roomRevenue: 150_000,
    collected: 0,
  })

  const measured = facts({ bookings: [...WORKED, option] })

  it('blocks the calendar without being a sale', () => {
    expect(measured.occupiedUnitNights).toBe(12)
    expect(measured.soldUnitNights).toBe(7)
    expect(measured.heldOptionUnitNights).toBe(5)
  })

  it('earns nothing, however hopeful the quoted price is', () => {
    expect(METRICS.revenue.compute(measured)).toBe(210_000)
    expect(METRICS.adr.compute(measured)).toBe(27_143)
  })
})

describe('an out-of-service unit leaves the denominator', () => {
  const closed: OutOfServiceRow[] = [
    {
      unitId: 'unit-2',
      propertyId: 'prop-1',
      from: '2026-03-25',
      to: '2026-04-01',
    },
  ]

  it('removes exactly the closed nights from availability', () => {
    // 62 − 7 = 55 available
    const measured = facts({ bookings: WORKED, outOfService: closed })
    expect(measured.availableUnitNights).toBe(55)
    expect(measured.outOfServiceUnitNights).toBe(7)
    // 7 ÷ 55 = 12.72… → 12.7%, up from 11.3%: closing a unit does not count
    // against the manager who closed it.
    expect(METRICS.occupancy.compute(measured)).toBe(12.7)
  })

  it('counts a night closed twice only once', () => {
    const overlapping: OutOfServiceRow[] = [
      ...closed,
      {
        unitId: 'unit-2',
        propertyId: 'prop-1',
        from: '2026-03-27',
        to: '2026-04-01',
      },
    ]
    const measured = facts({ bookings: WORKED, outOfService: overlapping })
    expect(measured.availableUnitNights).toBe(55)
  })
})

describe('inventory that did not exist yet', () => {
  it('contributes only the nights after it entered service', () => {
    const units = [
      makeUnit({ unitId: 'unit-1' }),
      makeUnit({ unitId: 'unit-2', inServiceFrom: '2026-03-15' }),
    ]
    // 31 + 17 (15 March to 1 April) = 48
    expect(facts({ units }).availableUnitNights).toBe(48)
  })

  it('ignores a duplicated inventory row rather than doubling the denominator', () => {
    const units = [
      makeUnit({ unitId: 'unit-1' }),
      makeUnit({ unitId: 'unit-1' }),
    ]
    expect(facts({ units }).availableUnitNights).toBe(31)
  })
})

describe('unit-nights are counted as a set', () => {
  it('cannot report more than 100% occupancy from overlapping bookings', () => {
    const doubled = [
      makeBooking({
        bookingId: 'd1',
        unitId: 'unit-1',
        checkIn: '2026-03-01',
        checkOut: '2026-04-01',
      }),
      makeBooking({
        bookingId: 'd2',
        unitId: 'unit-2',
        checkIn: '2026-03-01',
        checkOut: '2026-04-01',
      }),
      // The fault: a second stay on a unit-night already occupied.
      makeBooking({
        bookingId: 'd3',
        unitId: 'unit-1',
        checkIn: '2026-03-05',
        checkOut: '2026-03-08',
      }),
    ]
    const measured = facts({ bookings: doubled })
    expect(measured.occupiedUnitNights).toBe(62)
    expect(METRICS.occupancy.compute(measured)).toBe(100)
  })

  it('surfaces a stay on inventory that was not available, instead of hiding it', () => {
    const measured = facts({
      units: [makeUnit({ unitId: 'unit-1' })],
      bookings: [BOOKING_B], // unit-2, which is not in the inventory
    })
    expect(measured.anomalousUnitNights).toBe(3)
    expect(measured.occupiedUnitNights).toBe(0)
  })
})

// ── Attribution across the boundary ───────────────────────────────────────

describe('a stay that crosses the edge of the window', () => {
  const crossing = makeBooking({
    bookingId: 'cross',
    unitId: 'unit-1',
    checkIn: '2026-02-27',
    checkOut: '2026-03-03',
    createdOn: '2026-01-01',
    committedOn: '2026-01-01',
    roomRevenue: 100_001,
    ancillaryRevenue: 30_000,
    collected: 0,
  })

  it('contributes only the nights inside the window', () => {
    // 27 and 28 February are outside; 1 and 2 March are inside.
    expect(facts({ bookings: [crossing] }).occupiedUnitNights).toBe(2)
  })

  it('recognises room revenue night by night, losing no agora', () => {
    // ₪1,000.01 over four nights allocates 25,001 + 25,000 + 25,000 + 25,000.
    // The two March nights are the third and fourth: 50,000.
    expect(facts({ bookings: [crossing] }).roomRevenue).toBe(50_000)

    // Over a window covering the whole stay, the parts add back exactly.
    const whole = facts({
      range: { start: '2026-02-01', end: '2026-04-01' },
      bookings: [crossing],
    })
    expect(whole.roomRevenue).toBe(100_001)
  })

  it('recognises fees once, on arrival, so they cannot land in two windows', () => {
    // Arrival is 27 February, so March sees no part of the fee.
    expect(facts({ bookings: [crossing] }).ancillaryRevenue).toBe(0)
    const february = facts({
      range: { start: '2026-02-01', end: '2026-03-01' },
      bookings: [crossing],
    })
    expect(february.ancillaryRevenue).toBe(30_000)
  })
})

// ── Statuses that do not count ────────────────────────────────────────────

describe('statuses outside a realised stay', () => {
  it.each(['inquiry', 'quote', 'cancelled', 'no_show'] as const)(
    'gives %s no nights and no revenue',
    (status) => {
      const measured = facts({
        bookings: [
          makeBooking({
            bookingId: 'ignored',
            status,
            cancelledOn: status === 'cancelled' ? '2026-02-15' : null,
            roomRevenue: 500_000,
            ancillaryRevenue: 100_000,
            collected: 100_000,
          }),
        ],
      })
      expect(measured.occupiedUnitNights).toBe(0)
      expect(measured.roomRevenue).toBe(0)
      expect(METRICS.revenue.compute(measured)).toBe(0)
    },
  )

  it.each(['checked_out', 'completed', 'review_requested'] as const)(
    'counts %s, because the stay already happened',
    (status) => {
      const measured = facts({
        bookings: [makeBooking({ ...BOOKING_A, status })],
      })
      expect(measured.occupiedUnitNights).toBe(4)
      expect(measured.roomRevenue).toBe(100_000)
    },
  )
})
