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

import { defineBookingOperations } from '@/lib/booking'
import type { BookingOperations } from '@/lib/booking'
import type { OperationServices } from '@/lib/service'
import {
  SupabaseAuditWriter,
  SupabaseBookingRepository,
  SupabaseIdempotencyStore,
  type Db,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { transactionRunner } from '../../_lib/wiring'

export type BookingWiring = {
  db: Db
  repository: SupabaseBookingRepository
  operations: BookingOperations
  services: OperationServices
  /** False when the writes are sequential rather than one transaction. */
  atomic: boolean
}

// `transactionRunner` moved to `src/app/(app)/_lib/wiring.ts` for the same
// reason `auditActorFor` did: three other write paths need it, and importing
// bookings from guests would say something false about how they relate.

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
 * Re-exported, not defined here any more.
 *
 * `auditActorFor` was never about bookings — a guest, a property and an
 * invitation all need the same answer to "whose name goes in the audit trail".
 * It lives in `src/app/(app)/_lib/wiring.ts` now. The re-export stays so the
 * call sites inside this module read the way they always did.
 */
export { auditActorFor } from '../../_lib/wiring'
