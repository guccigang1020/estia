/**
 * The executor, held to the promises it makes.
 *
 * Each of the following has at least one test that fails if the promise is
 * removed, rather than a test that merely walks the happy path:
 *
 *   · **one action per event** — the same triggering event delivered twice
 *     produces one row and one command call. The second delivery is recorded
 *     as suppressed/duplicate rather than dropped.
 *   · **simulation touches nothing** — an `auto` action in simulation resolves
 *     no command, claims nothing and records `simulated` carrying the reason
 *     and evidence a live run would have carried.
 *   · **the claim is taken before the work** — asserted from inside the
 *     command, which is the only place the ordering is observable.
 *   · **audit after success** — a failed audit write after a successful
 *     command yields `executed_unaudited`, not `executed` and not `failed`.
 *   · **the claim is released only when a retry could help** — kept for a
 *     permanent failure, handed back for a transient one.
 *   · **a missing command fails cleanly** — `command_not_implemented`, and
 *     nothing silently does nothing.
 */

import { describe, expect, it } from 'vitest'

import {
  FailingAuditWriter,
  InMemoryAuditWriter,
  type AuditWriter,
} from '../../audit/pipeline'
import { AppError } from '../../errors'
import type { PlannedAction } from '../types'

import {
  DEFAULT_DISPATCH_RETRY,
  InMemoryAutopilotLedger,
  dispatchAction,
  failureOf,
  type ExecutionDeps,
} from './dispatch'
import {
  InMemoryAutopilotActionRepository,
  type AutopilotActionRepository,
} from './repository'
import { createCommandRegistry, type CommandHandler } from './registry'

const ORG = 'org-estia'

/* ------------------------------------------------------------- fixtures --- */

/**
 * A safe internal action whose command is one of the six that actually resolve
 * today, so a test about ordering is not silently a test about the registry.
 */
function planned(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    organizationId: ORG,
    propertyId: 'property-1',
    kind: 'laundry.draft_order',
    safetyLevel: 'safe_internal',
    disposition: 'auto',
    runMode: 'live',
    confidence: 'high',
    reason: 'המכבסה מאחרת והכביסה לא תספיק להגעה של 15:00',
    triggerEvent: null,
    evidence: [
      {
        key: 'laundry.delivery_late',
        label: 'אספקה מאחרת',
        value: true,
        source: 'laundry',
      },
    ],
    command: 'laundry.draftOrder',
    commandInput: { propertyId: 'property-1' },
    idempotencyKey: 'evt-77::laundry.draft_order',
    correlationId: 'corr-1',
    exceptionDedupeKey: null,
    scheduledFor: null,
    ...overrides,
  }
}

interface Harness {
  deps: ExecutionDeps
  repository: InMemoryAutopilotActionRepository
  ledger: InMemoryAutopilotLedger
  audit: InMemoryAuditWriter
  calls: number
}

function harness(
  options: {
    handler?: CommandHandler
    audit?: AuditWriter
    command?: string
    repository?: AutopilotActionRepository
  } = {},
): Harness {
  const repository =
    (options.repository as InMemoryAutopilotActionRepository) ??
    new InMemoryAutopilotActionRepository()
  const ledger = new InMemoryAutopilotLedger()
  const audit = new InMemoryAuditWriter()
  const state = { calls: 0 }

  const handler: CommandHandler = async (invocation) => {
    state.calls += 1
    if (options.handler) return options.handler(invocation)
    return { ok: true }
  }

  const harnessed: Harness = {
    repository,
    ledger,
    audit,
    get calls() {
      return state.calls
    },
    deps: {
      repository,
      ledger,
      audit: options.audit ?? audit,
      registry: createCommandRegistry({
        [options.command ?? 'laundry.draftOrder']: handler,
      }),
      now: () => new Date('2026-09-06T06:00:00.000Z'),
      correlationId: 'run-1',
      retry: { maxAttempts: DEFAULT_DISPATCH_RETRY.maxAttempts, backoffMs: 0 },
      sleep: async () => undefined,
    },
  }

  return harnessed
}

/* ------------------------------------------------------- one per event --- */

describe('idempotency', () => {
  it('produces one action and one command call for a double delivery', async () => {
    const test = harness()
    const action = planned()

    const first = await dispatchAction(action, test.deps)
    const second = await dispatchAction(action, test.deps)

    expect(first.outcome.status).toBe('executed')
    expect(second.outcome).toEqual({
      status: 'suppressed',
      reason: 'duplicate',
    })

    // The guarantee, stated three ways: one row, one call, one audit record.
    expect(test.repository.rows).toHaveLength(1)
    expect(test.calls).toBe(1)
    expect(test.audit.records).toHaveLength(1)
  })

  it('claims the key before the command runs, not after', async () => {
    let heldDuringCall: readonly string[] = []

    // Read from inside the handler, which is the only moment at which "claimed
    // before" and "claimed after" are distinguishable from outside.
    const test = harness({
      handler: async () => {
        heldDuringCall = test.ledger.keys
        return {}
      },
    })
    const action = planned()

    await dispatchAction(action, test.deps)

    expect(heldDuringCall).toContain(`${ORG}::${action.idempotencyKey}`)
  })

  it('reports the duplicate rather than silently doing nothing', async () => {
    const test = harness()
    await dispatchAction(planned(), test.deps)
    const second = await dispatchAction(planned(), test.deps)

    // Every refusal names itself. A row with neither a reason nor an error code
    // is forbidden by the schema and by the repository.
    expect(second.outcome).toEqual({
      status: 'suppressed',
      reason: 'duplicate',
    })
  })
})

/* --------------------------------------------------------- simulation --- */

describe('simulation', () => {
  it('performs nothing, claims nothing and records what would have happened', async () => {
    const test = harness()

    const report = await dispatchAction(
      planned({ runMode: 'simulation', disposition: 'auto' }),
      test.deps,
    )

    expect(report.outcome).toEqual({ status: 'simulated' })
    expect(test.calls).toBe(0)
    expect(test.ledger.keys).toHaveLength(0)
    expect(test.audit.records).toHaveLength(0)

    const row = test.repository.rows[0]
    expect(row.outcome).toBe('simulated')
    expect(row.executedAt).toBeNull()
    // The same reason and the same evidence a live run would have carried.
    expect(row.reason).toContain('המכבסה מאחרת')
    expect(row.evidence).toHaveLength(1)
    expect(row.result.wouldHave).toContain('היה מבצע אוטומטית')
  })

  it('beats the disposition: simulation is decided first', async () => {
    const test = harness()

    for (const disposition of ['auto', 'ask_approval', 'suggest'] as const) {
      const report = await dispatchAction(
        planned({
          disposition,
          runMode: 'simulation',
          idempotencyKey: `sim::${disposition}`,
        }),
        test.deps,
      )
      expect(report.outcome).toEqual({ status: 'simulated' })
    }

    expect(test.calls).toBe(0)
  })
})

/* -------------------------------------------------------- dispositions --- */

describe('dispositions', () => {
  it('records a suggestion as planned and runs nothing', async () => {
    const test = harness()

    const report = await dispatchAction(
      planned({ disposition: 'suggest' }),
      test.deps,
    )

    expect(report.outcome).toEqual({ status: 'planned' })
    expect(report.action.outcome).toBe('planned')
    expect(test.calls).toBe(0)
    expect(test.ledger.keys).toHaveLength(0)
  })

  it('records an approval request and runs nothing', async () => {
    const test = harness()

    const report = await dispatchAction(
      planned({ disposition: 'ask_approval' }),
      test.deps,
    )

    expect(report.outcome).toEqual({ status: 'awaiting_approval' })
    expect(report.action.outcome).toBe('awaiting_approval')
    expect(test.calls).toBe(0)
  })

  it('executes an auto action through the command', async () => {
    const test = harness({
      handler: async (invocation) => ({
        orderId: 'order-9',
        reason: invocation.action.reason,
      }),
    })

    const report = await dispatchAction(planned(), test.deps)

    expect(report.outcome.status).toBe('executed')
    expect(report.action.result.orderId).toBe('order-9')
    expect(report.action.executedAt).not.toBeNull()
  })

  it('completes a command-less action inside Autopilot', async () => {
    const test = harness()

    const report = await dispatchAction(
      planned({
        kind: 'exception.raise',
        safetyLevel: 'information',
        command: null,
        commandInput: {},
      }),
      test.deps,
    )

    expect(report.outcome.status).toBe('executed')
    expect(report.action.result).toEqual({
      internal: true,
      kind: 'exception.raise',
    })
    expect(test.calls).toBe(0)
  })
})

/* -------------------------------------------------------------- audit --- */

describe('audit', () => {
  it('records the action as the system, naming the grant that authorised it', async () => {
    const test = harness()

    await dispatchAction(planned(), test.deps)

    const record = test.audit.records[0]
    expect(record.actorType).toBe('system')
    expect(record.actorUserId).toBeNull()
    expect(record.actorLabel).toBe('אוטופיילוט')
    expect(record.action).toBe('laundry.order_create')
    expect(record.resourceType).toBe('autopilot_action')
    expect(record.summary).toContain('המכבסה מאחרת')
    expect(record.requestId).toBe('corr-1')
  })

  it('reports executed_unaudited when the work succeeded and the audit did not', async () => {
    const test = harness({ audit: new FailingAuditWriter() })

    const report = await dispatchAction(planned(), test.deps)

    // Neither `executed` nor `failed`: both would be lies.
    expect(report.outcome.status).toBe('executed_unaudited')
    expect(report.action.outcome).toBe('executed_unaudited')
    expect(report.action.executedAt).not.toBeNull()
    expect(report.action.errorCode).toBe('audit_write_failed')
    // The work happened exactly once, and it is not retried by the failure.
    expect(test.calls).toBe(1)
  })
})

/* ------------------------------------------------------------ failure --- */

describe('failure', () => {
  it('fails cleanly when the command is not implemented', async () => {
    const test = harness({ command: 'nothing.wired' })

    const report = await dispatchAction(
      planned({
        kind: 'guest.send_reminder',
        safetyLevel: 'external_communication',
        command: 'messaging.sendGuestMessage',
      }),
      test.deps,
    )

    expect(report.outcome).toMatchObject({
      status: 'failed',
      code: 'command_not_implemented',
      retryable: false,
    })
    expect(report.action.errorCode).toBe('command_not_implemented')
    expect(report.action.errorDetail).toContain('messaging.sendGuestMessage')
    expect(test.calls).toBe(0)
    // Permanent: the claim is kept, so a redelivery does not reproduce it.
    expect(test.ledger.keys).toHaveLength(1)
  })

  it('keeps the claim for a permanent failure and tries once', async () => {
    const test = harness({
      handler: async () => {
        throw new AppError({
          code: 'validation_failed',
          status: 422,
          message: 'the booking has no dates',
          userMessage: 'חסרים תאריכים.',
          retryable: false,
        })
      },
    })

    const report = await dispatchAction(planned(), test.deps)

    expect(report.outcome).toMatchObject({
      status: 'failed',
      code: 'validation_failed',
      retryable: false,
    })
    expect(test.calls).toBe(1)
    expect(test.ledger.keys).toHaveLength(1)
    expect(failureOf(report.action)).toEqual({
      code: 'validation_failed',
      retryable: false,
    })
  })

  it('releases the claim when every attempt failed for a retryable reason', async () => {
    const test = harness({
      handler: async () => {
        throw new Error('the pooler dropped the connection')
      },
    })

    const report = await dispatchAction(planned(), test.deps)

    expect(report.outcome).toMatchObject({ status: 'failed', retryable: true })
    // The inner loop tried twice, and then handed the key back.
    expect(test.calls).toBe(2)
    expect(test.ledger.keys).toHaveLength(0)
    expect(report.action.attempt).toBe(2)
  })

  it('stops the inner loop the moment a failure is permanent', async () => {
    let seen = 0
    const test = harness({
      handler: async () => {
        seen += 1
        throw new AppError({
          code: 'conflict',
          status: 409,
          message: 'someone else changed it',
          userMessage: 'הרשומה השתנתה.',
          retryable: false,
        })
      },
    })

    await dispatchAction(planned(), test.deps)

    expect(seen).toBe(1)
  })
})
