import { describe, expect, it } from 'vitest'

import { demandCount, revenueReport } from './metrics'
import type {
  BookingSourceName,
  BookingStatusName,
  RevenueBooking,
  Window,
} from './types'

const AUGUST: Window = { from: '2026-08-01', to: '2026-09-01' }

let seq = 0
const booking = (over: Partial<RevenueBooking> = {}): RevenueBooking => ({
  id: `b-${++seq}`,
  propertyId: 'p-1',
  unitId: 'u-1',
  status: 'confirmed' as BookingStatusName,
  source: 'direct_website' as BookingSourceName,
  checkIn: '2026-08-07',
  checkOut: '2026-08-09',
  totalAgorot: 100_000,
  accommodationAgorot: 70_000,
  createdAt: '2026-06-01T09:00:00Z',
  ...over,
})

const report = (
  bookings: readonly RevenueBooking[],
  bookableUnits: number | null = 4,
) => revenueReport({ window: AUGUST, bookings, bookableUnits })

describe('a night is a night, not a day', () => {
  it('counts Friday to Sunday as two', () => {
    const r = report([
      booking({ checkIn: '2026-08-07', checkOut: '2026-08-09' }),
    ])
    expect(r.nightsSold).toEqual({ known: true, value: 2 })
  })

  it('counts only the part of a stay inside the window', () => {
    // Six nights, two of them in July. August must not claim them.
    const r = report([
      booking({ checkIn: '2026-07-30', checkOut: '2026-08-05' }),
    ])
    expect(r.nightsSold).toEqual({ known: true, value: 4 })
  })

  it('and prices only that part', () => {
    const r = report([
      booking({
        checkIn: '2026-07-30',
        checkOut: '2026-08-05',
        totalAgorot: 600_00,
        accommodationAgorot: 600_00,
      }),
    ])
    // Four of six nights: two thirds of ₪600.
    expect(r.roomRevenueAgorot).toEqual({ known: true, value: 400_00 })
  })
})

describe('ADR is room revenue, which is the whole point of it', () => {
  it('ignores the cleaning fee that is sitting in the total', () => {
    // ₪700 accommodation over two nights is ₪350 a night. The ₪300 of fees in
    // `totalAgorot` must not lift it to ₪500 — an owner pricing next season
    // against that number prices it a fifth too high all summer.
    const r = report([
      booking({ totalAgorot: 100_000, accommodationAgorot: 70_000 }),
    ])
    expect(r.adrAgorot).toEqual({ known: true, value: 35_000 })
    expect(r.totalRevenueAgorot).toEqual({ known: true, value: 100_000 })
  })

  it('refuses rather than falling back to the total', () => {
    const r = report([booking({ accommodationAgorot: null })])
    expect(r.adrAgorot).toEqual({ known: false, reason: 'no_source' })
    expect(r.roomRevenueAgorot).toEqual({ known: false, reason: 'no_source' })
    expect(r.withoutAccommodationLines).toBe(1)
    // And still answers the question it CAN answer, beside it.
    expect(r.totalRevenueAgorot).toEqual({ known: true, value: 100_000 })
  })

  it('averages over the nights it could price, not over every night sold', () => {
    // One priced booking (2 nights, ₪700) and one unpriced (2 nights). ADR is
    // ₪350, not ₪175 — the unpriced booking must not average in at zero.
    const r = report([
      booking({ accommodationAgorot: 70_000 }),
      booking({ accommodationAgorot: null }),
    ])
    expect(r.adrAgorot).toEqual({ known: true, value: 35_000 })
    expect(r.withoutAccommodationLines).toBe(1)
  })
})

describe('occupancy needs a denominator and will not invent one', () => {
  it('is unknown, not zero, when nobody counted the units', () => {
    const r = report([booking()], null)
    expect(r.occupancy).toEqual({ known: false, reason: 'no_denominator' })
    expect(r.nightsAvailable).toEqual({
      known: false,
      reason: 'no_denominator',
    })
    // Zero and unknown are opposite facts about a business.
    expect(r.occupancy.known).toBe(false)
  })

  it('divides nights sold by units times nights', () => {
    // 4 units × 31 nights = 124 available; 2 sold.
    const r = report([booking()], 4)
    expect(r.nightsAvailable).toEqual({ known: true, value: 124 })
    expect(r.occupancy).toEqual({ known: true, value: 1.6 })
  })

  it('drags RevPAR down on an empty month while ADR stays put', () => {
    const r = report([booking({ accommodationAgorot: 70_000 })], 4)
    expect(r.adrAgorot).toEqual({ known: true, value: 35_000 })
    // ₪700 across 124 available nights.
    expect(r.revparAgorot).toEqual({ known: true, value: 565 })
  })
})

describe('which bookings are occupancy at all', () => {
  const demand: BookingStatusName[] = ['inquiry', 'quote', 'option']

  it.each(demand)('%s is demand and not a sold night', (status) => {
    const r = report([booking({ status })])
    expect(r.nightsSold).toEqual({ known: false, reason: 'no_data' })
  })

  it('a booking awaiting payment holds the unit, so it counts', () => {
    const r = report([booking({ status: 'awaiting_payment' })])
    expect(r.nightsSold).toEqual({ known: true, value: 2 })
  })

  it('a cancelled booking is not occupancy', () => {
    const r = report([booking({ status: 'cancelled' })])
    expect(r.nightsSold).toEqual({ known: true, value: 0 })
  })
})

describe('the cancellation rate counts only what was decided', () => {
  it('one cancelled out of two real bookings is fifty percent', () => {
    const r = report([booking(), booking({ status: 'cancelled' })])
    expect(r.cancellationRate).toEqual({ known: true, value: 50 })
  })

  it('an enquiry that went quiet was never cancelled', () => {
    // Without this rule every busy guesthouse looks unreliable, because
    // enquiries outnumber bookings several to one.
    const r = report([
      booking(),
      booking({ status: 'cancelled' }),
      booking({ status: 'inquiry' }),
      booking({ status: 'inquiry' }),
      booking({ status: 'quote' }),
    ])
    expect(r.cancellationRate).toEqual({ known: true, value: 50 })
    expect(demandCount([booking({ status: 'inquiry' })])).toBe(1)
  })
})

describe('lead time, and the rows that would poison it', () => {
  it('measures how far ahead the guest booked', () => {
    const r = report([
      booking({ createdAt: '2026-07-08T09:00:00Z', checkIn: '2026-08-07' }),
    ])
    expect(r.leadTimeDays).toEqual({ known: true, value: 30 })
  })

  it('leaves out a row written after the guest had already arrived', () => {
    // Imported from a previous system, or typed in after the fact. Averaging
    // it in reports zero days ahead for a business booked two months out.
    const r = report([
      booking({ createdAt: '2026-07-08T09:00:00Z', checkIn: '2026-08-07' }),
      booking({ createdAt: '2026-08-20T09:00:00Z', checkIn: '2026-08-07' }),
    ])
    expect(r.leadTimeDays).toEqual({ known: true, value: 30 })
    expect(r.backdated).toBe(1)
  })

  it('and says so rather than reporting nothing when they are all like that', () => {
    const r = report([
      booking({ createdAt: '2026-08-20T09:00:00Z', checkIn: '2026-08-07' }),
    ])
    expect(r.leadTimeDays).toEqual({ known: false, reason: 'no_source' })
    expect(r.backdated).toBe(1)
  })
})

describe('channel mix', () => {
  it('shares by nights, because four one-night stays are not a week', () => {
    const r = report([
      booking({
        source: 'airbnb',
        checkIn: '2026-08-01',
        checkOut: '2026-08-02',
      }),
      booking({
        source: 'airbnb',
        checkIn: '2026-08-03',
        checkOut: '2026-08-04',
      }),
      booking({
        source: 'direct_website',
        checkIn: '2026-08-10',
        checkOut: '2026-08-16',
      }),
    ])

    expect(r.channelMix.map((c) => c.source)).toEqual([
      'direct_website',
      'airbnb',
    ])
    expect(r.channelMix[0]).toMatchObject({
      nights: 6,
      bookings: 1,
      nightsShare: 75,
    })
    expect(r.channelMix[1]).toMatchObject({ nights: 2, bookings: 2 })
  })

  it('shows no row for a channel that sent nothing', () => {
    const r = report([booking({ source: 'airbnb' })])
    expect(r.channelMix).toHaveLength(1)
  })
})

describe('the number this module will never produce', () => {
  it('market position, on every input', () => {
    for (const input of [[], [booking()], [booking({ status: 'cancelled' })]]) {
      expect(
        revenueReport({
          window: AUGUST,
          bookings: input,
          bookableUnits: 4,
        }).marketPosition,
      ).toEqual({ known: false, reason: 'not_in_product' })
    }
  })
})

describe('an empty window', () => {
  it('says there is nothing to calculate rather than reporting zeroes', () => {
    const r = report([])
    expect(r.nightsSold).toEqual({ known: false, reason: 'no_data' })
    expect(r.adrAgorot).toEqual({ known: false, reason: 'no_source' })
    expect(r.cancellationRate).toEqual({ known: false, reason: 'no_data' })
    expect(r.averageStayNights).toEqual({ known: false, reason: 'no_data' })
    // The denominator is still knowable, and still reported.
    expect(r.nightsAvailable).toEqual({ known: true, value: 124 })
  })
})
