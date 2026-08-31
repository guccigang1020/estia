/**
 * The window the board covers.
 *
 * Two decisions here are the kind that are wrong in a way no screenshot
 * reveals. Whether the window is half-open — a board whose last day silently
 * vanished is a rota somebody turns up for on the wrong morning. And whether a
 * hand-edited address bar produces an error page, a silently different week,
 * or a week plus a sentence saying the dates were ignored.
 *
 * The look-back is the third: a departure clean that did not finish yesterday
 * is the reason the unit is not ready for today's arrival, and a window that
 * started at today would show the arrival and hide the cause.
 */

import { describe, expect, it } from 'vitest'

import { addDays, localDate } from '@/lib/booking/dates'

import {
  DEFAULT_LOOK_AHEAD,
  DEFAULT_LOOK_BACK,
  defaultHorizon,
  describeHorizon,
  horizonIssue,
  isCustomHorizon,
  parseHorizon,
} from './horizon'

/** A fixed instant in Jerusalem, so nothing here depends on when it runs. */
const NOON = new Date('2026-08-17T12:00:00+03:00')

describe('the default window', () => {
  it('opens on yesterday and runs a week ahead, half-open', () => {
    // The last day named is inside the window and `to` is the day after it,
    // which is the same convention a stay uses. Two consecutive weeks then
    // neither overlap nor leave a gap.
    expect(defaultHorizon(NOON)).toEqual({
      from: '2026-08-16',
      to: '2026-08-25',
    })
  })

  it('derives both ends from the constants rather than from a literal', () => {
    const today = localDate(NOON)
    expect(defaultHorizon(NOON)).toEqual({
      from: addDays(today, -DEFAULT_LOOK_BACK),
      to: addDays(today, DEFAULT_LOOK_AHEAD + 1),
    })
  })

  it('anchors on the property date, not on the server clock', () => {
    // 23:30 on the 16th in Jerusalem is the 20:30 of the 16th in UTC and the
    // 17th nowhere the property is. A board built on UTC would move a whole
    // day of work every evening.
    const lateEvening = new Date('2026-08-16T23:30:00+03:00')
    expect(defaultHorizon(lateEvening).from).toBe('2026-08-15')
  })
})

describe('reading the window out of the URL', () => {
  it('takes a valid explicit window', () => {
    expect(
      parseHorizon({ from: '2026-09-01', to: '2026-09-08' }, NOON),
    ).toEqual({ from: '2026-09-01', to: '2026-09-08' })
  })

  it('falls back rather than querying a window that matches nothing', () => {
    for (const params of [
      { from: '2026-09-08', to: '2026-09-01' },
      { from: '2026-09-01', to: '2026-09-01' },
      { from: 'soon', to: '2026-09-08' },
      { from: '2026-02-30', to: '2026-03-05' },
      { to: '2026-09-08' },
    ]) {
      expect(parseHorizon(params, NOON)).toEqual(defaultHorizon(NOON))
    }
  })

  it('takes the first value when a key is repeated', () => {
    expect(
      parseHorizon(
        { from: ['2026-09-01', '2026-10-01'], to: ['2026-09-08'] },
        NOON,
      ),
    ).toEqual({ from: '2026-09-01', to: '2026-09-08' })
  })
})

describe('knowing whether the person narrowed it themselves', () => {
  it('is false for the default and true for anything else', () => {
    // This is what decides between "you have no work this week" and "your
    // window matched nothing" — the same distinction `empty-presets.ts`
    // exists to protect, one module over.
    expect(isCustomHorizon(defaultHorizon(NOON), NOON)).toBe(false)
    expect(
      isCustomHorizon({ from: '2026-09-01', to: '2026-09-08' }, NOON),
    ).toBe(true)
  })
})

describe('saying that the window was ignored', () => {
  it('says nothing when nothing was asked for, or when it was used', () => {
    expect(horizonIssue({})).toBeNull()
    expect(horizonIssue({ from: '2026-09-01', to: '2026-09-08' })).toBeNull()
  })

  it('names each way it could not be used', () => {
    expect(horizonIssue({ from: '2026-09-01' })).toContain('תאריך סיום')
    expect(horizonIssue({ from: 'soon', to: '2026-09-08' })).toContain(
      'אינו תקין',
    )
    expect(horizonIssue({ from: '2026-09-08', to: '2026-09-01' })).toContain(
      'אינו מאוחר',
    )
  })
})

describe('naming the window', () => {
  it('names the last day inside it, never the exclusive boundary', () => {
    // `to` is 2026-08-25 and the board's last day is the 24th. Showing the
    // 25th would promise a day the board does not contain.
    const label = describeHorizon({ from: '2026-08-16', to: '2026-08-25' })
    expect(label).toContain('16')
    expect(label).toContain('24')
    expect(label).not.toContain('25')
  })
})
