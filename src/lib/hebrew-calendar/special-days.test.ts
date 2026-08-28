/**
 * Proof that the holiday table lands on the right days.
 *
 * Three independent kinds of check, because a holiday table can be wrong in
 * three different ways:
 *
 *  1. **Hebrew-date invariants, every year for a century.** Pesach is 15 Nisan
 *     and Purim is 14 Adar (the *second* Adar in a leap year), in every one of
 *     a hundred consecutive years. This catches a rule applied to the wrong
 *     month, or one that quietly stops firing.
 *
 *  2. **Gregorian cross-check against hebcal.com**, whose Israel holiday
 *     calendars for 2026 and 2027 were fetched on 2026-08-27 and are
 *     transcribed below. This catches a calendar that is internally consistent
 *     but shifted, and it checks the Israeli one-day-yom-tov reckoning rather
 *     than assuming it.
 *
 *  3. **The movable days**, whose whole point is that they are not on a fixed
 *     Hebrew date: the two summer fasts step off Shabbat, and Yom HaAtzmaut
 *     moves by statute.
 *
 * There is also a fourth section, for the days the legacy table **does not
 * contain**. Those absences are asserted rather than left implicit, so that
 * "does the calendar know about Yom HaShoah?" has an answer in the test suite
 * instead of in someone's memory.
 */

import { describe, expect, it } from 'vitest'

import {
  daysInHebrewMonth,
  hebrewToFixed,
  isHebrewLeapYear,
  purimAdar,
  toHebrewDate,
  toIsoDate,
} from './arithmetic'
import { dayOfWeek, fixedToIso, isoToFixed } from './gregorian'
import {
  beinHazmanimPeriods,
  hebrewYearSpecialDays,
  hebrewYearsSpanning,
  isBeinHazmanim,
  isCholHaMoed,
  isYomTov,
  roshHashanahDate,
  specialDayOn,
  specialDaysBetween,
  specialDaysOn,
} from './special-days'
import { HEBREW_MONTH } from './types'
import type { HebrewMonth, SpecialDay } from './types'

// ── A century of Hebrew years ─────────────────────────────────────────────

const FIRST_YEAR = 5760
const LAST_YEAR = 5860

const YEARS: number[] = []
for (let year = FIRST_YEAR; year <= LAST_YEAR; year += 1) YEARS.push(year)

function byName(year: number): Map<string, SpecialDay[]> {
  const index = new Map<string, SpecialDay[]>()
  for (const day of hebrewYearSpecialDays(year)) {
    const existing = index.get(day.name)
    if (existing) existing.push(day)
    else index.set(day.name, [day])
  }
  return index
}

/** Named days that sit on the same Hebrew date every single year. */
const FIXED_HEBREW_DATES: Array<{
  name: string
  month: HebrewMonth | 'purim-adar'
  day: number
  kind: SpecialDay['kind']
}> = [
  { name: 'ראש השנה', month: HEBREW_MONTH.tishrei, day: 1, kind: 'yom_tov' },
  { name: 'ראש השנה ב׳', month: HEBREW_MONTH.tishrei, day: 2, kind: 'yom_tov' },
  { name: 'ערב יום כיפור', month: HEBREW_MONTH.tishrei, day: 9, kind: 'minor' },
  { name: 'יום כיפור', month: HEBREW_MONTH.tishrei, day: 10, kind: 'yom_tov' },
  { name: 'סוכות', month: HEBREW_MONTH.tishrei, day: 15, kind: 'yom_tov' },
  {
    name: 'הושענא רבה',
    month: HEBREW_MONTH.tishrei,
    day: 21,
    kind: 'chol_hamoed',
  },
  { name: 'שמחת תורה', month: HEBREW_MONTH.tishrei, day: 22, kind: 'yom_tov' },
  { name: 'ערב ראש השנה', month: HEBREW_MONTH.elul, day: 29, kind: 'minor' },
  { name: 'ערב פסח', month: HEBREW_MONTH.nisan, day: 14, kind: 'minor' },
  { name: 'פסח', month: HEBREW_MONTH.nisan, day: 15, kind: 'yom_tov' },
  {
    name: 'שביעי של פסח',
    month: HEBREW_MONTH.nisan,
    day: 21,
    kind: 'yom_tov',
  },
  { name: 'שבועות', month: HEBREW_MONTH.sivan, day: 6, kind: 'yom_tov' },
  { name: 'ט״ו בשבט', month: HEBREW_MONTH.shevat, day: 15, kind: 'minor' },
  { name: 'ל״ג בעומר', month: HEBREW_MONTH.iyar, day: 18, kind: 'minor' },
  { name: 'ט״ו באב', month: HEBREW_MONTH.av, day: 15, kind: 'minor' },
  { name: 'פורים', month: 'purim-adar', day: 14, kind: 'minor' },
  { name: 'שושן פורים', month: 'purim-adar', day: 15, kind: 'minor' },
]

describe('every holiday falls on its Hebrew date, every year for a century', () => {
  it.each(FIXED_HEBREW_DATES)(
    '$name is always $day of month $month',
    ({ name, month, day, kind }) => {
      for (const year of YEARS) {
        const found = byName(year).get(name)
        expect(found, `${name} missing in ${year}`).toHaveLength(1)
        const expectedMonth = month === 'purim-adar' ? purimAdar(year) : month
        expect(found![0].hebrewDate).toEqual({
          year,
          month: expectedMonth,
          day,
        })
        expect(found![0].kind).toBe(kind)
      }
    },
  )

  it('runs Purim in the second Adar of a leap year, not the first', () => {
    const leapYears = YEARS.filter((year) => isHebrewLeapYear(year))
    expect(leapYears.length).toBeGreaterThan(30)
    for (const year of leapYears) {
      expect(byName(year).get('פורים')![0].hebrewDate.month).toBe(
        HEBREW_MONTH.adarII,
      )
    }
  })

  it('gives chol hamoed Pesach five days, 16–20 Nisan', () => {
    for (const year of YEARS) {
      const days = byName(year).get('חול המועד פסח')!
      expect(days).toHaveLength(5)
      expect(days.map((day) => day.hebrewDate.day)).toEqual([
        16, 17, 18, 19, 20,
      ])
      for (const day of days) {
        expect(day.hebrewDate.month).toBe(HEBREW_MONTH.nisan)
        expect(day.kind).toBe('chol_hamoed')
      }
    }
  })

  it('gives chol hamoed Sukkot five days, 16–20 Tishrei', () => {
    for (const year of YEARS) {
      const days = byName(year).get('חול המועד סוכות')!
      expect(days).toHaveLength(5)
      expect(days.map((day) => day.hebrewDate.day)).toEqual([
        16, 17, 18, 19, 20,
      ])
      for (const day of days) {
        expect(day.hebrewDate.month).toBe(HEBREW_MONTH.tishrei)
      }
    }
  })

  it('runs Chanukah for eight consecutive days from 25 Kislev', () => {
    let crossedIntoTevet = 0
    for (const year of YEARS) {
      const index = byName(year)
      const nights = Array.from({ length: 8 }, (_, night) => {
        const found = index.get(`חנוכה · נר ${night + 1}`)
        expect(found, `night ${night + 1} missing in ${year}`).toHaveLength(1)
        return found![0]
      })
      expect(nights[0].hebrewDate).toEqual({
        year,
        month: HEBREW_MONTH.kislev,
        day: 25,
      })
      // Eight consecutive civil days, which is the only way to say "eight
      // days" when the month underneath may be 29 days or 30.
      for (let night = 1; night < 8; night += 1) {
        expect(isoToFixed(nights[night].date)).toBe(
          isoToFixed(nights[night - 1].date) + 1,
        )
      }
      // Kislev has 29 or 30 days, so eight days from the 25th always spill
      // into Tevet — onto the 3rd in a deficient year, the 2nd otherwise.
      const last = nights[7].hebrewDate
      expect(last.month).toBe(HEBREW_MONTH.tevet)
      expect(last.day).toBe(
        daysInHebrewMonth(year, HEBREW_MONTH.kislev) === 29 ? 3 : 2,
      )
      crossedIntoTevet += 1
    }
    expect(crossedIntoTevet).toBe(YEARS.length)
  })
})

// ── The movable days ──────────────────────────────────────────────────────

describe('fasts step off Shabbat', () => {
  it('keeps Tisha BeAv on 9 Av, or 10 Av when the 9th is Shabbat', () => {
    let postponed = 0
    for (const year of YEARS) {
      const fast = byName(year).get('תשעה באב')![0]
      const nominal = hebrewToFixed({ year, month: HEBREW_MONTH.av, day: 9 })
      const actual = isoToFixed(fast.date)
      expect(dayOfWeek(fast.date)).not.toBe(6) // never on Shabbat
      if (
        dayOfWeek(toIsoDate({ year, month: HEBREW_MONTH.av, day: 9 })) === 6
      ) {
        expect(actual).toBe(nominal + 1)
        expect(fast.hebrewDate.day).toBe(10)
        expect(dayOfWeek(fast.date)).toBe(0) // postponed to Sunday
        postponed += 1
      } else {
        expect(actual).toBe(nominal)
        expect(fast.hebrewDate.day).toBe(9)
      }
    }
    // The postponement really happens, so the branch above is exercised.
    expect(postponed).toBeGreaterThan(10)
  })

  it('keeps 17 Tammuz on the 17th, or the 18th when the 17th is Shabbat', () => {
    let postponed = 0
    for (const year of YEARS) {
      const fast = byName(year).get('צום י״ז בתמוז')![0]
      expect(dayOfWeek(fast.date)).not.toBe(6)
      expect([17, 18]).toContain(fast.hebrewDate.day)
      expect(fast.hebrewDate.month).toBe(HEBREW_MONTH.tammuz)
      if (fast.hebrewDate.day === 18) {
        expect(dayOfWeek(fast.date)).toBe(0)
        postponed += 1
      }
    }
    expect(postponed).toBeGreaterThan(10)
  })

  it('moves both fasts together — they are always three weeks apart', () => {
    // The Three Weeks. 17 Tammuz and 9 Av are 21 days apart nominally, and
    // both are postponed by the same rule, so the gap stays 21 days.
    for (const year of YEARS) {
      const index = byName(year)
      const gap =
        isoToFixed(index.get('תשעה באב')![0].date) -
        isoToFixed(index.get('צום י״ז בתמוז')![0].date)
      expect(gap).toBe(21)
    }
  })
})

describe('Yom HaAtzmaut moves by statute', () => {
  it('never falls on Friday or Shabbat, and neither does Yom HaZikaron', () => {
    const weekdaysSeen = new Set<number>()
    for (const year of YEARS) {
      const index = byName(year)
      const independence = index.get('יום העצמאות')![0]
      const remembrance = index.get('יום הזיכרון')![0]
      weekdaysSeen.add(dayOfWeek(independence.date))
      expect([5, 6]).not.toContain(dayOfWeek(independence.date))
      expect([5, 6]).not.toContain(dayOfWeek(remembrance.date))
      // Remembrance Day is always the day before Independence Day.
      expect(isoToFixed(independence.date) - isoToFixed(remembrance.date)).toBe(
        1,
      )
    }
    // The statute leaves only three possible weekdays: Tuesday, Wednesday,
    // Thursday. All three occur, so no branch of the rule is dead.
    expect([...weekdaysSeen].sort((a, b) => a - b)).toEqual([2, 3, 4])
  })

  it('lands within two days either side of 5 Iyar', () => {
    let moved = 0
    for (const year of YEARS) {
      const independence = byName(year).get('יום העצמאות')![0]
      expect(independence.hebrewDate.month).toBe(HEBREW_MONTH.iyar)
      expect([3, 4, 5, 6]).toContain(independence.hebrewDate.day)
      if (independence.hebrewDate.day !== 5) moved += 1
    }
    expect(moved).toBeGreaterThan(40)
  })
})

// ── Cross-check against hebcal.com ────────────────────────────────────────

/**
 * hebcal.com's Israel holiday calendar, fetched 2026-08-27 from
 * `hebcal.com/hebcal?v=1&cfg=json&maj=on&min=on&mod=on&i=on&year=2026|2027`.
 * Transcribed verbatim; `i=on` selects the Israeli one-day-yom-tov schedule,
 * which is the one this product uses.
 */
const HEBCAL_2026: Array<[string, string]> = [
  ['2026-02-02', 'ט״ו בשבט'],
  ['2026-03-03', 'פורים'],
  ['2026-03-04', 'שושן פורים'],
  ['2026-04-01', 'ערב פסח'],
  ['2026-04-02', 'פסח'],
  ['2026-04-08', 'שביעי של פסח'],
  ['2026-04-21', 'יום הזיכרון'],
  ['2026-04-22', 'יום העצמאות'],
  ['2026-05-05', 'ל״ג בעומר'],
  ['2026-05-22', 'שבועות'],
  ['2026-07-23', 'תשעה באב'],
  ['2026-07-29', 'ט״ו באב'],
  ['2026-09-11', 'ערב ראש השנה'],
  ['2026-09-12', 'ראש השנה'],
  ['2026-09-13', 'ראש השנה ב׳'],
  ['2026-09-20', 'ערב יום כיפור'],
  ['2026-09-21', 'יום כיפור'],
  ['2026-09-26', 'סוכות'],
  ['2026-10-02', 'הושענא רבה'],
  ['2026-10-03', 'שמחת תורה'],
  ['2026-12-05', 'חנוכה · נר 1'],
]

const HEBCAL_2027: Array<[string, string]> = [
  ['2027-01-23', 'ט״ו בשבט'],
  ['2027-03-23', 'פורים'],
  ['2027-03-24', 'שושן פורים'],
  ['2027-04-21', 'ערב פסח'],
  ['2027-04-22', 'פסח'],
  ['2027-04-28', 'שביעי של פסח'],
  ['2027-05-11', 'יום הזיכרון'],
  ['2027-05-12', 'יום העצמאות'],
  ['2027-05-25', 'ל״ג בעומר'],
  ['2027-06-11', 'שבועות'],
  ['2027-08-12', 'תשעה באב'],
  ['2027-08-18', 'ט״ו באב'],
  ['2027-10-01', 'ערב ראש השנה'],
  ['2027-10-02', 'ראש השנה'],
  ['2027-10-03', 'ראש השנה ב׳'],
  ['2027-10-10', 'ערב יום כיפור'],
  ['2027-10-11', 'יום כיפור'],
  ['2027-10-16', 'סוכות'],
  ['2027-10-22', 'הושענא רבה'],
  ['2027-10-23', 'שמחת תורה'],
  ['2027-12-25', 'חנוכה · נר 1'],
]

describe('Gregorian holiday dates match hebcal.com for 2026 and 2027', () => {
  it.each([...HEBCAL_2026, ...HEBCAL_2027])(
    '%s is %s',
    (iso: string, name: string) => {
      expect(specialDaysOn(iso).map((day) => day.name)).toContain(name)
    },
  )

  it('matches hebcal on the whole run of chol hamoed', () => {
    // hebcal 2026: Pesach II–VI (CH''M) on 3–7 April; Sukkot II–VI plus
    // Hoshana Raba on 27 September – 2 October.
    for (const iso of [
      '2026-04-03',
      '2026-04-04',
      '2026-04-05',
      '2026-04-06',
      '2026-04-07',
    ]) {
      expect(isCholHaMoed(iso)).toBe(true)
      expect(specialDayOn(iso)!.name).toBe('חול המועד פסח')
    }
    for (const iso of [
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]) {
      expect(isCholHaMoed(iso)).toBe(true)
    }
    // The days on either side are yom tov, not chol hamoed.
    expect(isCholHaMoed('2026-04-02')).toBe(false)
    expect(isCholHaMoed('2026-04-08')).toBe(false)
    expect(isYomTov('2026-04-02')).toBe(true)
    expect(isYomTov('2026-04-08')).toBe(true)
    expect(isYomTov('2026-10-03')).toBe(true)
  })

  it('matches hebcal on all eight days of Chanukah 5787', () => {
    // hebcal labels the *evening* the candle is lit, so its "1 Candle" is
    // 2026-12-04 and its "8th Day" is 2026-12-12. This module labels the
    // Hebrew day, the convention an Israeli wall calendar uses, so its
    // נר 1 is 25 Kislev = 2026-12-05 and נר 8 is 2026-12-12. The eight days
    // are the same eight days; only the label on the evening differs.
    const dates = [
      '2026-12-05',
      '2026-12-06',
      '2026-12-07',
      '2026-12-08',
      '2026-12-09',
      '2026-12-10',
      '2026-12-11',
      '2026-12-12',
    ]
    dates.forEach((iso, index) => {
      expect(specialDaysOn(iso).map((day) => day.name)).toContain(
        `חנוכה · נר ${index + 1}`,
      )
    })
    // hebcal's "Chanukah: 8th Day" is 2026-12-12 — the same last day.
    expect(specialDaysOn('2026-12-12').map((day) => day.name)).toContain(
      'חנוכה · נר 8',
    )
    expect(specialDaysOn('2026-12-04').map((day) => day.name)).toEqual([])
  })

  it('puts Rosh Hashanah where hebcal does', () => {
    expect(roshHashanahDate(5787)).toBe('2026-09-12')
    expect(roshHashanahDate(5788)).toBe('2027-10-02')
    expect(roshHashanahDate(5785)).toBe('2024-10-03')
  })
})

// ── Precedence and bein hazmanim ──────────────────────────────────────────

describe('precedence when several days collide', () => {
  it('shows the festival, not the vacation, on a yom tov inside bein hazmanim', () => {
    // Bein hazmanim Nisan covers 1–22 Nisan, which swallows the whole of
    // Pesach. The headline must be the festival.
    expect(specialDayOn('2026-04-02')!.name).toBe('פסח')
    expect(specialDayOn('2026-04-02')!.kind).toBe('yom_tov')
    expect(specialDayOn('2026-04-05')!.kind).toBe('chol_hamoed')
    expect(specialDayOn('2026-04-01')!.name).toBe('ערב פסח')
    // …but the vacation is still there underneath, which is what staffing
    // needs to know. The legacy could only ever report one of the two.
    expect(isBeinHazmanim('2026-04-02')).toBe(true)
    expect(isBeinHazmanim('2026-04-05')).toBe(true)
    expect(specialDaysOn('2026-04-02').map((day) => day.kind)).toEqual([
      'yom_tov',
      'bein_hazmanim',
    ])
  })

  it('orders every date highest precedence first', () => {
    for (const year of [5786, 5787, 5788]) {
      const from = roshHashanahDate(year)
      const to = roshHashanahDate(year + 1)
      const seen = new Set<string>()
      for (const day of specialDaysBetween(from, to)) {
        if (seen.has(day.date)) continue
        seen.add(day.date)
        const kinds = specialDaysOn(day.date).map((entry) => entry.kind)
        const ranks = kinds.map((kind) =>
          ['bein_hazmanim', 'minor', 'chol_hamoed', 'yom_tov'].indexOf(kind),
        )
        expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
      }
    }
  })

  it('reports a date with nothing on it as null, not as a fabricated day', () => {
    // A plain Tuesday in mid-Cheshvan.
    expect(specialDayOn('2026-11-10')).toBeNull()
    expect(specialDaysOn('2026-11-10')).toEqual([])
    expect(isBeinHazmanim('2026-11-10')).toBe(false)
    expect(isCholHaMoed('2026-11-10')).toBe(false)
    expect(isYomTov('2026-11-10')).toBe(false)
  })
})

describe('bein hazmanim periods', () => {
  it('reports the three legacy periods with their legacy boundaries', () => {
    const periods = beinHazmanimPeriods(5787)
    expect(periods.map((period) => period.name)).toEqual([
      'בין הזמנים ניסן',
      'בין הזמנים אב',
      'בין הזמנים תשרי',
    ])
    expect(toHebrewDate(periods[0].from)).toEqual({
      year: 5787,
      month: HEBREW_MONTH.nisan,
      day: 1,
    })
    expect(toHebrewDate(periods[0].to)).toEqual({
      year: 5787,
      month: HEBREW_MONTH.nisan,
      day: 22,
    })
    expect(toHebrewDate(periods[1].from).day).toBe(10)
    expect(toHebrewDate(periods[1].to)).toEqual({
      year: 5787,
      month: HEBREW_MONTH.av,
      day: 30,
    })
    expect(toHebrewDate(periods[2].to)).toEqual({
      year: 5787,
      month: HEBREW_MONTH.tishrei,
      day: 23,
    })
  })

  it('marks every day of each period, and nothing outside it', () => {
    let daysChecked = 0
    for (const year of YEARS) {
      for (const period of beinHazmanimPeriods(year)) {
        for (
          let fixed = isoToFixed(period.from);
          fixed <= isoToFixed(period.to);
          fixed += 1
        ) {
          expect(isBeinHazmanim(fixedToIso(fixed))).toBe(true)
          daysChecked += 1
        }
      }
    }
    // 101 years × three periods of 22, 21 and 23 days.
    expect(daysChecked).toBe(YEARS.length * 66)
    // The day before and after the Nisan period are outside it.
    const nisan = beinHazmanimPeriods(5787)[0]
    expect(isBeinHazmanim(nisan.from)).toBe(true)
    expect(isBeinHazmanim(nisan.to)).toBe(true)
    expect(isBeinHazmanim(toIsoDate({ year: 5787, month: HEBREW_MONTH.adarII, day: 29 }))).toBe(false) // prettier-ignore
    expect(isBeinHazmanim(toIsoDate({ year: 5787, month: HEBREW_MONTH.nisan, day: 23 }))).toBe(false) // prettier-ignore
  })
})

// ── What this table deliberately does not know ────────────────────────────

describe('days the legacy table never contained', () => {
  /**
   * These all appear in hebcal's Israel calendar for 2026 and are absent from
   * the legacy `HOL` table. The port did not add them: each is a product
   * decision with a pricing and staffing consequence, and inventing them
   * during a port would be a silent change of behaviour.
   *
   * If the product wants them, add them deliberately — and delete the
   * corresponding line here.
   */
  const ABSENT: Array<[string, string]> = [
    ['2026-04-14', 'Yom HaShoah'],
    ['2026-05-15', 'Yom Yerushalayim'],
    ['2026-09-25', 'Erev Sukkot'],
    ['2026-05-21', 'Erev Shavuot'],
    ['2026-11-09', 'Sigd'],
    ['2026-05-01', 'Pesach Sheni'],
    ['2027-02-21', 'Purim Katan'],
    ['2026-02-17', 'Family Day'],
  ]

  it.each(ABSENT)('%s (%s) is not in the table', (iso: string) => {
    // Some of these dates do carry a bein hazmanim entry; none carries a
    // named observance.
    const named = specialDaysOn(iso).filter(
      (day) => day.kind !== 'bein_hazmanim',
    )
    expect(named).toEqual([])
  })

  it('has no Rosh Chodesh, Tzom Gedaliah or Asara BeTevet either', () => {
    // 3 Tishrei (Tzom Gedaliah) and 10 Tevet (Asara BeTevet), 5787.
    const gedaliah = toIsoDate({
      year: 5787,
      month: HEBREW_MONTH.tishrei,
      day: 3,
    })
    const asara = toIsoDate({ year: 5787, month: HEBREW_MONTH.tevet, day: 10 })
    expect(
      specialDaysOn(gedaliah).filter((day) => day.kind !== 'bein_hazmanim'),
    ).toEqual([])
    expect(specialDaysOn(asara)).toEqual([])
  })
})

// ── The table works outside the legacy's seven-year window ────────────────

describe('the holiday table is not pinned to the current year', () => {
  it('answers for a Hebrew year decades away in both directions', () => {
    // The legacy built HOL for `new Date().getFullYear() + 3758 … + 3764`
    // and returned nothing outside it. These two are far outside.
    expect(specialDayOn(toIsoDate({ year: 5700, month: HEBREW_MONTH.nisan, day: 15 }))!.name).toBe('פסח') // prettier-ignore
    expect(specialDayOn(toIsoDate({ year: 5850, month: HEBREW_MONTH.nisan, day: 15 }))!.name).toBe('פסח') // prettier-ignore
  })

  it('lists the Hebrew years a civil range touches', () => {
    // A civil year always straddles two Hebrew years, because Rosh Hashanah
    // falls in September or October.
    expect(hebrewYearsSpanning('2026-01-01', '2026-12-31')).toEqual([
      5786, 5787,
    ])
    expect(hebrewYearsSpanning('2026-01-01', '2026-01-31')).toEqual([5786])
    expect(hebrewYearsSpanning('2026-09-12', '2026-09-12')).toEqual([5787])
    expect(hebrewYearsSpanning('2024-01-01', '2028-12-31')).toEqual([
      5784, 5785, 5786, 5787, 5788, 5789,
    ])
  })

  it('produces the same number of entries for every year of a century', () => {
    // A year's table is a fixed shape: only the fasts and Independence Day
    // move, and none of them changes how many entries there are.
    const counts = new Set(
      YEARS.map((year) => hebrewYearSpecialDays(year).length),
    )
    expect(counts.size).toBe(1)
  })
})
