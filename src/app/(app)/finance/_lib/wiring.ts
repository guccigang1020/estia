/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Where the finance domain meets the request.
 *
 * The same file `bookings/_lib/wiring.ts` is, for the same reason and with the
 * same shape: it takes the request-scoped Supabase client — the one that runs
 * as the signed-in user under row level security — hands it to
 * `SupabaseFinanceRepository`, and builds the operations on top. Every write
 * the finance screens perform goes through the object this returns, which is
 * what makes authorization, validation, the version check, the audit event and
 * idempotency unskippable rather than remembered.
 *
 * ── Reads take the repository too ─────────────────────────────────────────
 *
 * `financeRepository()` exists beside the full wiring because a list screen
 * needs the port and nothing else. It builds no transaction runner, so a read
 * never logs the `DATABASE_URL` warning that only a write is entitled to.
 *
 * ── Atomicity, and the honest state of it ─────────────────────────────────
 *
 * `postgresUnitOfWork` is a real transaction and is what this asks for first.
 * It needs `DATABASE_URL` pointing at the Supabase transaction pooler, and this
 * deployment does not set one. Rather than crash every write with a wiring
 * error, the fallback is `sequentialUnitOfWork`, which is explicitly **not** a
 * transaction: it runs the writes in order and raises `PartialCommitError`
 * naming what did commit when a later one fails. `atomic` is returned so a
 * caller can say so, and the fallback logs once per process.
 */

import type { AuditActor } from '@/lib/audit/events'
import { defineFinanceOperations, type FinanceOperations } from '@/lib/finance'
import {
  AtomicTransactionUnavailableError,
  SupabaseAuditWriter,
  SupabaseFinanceRepository,
  SupabaseIdempotencyStore,
  postgresUnitOfWork,
  sequentialUnitOfWork,
  type Db,
} from '@/lib/persistence'
import type { OperationServices } from '@/lib/service'
import { createClient } from '@/lib/supabase/server'
import type { User } from '@supabase/supabase-js'

export type FinanceWiring = {
  db: Db
  repository: SupabaseFinanceRepository
  operations: FinanceOperations
  services: OperationServices
  /** False when the writes are sequential rather than one transaction. */
  atomic: boolean
}

/** Logged once, not once per write. */
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
        '[finance] DATABASE_URL is not set, so finance writes are sequential ' +
          'rather than transactional. A failure after the row is written ' +
          'leaves the audit event uncommitted, and PartialCommitError will ' +
          'name which. Point DATABASE_URL at the Supabase transaction pooler ' +
          '(port 6543) to restore atomicity.',
        cause.message,
      )
    }

    return { transactions: sequentialUnitOfWork(db), atomic: false }
  }
}

/**
 * The port, bound to this request.
 *
 * Built per call rather than cached at module scope: the client carries the
 * caller's session, and one shared instance would be one shared identity.
 */
export async function financeRepository(): Promise<{
  db: Db
  repo: SupabaseFinanceRepository
}> {
  const db = await createClient()
  return { db, repo: new SupabaseFinanceRepository(db) }
}

export async function financeWiring(): Promise<FinanceWiring> {
  const db = await createClient()
  const repository = new SupabaseFinanceRepository(db)
  const { transactions, atomic } = transactionRunner(db)

  return {
    db,
    repository,
    operations: defineFinanceOperations(repository),
    services: {
      audit: new SupabaseAuditWriter(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
      onEventError(error) {
        // Never rethrown — a written rule with an undelivered event is still a
        // written rule. Logged so it is not silent.
        console.error('[finance] domain event delivery failed', error)
      },
    },
    atomic,
  }
}

/**
 * How this person is named in the audit timeline.
 *
 * The authorization engine deals in ids and would be wrong to know a name; the
 * audit trail is worthless without one. Falls back through the profile name,
 * the email, and finally the id — never to "משתמש", which would make two
 * different people's actions indistinguishable in a dispute.
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
