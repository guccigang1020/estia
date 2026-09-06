/**
 * The failure queue, held to what it must never do.
 *
 * The load-bearing test is the money one: a failed refund, a failed
 * cancellation and a failed access code are never tried again on their own,
 * whatever the error said, and they end in `needs_review` rather than in
 * silence. Everything else here is about the boundary — the ceiling, the
 * permanent failure, the attempt cap — and about the promise that nothing is
 * ever dropped.
 */

import { describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../../audit/pipeline'
import type { PlannedAction } from '../types'

import {
  InMemoryAutopilotLedger,
  type ExecutionDeps,
  type ExecutionReport,
} from './dispatch'
import { createCommandRegistry } from './registry'
import {
  InMemoryAutopilotActionRepository,
  type AutopilotActionRow,
} from './repository'
import {
  AUTO_RETRY_CEILING,
  decideRetry,
  retryAction,
  retryRefusalLabel,
  runRetryQueue,
} from './retry'

const ORG = 'org-estia'
const NOW = new Date('2026-09-06T06:00:00.000Z')

function planned(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    organizationId: ORG,
    propertyId: 'property-1',
    kind: 'laundry.draft_order',
    safetyLevel: 'safe_internal',
    disposition: 'auto',
    runMode: 'live',
    confidence: 'high',
    reason: 'המכבסה מאחרת',
    triggerEvent: null,
    evidence: [],
    command: 'laundry.draftOrder',
    commandInput: {},
    idempotencyKey: 'evt-1::laundry.draft_order',
    correlationId: 'corr-1',
    exceptionDedupeKey: null,
    scheduledFor: null,
    ...overrides,
  }
}

function harness() {
  const repository = new InMemoryAutopilotActionRepository()
  const ledger = new InMemoryAutopilotLedger()
  const audit = new InMemoryAuditWriter()
  const state = { calls: 0, fail: false }

  const deps: ExecutionDeps = {
    repository,
    ledger,
    audit,
    registry: createCommandRegistry({
      'laundry.draftOrder': async () => {
        state.calls += 1
        if (state.fail) throw new Error('still down')
        return { ok: true }
      },
      'payments.refund': async () => {
        state.calls += 1
        return { refunded: true }
      },
      'inventory.transfer': async () => {
        state.calls += 1
        return { moved: true }
      },
    }),
    now: () => NOW,
    correlationId: 'run-1',
    retry: { maxAttempts: 1, backoffMs: 0 },
    sleep: async () => undefined,
  }

  return { deps, repository, ledger, audit, state }
}

/** A row that has already failed once, without going through dispatch. */
async function failedRow(
  repository: InMemoryAutopilotActionRepository,
  overrides: Partial<PlannedAction>,
  failure: { code: string; retryable: boolean } = {
    code: 'timeout',
    retryable: true,
  },
  attempt = 1,
): Promise<AutopilotActionRow> {
  const { record } = await repository.insert({
    planned: planned(overrides),
    outcome: 'planned',
    createdAt: NOW,
  })

  return repository.update(record, {
    outcome: 'failed',
    errorCode: failure.code,
    errorDetail: 'it did not work',
    attempt,
    result: { failure },
  })
}

/* ---------------------------------------------------------- the decision -- */

describe('decideRetry', () => {
  it('never retries money, access or cancellation', async () => {
    const test = harness()
    const row = await failedRow(test.repository, {
      kind: 'payment.refund',
      safetyLevel: 'money_access_cancellation',
      command: 'payments.refund',
    })

    expect(decideRetry(row)).toMatchObject({
      retry: false,
      reason: 'money_access_cancellation',
    })
  })

  it('never retries a business-impact action', async () => {
    const test = harness()
    const row = await failedRow(test.repository, {
      kind: 'inventory.suggest_transfer',
      safetyLevel: 'business_impact',
      command: 'inventory.transfer',
    })

    expect(decideRetry(row)).toMatchObject({
      retry: false,
      reason: 'safety_level_too_high',
    })
  })

  it('retries up to the stated ceiling', async () => {
    const test = harness()
    const row = await failedRow(test.repository, {
      kind: 'guest.send_reminder',
      safetyLevel: AUTO_RETRY_CEILING,
      command: 'messaging.sendGuestMessage',
    })

    expect(decideRetry(row)).toEqual({ retry: true })
  })

  it('does not retry a permanent failure', async () => {
    const test = harness()
    const row = await failedRow(
      test.repository,
      {},
      {
        code: 'validation_failed',
        retryable: false,
      },
    )

    expect(decideRetry(row)).toMatchObject({
      retry: false,
      reason: 'permanent_failure',
    })
  })

  it('stops at the attempt cap', async () => {
    const test = harness()
    const row = await failedRow(
      test.repository,
      {},
      { code: 'timeout', retryable: true },
      3,
    )

    expect(decideRetry(row, { limit: 3 })).toMatchObject({
      retry: false,
      reason: 'attempts_exhausted',
    })
  })

  it('does not retry something that did not fail', async () => {
    const test = harness()
    const { record } = await test.repository.insert({
      planned: planned(),
      outcome: 'awaiting_approval',
      createdAt: NOW,
    })

    expect(decideRetry(record)).toMatchObject({
      retry: false,
      reason: 'not_failed',
    })
  })

  it('does not retry something a person undid', async () => {
    const test = harness()
    const row = await failedRow(test.repository, {})
    const undone = await test.repository.update(row, {
      undoneAt: NOW,
      undoneBy: 'user-dana',
    })

    expect(decideRetry(undone)).toMatchObject({
      retry: false,
      reason: 'undone',
    })
  })
})

/* ------------------------------------------------------------- the doing -- */

describe('retryAction', () => {
  it('hands a money failure to a person instead of running it', async () => {
    const test = harness()
    const row = await failedRow(test.repository, {
      kind: 'payment.refund',
      safetyLevel: 'money_access_cancellation',
      command: 'payments.refund',
    })

    const result = await retryAction(row, test.deps)

    expect(result.status).toBe('needs_review')
    if (result.status !== 'needs_review') return

    expect(result.reason).toBe('money_access_cancellation')
    expect(result.action.outcome).toBe('needs_review')
    // Nothing was refunded a second time.
    expect(test.state.calls).toBe(0)
    // And the failure it started from is still readable on the row.
    expect(result.action.errorCode).toBe('timeout')
  })

  it('runs a safe failure again and counts the attempt', async () => {
    const test = harness()
    const row = await failedRow(test.repository, {})

    const result = await retryAction(row, test.deps)

    expect(result.status).toBe('retried')
    if (result.status !== 'retried') return

    expect(result.report.outcome.status).toBe('executed')
    expect(result.report.action.attempt).toBe(2)
    expect(test.state.calls).toBe(1)
  })

  it('gives up into needs_review rather than into nothing', async () => {
    const test = harness()
    test.state.fail = true
    const row = await failedRow(test.repository, {})

    // Attempt two fails as well, and the third pass is over the cap.
    const second = await retryAction(row, test.deps, { limit: 2 })
    expect(second.status).toBe('retried')
    if (second.status !== 'retried') return

    const third = await retryAction(second.report.action, test.deps, {
      limit: 2,
    })

    expect(third.status).toBe('needs_review')
    if (third.status !== 'needs_review') return
    expect(third.reason).toBe('attempts_exhausted')
    // Nothing is ever silently dropped: the row is still there, and it is in
    // the one state whose meaning is "somebody has to look at this".
    expect(test.repository.rows[0].outcome).toBe('needs_review')
  })
})

/* -------------------------------------------------------------- the pass -- */

describe('runRetryQueue', () => {
  it('leaves nothing in failed and reports on every row', async () => {
    const test = harness()

    await failedRow(test.repository, { idempotencyKey: 'k-safe' })
    await failedRow(test.repository, {
      idempotencyKey: 'k-money',
      kind: 'payment.refund',
      safetyLevel: 'money_access_cancellation',
      command: 'payments.refund',
    })

    const results = await runRetryQueue(ORG, test.deps)

    expect(results).toHaveLength(2)
    expect(
      test.repository.rows.filter((row) => row.outcome === 'failed'),
    ).toHaveLength(0)

    const executed = results.filter(
      (result): result is { status: 'retried'; report: ExecutionReport } =>
        result.status === 'retried',
    )
    expect(executed).toHaveLength(1)
  })
})

describe('labels', () => {
  it('names every refusal in Hebrew', () => {
    expect(retryRefusalLabel('money_access_cancellation')).toBe(
      'כסף, גישה או ביטול',
    )
    expect(retryRefusalLabel('attempts_exhausted')).toBe('מיצוי ניסיונות')
  })
})
