/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Where the operations screens meet the request.
 *
 * The same shape as `bookings/_lib/wiring.ts`, and for the same reasons: take
 * the request-scoped Supabase client — the one that runs as the signed-in
 * person under row level security — and build the operation on top of it, so
 * that authorization, validation, the audit event and idempotency are
 * unskippable rather than remembered.
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
 * For a task that means the row can exist without its audit event. That is a
 * smaller failure than the same thing happening to a booking and it is still a
 * failure, so it is surfaced rather than hidden: `atomic` is returned, and the
 * fallback logs once per process. Setting `DATABASE_URL` closes it with no code
 * change.
 *
 * Built per call rather than cached at module scope: the client carries the
 * caller's session, and one shared instance would be one shared identity.
 */

import type { AuditActor } from '@/lib/audit/events'
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
import type { User } from '@supabase/supabase-js'

import { defineTaskCreation, type TaskCreationOperation } from './operations'

export type OperationsWiring = {
  db: Db
  /** Opens an ordinary task. `task.create`. */
  createTask: TaskCreationOperation
  /** Opens a fault report. `incident.create`, and always type `maintenance`. */
  reportIncident: TaskCreationOperation
  services: OperationServices
  /** False when the writes are sequential rather than one transaction. */
  atomic: boolean
}

/** Logged once, not once per task. */
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
        '[operations] DATABASE_URL is not set, so task writes are sequential ' +
          'rather than transactional. A failure after the task row is written ' +
          'leaves the audit event uncommitted, and PartialCommitError will say ' +
          'so. Point DATABASE_URL at the Supabase transaction pooler (port ' +
          '6543) to restore atomicity.',
        cause.message,
      )
    }

    return { transactions: sequentialUnitOfWork(db), atomic: false }
  }
}

export async function operationsWiring(): Promise<OperationsWiring> {
  const db = await createClient()
  const { transactions, atomic } = transactionRunner(db)

  return {
    db,
    createTask: defineTaskCreation({
      name: 'task.create',
      permission: 'task.create',
      db,
    }),
    reportIncident: defineTaskCreation({
      name: 'incident.create',
      permission: 'incident.create',
      // A fault report is a `maintenance` task, because there is no
      // `public.incidents` table — see `tasks/_lib/queries.ts`. Fixed here
      // rather than chosen on the form: a "fault" the reporter typed as
      // `guest_request` would vanish from the register that exists to hold it.
      fixedType: 'maintenance',
      db,
    }),
    services: {
      audit: new SupabaseAuditWriter(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
      onEventError(error) {
        // Never rethrown — a reported fault with an undelivered alert is still
        // a reported fault. Logged so it is not silent.
        console.error('[operations] domain event delivery failed', error)
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
