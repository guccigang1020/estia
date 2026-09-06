/**
 * Approval, held to the two things it must not get wrong.
 *
 * The record has to name both actors — Autopilot prepared it, a person released
 * it — and pressing the button twice has to send one message. The second is
 * proved twice over: once through the state check, and once through the ledger
 * claim that catches two presses which genuinely race past it.
 */

import { describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../../audit/pipeline'
import type { PlannedAction } from '../types'

import { approveAction } from './approval'
import {
  InMemoryAutopilotLedger,
  dispatchAction,
  type ExecutionDeps,
} from './dispatch'
import { createCommandRegistry, type CommandHandler } from './registry'
import { InMemoryAutopilotActionRepository } from './repository'

const ORG = 'org-estia'
const DANA = { userId: 'user-dana', label: 'דנה' }

function planned(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    organizationId: ORG,
    propertyId: 'property-1',
    kind: 'laundry.draft_order',
    safetyLevel: 'safe_internal',
    disposition: 'ask_approval',
    runMode: 'live',
    confidence: 'medium',
    reason: 'המכבסה מאחרת והכביסה לא תספיק להגעה של 15:00',
    triggerEvent: null,
    evidence: [],
    command: 'laundry.draftOrder',
    commandInput: {},
    idempotencyKey: 'evt-5::laundry.draft_order',
    correlationId: 'corr-1',
    exceptionDedupeKey: null,
    scheduledFor: null,
    ...overrides,
  }
}

function harness(handler?: CommandHandler) {
  const repository = new InMemoryAutopilotActionRepository()
  const ledger = new InMemoryAutopilotLedger()
  const audit = new InMemoryAuditWriter()
  const state = { calls: 0 }

  const deps: ExecutionDeps = {
    repository,
    ledger,
    audit,
    registry: createCommandRegistry({
      'laundry.draftOrder': async (invocation) => {
        state.calls += 1
        return handler ? handler(invocation) : { ok: true }
      },
    }),
    now: () => new Date('2026-09-06T06:00:00.000Z'),
    correlationId: 'run-1',
    sleep: async () => undefined,
  }

  return { deps, repository, ledger, audit, state }
}

describe('approval', () => {
  it('runs the prepared action and names both actors', async () => {
    const test = harness()
    const prepared = await dispatchAction(planned(), test.deps)

    expect(prepared.outcome).toEqual({ status: 'awaiting_approval' })
    expect(test.state.calls).toBe(0)

    const result = await approveAction({
      organizationId: ORG,
      actionId: prepared.action.id,
      approver: DANA,
      deps: test.deps,
    })

    expect(result.status).toBe('approved')
    if (result.status !== 'approved') return

    expect(result.report.outcome.status).toBe('executed')
    expect(test.state.calls).toBe(1)

    const row = result.report.action
    // `autopilot_actions_approved_pair`: both halves, or neither.
    expect(row.approvedBy).toBe('user-dana')
    expect(row.approvedAt).not.toBeNull()

    const record = test.audit.records[0]
    expect(record.actorType).toBe('system')
    expect(record.actorLabel).toBe('אוטופיילוט')
    expect(record.onBehalfOfUserId).toBe('user-dana')
    expect(record.summary).toContain('הוכן על ידי אוטופיילוט ואושר על ידי דנה')
  })

  it('refuses a second press without running anything', async () => {
    const test = harness()
    const prepared = await dispatchAction(planned(), test.deps)

    await approveAction({
      organizationId: ORG,
      actionId: prepared.action.id,
      approver: DANA,
      deps: test.deps,
    })
    const second = await approveAction({
      organizationId: ORG,
      actionId: prepared.action.id,
      approver: DANA,
      deps: test.deps,
    })

    expect(second).toMatchObject({
      status: 'refused',
      reason: 'not_awaiting_approval',
    })
    expect(test.state.calls).toBe(1)
  })

  it('sends one message when two presses race', async () => {
    const test = harness()
    const prepared = await dispatchAction(planned(), test.deps)

    const [first, second] = await Promise.all([
      approveAction({
        organizationId: ORG,
        actionId: prepared.action.id,
        approver: DANA,
        deps: test.deps,
      }),
      approveAction({
        organizationId: ORG,
        actionId: prepared.action.id,
        approver: DANA,
        deps: test.deps,
      }),
    ])

    // Whichever ordering the two took, the work happened once — the loser is
    // either refused by the state check or caught by the ledger claim.
    expect(test.state.calls).toBe(1)
    const outcomes = [first, second].map((result) =>
      result.status === 'approved' ? result.report.outcome.status : 'refused',
    )
    expect(outcomes.filter((status) => status === 'executed')).toHaveLength(1)
  })

  it('refuses to approve a simulated action', async () => {
    const test = harness()
    const prepared = await dispatchAction(
      planned({ runMode: 'simulation' }),
      test.deps,
    )

    const result = await approveAction({
      organizationId: ORG,
      actionId: prepared.action.id,
      approver: DANA,
      deps: test.deps,
    })

    // The schema would refuse an `approved` simulation row; the refusal is here
    // so the person gets a sentence rather than a constraint violation.
    expect(result).toMatchObject({ status: 'refused', reason: 'simulation' })
    expect(test.state.calls).toBe(0)
  })

  it('refuses an action that is not there', async () => {
    const test = harness()

    const result = await approveAction({
      organizationId: ORG,
      actionId: 'nope',
      approver: DANA,
      deps: test.deps,
    })

    expect(result).toMatchObject({ status: 'refused', reason: 'not_found' })
  })
})
