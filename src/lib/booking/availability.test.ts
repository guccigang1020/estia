/**
 * The availability engine.
 *
 * The test that earns its place more than any other in this file is the
 * same-day turnaround: one guest leaves on the 5th, the next arrives on the
 * 5th, and that is not a conflict. Getting it wrong costs one sellable night
 * per changeover — across a year and a dozen units, a month of revenue that
 * nobody ever sees disappear, because the calendar looks plausible.
 *
 * The rest is mostly about what does *not* block: an enquiry, a cancelled
 * booking, a stay that has already checked out, an expired hold, a released
 * hold, a hold on another unit, a block on the departure date. Each of those
 * would quietly remove inventory from sale.
 *
 * Nothing here proves the system cannot double-book. It cannot: see the header
 * of `availability.ts`. The database's exclusion constraint is the guarantee;
 * this engine exists to give a useful answer before someone submits.
 */

import { describe, expect, it } from 'vitest'
import {
  availabilityCalendar,
  checkAvailability,
  isOccupying,
  minimumNightsFor,
  type AvailabilitySource,
  type OccupyingBooking,
  type UnitAvailabilityRules,
} from './availability'
import {
  BOOKING_STATUSES,
  OCCUPYING_STATUSES,
  type BookingStatus,
  type Hold,
} from './types'

// ── The world ─────────────────────────────────────────────────────────────

const ORG = 'org-a'
const UNIT = 'unit-1'
const NOW = new Date('2026-08-20T09:00:00.000Z')

const OPEN_RULES: UnitAvailabilityRules = {
  unitId: UNIT,
  minimumNights: 1,
  blockedDates: [],
}

function source(seed: {
  bookings?: readonly OccupyingBooking[]
  holds?: readonly Hold[]
  rules?: UnitAvailabilityRules | null
}): AvailabilitySource {
  return {
    async loadBookings() {
      return seed.bookings ?? []
    },
    async loadHolds() {
      return seed.holds ?? []
    },
    async loadRules() {
      return seed.rules === undefined ? OPEN_RULES : seed.rules
    },
  }
}

function booking(
  overrides: Partial<OccupyingBooking> &
    Pick<OccupyingBooking, 'checkIn' | 'checkOut'>,
): OccupyingBooking {
  return {
    id: 'bk-1',
    reference: '8891',
    status: 'confirmed',
    ...overrides,
  }
}

function hold(overrides: Partial<Hold> = {}): Hold {
  return {
    id: 'hold-1',
    organizationId: ORG,
    unitId: UNIT,
    checkIn: '2026-09-03',
    checkOut: '2026-09-06',
    reason: 'agent_quote',
    heldByUserId: 'user-agent',
    // Half an hour after `NOW`.
    expiresAt: '2026-08-20T09:30:00.000Z',
    releasedAt: null,
    convertedToBookingId: null,
    ...overrides,
  }
}

function ask(
  from: AvailabilitySource,
  checkIn: string,
  checkOut: string,
  options: {
    ignoreHoldId?: string
    ignoreBookingId?: string
    ignoreMinimumNights?: boolean
  } = {},
) {
  return checkAvailability(
    from,
    { organizationId: ORG, unitId: UNIT, range: { checkIn, checkOut } },
    { now: NOW, ...options },
  )
}

// ── The half-open convention ──────────────────────────────────────────────

describe('the half-open convention', () => {
  it('treats a same-day turnaround as available', async () => {
    // Out on the 5th, in on the 5th. This is a normal changeover and the whole
    // reason a stay is [checkIn, checkOut).
    const result = await ask(
      source({
        bookings: [booking({ checkIn: '2026-09-03', checkOut: '2026-09-05' })],
      }),
      '2026-09-05',
      '2026-09-07',
    )

    expect(result.available).toBe(true)
    expect(result.blockers).toEqual([])
  })

  it('treats an arrival on our departure date as available', async () => {
    const result = await ask(
      source({
        bookings: [booking({ checkIn: '2026-09-05', checkOut: '2026-09-08' })],
      }),
      '2026-09-03',
      '2026-09-05',
    )

    expect(result.available).toBe(true)
  })

  it('refuses an overlap of a single night', async () => {
    const result = await ask(
      source({
        bookings: [booking({ checkIn: '2026-09-03', checkOut: '2026-09-06' })],
      }),
      '2026-09-05',
      '2026-09-07',
    )

    expect(result.available).toBe(false)
    expect(result.blockers[0].kind).toBe('booking')
    expect(result.blockers[0].bookingId).toBe('bk-1')
  })

  it('refuses a stay entirely inside another', async () => {
    const result = await ask(
      source({
        bookings: [booking({ checkIn: '2026-09-01', checkOut: '2026-09-20' })],
      }),
      '2026-09-05',
      '2026-09-07',
    )

    expect(result.available).toBe(false)
  })

  it('counts the nights of the stay, not the days it touches', async () => {
    const result = await ask(source({}), '2026-09-03', '2026-09-06')
    expect(result.nights).toBe(3)
  })
})

// ── Which bookings occupy ─────────────────────────────────────────────────

describe('occupancy', () => {
  it.each(OCCUPYING_STATUSES)(
    'is blocked by a booking in %s',
    async (status) => {
      const result = await ask(
        source({
          bookings: [
            booking({ status, checkIn: '2026-09-03', checkOut: '2026-09-06' }),
          ],
        }),
        '2026-09-04',
        '2026-09-05',
      )

      expect(result.available).toBe(false)
    },
  )

  const notOccupying = BOOKING_STATUSES.filter(
    (status) => !OCCUPYING_STATUSES.includes(status),
  )

  it.each(notOccupying)('is not blocked by a booking in %s', async (status) => {
    const result = await ask(
      source({
        bookings: [
          booking({ status, checkIn: '2026-09-03', checkOut: '2026-09-06' }),
        ],
      }),
      '2026-09-04',
      '2026-09-05',
    )

    expect(result.available).toBe(true)
  })

  it('decides occupancy itself rather than trusting the query', async () => {
    // A source that hands back everything it found, cancelled rows included —
    // the shape a service-role read actually has. The engine filters.
    const result = await ask(
      source({
        bookings: [
          booking({
            id: 'bk-cancelled',
            status: 'cancelled',
            checkIn: '2026-09-01',
            checkOut: '2026-09-30',
          }),
          booking({
            id: 'bk-inquiry',
            status: 'inquiry',
            checkIn: '2026-09-01',
            checkOut: '2026-09-30',
          }),
        ],
      }),
      '2026-09-04',
      '2026-09-06',
    )

    expect(result.available).toBe(true)
  })

  it('ignores the booking being amended, so it cannot collide with itself', async () => {
    const existing = booking({
      id: 'bk-7',
      checkIn: '2026-09-03',
      checkOut: '2026-09-06',
    })

    const collides = await ask(
      source({ bookings: [existing] }),
      '2026-09-04',
      '2026-09-07',
    )
    const amending = await ask(
      source({ bookings: [existing] }),
      '2026-09-04',
      '2026-09-07',
      { ignoreBookingId: 'bk-7' },
    )

    expect(collides.available).toBe(false)
    expect(amending.available).toBe(true)
  })

  it('agrees with the contract about which statuses occupy', () => {
    for (const status of BOOKING_STATUSES) {
      expect(isOccupying(status)).toBe(
        OCCUPYING_STATUSES.includes(status as BookingStatus),
      )
    }
  })
})

// ── Holds ─────────────────────────────────────────────────────────────────

describe('holds', () => {
  it('is blocked by a live hold', async () => {
    const result = await ask(
      source({ holds: [hold()] }),
      '2026-09-04',
      '2026-09-05',
    )

    expect(result.available).toBe(false)
    expect(result.blockers[0].kind).toBe('hold')
    expect(result.blockers[0].holdId).toBe('hold-1')
  })

  it('is not blocked by an expired hold, swept or not', async () => {
    // The row is still there, `releasedAt` is still null, and nothing has been
    // cleaned up. It must block nothing all the same.
    const result = await ask(
      source({ holds: [hold({ expiresAt: '2026-08-20T08:00:00.000Z' })] }),
      '2026-09-04',
      '2026-09-05',
    )

    expect(result.available).toBe(true)
  })

  it('is not blocked by a released hold', async () => {
    const result = await ask(
      source({ holds: [hold({ releasedAt: '2026-08-20T09:10:00.000Z' })] }),
      '2026-09-04',
      '2026-09-05',
    )

    expect(result.available).toBe(true)
  })

  it('is not blocked by a hold that has already become a booking', async () => {
    const result = await ask(
      source({ holds: [hold({ convertedToBookingId: 'bk-9' })] }),
      '2026-09-04',
      '2026-09-05',
    )

    expect(result.available).toBe(true)
  })

  it('is not blocked by a hold on a different unit', async () => {
    const result = await ask(
      source({ holds: [hold({ unitId: 'unit-2' })] }),
      '2026-09-04',
      '2026-09-05',
    )

    expect(result.available).toBe(true)
  })

  it('honours the half-open convention for holds too', async () => {
    const result = await ask(
      source({
        holds: [hold({ checkIn: '2026-09-03', checkOut: '2026-09-05' })],
      }),
      '2026-09-05',
      '2026-09-07',
    )

    expect(result.available).toBe(true)
  })

  it('ignores the hold being converted into this very booking', async () => {
    const result = await ask(
      source({ holds: [hold()] }),
      '2026-09-03',
      '2026-09-06',
      {
        ignoreHoldId: 'hold-1',
      },
    )

    expect(result.available).toBe(true)
  })
})

// ── Rules ─────────────────────────────────────────────────────────────────

describe('unit rules', () => {
  it('refuses a stay under the minimum, and says what the minimum is', async () => {
    const result = await ask(
      source({ rules: { ...OPEN_RULES, minimumNights: 3 } }),
      '2026-09-03',
      '2026-09-05',
    )

    expect(result.available).toBe(false)
    expect(result.blockers[0]).toMatchObject({
      kind: 'minimum_nights',
      requiredNights: 3,
      requestedNights: 2,
    })
    expect(result.blockers[0].message).toContain('3')
  })

  it('allows a stay exactly at the minimum', async () => {
    const result = await ask(
      source({ rules: { ...OPEN_RULES, minimumNights: 3 } }),
      '2026-09-03',
      '2026-09-06',
    )

    expect(result.available).toBe(true)
  })

  it('lets a season override the unit default for that arrival date', async () => {
    const rules: UnitAvailabilityRules = {
      ...OPEN_RULES,
      minimumNights: 1,
      minimumNightsByArrival: { '2026-09-03': 5 },
    }

    expect(minimumNightsFor(rules, '2026-09-03')).toBe(5)
    expect(minimumNightsFor(rules, '2026-09-04')).toBe(1)

    const result = await ask(source({ rules }), '2026-09-03', '2026-09-06')
    expect(result.available).toBe(false)
  })

  it('can be told to ignore the minimum, for an override or a maintenance block', async () => {
    const result = await ask(
      source({ rules: { ...OPEN_RULES, minimumNights: 5 } }),
      '2026-09-03',
      '2026-09-04',
      { ignoreMinimumNights: true },
    )

    expect(result.available).toBe(true)
  })

  it('refuses a blocked date inside the stay', async () => {
    const result = await ask(
      source({ rules: { ...OPEN_RULES, blockedDates: ['2026-09-04'] } }),
      '2026-09-03',
      '2026-09-06',
    )

    expect(result.available).toBe(false)
    expect(result.blockers[0]).toMatchObject({
      kind: 'blocked_date',
      date: '2026-09-04',
    })
  })

  it('ignores a block on the departure date, which the stay does not occupy', async () => {
    const result = await ask(
      source({ rules: { ...OPEN_RULES, blockedDates: ['2026-09-06'] } }),
      '2026-09-03',
      '2026-09-06',
    )

    expect(result.available).toBe(true)
  })

  it('refuses an arrival on a closed-to-arrival date', async () => {
    const result = await ask(
      source({ rules: { ...OPEN_RULES, noArrivalDates: ['2026-09-03'] } }),
      '2026-09-03',
      '2026-09-06',
    )

    expect(result.blockers[0].kind).toBe('no_arrival')
  })

  it('refuses a departure on a closed-to-departure date', async () => {
    const result = await ask(
      source({ rules: { ...OPEN_RULES, noDepartureDates: ['2026-09-06'] } }),
      '2026-09-03',
      '2026-09-06',
    )

    expect(result.blockers[0].kind).toBe('no_departure')
  })

  it('refuses a unit it has no rules for, rather than assuming it is open', async () => {
    const result = await ask(
      source({ rules: null }),
      '2026-09-03',
      '2026-09-06',
    )

    expect(result.available).toBe(false)
    expect(result.blockers[0].kind).toBe('unknown_unit')
  })
})

// ── Bad input ─────────────────────────────────────────────────────────────

describe('invalid ranges', () => {
  it.each([
    ['2026-09-06', '2026-09-03', 'reversed'],
    ['2026-09-03', '2026-09-03', 'zero nights'],
    ['not-a-date', '2026-09-06', 'nonsense arrival'],
    ['2026-02-30', '2026-03-02', 'a day that does not exist'],
  ])('refuses %s → %s (%s)', async (checkIn, checkOut) => {
    const result = await ask(source({}), checkIn, checkOut)

    expect(result.available).toBe(false)
    expect(result.nights).toBe(0)
    expect(result.blockers[0].kind).toBe('invalid_range')
  })
})

// ── Everything at once ────────────────────────────────────────────────────

describe('collecting blockers', () => {
  it('reports every reason, not the first one it found', async () => {
    const result = await ask(
      source({
        bookings: [booking({ checkIn: '2026-09-03', checkOut: '2026-09-06' })],
        holds: [
          hold({ id: 'hold-2', checkIn: '2026-09-04', checkOut: '2026-09-05' }),
        ],
        rules: {
          ...OPEN_RULES,
          minimumNights: 10,
          blockedDates: ['2026-09-04'],
        },
      }),
      '2026-09-03',
      '2026-09-06',
    )

    expect(result.blockers.map((blocker) => blocker.kind).sort()).toEqual([
      'blocked_date',
      'booking',
      'hold',
      'minimum_nights',
    ])
  })

  it('writes every blocker in Hebrew', async () => {
    const result = await ask(
      source({
        bookings: [booking({ checkIn: '2026-09-03', checkOut: '2026-09-06' })],
      }),
      '2026-09-04',
      '2026-09-05',
    )

    for (const blocker of result.blockers) {
      expect(blocker.message).toMatch(/[֐-׿]/)
    }
  })
})

// ── The calendar ──────────────────────────────────────────────────────────

describe('the calendar', () => {
  it('returns one entry per night, and none for the departure day', async () => {
    const days = await availabilityCalendar(
      source({}),
      {
        organizationId: ORG,
        unitId: UNIT,
        range: { checkIn: '2026-09-03', checkOut: '2026-09-06' },
      },
      { now: NOW },
    )

    expect(days.map((day) => day.date)).toEqual([
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
    ])
    expect(days.every((day) => day.state === 'free')).toBe(true)
  })

  it('shows a changeover day as sold to the arriving guest, not to both', async () => {
    const days = await availabilityCalendar(
      source({
        bookings: [
          booking({
            id: 'bk-out',
            checkIn: '2026-09-03',
            checkOut: '2026-09-05',
          }),
          booking({
            id: 'bk-in',
            checkIn: '2026-09-05',
            checkOut: '2026-09-07',
          }),
        ],
      }),
      {
        organizationId: ORG,
        unitId: UNIT,
        range: { checkIn: '2026-09-03', checkOut: '2026-09-07' },
      },
      { now: NOW },
    )

    expect(days).toEqual([
      { date: '2026-09-03', state: 'booked', bookingId: 'bk-out' },
      { date: '2026-09-04', state: 'booked', bookingId: 'bk-out' },
      { date: '2026-09-05', state: 'booked', bookingId: 'bk-in' },
      { date: '2026-09-06', state: 'booked', bookingId: 'bk-in' },
    ])
  })

  it('distinguishes held from booked from blocked', async () => {
    const days = await availabilityCalendar(
      source({
        bookings: [
          booking({
            id: 'bk-a',
            checkIn: '2026-09-03',
            checkOut: '2026-09-04',
          }),
        ],
        holds: [
          hold({ id: 'hold-x', checkIn: '2026-09-04', checkOut: '2026-09-05' }),
        ],
        rules: { ...OPEN_RULES, blockedDates: ['2026-09-05'] },
      }),
      {
        organizationId: ORG,
        unitId: UNIT,
        range: { checkIn: '2026-09-03', checkOut: '2026-09-07' },
      },
      { now: NOW },
    )

    expect(days.map((day) => day.state)).toEqual([
      'booked',
      'held',
      'blocked',
      'free',
    ])
  })

  it('shows an expired hold as free', async () => {
    const days = await availabilityCalendar(
      source({ holds: [hold({ expiresAt: '2026-08-20T08:00:00.000Z' })] }),
      {
        organizationId: ORG,
        unitId: UNIT,
        range: { checkIn: '2026-09-03', checkOut: '2026-09-04' },
      },
      { now: NOW },
    )

    expect(days[0].state).toBe('free')
  })
})
