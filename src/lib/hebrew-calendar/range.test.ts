/**
 * What a stay contains — the function pricing and staffing will call.
 *
 * The thing most worth proving here is the half-open boundary. A stay is
 * `[checkIn, checkOut)`: the check-out date is not an occupied night. Get that
 * wrong and the pricing engine charges a Shabbat premium to a guest who left
 * on Friday morning, which is a dispute the guesthouse loses.
 */

import { describe, expect, it } from 'vitest'

import { toIsoDate } from './arithmetic'
import {
  isPeakNight,
  shabbatNightsInStay,
  specialDaysInStay,
  summarizeStay,
} from './range'
import { HEBREW_MONTH } from './types'

describe('the half-open boundary', () => {
  it('counts nights, not days', () => {
    // Friday 2026-04-03 to Sunday 2026-04-05: two nights.
    expect(
      summarizeStay({ checkIn: '2026-04-03', checkOut: '2026-04-05' }).nights,
    ).toBe(2)
  })

  it('does not count the check-out date as an occupied night', () => {
    // Shabbat is 2026-04-04. A guest checking out that morning did not stay
    // for it.
    expect(
      shabbatNightsInStay({ checkIn: '2026-04-02', checkOut: '2026-04-04' }),
    ).toEqual([])
    // A guest checking out the next morning did.
    expect(
      shabbatNightsInStay({ checkIn: '2026-04-02', checkOut: '2026-04-05' }),
    ).toEqual(['2026-04-04'])
  })

  it('does not price a festival the guest checked out on', () => {
    // Pesach is 2026-04-02. Checking out that morning is not staying for it.
    const leaving = summarizeStay({
      checkIn: '2026-03-31',
      checkOut: '2026-04-02',
    })
    expect(leaving.yomTov).toEqual([])
    expect(leaving.peakDates).toEqual([])

    const staying = summarizeStay({
      checkIn: '2026-04-01',
      checkOut: '2026-04-03',
    })
    expect(staying.yomTov.map((day) => day.date)).toEqual(['2026-04-02'])
  })

  it('treats a zero-length or reversed range as empty, not as an error', () => {
    // Availability code passes ranges around freely; throwing here would turn
    // a validation problem into a crash in the pricing path.
    for (const range of [
      { checkIn: '2026-04-02', checkOut: '2026-04-02' },
      { checkIn: '2026-04-10', checkOut: '2026-04-02' },
    ]) {
      const summary = summarizeStay(range)
      expect(summary.nights).toBe(0)
      expect(summary.peakDates).toEqual([])
      expect(summary.yomTov).toEqual([])
      expect(specialDaysInStay(range)).toEqual([])
      expect(shabbatNightsInStay(range)).toEqual([])
    }
  })
})

describe('a Pesach stay, the busiest week of an Israeli guesthouse year', () => {
  // 5786: Erev Pesach 2026-04-01, Pesach 04-02, chol hamoed 04-03…04-07,
  // Shvi'i shel Pesach 04-08. Cross-checked against hebcal in
  // special-days.test.ts.
  const summary = summarizeStay({
    checkIn: '2026-04-01',
    checkOut: '2026-04-09',
  })

  it('counts the eight nights', () => {
    expect(summary.nights).toBe(8)
  })

  it('separates yom tov from chol hamoed', () => {
    expect(summary.yomTov.map((day) => day.date)).toEqual([
      '2026-04-02',
      '2026-04-08',
    ])
    expect(summary.cholHaMoed.map((day) => day.date)).toEqual([
      '2026-04-03',
      '2026-04-04',
      '2026-04-05',
      '2026-04-06',
      '2026-04-07',
    ])
  })

  it('reports the Shabbat inside the festival', () => {
    expect(summary.shabbatDates).toEqual(['2026-04-04'])
  })

  it('reports erev Pesach as a minor day, not as a festival', () => {
    expect(summary.minorHolidays.map((day) => day.name)).toEqual(['ערב פסח'])
  })

  it('marks the whole stay as bein hazmanim underneath', () => {
    // 1–22 Nisan. Every night of this stay is inside it, even the ones whose
    // headline is Pesach.
    expect(summary.beinHazmanim).toHaveLength(8)
  })

  it('prices seven of the eight nights as peak', () => {
    // Everything except erev Pesach itself. Shabbat 04-04 is already chol
    // hamoed, so it is counted once, not twice.
    expect(summary.peakDates).toEqual([
      '2026-04-02',
      '2026-04-03',
      '2026-04-04',
      '2026-04-05',
      '2026-04-06',
      '2026-04-07',
      '2026-04-08',
    ])
    expect(new Set(summary.peakDates).size).toBe(summary.peakDates.length)
  })
})

describe('an ordinary midweek stay', () => {
  const summary = summarizeStay({
    checkIn: '2026-11-09',
    checkOut: '2026-11-12',
  })

  it('finds nothing at all', () => {
    expect(summary.nights).toBe(3)
    expect(summary.shabbatDates).toEqual([])
    expect(summary.yomTov).toEqual([])
    expect(summary.cholHaMoed).toEqual([])
    expect(summary.minorHolidays).toEqual([])
    expect(summary.beinHazmanim).toEqual([])
    expect(summary.peakDates).toEqual([])
  })
})

describe('an ordinary weekend', () => {
  it('prices the Shabbat night and nothing else', () => {
    const summary = summarizeStay({
      checkIn: '2026-11-13',
      checkOut: '2026-11-15',
    })
    expect(summary.nights).toBe(2)
    expect(summary.shabbatDates).toEqual(['2026-11-14'])
    expect(summary.peakDates).toEqual(['2026-11-14'])
    expect(summary.yomTov).toEqual([])
  })
})

describe('a stay spanning the turn of the Hebrew year', () => {
  it('finds days from both Hebrew years', () => {
    // 29 Elul 5786 is 2026-09-11 and 1 Tishrei 5787 is 2026-09-12, so this
    // stay crosses the year boundary — the case a per-year lookup table is
    // most likely to get wrong.
    const summary = summarizeStay({
      checkIn: '2026-09-10',
      checkOut: '2026-09-15',
    })
    const names = summary.minorHolidays
      .concat(summary.yomTov)
      .map((day) => day.name)
    expect(names).toContain('ערב ראש השנה')
    expect(names).toContain('ראש השנה')
    expect(names).toContain('ראש השנה ב׳')
    expect(summary.yomTov.map((day) => day.date)).toEqual([
      '2026-09-12',
      '2026-09-13',
    ])
  })
})

describe('per-night pricing', () => {
  it('marks Shabbat, yom tov and chol hamoed as peak, and nothing else', () => {
    expect(isPeakNight('2026-04-04')).toBe(true) // Shabbat and chol hamoed
    expect(isPeakNight('2026-04-02')).toBe(true) // Pesach
    expect(isPeakNight('2026-04-05')).toBe(true) // chol hamoed
    expect(isPeakNight('2026-11-14')).toBe(true) // plain Shabbat
    expect(isPeakNight('2026-04-01')).toBe(false) // erev Pesach: minor only
    expect(isPeakNight('2026-03-03')).toBe(false) // Purim: minor only
    expect(isPeakNight('2026-11-10')).toBe(false) // a plain Tuesday
  })

  it('agrees with summarizeStay night for night across a whole year', () => {
    // The per-night and per-range answers must not diverge; two pricing paths
    // that disagree is how a quote stops matching an invoice.
    const from = '2026-09-12' // 1 Tishrei 5787
    const to = '2027-10-02' // 1 Tishrei 5788
    const summary = summarizeStay({ checkIn: from, checkOut: to })
    const peak = new Set(summary.peakDates)
    for (const date of summary.peakDates) expect(isPeakNight(date)).toBe(true)
    let nonPeakChecked = 0
    for (const day of summary.minorHolidays) {
      if (!peak.has(day.date)) {
        expect(isPeakNight(day.date)).toBe(false)
        nonPeakChecked += 1
      }
    }
    expect(nonPeakChecked).toBeGreaterThan(5)
    expect(summary.peakDates.length).toBeGreaterThan(60)
  })
})

describe('special days in a stay', () => {
  it('returns every entry, including the ones precedence would hide', () => {
    const days = specialDaysInStay({
      checkIn: '2026-04-02',
      checkOut: '2026-04-03',
    })
    expect(days.map((day) => day.kind)).toEqual(['yom_tov', 'bein_hazmanim'])
  })

  it('works for a stay defined from Hebrew dates', () => {
    // Sukkot 5787: 15 Tishrei to 23 Tishrei.
    const checkIn = toIsoDate({
      year: 5787,
      month: HEBREW_MONTH.tishrei,
      day: 15,
    })
    const checkOut = toIsoDate({
      year: 5787,
      month: HEBREW_MONTH.tishrei,
      day: 23,
    })
    const summary = summarizeStay({ checkIn, checkOut })
    expect(summary.nights).toBe(8)
    expect(summary.yomTov.map((day) => day.name)).toEqual([
      'סוכות',
      'שמחת תורה',
    ])
    expect(summary.cholHaMoed).toHaveLength(6) // 16–20 Tishrei plus Hoshana Rabbah
  })
})
