/**
 * Hebrew numerals.
 *
 * The expected strings below are standard gematria and can be checked against
 * any Hebrew calendar or siddur; six of them were confirmed against the Hebrew
 * output of hebcal.com's converter in `anchors.test.ts`. The two that matter
 * most are 15 and 16, which are deliberately *not* written the obvious way.
 */

import { describe, expect, it } from 'vitest'

import { MAX_GEMATRIA, toGematria, toHebrewYearNumeral } from './gematria'

describe('units, tens and hundreds', () => {
  it.each([
    [1, 'א׳'],
    [2, 'ב׳'],
    [5, 'ה׳'],
    [9, 'ט׳'],
    [10, 'י׳'],
    [11, 'י״א'],
    [14, 'י״ד'],
    [17, 'י״ז'],
    [18, 'י״ח'],
    [19, 'י״ט'],
    [20, 'כ׳'],
    [21, 'כ״א'],
    [29, 'כ״ט'],
    [30, 'ל׳'],
    [100, 'ק׳'],
    [101, 'ק״א'],
    [400, 'ת׳'],
    [500, 'ת״ק'],
    [999, 'תתקצ״ט'],
  ])('writes %i as %s', (value, expected) => {
    expect(toGematria(value)).toBe(expected)
  })

  it('marks a single letter with a geresh and several with a gershayim', () => {
    expect(toGematria(7)).toBe('ז׳')
    expect(toGematria(7)).toContain('׳')
    expect(toGematria(27)).toBe('כ״ז')
    expect(toGematria(27)).toContain('״')
  })
})

describe('15 and 16 avoid spelling the Divine Name', () => {
  it('writes 15 as tet-vav, never yud-he', () => {
    expect(toGematria(15)).toBe('ט״ו')
    expect(toGematria(15)).not.toContain('יה')
  })

  it('writes 16 as tet-zayin, never yud-vav', () => {
    expect(toGematria(16)).toBe('ט״ז')
    expect(toGematria(16)).not.toContain('יו')
  })

  it('applies the same rule inside a larger number', () => {
    expect(toGematria(115)).toBe('קט״ו')
    expect(toGematria(216)).toBe('רט״ז')
    expect(toGematria(515)).toBe('תקט״ו')
  })

  it('leaves 115 and 116 as the only exceptions in their decade', () => {
    expect(toGematria(114)).toBe('קי״ד')
    expect(toGematria(117)).toBe('קי״ז')
  })
})

describe('the numerals are unambiguous', () => {
  it('gives all 999 values a distinct string', () => {
    // A collision would mean two different dates rendering identically, which
    // is a silent bug of exactly the kind gematria invites.
    const seen = new Map<string, number>()
    for (let value = 1; value <= MAX_GEMATRIA; value += 1) {
      const rendered = toGematria(value)
      const previous = seen.get(rendered)
      expect(previous, `${rendered} is both ${previous} and ${value}`).toBe(
        undefined,
      )
      seen.set(rendered, value)
    }
    expect(seen.size).toBe(999)
  })

  it('never emits an undefined fragment', () => {
    for (let value = 1; value <= MAX_GEMATRIA; value += 1) {
      expect(toGematria(value)).not.toContain('undefined')
    }
  })
})

describe('the legacy bugs this port fixed', () => {
  it('refuses 0 instead of returning an empty string', () => {
    // Legacy `gem(0)` returned ''. Unreachable for a day of the month, but it
    // would have rendered Hebrew year 6000 with no year at all.
    expect(() => toGematria(0)).toThrow(/expected 1…999/)
  })

  it('refuses numbers above 999 instead of reading off the end of a table', () => {
    // Legacy `gem(1000)` indexed HUNDREDS[10], which is undefined, and
    // produced a string containing the word "undefined".
    expect(() => toGematria(1000)).toThrow(/expected 1…999/)
    expect(() => toGematria(5786)).toThrow(/expected 1…999/)
  })

  it('refuses non-integers and negatives', () => {
    expect(() => toGematria(-1)).toThrow(/expected 1…999/)
    expect(() => toGematria(1.5)).toThrow(/expected 1…999/)
  })
})

describe('Hebrew years', () => {
  it('drops the millennium by default, as Israeli usage does', () => {
    expect(toHebrewYearNumeral(5786)).toBe('תשפ״ו')
    expect(toHebrewYearNumeral(5785)).toBe('תשפ״ה')
    expect(toHebrewYearNumeral(5760)).toBe('תש״ס')
    expect(toHebrewYearNumeral(5750)).toBe('תש״נ')
    expect(toHebrewYearNumeral(5810)).toBe('תת״י')
  })

  it('writes the formal full form on request', () => {
    expect(toHebrewYearNumeral(5786, { includeMillennium: true })).toBe(
      'ה׳תשפ״ו',
    )
    expect(toHebrewYearNumeral(5785, { includeMillennium: true })).toBe(
      'ה׳תשפ״ה',
    )
  })

  it('handles a year that is an exact multiple of a thousand', () => {
    // Legacy `gem(6000 % 1000)` was `gem(0)`, which returned ''. Year 6000 is
    // AD 2239 and far outside any booking, but a calendar that renders a year
    // as the empty string is wrong rather than out of scope.
    expect(toHebrewYearNumeral(6000)).toBe('ו׳')
    expect(toHebrewYearNumeral(6000, { includeMillennium: true })).toBe('ו׳')
  })

  it('handles years before AM 1000, which have no millennium letter', () => {
    expect(toHebrewYearNumeral(999)).toBe('תתקצ״ט')
    expect(toHebrewYearNumeral(999, { includeMillennium: true })).toBe('תתקצ״ט')
  })

  it('refuses year 0 and negatives', () => {
    expect(() => toHebrewYearNumeral(0)).toThrow(/out of range/)
    expect(() => toHebrewYearNumeral(-5786)).toThrow(/out of range/)
  })
})
