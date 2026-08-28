import { describe, expect, it } from 'vitest'

import { sumLines } from '@/lib/booking/pricing'

import type { CalendarUnit } from './inventory'
import { fitsParty, quoteFor } from './quote'

function unit(overrides: Partial<CalendarUnit> = {}): CalendarUnit {
  return {
    id: 'unit-1',
    code: 'A1',
    name: 'סוויטת הגליל',
    status: 'active',
    propertyId: 'property-1',
    propertyName: 'וילה הגליל',
    maxGuests: 4,
    standardGuests: 2,
    minNights: 1,
    basePriceAgorot: 90_000, // ₪900
    extraGuestPriceAgorot: 10_000, // ₪100
    cleaningFeeAgorot: 15_000, // ₪150
    depositAgorot: 100_000, // ₪1,000
    taxRateBps: 1700,
    taxIncludedInPrice: true,
    detailed: true,
    ...overrides,
  }
}

const TWO_NIGHTS = { checkIn: '2026-09-03', checkOut: '2026-09-05' }

describe('quoteFor', () => {
  it('refuses to invent a price for an unpriced unit', () => {
    expect(quoteFor(unit({ basePriceAgorot: 0 }), TWO_NIGHTS, 2)).toBeNull()
  })

  it('always returns a total that is the sum of its own lines', () => {
    for (const inclusive of [true, false]) {
      const quote = quoteFor(
        unit({ taxIncludedInPrice: inclusive }),
        TWO_NIGHTS,
        3,
      )
      expect(quote).not.toBeNull()
      expect(quote!.totalAgorot).toBe(sumLines(quote!.lines))
    }
  })

  it('prices one accommodation line per night, half-open', () => {
    const quote = quoteFor(unit(), TWO_NIGHTS, 2)!
    const nights = quote.lines.filter((line) => line.kind === 'accommodation')
    expect(quote.nights).toBe(2)
    expect(nights.map((line) => line.date)).toEqual([
      '2026-09-03',
      '2026-09-04',
    ])
  })

  it('adds an extra-guest line only beyond the rate’s standard occupancy', () => {
    const two = quoteFor(unit(), TWO_NIGHTS, 2)!
    const three = quoteFor(unit(), TWO_NIGHTS, 3)!

    expect(two.lines.some((line) => line.kind === 'extra_guest')).toBe(false)

    const extra = three.lines.find((line) => line.kind === 'extra_guest')
    expect(extra).toBeDefined()
    // One extra guest, two nights, ₪100 a night.
    expect(extra!.amount).toBe(20_000)
  })

  it('charges tax as a line only when the rates exclude it', () => {
    const exclusive = quoteFor(
      unit({ taxIncludedInPrice: false }),
      TWO_NIGHTS,
      2,
    )!
    expect(exclusive.lines.some((line) => line.kind === 'tax')).toBe(true)
    expect(exclusive.taxAgorot).toBeGreaterThan(0)
    // The contained figure would be a second answer to the same question.
    expect(exclusive.taxIncludedAgorot).toBeNull()
  })

  it('reports contained VAT without a line when the rates include it', () => {
    const inclusive = quoteFor(unit(), TWO_NIGHTS, 2)!
    expect(inclusive.lines.some((line) => line.kind === 'tax')).toBe(false)
    expect(inclusive.taxAgorot).toBe(0)
    expect(inclusive.taxIncludedAgorot).toBeGreaterThan(0)
    // Contained VAT is computed on the stay, never on the refundable deposit.
    expect(inclusive.taxIncludedAgorot!).toBeLessThan(inclusive.stayTotalAgorot)
  })

  it('keeps the refundable deposit in the total and out of the stay', () => {
    const quote = quoteFor(unit(), TWO_NIGHTS, 2)!
    expect(quote.depositAgorot).toBe(100_000)
    expect(quote.totalAgorot - quote.stayTotalAgorot).toBe(100_000)
  })

  it('produces no quote at all for a reversed range, rather than a wrong one', () => {
    expect(() =>
      quoteFor(unit(), { checkIn: '2026-09-05', checkOut: '2026-09-03' }, 2),
    ).toThrow()
  })
})

describe('fitsParty', () => {
  it('compares the party against the unit’s stated capacity', () => {
    expect(fitsParty(unit({ maxGuests: 4 }), 4)).toBe(true)
    expect(fitsParty(unit({ maxGuests: 4 }), 5)).toBe(false)
  })
})
