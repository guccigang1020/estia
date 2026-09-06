import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../booking/dates'

import {
  gradeDeadline,
  gradeExpectation,
  gradeInstant,
  gradeRelativeExpectation,
  localTime,
  minutesBetween,
  zonedInstant,
  type Deadline,
} from './deadlines'

describe('zonedInstant', () => {
  it('reads a wall clock as the property reads it, not as UTC', () => {
    // Israel is UTC+3 in September. 15:00 local is 12:00Z, and a naive slice
    // would have made it 15:00Z — three hours of margin that do not exist.
    const at = zonedInstant('2026-09-12', '15:00', PROPERTY_TIME_ZONE)
    expect(at.toISOString()).toBe('2026-09-12T12:00:00.000Z')
  })

  it('follows the clocks through the winter change', () => {
    // Israel is UTC+2 in January.
    const at = zonedInstant('2026-01-12', '15:00', PROPERTY_TIME_ZONE)
    expect(at.toISOString()).toBe('2026-01-12T13:00:00.000Z')
  })

  it('round-trips through localTime', () => {
    const at = zonedInstant('2026-09-12', '13:42', PROPERTY_TIME_ZONE)
    expect(localTime(at, PROPERTY_TIME_ZONE)).toBe('13:42')
  })

  it('refuses a date that is not a date, rather than rolling it forward', () => {
    expect(() => zonedInstant('12/09/2026', '15:00')).toThrow(RangeError)
    expect(() => zonedInstant('2026-09-12', '25:00')).toThrow(RangeError)
    expect(() => zonedInstant('2026-09-12', '3:00')).toThrow(RangeError)
  })
})

describe('minutesBetween', () => {
  it('goes negative once the moment has passed', () => {
    const earlier = new Date('2026-09-12T12:00:00.000Z')
    const later = new Date('2026-09-12T13:00:00.000Z')
    expect(minutesBetween(earlier, later)).toBe(60)
    expect(minutesBetween(later, earlier)).toBe(-60)
  })
})

describe('gradeInstant', () => {
  const target = new Date('2026-09-12T12:00:00.000Z')

  it('is on track with the warning still ahead', () => {
    const verdict = gradeInstant(
      target,
      120,
      30,
      new Date('2026-09-12T09:00:00.000Z'),
    )
    expect(verdict.state).toBe('on_track')
    expect(verdict.minutesRemaining).toBe(180)
    expect(verdict.overdue).toBe(false)
  })

  it('is at risk inside the warning window', () => {
    expect(
      gradeInstant(target, 120, 30, new Date('2026-09-12T10:30:00.000Z')).state,
    ).toBe('at_risk')
  })

  it('is critical inside the critical window', () => {
    expect(
      gradeInstant(target, 120, 30, new Date('2026-09-12T11:45:00.000Z')).state,
    ).toBe('critical')
  })

  it('is critical and overdue past the target', () => {
    const verdict = gradeInstant(
      target,
      120,
      30,
      new Date('2026-09-12T13:00:00.000Z'),
    )
    expect(verdict.state).toBe('critical')
    expect(verdict.overdue).toBe(true)
    expect(verdict.minutesRemaining).toBe(-60)
  })

  it('corrects a policy whose thresholds are the wrong way round', () => {
    // warn 10, critical 120 would go critical first and then relax as the
    // deadline approached, which nobody would believe.
    const verdict = gradeInstant(
      target,
      10,
      120,
      new Date('2026-09-12T10:30:00.000Z'),
    )
    expect(verdict.state).toBe('critical')
    expect(new Date(verdict.warnAt).getTime()).toBeLessThanOrEqual(
      new Date(verdict.criticalAt).getTime(),
    )
  })
})

describe('gradeDeadline', () => {
  const deadline: Deadline = {
    date: '2026-09-12',
    time: '15:00',
    warnMinutesBefore: 120,
    criticalMinutesBefore: 30,
    timeZone: PROPERTY_TIME_ZONE,
  }

  it('grades against the property wall clock', () => {
    // 13:42 local on the day — inside the two-hour warning, outside critical.
    const now = zonedInstant('2026-09-12', '13:42', PROPERTY_TIME_ZONE)
    const verdict = gradeDeadline(deadline, now)
    expect(verdict.state).toBe('at_risk')
    expect(verdict.minutesRemaining).toBe(78)
  })

  it('does not file a late-evening deadline under the wrong day', () => {
    // 23:30 in Israel is 20:30Z — already "tomorrow" on a naive UTC slice.
    const now = zonedInstant('2026-09-12', '23:30', PROPERTY_TIME_ZONE)
    const late = gradeDeadline(
      {
        ...deadline,
        time: '23:45',
        warnMinutesBefore: 60,
        criticalMinutesBefore: 10,
      },
      now,
    )
    expect(late.overdue).toBe(false)
    expect(late.minutesRemaining).toBe(15)
  })
})

describe('gradeExpectation', () => {
  const deadline: Deadline = {
    date: '2026-09-12',
    time: '15:00',
    warnMinutesBefore: 120,
    criticalMinutesBefore: 30,
    timeZone: PROPERTY_TIME_ZONE,
  }
  const now = zonedInstant('2026-09-12', '13:42', PROPERTY_TIME_ZONE)

  it('reports ready only when something says it was done', () => {
    const outstanding = gradeExpectation(
      { key: 'contract', label: 'החוזה נחתם', satisfiedAt: null },
      deadline,
      now,
    )
    expect(outstanding.state).toBe('at_risk')

    const done = gradeExpectation(
      {
        key: 'contract',
        label: 'החוזה נחתם',
        satisfiedAt: '2026-09-10T08:00:00.000Z',
      },
      deadline,
      now,
    )
    expect(done.state).toBe('ready')
  })

  it('carries the whole sentence as evidence', () => {
    const verdict = gradeExpectation(
      { key: 'cleaning', label: 'הניקיון הסתיים', satisfiedAt: null },
      deadline,
      now,
    )
    const byKey = new Map(
      verdict.evidence.map((item) => [item.key, item.value]),
    )
    expect(byKey.get('cleaning.target')).toBe('15:00')
    expect(byKey.get('cleaning.now')).toBe('13:42')
    expect(byKey.get('cleaning.minutes_remaining')).toBe(78)
  })
})

describe('gradeRelativeExpectation', () => {
  it('measures back from the arrival rather than from a wall clock', () => {
    const verdict = gradeRelativeExpectation(
      { key: 'contract_unsigned', label: 'החוזה נחתם', satisfiedAt: null },
      {
        anchorAt: '2026-09-12T12:00:00.000Z',
        hoursBefore: 72,
        warnMinutesBefore: 1440,
        criticalMinutesBefore: 0,
      },
      new Date('2026-09-09T13:00:00.000Z'),
    )
    // Target was 2026-09-09T12:00Z; an hour past it.
    expect(verdict.deadline.targetAt).toBe('2026-09-09T12:00:00.000Z')
    expect(verdict.state).toBe('critical')
    expect(verdict.deadline.overdue).toBe(true)
  })

  it('refuses an anchor that is not an instant', () => {
    expect(() =>
      gradeRelativeExpectation(
        { key: 'x', label: 'x', satisfiedAt: null },
        {
          anchorAt: 'not a date',
          hoursBefore: 1,
          warnMinutesBefore: 1,
          criticalMinutesBefore: 0,
        },
        new Date(),
      ),
    ).toThrow(RangeError)
  })
})
