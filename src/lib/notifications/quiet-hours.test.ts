import { describe, expect, it } from 'vitest'

import {
  describeQuietHours,
  localMinutes,
  minutesOfDay,
  quietHoursVerdict,
  withinWindow,
} from './quiet-hours'
import { settings } from './testing'

describe('the clock', () => {
  it('reads HH:MM', () => {
    expect(minutesOfDay('00:00')).toBe(0)
    expect(minutesOfDay('07:00')).toBe(420)
    expect(minutesOfDay('22:30')).toBe(1350)
    expect(minutesOfDay('23:59')).toBe(1439)
  })

  it('refuses what is not a time', () => {
    expect(minutesOfDay('')).toBe(-1)
    expect(minutesOfDay('25:00')).toBe(-1)
    expect(minutesOfDay('22:60')).toBe(-1)
    expect(minutesOfDay('evening')).toBe(-1)
  })

  it('renders midnight as 0 rather than 1440', () => {
    // `hourCycle: 'h24'` would render midnight as 24:00 and make this 1440 —
    // an off-by-a-whole-day at the one moment quiet hours are most likely to
    // be tested.
    const midnightInJerusalem = new Date('2026-03-10T22:00:00.000Z')
    expect(localMinutes(midnightInJerusalem, 'Asia/Jerusalem')).toBe(0)
  })

  it('answers in the zone it is given, not the machine s', () => {
    const instant = new Date('2026-03-11T10:00:00.000Z')
    expect(localMinutes(instant, 'UTC')).toBe(600)
    expect(localMinutes(instant, 'Asia/Jerusalem')).toBe(720)
  })
})

describe('a window that wraps midnight', () => {
  const start = minutesOfDay('22:00')
  const end = minutesOfDay('07:00')

  it('contains the hours on both sides of midnight', () => {
    expect(withinWindow(minutesOfDay('23:40'), start, end)).toBe(true)
    expect(withinWindow(minutesOfDay('02:00'), start, end)).toBe(true)
    expect(withinWindow(minutesOfDay('06:59'), start, end)).toBe(true)
  })

  it('excludes the working day', () => {
    expect(withinWindow(minutesOfDay('07:00'), start, end)).toBe(false)
    expect(withinWindow(minutesOfDay('12:00'), start, end)).toBe(false)
    expect(withinWindow(minutesOfDay('21:59'), start, end)).toBe(false)
  })

  it('treats an equal start and end as no window at all', () => {
    expect(withinWindow(600, 600, 600)).toBe(false)
  })
})

describe('the verdict', () => {
  const midnight = new Date('2026-03-10T22:40:00.000Z') // 00:40 Jerusalem
  const morning = new Date('2026-03-11T08:00:00.000Z') // 10:00 Jerusalem

  it('never holds the in-app channel', () => {
    // In-app is pull. Finding what happened overnight at eight in the morning
    // is the point of the channel, not an interruption.
    expect(
      quietHoursVerdict({
        channel: 'in_app',
        severity: 'info',
        settings: settings(),
        now: midnight,
      }),
    ).toEqual({ held: false })
  })

  it('holds a push channel inside the window and says when it may go', () => {
    const verdict = quietHoursVerdict({
      channel: 'sms',
      severity: 'attention',
      settings: settings(),
      now: midnight,
    })

    expect(verdict.held).toBe(true)
    if (!verdict.held) throw new Error('unreachable')

    // 00:40 to 07:00 is 380 minutes.
    expect(verdict.until.getTime() - midnight.getTime()).toBe(380 * 60_000)
  })

  it('does not hold outside the window', () => {
    expect(
      quietHoursVerdict({
        channel: 'sms',
        severity: 'info',
        settings: settings(),
        now: morning,
      }),
    ).toEqual({ held: false })
  })

  it('lets urgent through when the business allows it', () => {
    expect(
      quietHoursVerdict({
        channel: 'sms',
        severity: 'urgent',
        settings: settings(),
        now: midnight,
      }).held,
    ).toBe(false)

    expect(
      quietHoursVerdict({
        channel: 'sms',
        severity: 'critical',
        settings: settings(),
        now: midnight,
      }).held,
    ).toBe(false)
  })

  it('holds even urgent when the business asked for silence', () => {
    expect(
      quietHoursVerdict({
        channel: 'sms',
        severity: 'critical',
        settings: settings({ urgentOverridesQuietHours: false }),
        now: midnight,
      }).held,
    ).toBe(true)
  })

  it('sends everything when quiet hours are off', () => {
    expect(
      quietHoursVerdict({
        channel: 'sms',
        severity: 'info',
        settings: settings({ quietHoursEnabled: false }),
        now: midnight,
      }),
    ).toEqual({ held: false })
  })

  it('fails towards silence on an unparseable window', () => {
    // The message is written either way and the in-app channel is unaffected,
    // so being wrong in this direction costs a delay and being wrong in the
    // other costs a telephone call at three in the morning.
    const verdict = quietHoursVerdict({
      channel: 'sms',
      severity: 'attention',
      settings: settings({ quietHoursStart: 'evening' }),
      now: morning,
    })

    expect(verdict.held).toBe(true)
  })
})

describe('describing the window', () => {
  it('says nothing when there is nothing to say', () => {
    expect(
      describeQuietHours(settings({ quietHoursEnabled: false })),
    ).toBeNull()
  })

  it('reads back what a person typed', () => {
    expect(describeQuietHours(settings())).toBe('22:00–07:00')
  })
})
