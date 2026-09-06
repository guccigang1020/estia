/**
 * The report, and the one number in it that is not a measurement.
 *
 * The assertion that matters is that the estimate cannot be rendered as a bare
 * figure. "ESTIA saved you 47 hours" is the most quotable line this product
 * will produce and it will end up on a slide; if the type allows a naked
 * number, somebody will use one, and then it is a measurement claim the
 * business cannot support.
 */

import { describe, expect, it } from 'vitest'

import { AUTOPILOT_ACTION_KINDS } from '../actions'

import {
  MINUTES_PER_ACTION,
  REMINDER_KINDS,
  TimeSavedEstimate,
  buildValueReport,
  formatMinutes,
} from './value'

const WINDOW = { from: '2026-08-01', to: '2026-08-31' }

function report() {
  return buildValueReport({
    window: WINDOW,
    executed: {
      'task.create': 40,
      'task.assign': 30,
      'guest.send_reminder': 22,
      'inventory.flag_shortage': 6,
      'laundry.draft_order': 9,
      'agent.remind': 4,
    },
    issuesPrevented: 7,
    bookingIdsProtected: ['booking-1', 'booking-2', 'booking-1'],
  })
}

describe('the counts', () => {
  it('adds up every executed action', () => {
    expect(report().actionsAutomated).toBe(40 + 30 + 22 + 6 + 9 + 4)
  })

  it('counts reminders from the named list, not from the safety level', () => {
    expect(report().remindersSent).toBe(22 + 4)
    expect(REMINDER_KINDS).not.toContain('guest.send_arrival_info')
  })

  it('counts shortages from the action that flags them', () => {
    expect(report().shortagesDetected).toBe(6)
  })

  it('counts internal work as tasks avoided and nothing twice', () => {
    // task.create, task.assign, laundry.draft_order and the shortage flag are
    // safe_internal; the two reminders are not, and are counted as reminders.
    expect(report().manualTasksAvoided).toBe(40 + 30 + 9 + 6)
  })

  it('deduplicates the bookings a prevented issue touched', () => {
    expect(report().bookingsProtected).toBe(2)
  })

  it('carries the counts it was given rather than deriving them', () => {
    expect(report().issuesPrevented).toBe(7)
  })
})

describe('the time estimate', () => {
  it('has no bare minutes property to render', () => {
    const { timeSaved } = report()

    expect('minutes' in timeSaved).toBe(false)
    expect(Object.keys(timeSaved)).toEqual(['method', 'formatted'])
  })

  it('says it is an estimate in every form a screen could show', () => {
    const { timeSaved } = report()

    expect(timeSaved.formatted).toContain('הערכה')
    expect(String(timeSaved)).toContain('הערכה')
    expect(`${timeSaved}`).toContain('הערכה')
  })

  it('fails loudly rather than quietly becoming a number', () => {
    // No valueOf, deliberately: arithmetic on an estimate should break where
    // it is written and not produce a confident figure three screens later.
    expect(Number(report().timeSaved)).toBeNaN()
  })

  it('cannot be produced without its method', () => {
    const { timeSaved } = report()

    expect(timeSaved.method.qualifier).toBe('הערכה')
    expect(timeSaved.method.disclaimer.length).toBeGreaterThan(0)
    expect(timeSaved.method.table.length).toBeGreaterThan(0)
    expect(timeSaved.method.totalMinutes).toBeGreaterThan(0)
  })

  it('cannot be constructed outside the module that explains it', () => {
    // @ts-expect-error the constructor is private, so nothing can fabricate an
    // estimate with an empty method and a confident number.
    const forged = new TimeSavedEstimate({}, '47 שעות')
    expect(forged).toBeDefined()
  })

  it('shows the arithmetic behind the figure, line by line', () => {
    const { timeSaved } = report()
    const line = timeSaved.method.table.find(
      (one) => one.kind === 'task.create',
    )

    expect(line?.count).toBe(40)
    expect(line?.minutesEach).toBe(MINUTES_PER_ACTION['task.create'])
    expect(line?.minutes).toBe(40 * MINUTES_PER_ACTION['task.create'])

    const summed = timeSaved.method.table.reduce(
      (total, one) => total + one.minutes,
      0,
    )
    expect(summed).toBe(timeSaved.method.totalMinutes)
  })

  it('lists nothing that did not happen', () => {
    const kinds = report().timeSaved.method.table.map((one) => one.kind)
    expect(kinds).not.toContain('payment.refund')
  })

  it('still carries a method when nothing ran', () => {
    const empty = buildValueReport({
      window: WINDOW,
      executed: {},
      issuesPrevented: 0,
      bookingIdsProtected: [],
    })

    expect(empty.timeSaved.method.totalMinutes).toBe(0)
    expect(empty.timeSaved.formatted).toContain('הערכה')
  })
})

describe('the minutes table', () => {
  it('prices every action in the catalogue, so none is silently free', () => {
    for (const kind of AUTOPILOT_ACTION_KINDS) {
      expect(MINUTES_PER_ACTION[kind]).toBeGreaterThan(0)
    }
  })
})

describe('formatting', () => {
  it('reads as a person would say the duration', () => {
    expect(formatMinutes(45)).toBe('45 דקות')
    expect(formatMinutes(120)).toBe('2 שעות')
    expect(formatMinutes(140)).toBe('2 שעות ו-20 דקות')
  })
})
