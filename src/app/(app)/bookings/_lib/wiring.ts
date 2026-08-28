/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Where the booking domain meets the request.
 *
 * `src/lib/booking` has been complete and tested for weeks and nothing
 * imported it. This file is the missing sentence: it takes the request-scoped
 * Supabase client — the one that runs as the signed-in user under row level
 * security — hands it to `SupabaseBookingRepository`, and builds the six
 * operations on top. Every mutation the bookings screens perform goes through
 * the object this returns, which is what makes authorization, validation, the
 * version check, the audit event and idempotency unskippable rather than
 * remembered.
 *
 * ── Atomicity, and the honest state of it ─────────────────────────────────
 *
 * `postgresUnitOfWork` is a real transaction and is what this asks for first.
 * It needs `DATABASE_URL` pointing at the Supabase transaction pooler, and
 * this deployment does not set one — `.env.local` carries the Supabase URL and
 * the publishable key and nothing else. Rather than crash every booking write
 * with a wiring error, the fallback is `sequentialUnitOfWork`, which is
 * explicitly **not** a transaction: it runs the writes in order and raises
 * `PartialCommitError` naming what did commit when a later one fails.
 *
 * That distinction is surfaced, not hidden. `atomic` is returned so a caller
 * can say so, and the fallback logs once per process so that "the audit row is
 * missing for a booking that exists" is a state somebody has already been
 * warned about instead of a mystery. Setting `DATABASE_URL` closes it with no
 * code change.
 */

import type { AuditActor } from '@/lib/audit/events'
import { defineBookingOperations } from '@/lib/booking'
import type { BookingOperations } from '@/lib/booking'
import type { OperationServices } from '@/lib/service'
import {
  AtomicTransactionUnavailableError,
  SupabaseAuditWriter,
  SupabaseBookingRepository,
  SupabaseIdempotencyStore,
  postgresUnitOfWork,
  sequentialUnitOfWork,
  type Db,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'
import type { User } from '@supabase/supabase-js'

export type BookingWiring = {
  db: Db
  repository: SupabaseBookingRepository
  operations: BookingOperations
  services: OperationServices
  /** False when the writes are sequential rather than one transaction. */
  atomic: boolean
}

/** Logged once, not once per booking. */
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
        '[bookings] DATABASE_URL is not set, so booking writes are sequential ' +
          'rather than transactional. A failure after the booking row is ' +
          'written leaves the audit event or the price lines behind it ' +
          'uncommitted, and PartialCommitError will name which. Point ' +
          'DATABASE_URL at the Supabase transaction pooler (port 6543) to ' +
          'restore atomicity.',
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
export async function bookingWiring(): Promise<BookingWiring> {
  const db = await createClient()
  const repository = new SupabaseBookingRepository(db)
  const { transactions, atomic } = transactionRunner(db)

  return {
    db,
    repository,
    operations: defineBookingOperations(repository),
    services: {
      audit: new SupabaseAuditWriter(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
      onEventError(error) {
        // Never rethrown — a delivered booking with an undelivered event is
        // still a booking. Logged so it is not silent.
        console.error('[bookings] domain event delivery failed', error)
      },
    },
    atomic,
  }
}

/**
 * How this person is named in the audit timeline.
 *
 * The authorization engine deals in ids and would be wrong to know a name;
 * the audit trail is worthless without one. Falls back through the profile
 * name, the email, and finally the id — never to "משתמש", which would make two
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
