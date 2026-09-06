/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Where Autopilot meets the request.
 *
 * The same shape as `src/app/(app)/tasks/_lib/wiring.ts`, and for the same
 * reasons: take the request-scoped Supabase client — the one that runs as the
 * signed-in person under row level security — and build everything on top of
 * it, so that authorization, validation, the audit event and idempotency are
 * unskippable rather than remembered.
 *
 * ── NEVER IMPORT THIS FROM A CLIENT COMPONENT ─────────────────────────────
 *
 * It reaches `@/lib/supabase/server`, which validates the environment at module
 * load, and `@/lib/persistence`, which reaches the `postgres` driver, which
 * imports `fs`. In a browser bundle that is not a broken page — it is every
 * page in the application returning 500 with `Can't resolve 'fs'`, for every
 * user, from one import. It is deliberately NOT re-exported from
 * `runtime/index.ts` for that reason, and `scripts/client-bundle.mjs` walks the
 * graph that proves it.
 *
 * ── Atomicity, and the honest state of it ─────────────────────────────────
 *
 * `postgresUnitOfWork` is a real transaction and is what this asks for first.
 * It needs `DATABASE_URL` pointing at the Supabase transaction pooler, and this
 * deployment does not set one. Rather than crash every write with a wiring
 * error, the fallback is `sequentialUnitOfWork`, which is explicitly **not** a
 * transaction: it runs the writes in order and raises `PartialCommitError`
 * naming what did commit when a later one fails.
 *
 * For Autopilot that means a command's row can exist without its audit event.
 * That is surfaced rather than hidden — `atomic` is returned, and the fallback
 * logs once per process. Setting `DATABASE_URL` closes it with no code change.
 *
 * ── Who Autopilot is, and who it acts for ─────────────────────────────────
 *
 * The domain commands run under the caller's own resolved `Actor`, because the
 * authorization engine must answer the same question it answers for a click —
 * an automation is not a way around it. The AUDIT actor is different: `system`,
 * labelled אוטופיילוט, with the person on `onBehalfOfUserId`. Recording only
 * the person would claim they wrote the message; recording only Autopilot would
 * hide that a human's session released it. Both happened, so both are recorded,
 * and `ActorType` has more than one member for exactly this.
 *
 * Built per call rather than cached at module scope: the client carries the
 * caller's session, and one shared instance would be one shared identity.
 */

import type { Actor } from '@/lib/authz/can'
import {
  AtomicTransactionUnavailableError,
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
  postgresUnitOfWork,
  sequentialUnitOfWork,
  type Db,
} from '@/lib/persistence'
import type { OperationServices } from '@/lib/service'
import { createClient } from '@/lib/supabase/server'

import {
  SupabaseAutopilotActionRepository,
  createCommandRegistry,
  idempotencyLedger,
  type CommandInvocation,
  type ExecutionDeps,
} from '../execute'

import { SupabaseAutopilotPolicyRepository } from './context'
import { autopilotCommandHandlers } from './handlers'
import { SupabaseFactPorts } from './ports'
import type { AutopilotFactPorts } from './ports'

export interface AutopilotWiring {
  db: Db
  facts: AutopilotFactPorts
  policies: SupabaseAutopilotPolicyRepository
  execution: ExecutionDeps
  /** False when the writes are sequential rather than one transaction. */
  atomic: boolean
}

/** Logged once per process, not once per action. */
let warnedAboutTransactions = false

function transactionRunner(db: Db): {
  transactions: OperationServices['transactions']
  atomic: boolean
} {
  try {
    return { transactions: postgresUnitOfWork(db), atomic: true }
  } catch (cause) {
    if (!(cause instanceof AtomicTransactionUnavailableError)) throw cause

    if (!warnedAboutTransactions) {
      warnedAboutTransactions = true
      console.warn(
        '[autopilot] DATABASE_URL is not set, so an action and its audit ' +
          'event are written sequentially rather than in one transaction. A ' +
          'failure after the command has run leaves the audit event ' +
          'uncommitted, and PartialCommitError will say so. Point ' +
          'DATABASE_URL at the Supabase transaction pooler (port 6543) to ' +
          'restore atomicity.',
        cause.message,
      )
    }

    return { transactions: sequentialUnitOfWork(db), atomic: false }
  }
}

export interface AutopilotWiringInput {
  /** The resolved identity the commands run as. Never invented here. */
  actor: Actor
  /** Ties every audit record produced by one pass together. */
  correlationId: string
  /** The person whose session started this, or null for a scheduled sweep. */
  requestedBy?: string | null
  /** Injected so a pass is deterministic in a test that owns the clock. */
  now?: () => Date
}

export async function autopilotWiring(
  input: AutopilotWiringInput,
): Promise<AutopilotWiring> {
  const db = await createClient()
  const { transactions, atomic } = transactionRunner(db)
  const now = input.now ?? (() => new Date())

  const audit = new SupabaseAuditWriter(db)
  const idempotency = new SupabaseIdempotencyStore(db)

  const services: OperationServices = {
    audit,
    idempotency,
    transactions,
    onEventError(error) {
      // Never rethrown — an action that happened with an undelivered event is
      // still an action that happened. Logged so it is not silent.
      console.error('[autopilot] domain event delivery failed', error)
    },
  }

  const handlers = autopilotCommandHandlers({
    db,
    services,
    organizationId: input.actor.organizationId,
    context: (invocation: CommandInvocation) => ({
      actor: input.actor,
      auditActor: {
        type: 'system' as const,
        userId: null,
        label: 'אוטופיילוט',
        onBehalfOfUserId: input.requestedBy ?? null,
      },
      correlationId: invocation.correlationId,
      now: invocation.now,
      // Left unset so `operationHandler` fills it with the action's own prose.
      // The honest answer to "why was this cancelled" is the sentence Autopilot
      // composed when it decided to, and `booking.cancel` refuses without one.
      reason: null,
    }),
  })

  return {
    db,
    facts: new SupabaseFactPorts(db),
    policies: new SupabaseAutopilotPolicyRepository(db),
    execution: {
      repository: new SupabaseAutopilotActionRepository(db),
      registry: createCommandRegistry(handlers),
      // The claim over the idempotency table the service layer already owns.
      // `begin` is one `insert … on conflict do nothing`, so it is atomic
      // across processes — which `InMemoryAutopilotLedger` is not, and is why
      // that one is for tests.
      ledger: idempotencyLedger(idempotency),
      audit,
      now,
      correlationId: input.correlationId,
      requestedBy: input.requestedBy ?? null,
    },
    atomic,
  }
}
