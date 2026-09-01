/**
 * The forward demand curve.
 */

import { describe, expect, it } from 'vitest'

import { buildForecast, busiestDay } from './forecast'
import { assessStock, nullStockPort, shortagesOnly } from './ports'
import { buildLaundryRequirements } from './requirements'
import {
  CARMEL,
  CARMEL_REQUIREMENTS,
  GALILEE,
  GALILEE_REQUIREMENTS,
  PROFILES,
  REQUIRED_BY,
  SETTINGS,
} from './testing/example-configuration'
import type { ForecastEntry } from './types'

const FROM = '2026-09-01'

const ENTRIES: readonly ForecastEntry[] = [
  {
    bookingId: 'booking-galilee',
    propertyId: GALILEE,
    requiredOn: '2026-09-04',
    requirements: GALILEE_REQUIREMENTS,
  },
  {
    bookingId: 'booking-carmel',
    propertyId: CARMEL,
    requiredOn: '2026-09-04',
    requirements: CARMEL_REQUIREMENTS,
  },
  {
    bookingId: 'booking-later',
    propertyId: GALILEE,
    requiredOn: '2026-09-06',
    requirements: CARMEL_REQUIREMENTS,
  },
]

function forecast(
  overrides: Partial<Parameters<typeof buildForecast>[0]> = {},
) {
  return buildForecast({
    settings: SETTINGS,
    profiles: PROFILES,
    entries: ENTRIES,
    from: FROM,
    ...overrides,
  })
}

describe('the forecast', () => {
  it('uses the configured horizon and covers every day in it', () => {
    const result = forecast()

    expect(result.horizonDays).toBe(SETTINGS.forecastHorizonDays)
    expect(result.days).toHaveLength(SETTINGS.forecastHorizonDays)
    expect(result.from).toBe(FROM)
  })

  it('includes the quiet days, so the gaps are visible', () => {
    const empty = forecast().days.filter((day) => day.units === 0)

    // Most of the week has nothing in it, and a forecast that omitted those
    // days would render as a dense wall of work.
    expect(empty.length).toBeGreaterThan(0)
  })

  it('counts only laundry items, never the whole preparation plan', () => {
    const items = forecast().totals.map((entry) => entry.itemId)

    expect(items).toContain('towel_bath')
    expect(items).toContain('linen_set')
    expect(items).not.toContain('mattress')
    expect(items).not.toContain('toilet_paper')
  })

  it('sums the canonical preparation quantities and nothing else', () => {
    const towels = forecast().totals.find(
      (entry) => entry.itemId === 'towel_bath',
    )

    // Summed from the fixture itself rather than written down, so the
    // assertion cannot drift from the entries above — and so it stays a check
    // on the engine rather than a second copy of the arithmetic.
    const expected = ENTRIES.reduce(
      (sum, entry) =>
        sum +
        (entry.requirements.find((item) => item.itemId === 'towel_bath')
          ?.quantity ?? 0),
      0,
    )

    expect(towels?.quantity).toBe(expected)
    expect(expected).toBeGreaterThan(0)
  })

  it('does not inflate the curve with the laundry buffer', () => {
    // The buffer is spare ordered against damage. A demand curve carrying it
    // would make a business buy linen for a shortage it does not have; the
    // buffer appears when an order is built, which is where it is needed.
    const towels = forecast().totals.find(
      (entry) => entry.itemId === 'towel_bath',
    )
    const withBuffer = buildLaundryRequirements({
      settings: SETTINGS,
      profiles: PROFILES,
      requirements: GALILEE_REQUIREMENTS,
      propertyId: GALILEE,
      requiredBy: REQUIRED_BY,
      bookingId: null,
    }).requirements.find((entry) => entry.itemId === 'towel_bath')

    expect(towels?.quantity).toBeLessThan(
      (withBuffer?.quantity ?? 0) + (withBuffer?.quantity ?? 0),
    )
    expect(withBuffer?.quantity).toBeGreaterThan(
      withBuffer?.preparationQuantity ?? 0,
    )
  })

  it('narrows to one property when asked', () => {
    const galilee = forecast({ propertyId: GALILEE })

    expect(galilee.bookingCount).toBe(2)
    for (const day of galilee.days) {
      for (const bookingId of day.bookingIds) {
        expect(bookingId).not.toBe('booking-carmel')
      }
    }
  })

  it('excludes what falls outside the window', () => {
    const short = forecast({ horizonDays: 2 })

    expect(short.bookingCount).toBe(0)
    expect(short.totals).toEqual([])
  })

  it('writes a headline that names the items rather than a bare total', () => {
    const result = forecast()

    expect(result.headline).toContain(String(result.horizonDays))
    expect(result.headline).toContain('מגבות רחצה')
    expect(result.headline).toContain('מערכות מצעים')
  })

  it('says so plainly when there is nothing coming', () => {
    const nothing = forecast({ entries: [] })

    expect(nothing.totals).toEqual([])
    expect(nothing.headline).toContain('אין דרישות כביסה')
  })

  it('names the busiest day, which is where a shortage actually happens', () => {
    const busiest = busiestDay(forecast())

    // Demand is not spread evenly, and a week's total divided by seven has
    // never once described a real Friday.
    expect(busiest?.date).toBe('2026-09-04')
  })
})

// ── The stock port ────────────────────────────────────────────────────────

describe('stock, when nobody is counting it', () => {
  it('answers "unknown" rather than zero', async () => {
    const levels = await nullStockPort.levels({
      organizationId: 'org',
      itemIds: ['towel_bath'],
      propertyIds: [GALILEE],
    })

    // A zero would render a shortage of thirty and send somebody to buy
    // sheets they already own.
    expect(levels).toBeNull()
  })

  it('still lists every requirement, and says stock is not managed', () => {
    const requirements = buildLaundryRequirements({
      settings: SETTINGS,
      profiles: PROFILES,
      requirements: GALILEE_REQUIREMENTS,
      propertyId: GALILEE,
      requiredBy: REQUIRED_BY,
      bookingId: null,
    }).requirements

    const assessed = assessStock(requirements, null)

    expect(assessed).toHaveLength(requirements.length)
    for (const entry of assessed) {
      expect(entry.available).toBeNull()
      expect(entry.shortage).toBeNull()
      expect(entry.explanation).toContain('מלאי אינו מנוהל')
    }

    // And nothing is reported as short, because nothing is known to be.
    expect(shortagesOnly(assessed)).toEqual([])
  })

  it('computes a real shortage when levels are supplied', () => {
    const requirements = buildLaundryRequirements({
      settings: SETTINGS,
      profiles: PROFILES,
      requirements: GALILEE_REQUIREMENTS,
      propertyId: GALILEE,
      requiredBy: REQUIRED_BY,
      bookingId: null,
    }).requirements

    const towels = requirements.find((entry) => entry.itemId === 'towel_bath')
    if (!towels) throw new Error('no towels')

    const assessed = assessStock(requirements, [
      {
        itemId: 'towel_bath',
        propertyId: GALILEE,
        available: towels.quantity - 4,
        inLaundry: 2,
        returning: 1,
      },
    ])

    const short = shortagesOnly(assessed)

    expect(short).toHaveLength(1)
    expect(short[0]?.shortage).toBe(4)
    // The items with no level are reported as unknown, not as satisfied.
    const linen = assessed.find((entry) => entry.itemId === 'linen_set')
    expect(linen?.shortage).toBeNull()
  })
})
