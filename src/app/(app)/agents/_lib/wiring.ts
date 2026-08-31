/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Where the agent domain meets the request.
 *
 * The same shape as `bookings/_lib/wiring.ts`, and deliberately so: the
 * request-scoped Supabase client — the one that runs as the signed-in user
 * under row level security — is handed to `SupabaseAgentRepository`, and
 * `defineAgentOperations` is built on top. Every mutation the agent screens
 * perform goes through the object this returns, which is what makes
 * authorization, validation, the version check, the audit event and idempotency
 * unskippable rather than remembered.
 *
 * ── The transaction, and the honest state of it ───────────────────────────
 *
 * Identical to the bookings wiring, including the fallback: `postgresUnitOfWork`
 * needs `DATABASE_URL` pointing at the Supabase transaction pooler and this
 * deployment does not set one, so the writes run sequentially and
 * `PartialCommitError` names what committed when a later write fails. That
 * matters more here than almost anywhere else in the product: a suspension is
 * two rows — the terms and the membership — and a partial commit would leave a
 * suspended-looking screen above a membership that still resolves to an active
 * actor. `atomic` is returned so a caller can say so, and the fallback logs
 * once per process rather than silently.
 *
 * It is not duplicated code so much as duplicated *fallback*: the day
 * `DATABASE_URL` is set, both files start being transactional with no edit.
 */

import type { AuditActor } from '@/lib/audit/events'
import { defineAgentOperations, type AgentOperations } from '@/lib/agents'
import type { OperationServices } from '@/lib/service'
import {
  AtomicTransactionUnavailableError,
  SupabaseAgentRepository,
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
  postgresUnitOfWork,
  sequentialUnitOfWork,
  type Db,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'
import type { User } from '@supabase/supabase-js'

export type AgentWiring = {
  db: Db
  repository: SupabaseAgentRepository
  operations: AgentOperations
  services: OperationServices
  /** False when the writes are sequential rather than one transaction. */
  atomic: boolean
}

/** Logged once, not once per suspension. */
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
        '[agents] DATABASE_URL is not set, so agent writes are sequential ' +
          'rather than transactional. A suspension is two rows — the terms ' +
          'and the membership — and a failure between them leaves the screen ' +
          'and the actor disagreeing about whether the agent is blocked. ' +
          'Point DATABASE_URL at the Supabase transaction pooler (port 6543) ' +
          'to restore atomicity.',
        cause.message,
      )
    }

    return { transactions: sequentialUnitOfWork(db), atomic: false }
  }
}

/**
 * The domain, bound to this request.
 *
 * Built per call rather than cached at module scope: the client carries the
 * caller's session, and one shared instance would be one shared identity.
 */
export async function agentWiring(): Promise<AgentWiring> {
  const db = await createClient()
  const repository = new SupabaseAgentRepository(db)
  const { transactions, atomic } = transactionRunner(db)

  return {
    db,
    repository,
    operations: defineAgentOperations(repository),
    services: {
      audit: new SupabaseAuditWriter(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
      onEventError(error) {
        // Never rethrown — a suspended agent with an undelivered event is
        // still a suspended agent. Logged so it is not silent.
        console.error('[agents] domain event delivery failed', error)
      },
    },
    atomic,
  }
}

/**
 * How this person is named in the audit timeline.
 *
 * Identical to `auditActorFor` in the bookings wiring, and identical for the
 * same reason: the authorization engine deals in ids and would be wrong to know
 * a name, while an audit trail is worthless without one. Never falls back to
 * "משתמש", which would make two people's actions indistinguishable in the
 * dispute this trail exists for.
 */
export function auditActorFor(user: User): AuditActor {
  const fullName =
    typeof user.user_metadata?.full_name === 'string' &&
    user.user_metadata.full_name.trim().length > 0
      ? user.user_metadata.full_name.trim()
      : null

  return {
    type: 'user',
    userId: user.id,
    label: fullName ?? user.email ?? user.id,
  }
}
