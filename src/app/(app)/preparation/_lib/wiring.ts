/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Where the preparation domain meets the request.
 *
 * `src/lib/preparation` has been complete and tested for weeks and nothing
 * imported it: a rules engine, a costing engine, a snapshot mechanism and a
 * Supabase adapter over three tables, with no screen on the other end. This
 * file is the missing sentence, and it is the same shape as
 * `bookings/_lib/wiring.ts` — take the request-scoped client, the one that
 * runs as the signed-in person under row level security, and hand it to
 * `SupabasePreparationPorts`.
 *
 * ── The board is read-only, so it gets no unit of work ────────────────────
 *
 * `preparationWiring` reads plans and reads tasks. It builds nothing, saves
 * nothing and completes nothing, so there is no transaction to run, no audit
 * writer to inject and no idempotency store to build.
 * `createPreparationOperations` is deliberately not called there: it is the
 * plan write side, it needs `OperationServices`, and wiring it for a screen
 * that performs no write would be wiring a mechanism nobody can observe
 * working.
 *
 * `loadBooking` is no longer blocked — 0028 gave it the columns it was waiting
 * for — but it still never fires from the board, because the board reads plans
 * and tasks and never a booking. `loadAllocationContexts` does still raise
 * `SchemaNotProvisionedError`; it is reached only from the profit statement.
 *
 * ── The policy screen does write, so it gets the whole pipeline ───────────
 *
 * `catalogueWiring` is the second function, and it is the shape
 * `finance/_lib/wiring.ts` already set out: the request-scoped client, the
 * audit writer, the idempotency store and a transaction runner, with the
 * sequential fallback and its warning when `DATABASE_URL` is unset. It builds
 * `createCatalogueOperations` and not `createPreparationOperations` — the two
 * port lists are separate on purpose, so that the operations which must only
 * ever read a frozen snapshot cannot reach a catalogue writer.
 *
 * Built per call rather than cached at module scope: the client carries the
 * caller's session, and one shared instance would be one shared identity.
 */

import type { AuditActor } from '@/lib/audit/events'
import {
  AtomicTransactionUnavailableError,
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
  SupabasePreparationPorts,
  postgresUnitOfWork,
  sequentialUnitOfWork,
  type Db,
} from '@/lib/persistence'
import {
  createCatalogueOperations,
  createPreparationOperations,
  type CatalogueOperations,
  type PreparationOperations,
} from '@/lib/preparation'
import type { OperationServices } from '@/lib/service'
import { createClient } from '@/lib/supabase/server'
import type { User } from '@supabase/supabase-js'

export type PreparationWiring = {
  db: Db
  ports: SupabasePreparationPorts
}

export async function preparationWiring(): Promise<PreparationWiring> {
  const db = await createClient()
  return { db, ports: new SupabasePreparationPorts(db) }
}

export type CatalogueWiring = {
  db: Db
  ports: SupabasePreparationPorts
  operations: CatalogueOperations
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
        '[preparation] DATABASE_URL is not set, so a policy save is ' +
          'sequential rather than transactional. A failure after the ' +
          'catalogue row is written leaves the audit event uncommitted, and ' +
          'PartialCommitError will name which. Point DATABASE_URL at the ' +
          'Supabase transaction pooler (port 6543) to restore atomicity.',
        cause.message,
      )
    }

    return { transactions: sequentialUnitOfWork(db), atomic: false }
  }
}

export type PlanWiring = {
  db: Db
  ports: SupabasePreparationPorts
  operations: PreparationOperations
  services: OperationServices
  /** False when the writes are sequential rather than one transaction. */
  atomic: boolean
}

/**
 * The plan write side, which the board deliberately does not get.
 *
 * `preparationWiring` above reads and nothing else, so it needs no unit of
 * work. Building a plan is a different act: it captures a snapshot, writes it,
 * writes the plan, records an audit event and raises `preparation.calculated`,
 * and those have to commit together or not at all — a plan whose frozen
 * ruleset did not land is a plan that will silently re-cost itself against
 * next month's catalogue, which is the one property the whole snapshot
 * mechanism exists to guarantee.
 *
 * `createPreparationOperations` and not `createCatalogueOperations`: the two
 * port lists are separate on purpose, so operations that must only ever read a
 * frozen snapshot cannot reach a catalogue writer.
 */
export async function planWiring(): Promise<PlanWiring> {
  const db = await createClient()
  const ports = new SupabasePreparationPorts(db)
  const { transactions, atomic } = transactionRunner(db)

  return {
    db,
    ports,
    operations: createPreparationOperations(ports),
    services: {
      audit: new SupabaseAuditWriter(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
      onEventError(error) {
        console.error('[preparation] domain event delivery failed', error)
      },
    },
    atomic,
  }
}

export async function catalogueWiring(): Promise<CatalogueWiring> {
  const db = await createClient()
  const ports = new SupabasePreparationPorts(db)
  const { transactions, atomic } = transactionRunner(db)

  return {
    db,
    ports,
    operations: createCatalogueOperations(ports),
    services: {
      audit: new SupabaseAuditWriter(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
      onEventError(error) {
        console.error('[preparation] domain event delivery failed', error)
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
 * the email and finally the id — never to "משתמש", which would make two
 * different people's edits indistinguishable in a dispute.
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
