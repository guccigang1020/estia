/**
 * The estimate, and the two ways it could quietly become a lie.
 *
 *   1. Counting a SIMULATED action as time saved. Simulation is the rollout
 *      path, a customer has a fortnight of nothing but simulated rows, and
 *      counting them would produce a triumphant figure for a system that did
 *      not do anything.
 *   2. Counting a SUPPRESSED action as time saved. A refusal is ESTIA working
 *      correctly and it is not ESTIA doing somebody's job.
 *
 * Both are asserted below, and so is the arithmetic itself — because the whole
 * defence of showing this number at all is that a manager can reproduce it.
 */

import { describe, expect, it } from 'vitest'

import type { ActionView } from '@/components/autopilot/views'
import type { AutopilotActionOutcome } from '@/lib/contracts/states'

import {
  estimateTimeSaved,
  formatMinutes,
  minutesFor,
  MINUTES_BY_SAFETY,
  MINUTES_PER_KIND,
} from './estimate'

function action(
  kind: string,
  outcome: AutopilotActionOutcome,
  safety: ActionView['safetyLevel'] = 'external_communication',
): ActionView {
  return {
    id: `${kind}-${outcome}-${Math.random()}`,
    kind,
    kindLabel: kind,
    inCatalogue: true,
    safetyLevel: safety,
    disposition: 'auto',
    runMode: 'live',
    outcome,
    confidence: 'high',
    reason: '',
    triggerEvent: null,
    evidence: [],
    command: null,
    suppressedReason: null,
    suppressedText: null,
    errorCode: null,
    errorDetail: null,
    attempt: 1,
    approvedAt: null,
    approvedByName: null,
    requestedByName: null,
    scheduledFor: null,
    executedAt: null,
    undoneAt: null,
    createdAt: '2026-09-06T06:00:00Z',
    propertyId: null,
    propertyName: null,
    exceptionId: null,
  }
}

describe('what is counted', () => {
  it('counts executed work', () => {
    const estimate = estimateTimeSaved([
      action('guest.send_reminder', 'executed'),
      action('guest.send_reminder', 'executed'),
    ])
    expect(estimate.countedActions).toBe(2)
    expect(estimate.totalMinutes).toBe(8)
  })

  it('counts executed_unaudited, because the work happened', () => {
    const estimate = estimateTimeSaved([
      action('guest.send_reminder', 'executed_unaudited'),
    ])
    expect(estimate.countedActions).toBe(1)
  })

  it('counts no simulated action as time saved', () => {
    const estimate = estimateTimeSaved([
      action('guest.send_reminder', 'simulated'),
      action('guest.send_reminder', 'simulated'),
    ])
    expect(estimate.countedActions).toBe(0)
    expect(estimate.totalMinutes).toBe(0)
    expect(estimate.lines).toEqual([])
  })

  it('counts no suppressed action as time saved', () => {
    expect(
      estimateTimeSaved([action('guest.send_reminder', 'suppressed')])
        .totalMinutes,
    ).toBe(0)
  })

  it('counts no failed, planned or awaiting action', () => {
    const estimate = estimateTimeSaved([
      action('guest.send_reminder', 'failed'),
      action('guest.send_reminder', 'planned'),
      action('guest.send_reminder', 'awaiting_approval'),
      action('guest.send_reminder', 'cancelled'),
    ])
    expect(estimate.countedActions).toBe(0)
  })
})

describe('the arithmetic is reproducible', () => {
  it('shows count times coefficient per kind', () => {
    const estimate = estimateTimeSaved([
      action('guest.send_reminder', 'executed'),
      action('guest.send_reminder', 'executed'),
      action('guest.send_reminder', 'executed'),
      action('task.create', 'executed', 'safe_internal'),
    ])

    const reminder = estimate.lines.find(
      (line) => line.kind === 'guest.send_reminder',
    )
    expect(reminder).toEqual({
      kind: 'guest.send_reminder',
      label: 'guest.send_reminder',
      count: 3,
      minutesEach: 4,
      minutes: 12,
    })

    // The total is exactly the sum of the printed lines. Nothing is added
    // that the reader cannot see.
    expect(estimate.totalMinutes).toBe(
      estimate.lines.reduce((sum, line) => sum + line.minutes, 0),
    )
  })

  it('orders the lines largest first', () => {
    const estimate = estimateTimeSaved([
      action('task.create', 'executed', 'safe_internal'),
      action('brief.compose', 'executed', 'information'),
    ])
    expect(estimate.lines[0].kind).toBe('brief.compose')
  })
})

describe('minutesFor', () => {
  it('uses the declared coefficient where there is one', () => {
    expect(minutesFor('brief.compose')).toBe(MINUTES_PER_KIND['brief.compose'])
  })

  it('falls back to the safety class for a kind with no coefficient', () => {
    expect(minutesFor('booking.cancel')).toBe(
      MINUTES_BY_SAFETY.money_access_cancellation,
    )
  })

  it('does not throw on a kind the catalogue no longer carries', () => {
    expect(minutesFor('ghost.action')).toBe(MINUTES_BY_SAFETY.information)
  })
})

describe('formatMinutes', () => {
  it('says minutes below an hour', () => {
    expect(formatMinutes(45)).toBe('45 דקות')
  })

  it('says whole hours without a stray zero', () => {
    expect(formatMinutes(120)).toBe('2 שעות')
  })

  it('says hours and minutes', () => {
    expect(formatMinutes(135)).toBe('2 שעות ו־15 דקות')
  })

  it('says zero honestly', () => {
    expect(formatMinutes(0)).toBe('0 דקות')
  })
})
