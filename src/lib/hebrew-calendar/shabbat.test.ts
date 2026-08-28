/**
 * Shabbat — the day, and the honest absence of the times.
 *
 * Half of what is tested here is that the module does *not* claim things it
 * cannot know. A calendar that returned a plausible-looking candle-lighting
 * time computed from nothing would be worse than one that returns null, and
 * the null is therefore asserted rather than tolerated.
 */

import { describe, expect, it } from 'vitest'

import { fixedToIso, isoToFixed } from './gregorian'
import {
  SHABBAT_TIMES_UNAVAILABLE,
  SHABBAT_TIMES_UNAVAILABLE_EN,
  isErevShabbat,
  isShabbat,
  shabbatDatesBetween,
  shabbatWindow,
} from './shabbat'

describe('which day is Shabbat', () => {
  it('agrees with the runtime about Saturdays across 20 years', () => {
    const from = isoToFixed('2020-01-01')
    const to = isoToFixed('2039-12-31')
    let saturdays = 0
    for (let fixed = from; fixed <= to; fixed += 1) {
      const iso = fixedToIso(fixed)
      const viaDate = new Date(`${iso}T12:00:00Z`).getUTCDay()
      expect(isShabbat(iso)).toBe(viaDate === 6)
      expect(isErevShabbat(iso)).toBe(viaDate === 5)
      if (viaDate === 6) saturdays += 1
    }
    // 20 years with five Gregorian leap years is 7,305 days. 2020-01-01 was a
    // Wednesday, so the first Saturday is day 4 and the count is
    // 1 + floor((7305 − 4) / 7) = 1044.
    expect(to - from + 1).toBe(7305)
    expect(saturdays).toBe(1044)
    // …and the range helper must agree with the day-by-day count.
    expect(shabbatDatesBetween('2020-01-01', '2039-12-31')).toHaveLength(1044)
  })

  it('knows a specific Shabbat and the Friday before it', () => {
    // 2026-04-04 was a Saturday.
    expect(isShabbat('2026-04-04')).toBe(true)
    expect(isErevShabbat('2026-04-03')).toBe(true)
    expect(isShabbat('2026-04-03')).toBe(false)
    expect(isErevShabbat('2026-04-04')).toBe(false)
  })
})

describe('the Shabbat of a week', () => {
  it('resolves every day of a week to the Shabbat that closes it', () => {
    // Sunday 2026-03-29 through Shabbat 2026-04-04.
    for (const iso of [
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
      '2026-04-04',
    ]) {
      expect(shabbatWindow(iso).shabbatDate).toBe('2026-04-04')
    }
    // The next day starts a new week.
    expect(shabbatWindow('2026-04-05').shabbatDate).toBe('2026-04-11')
  })

  it('begins on the Friday evening and ends on the Shabbat evening', () => {
    const window = shabbatWindow('2026-04-04')
    expect(window.beginsEveningOf).toBe('2026-04-03')
    expect(window.endsEveningOf).toBe('2026-04-04')
    expect(isErevShabbat(window.beginsEveningOf)).toBe(true)
  })

  it('always returns a Saturday, for every day of two years', () => {
    for (
      let fixed = isoToFixed('2026-01-01');
      fixed <= isoToFixed('2027-12-31');
      fixed += 1
    ) {
      const window = shabbatWindow(fixedToIso(fixed))
      expect(isShabbat(window.shabbatDate)).toBe(true)
      expect(isErevShabbat(window.beginsEveningOf)).toBe(true)
      // Never more than six days away in either direction.
      const distance = isoToFixed(window.shabbatDate) - fixed
      expect(distance).toBeGreaterThanOrEqual(0)
      expect(distance).toBeLessThanOrEqual(6)
    }
  })
})

describe('candle lighting and havdalah are not invented', () => {
  it('returns null for both times, always', () => {
    const window = shabbatWindow('2026-04-04')
    expect(window.candleLighting).toBeNull()
    expect(window.havdalah).toBeNull()
  })

  it('never returns a time for any Shabbat of a year', () => {
    // Guards against a future "helpful" default such as a fixed 18-minute
    // offset, which would be wrong by up to an hour across Israel and across
    // the seasons.
    for (const date of shabbatDatesBetween('2026-01-01', '2026-12-31')) {
      const window = shabbatWindow(date)
      expect(window.candleLighting).toBeNull()
      expect(window.havdalah).toBeNull()
    }
  })

  it('explains why, in both Hebrew and English', () => {
    expect(SHABBAT_TIMES_UNAVAILABLE).toContain('שקיעה')
    expect(SHABBAT_TIMES_UNAVAILABLE_EN).toContain('location')
    expect(SHABBAT_TIMES_UNAVAILABLE_EN).toContain('day boundary only')
  })
})

describe('Shabbatot in a range', () => {
  it('lists every Shabbat of a month', () => {
    expect(shabbatDatesBetween('2026-04-01', '2026-04-30')).toEqual([
      '2026-04-04',
      '2026-04-11',
      '2026-04-18',
      '2026-04-25',
    ])
  })

  it('includes both ends when they are themselves Shabbat', () => {
    expect(shabbatDatesBetween('2026-04-04', '2026-04-11')).toEqual([
      '2026-04-04',
      '2026-04-11',
    ])
  })

  it('returns nothing for a range with no Saturday in it', () => {
    // Sunday to Friday.
    expect(shabbatDatesBetween('2026-03-29', '2026-04-03')).toEqual([])
    // A single non-Saturday day.
    expect(shabbatDatesBetween('2026-04-02', '2026-04-02')).toEqual([])
    // A reversed range.
    expect(shabbatDatesBetween('2026-04-30', '2026-04-01')).toEqual([])
  })

  it('finds 52 or 53 Shabbatot in every year of a decade', () => {
    for (let year = 2026; year <= 2035; year += 1) {
      const count = shabbatDatesBetween(`${year}-01-01`, `${year}-12-31`).length
      expect([52, 53]).toContain(count)
    }
  })
})
