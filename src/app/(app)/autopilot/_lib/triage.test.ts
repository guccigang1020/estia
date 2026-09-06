/**
 * The five sections, and the one property that keeps them honest.
 *
 * The claim worth writing down: the buckets PARTITION the input. Every
 * exception and every action lands in exactly one, and nothing is dropped —
 * because a screen that silently discards a row somebody wrote a detector for
 * is the failure that is invisible until it matters.
 */

import { describe, expect, it } from 'vitest'

import type { ActionView, ExceptionView } from '@/components/autopilot/views'
import {
  AUTOPILOT_ACTION_OUTCOMES,
  AUTOPILOT_DOMAINS,
  AUTOPILOT_EXCEPTION_STATES,
  AUTOPILOT_RISK_STATES,
  type AutopilotActionOutcome,
  type AutopilotDomain,
  type AutopilotExceptionState,
  type AutopilotRiskState,
} from '@/lib/contracts/states'

import { needsAttention, triage } from './triage'

function exception(
  id: string,
  domain: AutopilotDomain,
  risk: AutopilotRiskState,
  state: AutopilotExceptionState,
): ExceptionView {
  return {
    id,
    code: 'a.b',
    domain,
    risk,
    state,
    title: id,
    detail: '',
    resourceType: 'booking',
    resourceId: null,
    propertyId: null,
    propertyName: null,
    evidence: [],
    causedBy: null,
    dueAt: null,
    warnAt: null,
    criticalAt: null,
    ownerUserId: null,
    ownerName: null,
    firstSeenAt: '2026-09-06T06:00:00Z',
    lastSeenAt: '2026-09-06T06:00:00Z',
    seenCount: 1,
  }
}

function action(id: string, outcome: AutopilotActionOutcome): ActionView {
  return {
    id,
    kind: 'guest.send_reminder',
    kindLabel: 'תזכורת לאורח',
    inCatalogue: true,
    safetyLevel: 'external_communication',
    disposition: 'ask_approval',
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

describe('the buckets partition the input', () => {
  it('places every combination of domain, risk and state exactly once', () => {
    const rows: ExceptionView[] = []
    let n = 0
    for (const domain of AUTOPILOT_DOMAINS) {
      for (const risk of AUTOPILOT_RISK_STATES) {
        for (const state of AUTOPILOT_EXCEPTION_STATES) {
          rows.push(exception(`e${n++}`, domain, risk, state))
        }
      }
    }

    const board = triage(rows, [])
    const placed = [
      ...board.atRisk,
      ...board.inProgressExceptions,
      ...board.opportunities,
      ...board.watching,
    ].map((row) => row.id)

    expect(placed).toHaveLength(rows.length)
    expect(new Set(placed).size).toBe(rows.length)
  })

  it('places every outcome in the vocabulary exactly once', () => {
    const actions = AUTOPILOT_ACTION_OUTCOMES.map((outcome, index) =>
      action(`a${index}`, outcome),
    )

    const board = triage([], actions)
    const placed = [
      ...board.decisions,
      ...board.inProgressActions,
      ...board.handled,
    ].map((row) => row.id)

    expect(placed).toHaveLength(actions.length)
    expect(new Set(placed).size).toBe(actions.length)
  })
})

describe('the order of the rules', () => {
  it('files an at-risk opportunity under opportunities, not under risk', () => {
    const board = triage(
      [exception('e', 'sales_opportunity', 'at_risk', 'new')],
      [],
    )
    expect(board.opportunities.map((r) => r.id)).toEqual(['e'])
    expect(board.atRisk).toEqual([])
  })

  it('files anything in progress under in progress, whatever its domain', () => {
    const board = triage(
      [exception('e', 'optimization', 'critical', 'in_progress')],
      [],
    )
    expect(board.inProgressExceptions.map((r) => r.id)).toEqual(['e'])
    expect(board.opportunities).toEqual([])
  })

  it('watches an open, on-track, non-opportunity exception rather than alarming', () => {
    const board = triage([exception('e', 'preparation', 'on_track', 'new')], [])
    expect(board.watching.map((r) => r.id)).toEqual(['e'])
    expect(board.atRisk).toEqual([])
  })

  it('does not treat a resolved critical exception as at risk', () => {
    const board = triage([exception('e', 'safety', 'critical', 'resolved')], [])
    expect(board.atRisk).toEqual([])
    expect(board.watching.map((r) => r.id)).toEqual(['e'])
  })
})

describe('actions', () => {
  it('only awaiting_approval needs a decision', () => {
    const board = triage(
      [],
      [
        action('a', 'awaiting_approval'),
        action('b', 'approved'),
        action('c', 'planned'),
      ],
    )
    expect(board.decisions.map((r) => r.id)).toEqual(['a'])
    expect(board.inProgressActions.map((r) => r.id)).toEqual(['b', 'c'])
  })

  it('counts a suppression as handled, because a refusal is the system working', () => {
    const board = triage([], [action('a', 'suppressed')])
    expect(board.handled.map((r) => r.id)).toEqual(['a'])
  })

  it('counts a simulation as handled and never as a decision', () => {
    const board = triage([], [action('a', 'simulated')])
    expect(board.handled).toHaveLength(1)
    expect(board.decisions).toEqual([])
  })
})

describe('needsAttention', () => {
  it('is false for a day where ESTIA did fourteen things and none needs anybody', () => {
    const board = triage(
      [exception('e', 'preparation', 'ready', 'new')],
      Array.from({ length: 14 }, (_, i) => action(`a${i}`, 'executed')),
    )
    expect(needsAttention(board)).toBe(false)
  })

  it('is true for one prepared action waiting on a person', () => {
    expect(needsAttention(triage([], [action('a', 'awaiting_approval')]))).toBe(
      true,
    )
  })

  it('is true for one open opportunity', () => {
    expect(
      needsAttention(
        triage([exception('e', 'sales_opportunity', 'ready', 'new')], []),
      ),
    ).toBe(true)
  })

  it('is false for nothing at all', () => {
    expect(needsAttention(triage([], []))).toBe(false)
  })
})
