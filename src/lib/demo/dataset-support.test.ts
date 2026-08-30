/**
 * The two mechanisms the dataset stands on: derived identifiers, and dates
 * that move with the calendar.
 *
 * Both are the kind of thing that looks obviously right and is quietly wrong.
 * An id that is *nearly* a uuid passes every eye and is rejected by Postgres;
 * a date helper that adds twenty-four hours instead of a day is correct for
 * three hundred and sixty-three days a year and wrong on the two the clocks
 * change — in Israel, in the middle of the high season.
 */

import { describe, expect, it } from 'vitest'

import {
  TODAY,
  dateRange,
  day,
  demoUuid,
  idsFor,
  moment,
  momentOn,
  nights,
  share,
} from './dataset-support'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('identifiers', () => {
  it('are real uuids, version and variant included', () => {
    expect(demoUuid(1, 1)).toMatch(UUID)
    expect(demoUuid(35, 9999)).toMatch(UUID)
  })

  it('are the same on every call, which is what foreign keys need', () => {
    expect(demoUuid(14, 7)).toBe(demoUuid(14, 7))
  })

  it('never collide across tables or indices', () => {
    const seen = new Set<string>()
    for (let group = 1; group <= 40; group += 1) {
      for (let index = 1; index <= 200; index += 1) {
        seen.add(demoUuid(group, index))
      }
    }
    expect(seen.size).toBe(40 * 200)
  })

  it('binds to one table through `idsFor`', () => {
    const bookings = idsFor(14)
    expect(bookings(7)).toBe(demoUuid(14, 7))
  })
})

describe('dates', () => {
  it('resolves today in Jerusalem, not in UTC', () => {
    const expected = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())

    expect(TODAY).toBe(expected)
  })

  it('counts days, not twenty-four-hour blocks', () => {
    // Across the March clock change and the October one, in whichever
    // direction today happens to sit relative to them.
    for (const offset of [-200, -1, 0, 1, 200]) {
      expect(day(offset)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(nights(day(offset), day(offset + 1))).toBe(1)
    }
  })

  it('is symmetric: forward then back is where it started', () => {
    expect(day(0)).toBe(TODAY)
    expect(nights(day(-45), day(0))).toBe(45)
    expect(nights(day(0), day(60))).toBe(60)
  })

  it('writes a timestamp with the offset that actually applied', () => {
    const stamp = moment('2026-07-15', '14:30')
    // Israel Daylight Time in July.
    expect(stamp).toBe('2026-07-15T14:30:00+03:00')

    const winter = moment('2026-01-15', '14:30')
    expect(winter).toBe('2026-01-15T14:30:00+02:00')
  })

  it('parses back to the instant it claims to be', () => {
    const stamp = moment('2026-07-15', '14:30')
    expect(new Date(stamp).toISOString()).toBe('2026-07-15T11:30:00.000Z')
  })

  it('anchors `momentOn` to the same today', () => {
    expect(momentOn(0, '09:00').startsWith(`${TODAY}T09:00:00`)).toBe(true)
  })

  it('renders a half-open range the way PostgREST does', () => {
    expect(dateRange('2026-08-01', '2026-08-04')).toBe(
      '[2026-08-01,2026-08-04)',
    )
  })
})

describe('money', () => {
  it('takes a percentage in whole agorot', () => {
    expect(share(100_000, 30)).toBe(30_000)
    // Rounded, not truncated: a third of ₪1,150 is 38,333.33 agorot, and the
    // agora that vanishes in a truncation is the agora an invoice fails on.
    expect(share(115_000, 33)).toBe(37_950)
    expect(share(9_999, 50)).toBe(5_000)
  })
})
