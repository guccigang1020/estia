/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Where the damage case screens meet the request.
 *
 * The same shape as `tasks/_lib/wiring.ts`, and for the same reasons: take the
 * request-scoped Supabase client — the one that runs as the signed-in person
 * under row level security — and build the operations on top of it, so that
 * authorization, validation, the audit event and idempotency are unskippable
 * rather than remembered.
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
 * For a liability decision that means the decision row can exist without its
 * audit event, which is a bad failure and is therefore surfaced rather than
 * hidden: `atomic` is returned and the fallback logs once per process. Setting
 * `DATABASE_URL` closes it with no code change.
 *
 * Built per call rather than cached at module scope: the client carries the
 * caller's session, and one shared instance would be one shared identity.
 */

import type { AuditActor } from '@/lib/audit/events'
import {
  defineIncidentOperations,
  type IncidentOperations,
} from '@/lib/incidents/operations'
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
import { domainEventBus } from '../../../_lib/events'

export type CaseWiring = {
  db: Db
  operations: IncidentOperations
  services: OperationServices
  /** False when the writes are sequential rather than one transaction. */
  atomic: boolean
}

/** Logged once, not once per case. */
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
        '[incidents] DATABASE_URL is not set, so damage case writes are ' +
          'sequential rather than transactional. A failure after the ' +
          'decision row is written leaves the audit event uncommitted, and ' +
          'PartialCommitError will say so. Point DATABASE_URL at the Supabase ' +
          'transaction pooler (port 6543) to restore atomicity.',
        cause.message,
      )
    }

    return { transactions: sequentialUnitOfWork(db), atomic: false }
  }
}

export async function caseWiring(): Promise<CaseWiring> {
  const db = await createClient()
  const { transactions, atomic } = transactionRunner(db)

  return {
    db,
    operations: defineIncidentOperations({ db }),
    services: {
      audit: new SupabaseAuditWriter(db),
      events: domainEventBus(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
      onEventError(error) {
        // Never rethrown — a decision whose alert was not delivered is still a
        // decision. Logged so it is not silent.
        console.error('[incidents] domain event delivery failed', error)
      },
    },
    atomic,
  }
}

/**
 * How this person is named in the audit timeline.
 *
 * It matters more here than almost anywhere else in the product: a liability
 * decision is refused outright unless the actor type is a person, and the
 * label is what a dispute six months later reads. Falls back through the
 * profile name, the email, and finally the id — never to "משתמש", which would
 * make two different people's decisions indistinguishable.
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
