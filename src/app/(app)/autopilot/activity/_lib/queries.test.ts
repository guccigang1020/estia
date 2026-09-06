/**
 * The activity log's four views.
 *
 * The claim worth stating: the DEFAULT view carries no outcome filter at all,
 * so it includes the refusals and the simulations. A log that showed only what
 * executed would show an empty screen to the customer most worried about what
 * Autopilot might do — 0046 says so, and it is the reason `suppressed`,
 * `simulated` and `cancelled` are rows in the table rather than absences.
 */

import { describe, expect, it } from 'vitest'

import type { ActionView } from '@/components/autopilot/views'
import type { AutopilotActionOutcome } from '@/lib/contracts/states'
import { AUTOPILOT_ACTION_OUTCOMES } from '@/lib/contracts/states'

import {
  ACTIVITY_VIEWS,
  ACTIVITY_VIEW_LABEL,
  countByOutcome,
  outcomesFor,
  parseView,
} from './queries'

function action(outcome: AutopilotActionOutcome): ActionView {
  return {
    id: `a-${outcome}`,
    kind: 'task.create',
    kindLabel: 'פתיחת משימה',
    inCatalogue: true,
    safetyLevel: 'safe_internal',
    disposition: 'auto',
    runMode: 'live',
    outcome,
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
    exceptionId: null,
  }
}

describe('the views', () => {
  it('defaults to everything, filter and all', () => {
    expect(parseView(null)).toBe('all')
    expect(parseView('nonsense')).toBe('all')
    expect(outcomesFor('all')).toBeUndefined()
  })

  it('names every view', () => {
    for (const view of ACTIVITY_VIEWS) {
      expect(ACTIVITY_VIEW_LABEL[view].length).toBeGreaterThan(0)
    }
  })

  it('treats simulation as an execution, because it is what would have run', () => {
    expect(outcomesFor('executed')).toContain('simulated')
  })

  it('includes executed_unaudited in both executed and attention', () => {
    // It ran and the record failed. It belongs in the list of things that
    // happened AND in the list of things somebody has to look at.
    expect(outcomesFor('executed')).toContain('executed_unaudited')
    expect(outcomesFor('attention')).toContain('executed_unaudited')
  })

  it('puts failures and reviews in the attention view', () => {
    expect(outcomesFor('attention')).toEqual([
      'failed',
      'needs_review',
      'executed_unaudited',
    ])
  })

  it('names only members of the vocabulary', () => {
    for (const view of ACTIVITY_VIEWS) {
      for (const outcome of outcomesFor(view) ?? []) {
        expect(AUTOPILOT_ACTION_OUTCOMES).toContain(outcome)
      }
    }
  })
})

describe('countByOutcome', () => {
  it('reports zero for an outcome nothing is in, rather than omitting it', () => {
    const counts = countByOutcome([action('executed')])
    expect(counts.get('executed')).toBe(1)
    expect(counts.get('suppressed')).toBe(0)
    expect(counts.size).toBe(AUTOPILOT_ACTION_OUTCOMES.length)
  })

  it('counts repeats', () => {
    const counts = countByOutcome([
      action('suppressed'),
      action('suppressed'),
      action('failed'),
    ])
    expect(counts.get('suppressed')).toBe(2)
    expect(counts.get('failed')).toBe(1)
  })
})
