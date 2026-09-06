/**
 * The exception centre's filter and its joining of prepared actions.
 *
 * Two small claims with real consequences: a query parameter never reaches the
 * database as text, and an action with no exception is not attached to a
 * random one.
 */

import { describe, expect, it } from 'vitest'

import type { ActionView } from '@/components/autopilot/views'
import { AUTOPILOT_EXCEPTION_STATES } from '@/lib/contracts/states'

import { OPEN_EXCEPTION_STATES } from '../../_lib/reads'
import { actionsByException, parseStateFilter, statesFor } from './queries'

function action(id: string, exceptionId: string | null): ActionView {
  return {
    id,
    kind: 'task.create',
    kindLabel: 'פתיחת משימה',
    inCatalogue: true,
    safetyLevel: 'safe_internal',
    disposition: 'ask_approval',
    runMode: 'live',
    outcome: 'awaiting_approval',
    confidence: 'medium',
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
    exceptionId,
  }
}

describe('the state filter', () => {
  it('defaults to open', () => {
    expect(parseStateFilter(null)).toBe('open')
    expect(parseStateFilter('opne')).toBe('open')
  })

  it('accepts all', () => {
    expect(parseStateFilter('all')).toBe('all')
  })

  it('maps open onto the three states somebody still has in front of them', () => {
    expect(statesFor('open')).toEqual(OPEN_EXCEPTION_STATES)
    expect(statesFor('open')).not.toContain('resolved')
    expect(statesFor('open')).not.toContain('dismissed')
  })

  it('maps all onto the whole vocabulary', () => {
    expect(statesFor('all')).toEqual(AUTOPILOT_EXCEPTION_STATES)
  })
})

describe('actionsByException', () => {
  it('groups actions under the exception they name', () => {
    const grouped = actionsByException([
      action('a1', 'e1'),
      action('a2', 'e1'),
      action('a3', 'e2'),
    ])
    expect(grouped.get('e1')?.map((a) => a.id)).toEqual(['a1', 'a2'])
    expect(grouped.get('e2')?.map((a) => a.id)).toEqual(['a3'])
  })

  it('drops an action that names no exception rather than guessing', () => {
    const grouped = actionsByException([action('a1', null)])
    expect(grouped.size).toBe(0)
  })

  it('is empty for a reader who could not read the actions at all', () => {
    expect(actionsByException([]).size).toBe(0)
  })
})
