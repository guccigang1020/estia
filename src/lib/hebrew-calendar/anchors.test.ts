/**
 * Known-correct dates, from sources outside this codebase.
 *
 * The round-trip and invariant tests prove the calendar is *self-consistent*;
 * a systematically shifted calendar would pass every one of them. These
 * anchors prove it is aligned with reality. Every one is sourced, and the
 * source is named in the test so a future reader can re-check it rather than
 * trusting a number in a file.
 *
 * ## Where the anchors come from
 *
 * **Historical record.** Two dates whose Gregorian and Hebrew forms are both
 * matters of public record, independent of any calendar software:
 *
 *  - 14 May 1948 = 5 Iyar 5708, the Israeli Declaration of Independence. The
 *    Hebrew date is written into the declaration itself and is why Yom
 *    HaAtzmaut is kept on 5 Iyar.
 *  - 6 October 1973 = 10 Tishrei 5734, the outbreak of the Yom Kippur War —
 *    named for the day it began on.
 *
 * **hebcal.com's date converter**, queried on 2026-08-27. Hebcal is the
 * long-standing reference implementation used across Jewish-calendar software
 * and by synagogues and publishers; it is an entirely separate lineage from
 * both this code and ICU. Each anchor below records the exact query. Several
 * were chosen to sit on the awkward cases — a 30-day Cheshvan, a 30-day
 * Kislev, Adar I in a leap year, the last day before Rosh Hashanah — rather
 * than on comfortable mid-month dates.
 *
 * Two of those queries are *negative* results, which are as informative as the
 * positive ones: Hebcal rejected `5786 Cheshvan 30` and `5789 Adar I 30` as
 * non-existent dates, and this module must reject them too.
 *
 * Nothing here is asserted that could not be checked. No anchor was invented,
 * and none is carried with a caveat.
 */

import { describe, expect, it } from 'vitest'

import {
  daysInHebrewMonth,
  isHebrewLeapYear,
  toHebrewDate,
  toIsoDate,
} from './arithmetic'
import { dayOfWeek } from './gregorian'
import { formatHebrewDate } from './format'
import { HEBREW_MONTH } from './types'
import type { HebrewMonth } from './types'

interface Anchor {
  iso: string
  year: number
  month: HebrewMonth
  day: number
  /** Where this correspondence came from, and why this date was picked. */
  source: string
}

const ANCHORS: Anchor[] = [
  {
    iso: '1948-05-14',
    year: 5708,
    month: HEBREW_MONTH.iyar,
    day: 5,
    source:
      'Historical record: the Israeli Declaration of Independence is dated ' +
      '5 Iyar 5708 / 14 May 1948 in its own text.',
  },
  {
    iso: '1973-10-06',
    year: 5734,
    month: HEBREW_MONTH.tishrei,
    day: 10,
    source:
      'Historical record: the Yom Kippur War began on Yom Kippur, ' +
      '10 Tishrei 5734 / 6 October 1973.',
  },
  {
    iso: '1990-01-01',
    year: 5750,
    month: HEBREW_MONTH.tevet,
    day: 4,
    source: 'hebcal.com converter, gy=1990 gm=1 gd=1 — start of the era the product cares about.', // prettier-ignore
  },
  {
    iso: '2000-01-01',
    year: 5760,
    month: HEBREW_MONTH.tevet,
    day: 23,
    source:
      'hebcal.com converter, gy=2000 gm=1 gd=1 — a round Gregorian century.',
  },
  {
    iso: '2024-10-03',
    year: 5785,
    month: HEBREW_MONTH.tishrei,
    day: 1,
    source:
      'hebcal.com converter, gy=2024 gm=10 gd=3 — Rosh Hashanah 5785, ' +
      'pinning the start of a year rather than a day inside one.',
  },
  {
    iso: '2024-12-01',
    year: 5785,
    month: HEBREW_MONTH.cheshvan,
    day: 30,
    source:
      'hebcal.com converter, hy=5785 hm=Cheshvan hd=30 — a 30-day Cheshvan, ' +
      'which only exists in a complete year.',
  },
  {
    iso: '2025-12-20',
    year: 5786,
    month: HEBREW_MONTH.kislev,
    day: 30,
    source:
      'hebcal.com converter, hy=5786 hm=Kislev hd=30 — a 30-day Kislev, ' +
      'in a year whose Cheshvan has only 29.',
  },
  {
    iso: '2026-03-03',
    year: 5786,
    month: HEBREW_MONTH.adar,
    day: 14,
    source:
      'hebcal.com converter, hy=5786 hm=Adar hd=14 — Purim in a common year, ' +
      'where there is only one Adar.',
  },
  {
    iso: '2026-04-02',
    year: 5786,
    month: HEBREW_MONTH.nisan,
    day: 15,
    source: 'hebcal.com converter, hy=5786 hm=Nisan hd=15 — first day of Pesach.', // prettier-ignore
  },
  {
    iso: '2026-09-11',
    year: 5786,
    month: HEBREW_MONTH.elul,
    day: 29,
    source:
      'hebcal.com converter, hy=5786 hm=Elul hd=29 — the last day of a ' +
      'Hebrew year, the hardest place to be off by one.',
  },
  {
    iso: '2027-03-09',
    year: 5787,
    month: HEBREW_MONTH.adar,
    day: 30,
    source:
      'hebcal.com converter, hy=5787 hm=Adar1 hd=30 — Adar I in a leap year, ' +
      'the month that does not exist in a common one.',
  },
  {
    iso: '2027-03-23',
    year: 5787,
    month: HEBREW_MONTH.adarII,
    day: 14,
    source:
      'hebcal.com converter, hy=5787 hm=Adar2 hd=14 — Purim in a leap year, ' +
      'which falls in the second Adar, not the first.',
  },
  {
    iso: '2027-11-30',
    year: 5788,
    month: HEBREW_MONTH.cheshvan,
    day: 30,
    source:
      'hebcal.com converter, hy=5788 hm=Cheshvan hd=30 — a second complete ' +
      'year, so the 30-day Cheshvan is not a one-off coincidence.',
  },
  {
    iso: '2050-06-15',
    year: 5810,
    month: HEBREW_MONTH.sivan,
    day: 25,
    source:
      'hebcal.com converter, gy=2050 gm=6 gd=15 — well beyond the seven-year ' +
      'window the legacy holiday table could see.',
  },
]

describe('anchor dates from outside this codebase', () => {
  it.each(ANCHORS)(
    '$iso is $day/$month/$year — $source',
    ({ iso, year, month, day }) => {
      expect(toHebrewDate(iso)).toEqual({ year, month, day })
      expect(toIsoDate({ year, month, day })).toBe(iso)
    },
  )

  it('checks fourteen anchors, not a handful', () => {
    expect(ANCHORS).toHaveLength(14)
    expect(ANCHORS.every((anchor) => anchor.source.length > 0)).toBe(true)
  })
})

describe('anchors that pin the weekday as well as the date', () => {
  it('puts Yom Kippur 5734 on a Shabbat, as the historical record does', () => {
    // 6 October 1973 was a Saturday; the surprise of the attack is inseparable
    // from its having been both Yom Kippur and Shabbat.
    expect(dayOfWeek('1973-10-06')).toBe(6)
  })

  it('puts the Declaration of Independence on a Friday afternoon', () => {
    // It was signed hours before Shabbat came in, which is why the ceremony
    // was held at 4pm.
    expect(dayOfWeek('1948-05-14')).toBe(5)
  })
})

describe('negative anchors — dates hebcal.com rejects as non-existent', () => {
  it('has no 30 Cheshvan in 5786, matching hebcal returning HTTP 400', () => {
    // hebcal.com converter, hy=5786 hm=Cheshvan hd=30 → 400 Bad Request.
    expect(daysInHebrewMonth(5786, HEBREW_MONTH.cheshvan)).toBe(29)
    expect(() =>
      toIsoDate({ year: 5786, month: HEBREW_MONTH.cheshvan, day: 30 }),
    ).toThrow(/out of range/)
  })

  it('has no Adar I in 5789, matching hebcal returning HTTP 400', () => {
    // hebcal.com converter, hy=5789 hm=Adar1 hd=30 → 400 Bad Request,
    // because 5789 is a common year and has only one Adar.
    expect(isHebrewLeapYear(5789)).toBe(false)
    expect(() =>
      toIsoDate({ year: 5789, month: HEBREW_MONTH.adarII, day: 1 }),
    ).toThrow(/not a leap year/)
  })
})

describe('anchor dates rendered in Hebrew', () => {
  it('matches the Hebrew strings hebcal.com returned for the same days', () => {
    // hebcal returns `heDateParts` with vowel points and a `ב` prefix on the
    // month; the comparison is on the consonantal letters, which is what this
    // module renders and what a guest sees on a booking confirmation.
    // hebcal: א׳ בְּתִשְׁרֵי תשפ״ה
    expect(formatHebrewDate('2024-10-03')).toBe('א׳ תשרי תשפ״ה')
    expect(formatHebrewDate('2024-10-03', { monthPrefix: true })).toBe(
      'א׳ בתשרי תשפ״ה',
    )
    // hebcal: י״ד בַּאֲדָר ב׳ תשפ״ז
    expect(formatHebrewDate('2027-03-23')).toBe('י״ד אדר ב׳ תשפ״ז')
    // hebcal: כ״ג בְּטֵבֵת תש״ס
    expect(formatHebrewDate('2000-01-01')).toBe('כ״ג טבת תש״ס')
    // hebcal: ד׳ בְּטֵבֵת תש״נ
    expect(formatHebrewDate('1990-01-01')).toBe('ד׳ טבת תש״נ')
    // hebcal: כ״ה בְּסִיוָן תת״י
    expect(formatHebrewDate('2050-06-15')).toBe('כ״ה סיון תת״י')
  })
})
