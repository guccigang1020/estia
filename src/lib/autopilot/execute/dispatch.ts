/**
 * The executor.
 *
 * A planned action arrives having already been ruled on by the policy engine.
 * This file makes it happen — through the same domain command a person's click
 * calls — and records everything, including everything that did not happen.
 *
 * Everything is injected: the repository, the command registry, the audit
 * writer, the clock, the idempotency ledger and even the sleep between retries.
 * Every quality claimed below is therefore a statement a test makes rather than
 * one this comment asserts.
 *
 * ── The order, and why it is this order ───────────────────────────────────
 *
 *   1. **Simulation.** Decided before anything else and before any command is
 *      resolved. `autopilot_actions_simulation_never_executes` refuses the row
 *      a simulated execution would produce, and this code does not lean on
 *      that: a constraint is the last line of defence, not the first, and by
 *      the time the database refused the insert the WhatsApp would already have
 *      been sent. The check is here, and it is here again in
 *      `executePreparedAction`, which approval and retry also enter through.
 *   2. **`suggest`.** Recorded as `planned`. Nothing runs; the row IS the
 *      suggestion, and the screen offers it.
 *   3. **`ask_approval`.** Recorded as `awaiting_approval`. Nothing runs.
 *   4. **`auto`.** Claim, then run.
 *
 * ── Idempotency, and where the claim is taken ─────────────────────────────
 *
 * There are two guarantees and they are not redundant.
 *
 * The first is `unique (organization_id, idempotency_key)`. The insert happens
 * before anything is dispatched, so a redelivered webhook is a failed insert
 * rather than a second message to the same guest — and that holds across
 * processes, across restarts and across the two Node instances behind a load
 * balancer that an in-memory set would not. A duplicate delivery is reported as
 * `suppressed` with the reason `duplicate`, which is a first-class success: an
 * action correctly declined is the system working.
 *
 * The second is the ledger claim, taken **before** the command runs and never
 * after. `automation/engine.ts` makes the argument and it is the same one here:
 * claiming afterwards leaves a window in which a second attempt — a retry
 * sweep, an approval pressed twice — starts the same charge. The claim is
 * released when every attempt failed for a reason worth retrying, and
 * deliberately kept when the failure was permanent, because a retry of a
 * validation error is a second identical failure and a third attempt is not.
 *
 * ── Audit is not optional, and a failed audit is not a failed action ──────
 *
 * Every executed action writes an audit record with `actorType: 'system'`, so
 * "Autopilot did this at 03:14" reads differently from "Dana did this" — which
 * is the whole reason `ActorType` has more than one member.
 *
 * If the action succeeded and the audit write then failed, the outcome is
 * `executed_unaudited` rather than `executed` or `failed`. Both alternatives
 * are lies: the work happened, and there is no record of it. That state is rare
 * and it is exactly the state somebody needs to be told about.
 */

import { recordAuditEvent, type AuditWriter } from '../../audit/pipeline'
import type { AutopilotSuppressionReason } from '../../contracts/states'
import { isAppError } from '../../errors'
import type { IdempotencyStore } from '../../service/idempotency'
import { AUTOPILOT_ACTIONS } from '../actions'
import type { ExecutionOutcome, PlannedAction } from '../types'

import {
  plannedFromRow,
  type AutopilotActionRepository,
  type AutopilotActionRow,
} from './repository'
import type { CommandRegistry, CommandResult } from './registry'
import { simulateAction, simulationResult } from './simulate'

/* -------------------------------------------------------------- ledger --- */

/**
 * What is being executed right now, so it is not executed twice.
 *
 * `claim` must be atomic in whatever backs it — an insert on a unique key, not
 * a read followed by a write — or two concurrent attempts will both be told
 * they took it.
 */
export interface AutopilotLedger {
  /** True when this caller took the key; false when it was already held. */
  claim(organizationId: string, key: string): Promise<boolean>
  /** Hand the key back, so a later attempt may try again. */
  release(organizationId: string, key: string): Promise<void>
}

/** Atomic because JavaScript is single-threaded here, and for no other reason. */
export class InMemoryAutopilotLedger implements AutopilotLedger {
  private readonly held = new Set<string>()

  async claim(organizationId: string, key: string): Promise<boolean> {
    const scoped = `${organizationId}::${key}`
    if (this.held.has(scoped)) return false
    this.held.add(scoped)
    return true
  }

  async release(organizationId: string, key: string): Promise<void> {
    this.held.delete(`${organizationId}::${key}`)
  }

  get keys(): readonly string[] {
    return [...this.held]
  }
}

/**
 * The ledger over the idempotency table the service layer already owns.
 *
 * `begin` is a single `insert … on conflict do nothing` in the real store, so
 * the claim is atomic for the same reason every other claim in this codebase
 * is. The reservation is deliberately never completed: a key that stays
 * reserved is a key nobody may claim again, which is exactly what a permanent
 * success and a permanent failure both want. `release` abandons it, and is
 * called only when trying again could plausibly help.
 */
export function idempotencyLedger(store: IdempotencyStore): AutopilotLedger {
  const operation = 'autopilot.execute'

  return {
    async claim(organizationId, key) {
      const begun = await store.begin({ organizationId, operation }, key, key)
      return begun.status === 'reserved'
    },
    async release(organizationId, key) {
      await store.abandon({ organizationId, operation }, key)
    },
  }
}

/* --------------------------------------------------------------- retry --- */

export interface RetryPolicy {
  /** Total tries in one pass, not retries. `1` disables the inner loop. */
  maxAttempts: number
  /** Milliseconds before the next try. Multiplied by the attempt number. */
  backoffMs: number
}

/**
 * Two tries, close together, and then stop.
 *
 * One immediate retry absorbs the blip — a dropped connection, a pooler
 * hiccup — and anything that survives it is a real failure that belongs in the
 * queue in `retry.ts`, where the attempts are bounded, the money-level actions
 * are excluded, and a person can see what is stuck. A long inner loop would
 * hide all of that inside a single row nobody is watching.
 */
export const DEFAULT_DISPATCH_RETRY: RetryPolicy = {
  maxAttempts: 2,
  backoffMs: 200,
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------ outcomes --- */

/**
 * What one dispatch produced.
 *
 * A superset of the frozen `ExecutionOutcome` by exactly one member. A
 * `suggest` action is recorded as `planned` — the schema's own name for it, and
 * the brief's — and none of the six members of `ExecutionOutcome` describes it:
 * it did not run, it was not refused, and nobody is being asked to approve it.
 * Reporting it as any of those would be a lie about what the row says.
 */
export type DispatchOutcome = ExecutionOutcome | { status: 'planned' }

export interface ExecutionReport {
  /** The row. Present for everything except a refusal to even record. */
  action: AutopilotActionRow
  outcome: DispatchOutcome
}

/** Who pressed the button, for an action a person approved. */
export interface ApprovalStamp {
  userId: string
  /** How they are named in the timeline. */
  label: string
}

export interface ExecutionDeps {
  repository: AutopilotActionRepository
  registry: CommandRegistry
  ledger: AutopilotLedger
  audit: AuditWriter
  /** Injected so an execution's record is deterministic in a test. */
  now: () => Date
  /** Ties every audit record produced by one pass together. */
  correlationId: string
  /** Who asked. Null for a scheduled sweep, which is most of them. */
  requestedBy?: string | null
  retry?: RetryPolicy
  /** Injected so a retry test does not take a second of wall clock. */
  sleep?: (ms: number) => Promise<void>
}

/* ------------------------------------------------------------ dispatch --- */

/**
 * The outcome the row is created with.
 *
 * Simulation wins over the disposition, always and first: a business running a
 * fortnight of simulation set `auto` on twenty actions precisely so it could
 * see what they would do, and any path that read the disposition first would be
 * a path that could execute one of them.
 */
function initialOutcome(
  planned: PlannedAction,
): 'simulated' | 'planned' | 'awaiting_approval' {
  if (planned.runMode === 'simulation') return 'simulated'
  if (planned.disposition === 'ask_approval') return 'awaiting_approval'
  return 'planned'
}

export async function dispatchAction(
  planned: PlannedAction,
  deps: ExecutionDeps,
): Promise<ExecutionReport> {
  const outcome = initialOutcome(planned)

  // Composed before the insert so the simulated row carries the same reason
  // and the same evidence a live run would have carried.
  const simulated =
    planned.runMode === 'simulation'
      ? simulateAction(planned, deps.registry)
      : null

  const { record, created } = await deps.repository.insert({
    planned,
    outcome,
    requestedBy: deps.requestedBy ?? null,
    result: simulated === null ? {} : simulationResult(simulated),
    createdAt: deps.now(),
  })

  // The constraint held. This delivery is a redelivery, and the action it would
  // have taken has already been recorded — and possibly already performed.
  if (!created) {
    return {
      action: record,
      outcome: { status: 'suppressed', reason: 'duplicate' },
    }
  }

  if (planned.runMode === 'simulation') {
    return { action: record, outcome: { status: 'simulated' } }
  }
  if (planned.disposition === 'suggest') {
    return { action: record, outcome: { status: 'planned' } }
  }
  if (planned.disposition === 'ask_approval') {
    return { action: record, outcome: { status: 'awaiting_approval' } }
  }

  return executePreparedAction(record, deps)
}

/**
 * Run a recorded action.
 *
 * The one path that performs work, entered by `dispatchAction` for an `auto`
 * action, by `approval.ts` once a person has pressed the button, and by
 * `retry.ts` for a failure worth another try. One path, so there is one place
 * the claim is taken and one place the audit is written.
 */
export async function executePreparedAction(
  row: AutopilotActionRow,
  deps: ExecutionDeps,
  options: { approval?: ApprovalStamp } = {},
): Promise<ExecutionReport> {
  // Defence in depth, and not decoration: this function is reachable from three
  // callers and only one of them has already asked the question.
  if (row.runMode === 'simulation') {
    const updated = await deps.repository.update(row, {
      outcome: 'simulated',
    })
    return { action: updated, outcome: { status: 'simulated' } }
  }

  const claimed = await deps.ledger.claim(
    row.organizationId,
    row.idempotencyKey,
  )
  if (!claimed) {
    return suppress(row, deps, 'duplicate')
  }

  // An action with no command completes inside Autopilot — raising an
  // exception, composing a brief, flagging a shortage. The row IS the work, so
  // it is executed, it is audited like everything else, and it is deliberately
  // not dressed up as a command that ran.
  if (row.command === null) {
    return settleExecuted(
      row,
      deps,
      { internal: true, kind: row.actionKind },
      row.attempt,
      options.approval,
    )
  }

  const resolution = deps.registry.resolve(row.command)
  if (resolution.status === 'unavailable') {
    // Permanent: the command will not exist on the next attempt either. The
    // claim is kept for exactly that reason.
    return fail(row, deps, {
      code: 'command_not_implemented',
      detail: resolution.detail,
      retryable: false,
      attempt: row.attempt,
    })
  }

  const retry = deps.retry ?? DEFAULT_DISPATCH_RETRY
  const sleep = deps.sleep ?? realSleep
  const planned = plannedFromRow(row)

  let tries = 0
  let attempt = row.attempt
  let code = 'unexpected_error'
  let detail = 'unknown failure'
  let retryable = true

  while (tries < Math.max(1, retry.maxAttempts)) {
    tries += 1
    // The number of the last attempt made, counting the ones earlier passes
    // made. `retry.ts` increments the row before it calls back in.
    attempt = row.attempt + tries - 1

    try {
      const result = await resolution.run({
        action: planned,
        attempt,
        idempotencyKey: row.idempotencyKey,
        correlationId: row.correlationId ?? deps.correlationId,
        now: deps.now(),
      })
      return settleExecuted(row, deps, result, attempt, options.approval)
    } catch (cause) {
      code = codeOf(cause)
      detail = messageOf(cause)
      retryable = isAppError(cause) ? cause.retryable : true
      if (!retryable) break
      if (tries < retry.maxAttempts) await sleep(retry.backoffMs * tries)
    }
  }

  // Released only when trying again could plausibly succeed. A permanent
  // failure keeps its claim so the next delivery of the same event does not
  // reproduce the identical failure and the identical alert.
  if (retryable) {
    await deps.ledger.release(row.organizationId, row.idempotencyKey)
  }

  return fail(row, deps, { code, detail, retryable, attempt })
}

/* ------------------------------------------------------------ settling --- */

async function settleExecuted(
  row: AutopilotActionRow,
  deps: ExecutionDeps,
  result: CommandResult,
  attempt: number,
  approval: ApprovalStamp | undefined,
): Promise<ExecutionReport> {
  const executedAt = deps.now()
  const spec = AUTOPILOT_ACTIONS[row.actionKind]

  try {
    await recordAuditEvent(
      {
        actor: {
          // Not a user. A timeline that says "the system did this" is the whole
          // reason `ActorType` has more than one member.
          type: 'system',
          userId: null,
          label: 'אוטופיילוט',
          // Both actors, because that is what happened: Autopilot prepared it
          // and a named person released it.
          onBehalfOfUserId: approval?.userId ?? null,
        },
        context: {
          organizationId: row.organizationId,
          propertyId: row.propertyId,
          requestId: row.correlationId ?? deps.correlationId,
        },
        // The permission that authorised it, exactly as a human action records.
        action: spec.grant,
        resourceType: 'autopilot_action',
        resourceId: row.id,
        after: {
          kind: row.actionKind,
          command: row.command,
          attempt,
          ...(approval ? { approvedBy: approval.userId } : {}),
        },
        // Stored at planning time and never re-derived. It is also what the
        // domain command is given as its stated justification.
        reason: row.reason,
        summary: approval
          ? `הוכן על ידי אוטופיילוט ואושר על ידי ${approval.label} · ` +
            `${spec.label}: ${row.reason}`
          : `אוטופיילוט ביצע · ${spec.label}: ${row.reason}`,
      },
      deps.audit,
      { occurredAt: executedAt },
    )
  } catch (cause) {
    // The work happened and the record of it did not. Neither `executed` nor
    // `failed` would be true, and this is the state somebody has to be told
    // about — `autopilot_actions_review_idx` indexes it for that screen.
    const updated = await deps.repository.update(row, {
      outcome: 'executed_unaudited',
      result,
      attempt,
      executedAt,
      errorCode: 'audit_write_failed',
      errorDetail: messageOf(cause),
    })
    return {
      action: updated,
      outcome: { status: 'executed_unaudited', result },
    }
  }

  const updated = await deps.repository.update(row, {
    outcome: 'executed',
    result,
    attempt,
    executedAt,
  })
  return { action: updated, outcome: { status: 'executed', result } }
}

async function fail(
  row: AutopilotActionRow,
  deps: ExecutionDeps,
  failure: {
    code: string
    detail: string
    retryable: boolean
    attempt: number
  },
): Promise<ExecutionReport> {
  const updated = await deps.repository.update(row, {
    outcome: 'failed',
    errorCode: failure.code,
    errorDetail: failure.detail,
    attempt: failure.attempt,
    // Whether another attempt could plausibly help is decided here, where the
    // error was caught, and read back by the queue. The alternative — the queue
    // re-deciding from an error code it never saw thrown — is how a permanent
    // validation failure gets tried nine times.
    result: { failure: { code: failure.code, retryable: failure.retryable } },
  })

  return {
    action: updated,
    outcome: {
      status: 'failed',
      code: failure.code,
      detail: failure.detail,
      retryable: failure.retryable,
    },
  }
}

async function suppress(
  row: AutopilotActionRow,
  deps: ExecutionDeps,
  reason: AutopilotSuppressionReason,
): Promise<ExecutionReport> {
  const updated = await deps.repository.update(row, {
    outcome: 'suppressed',
    suppressedReason: reason,
  })
  return { action: updated, outcome: { status: 'suppressed', reason } }
}

/* ------------------------------------------------------------- reading --- */

/** What the last failure said about trying again. `null` when it did not fail. */
export function failureOf(
  row: AutopilotActionRow,
): { code: string; retryable: boolean } | null {
  const failure = row.result.failure
  if (failure === null || typeof failure !== 'object') return null

  const record = failure as Record<string, unknown>
  if (typeof record.retryable !== 'boolean') return null

  return {
    code: typeof record.code === 'string' ? record.code : 'unexpected_error',
    retryable: record.retryable,
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function codeOf(cause: unknown): string {
  return isAppError(cause) ? cause.code : 'unexpected_error'
}
