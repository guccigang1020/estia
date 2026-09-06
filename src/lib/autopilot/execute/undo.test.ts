/**
 * Undo, held to the promise that it never lies.
 *
 * The test that matters most is the refusal: a sent message cannot be unsent,
 * so `planUndo` returns an explicit "not reversible" with a sentence, and there
 * is no path by which a screen could render a button over it. The reversible
 * side is proved too — the reversal goes through a command like everything
 * else, both halves of `undone_*` move together, and a person is named in the
 * audit trail, because a person did it.
 */

import { describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../../audit/pipeline'
import type { PlannedAction } from '../types'

import { InMemoryAutopilotLedger, type ExecutionDeps } from './dispatch'
import {
  createCommandRegistry,
  type CommandRegistry,
  type CommandResolution,
} from './registry'
import {
  InMemoryAutopilotActionRepository,
  type AutopilotActionRow,
} from './repository'
import { REVERSALS, planUndo, undoAction } from './undo'

const ORG = 'org-estia'
const NOW = new Date('2026-09-06T06:00:00.000Z')
const DANA = { userId: 'user-dana', label: 'דנה' }

function planned(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    organizationId: ORG,
    propertyId: 'property-1',
    kind: 'task.assign',
    safetyLevel: 'safe_internal',
    disposition: 'auto',
    runMode: 'live',
    confidence: 'high',
    reason: 'המנקה המקורי לא הגיע',
    triggerEvent: null,
    evidence: [],
    command: 'tasks.assignTask',
    commandInput: { taskId: 'task-1', previousAssigneeId: 'user-avi' },
    idempotencyKey: 'evt-1::task.assign',
    correlationId: 'corr-1',
    exceptionDedupeKey: null,
    scheduledFor: null,
    ...overrides,
  }
}

interface Harness {
  deps: ExecutionDeps
  repository: InMemoryAutopilotActionRepository
  audit: InMemoryAuditWriter
  state: { calls: number; lastInput: Readonly<Record<string, unknown>> }
}

/**
 * A registry that resolves the reversing command.
 *
 * Written by hand rather than through `createCommandRegistry`, because the
 * production registry correctly refuses `tasks.assignTask` today — no such
 * operation exists. This is what the module will do the week one does.
 */
function harness(options: { reversalWired?: boolean } = {}): Harness {
  const repository = new InMemoryAutopilotActionRepository()
  const audit = new InMemoryAuditWriter()
  const state = {
    calls: 0,
    lastInput: {} as Readonly<Record<string, unknown>>,
  }

  const wired: CommandRegistry = {
    resolve(command): CommandResolution {
      if (command !== 'tasks.assignTask') {
        return { status: 'unavailable', detail: `${command} לא חובר.` }
      }
      return {
        status: 'available',
        operation: 'tasks.assign',
        run: async (invocation) => {
          state.calls += 1
          state.lastInput = invocation.action.commandInput
          return { assigned: true }
        },
      }
    },
  }

  return {
    repository,
    audit,
    state,
    deps: {
      repository,
      audit,
      ledger: new InMemoryAutopilotLedger(),
      registry: options.reversalWired ? wired : createCommandRegistry(),
      now: () => NOW,
      correlationId: 'run-1',
    },
  }
}

async function executedRow(
  repository: InMemoryAutopilotActionRepository,
  overrides: Partial<PlannedAction> = {},
  result: Readonly<Record<string, unknown>> = {},
): Promise<AutopilotActionRow> {
  const { record } = await repository.insert({
    planned: planned(overrides),
    outcome: 'planned',
    createdAt: NOW,
  })
  return repository.update(record, {
    outcome: 'executed',
    executedAt: NOW,
    result,
  })
}

/* ------------------------------------------------------------ refusals --- */

describe('planUndo', () => {
  it('refuses an external action, because a sent message is sent', async () => {
    const test = harness({ reversalWired: true })
    const row = await executedRow(test.repository, {
      kind: 'guest.send_reminder',
      safetyLevel: 'external_communication',
      command: 'messaging.sendGuestMessage',
    })

    const plan = planUndo(row, test.deps.registry)

    expect(plan.reversible).toBe(false)
    if (plan.reversible) return
    expect(plan.reason).toBe('external_action')
    expect(plan.explanation).toContain('הודעה שנשלחה נשלחה')
  })

  it('refuses money and cancellation for the same reason', async () => {
    const test = harness({ reversalWired: true })
    const row = await executedRow(test.repository, {
      kind: 'booking.cancel',
      safetyLevel: 'money_access_cancellation',
      command: 'bookings.cancelBooking',
    })

    expect(planUndo(row, test.deps.registry)).toMatchObject({
      reversible: false,
      reason: 'external_action',
    })
  })

  it('refuses an action that never executed', async () => {
    const test = harness({ reversalWired: true })
    const { record } = await test.repository.insert({
      planned: planned(),
      outcome: 'awaiting_approval',
      createdAt: NOW,
    })

    expect(planUndo(record, test.deps.registry)).toMatchObject({
      reversible: false,
      reason: 'not_executed',
    })
  })

  it('refuses an internal action with no reversal defined', async () => {
    const test = harness({ reversalWired: true })
    const row = await executedRow(test.repository, {
      kind: 'hold.release_expired',
      safetyLevel: 'safe_internal',
      command: 'holds.releaseExpired',
    })

    // Releasing an expired hold is internal and is deliberately not reversible:
    // the dates may already have been sold.
    expect(REVERSALS['hold.release_expired']).toBeUndefined()
    expect(planUndo(row, test.deps.registry)).toMatchObject({
      reversible: false,
      reason: 'no_reversal',
    })
  })

  it('refuses when the row does not carry the old value', async () => {
    const test = harness({ reversalWired: true })
    const row = await executedRow(test.repository, {
      commandInput: { taskId: 'task-1' },
    })

    const plan = planUndo(row, test.deps.registry)
    expect(plan).toMatchObject({ reversible: false, reason: 'no_reversal' })
    if (plan.reversible) return
    expect(plan.explanation).toContain('המשויך הקודם')
  })

  it('refuses when the reversing command is not implemented', async () => {
    const test = harness()
    const row = await executedRow(test.repository)

    expect(planUndo(row, test.deps.registry)).toMatchObject({
      reversible: false,
      reason: 'command_unavailable',
    })
  })

  it('offers a reversal when there genuinely is one', async () => {
    const test = harness({ reversalWired: true })
    const row = await executedRow(test.repository)

    const plan = planUndo(row, test.deps.registry)

    expect(plan.reversible).toBe(true)
    if (!plan.reversible) return
    expect(plan.command).toBe('tasks.assignTask')
    expect(plan.input).toEqual({ taskId: 'task-1', assigneeId: 'user-avi' })
  })
})

/* -------------------------------------------------------------- doing --- */

describe('undoAction', () => {
  it('refuses an external action without touching anything', async () => {
    const test = harness({ reversalWired: true })
    const row = await executedRow(test.repository, {
      kind: 'guest.send_reminder',
      safetyLevel: 'external_communication',
      command: 'messaging.sendGuestMessage',
    })

    const result = await undoAction(row, test.deps, DANA)

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'external_action',
    })
    expect(test.state.calls).toBe(0)
    expect(test.repository.rows[0].undoneAt).toBeNull()
    expect(test.audit.records).toHaveLength(0)
  })

  it('reverses through a command and names the person who did it', async () => {
    const test = harness({ reversalWired: true })
    const row = await executedRow(test.repository)

    const result = await undoAction(row, test.deps, DANA)

    expect(result.status).toBe('undone')
    if (result.status !== 'undone') return

    expect(test.state.calls).toBe(1)
    expect(test.state.lastInput).toEqual({
      taskId: 'task-1',
      assigneeId: 'user-avi',
    })

    // `autopilot_actions_undone_pair`: both halves, or neither. And the action
    // keeps its outcome — the log is not editable by the party who would most
    // like it gone.
    expect(result.action.undoneBy).toBe('user-dana')
    expect(result.action.undoneAt).toEqual(NOW)
    expect(result.action.outcome).toBe('executed')

    const record = test.audit.records[0]
    expect(record.actorType).toBe('user')
    expect(record.actorUserId).toBe('user-dana')
    expect(record.summary).toContain('דנה ביטלה פעולה של אוטופיילוט')
  })

  it('reverses once when the button is pressed twice', async () => {
    const test = harness({ reversalWired: true })
    const row = await executedRow(test.repository)

    const first = await undoAction(row, test.deps, DANA)
    expect(first.status).toBe('undone')

    // The row now carries `undone_at`, and the claim on the undo key is held.
    const second = await undoAction(test.repository.rows[0], test.deps, DANA)

    expect(second).toMatchObject({
      status: 'refused',
      reason: 'already_undone',
    })
    expect(test.state.calls).toBe(1)
  })
})
