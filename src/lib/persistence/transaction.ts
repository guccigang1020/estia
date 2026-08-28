/**
 * Atomicity, and the fact that this layer does not have it.
 *
 * ############################################################################
 * # READ THIS BEFORE WIRING A BOOKING OR A PAYMENT.                          #
 * #                                                                          #
 * # `sequentialUnitOfWork` IS NOT A TRANSACTION. Nothing in this directory   #
 * # is. A unit of work that fails half way leaves the successful half        #
 * # durable, and `PartialCommitError` says which half.                       #
 * ############################################################################
 *
 * ── Why, precisely ────────────────────────────────────────────────────────
 *
 * `TransactionRunner.run(work)` takes a JavaScript closure. Making that closure
 * atomic means running it between a `BEGIN` and a `COMMIT` on one connection.
 * Supabase is reached here over PostgREST, which is stateless HTTP: every
 * request is its own implicit transaction and there is no session to hold a
 * `BEGIN` open across three of them. This is not a gap in `@supabase/supabase-js`
 * that a cleverer call would close — a JavaScript function cannot execute
 * inside a Postgres transaction over HTTP, and no amount of care in this file
 * changes that.
 *
 * There are exactly two real fixes, and both are outside this directory:
 *
 *   1. **A Postgres function per operation, invoked by RPC.** The whole unit of
 *      work — insert the booking, insert its price lines, insert the audit row,
 *      complete the idempotency key — becomes one `plpgsql` function and one
 *      `rpc()` call, which is one statement and therefore atomic. This is the
 *      usual answer and the right one. It needs a migration (`supabase/`), and
 *      it needs the operation port to change shape: an operation would declare
 *      an RPC name and its arguments instead of a JavaScript `execute`, because
 *      the body has to live in the database. Both are changes to files this
 *      work does not own, so both are reported rather than made.
 *
 *   2. **A direct Postgres connection** (`pg`, `postgres.js`) alongside
 *      PostgREST, with real `BEGIN`/`COMMIT` and `set local role` to keep RLS.
 *      This preserves the port exactly as written. It needs a dependency, and
 *      adding one was out of scope here.
 *
 * ── What is atomic anyway ─────────────────────────────────────────────────
 *
 * More than nothing, and the most important part. **A single statement is
 * atomic, and it takes its triggers with it.** Inserting one booking row fires
 * `tg_bookings_sync_occupancy`, which projects it into `unit_occupancy`, where
 * the GiST exclusion constraint either accepts it or fails the whole statement.
 * So the double-booking guarantee — the one thing that absolutely must not be
 * racy — is intact regardless of anything in this file, because it lives
 * inside one statement in the database.
 *
 * What is *not* atomic is the composition: booking + price lines + audit row +
 * idempotency completion are four statements, and a failure at the third
 * leaves the first two committed.
 *
 * ── So what does this file give you ───────────────────────────────────────
 *
 * Honesty and a trail. `sequentialUnitOfWork` runs the work with a handle that
 * records each write as it commits, and converts a mid-way failure into a
 * `PartialCommitError` naming exactly what is already durable. That turns the
 * worst version of this failure — silence — into an incident report. It is a
 * consolation prize and it is labelled as one.
 */

import type { TransactionHandle, TransactionRunner } from '../service'
import type { Db } from './client'
import { PartialCommitError } from './errors'

/**
 * The handle the pipeline passes to every write.
 *
 * Opaque to the service layer by design (`TransactionHandle` is `unknown`
 * there), and given a real shape here. It carries the client, so every write
 * in one unit of work goes through one client and therefore one session and
 * one set of RLS decisions — which is not atomicity, but does rule out the
 * separate bug of half an operation running as a different user.
 */
export interface SupabaseUnitOfWork {
  readonly kind: 'supabase-unit-of-work'
  readonly db: Db
  /** Writes that have already committed, in order, as short labels. */
  readonly committed: readonly string[]
  /**
   * Called by an adapter the moment a write is durable.
   *
   * Adapters must call this *after* the round trip succeeds and never before:
   * the list is used to tell an operator what survived a failure, and an
   * optimistic entry would send them looking for a row that is not there.
   */
  record(label: string): void
  /**
   * True for the honest runner below, and the flag a future atomic runner
   * would set to `false`. Left readable so a call site that genuinely must not
   * run without atomicity can refuse rather than hope.
   */
  readonly atomic: boolean
}

export function isSupabaseUnitOfWork(
  handle: TransactionHandle,
): handle is SupabaseUnitOfWork {
  return (
    handle !== null &&
    typeof handle === 'object' &&
    (handle as { kind?: unknown }).kind === 'supabase-unit-of-work'
  )
}

/**
 * The client an adapter should write through.
 *
 * Adapters accept a handle because the port says they must, and they fall back
 * to their own client when they are handed `undefined` — which is what
 * `noTransactionRunner` passes, and what happens in a unit test. Falling back
 * is correct: the alternative is an adapter that cannot be exercised without a
 * runner, which would make the tests need one for no reason.
 */
export function clientFor(handle: TransactionHandle, fallback: Db): Db {
  return isSupabaseUnitOfWork(handle) ? handle.db : fallback
}

/** Note a durable write, when there is a handle listening. */
export function recordWrite(handle: TransactionHandle, label: string): void {
  if (isSupabaseUnitOfWork(handle)) handle.record(label)
}

/**
 * Sequential, not atomic. The name is the documentation.
 *
 * Deliberately *not* called `supabaseTransactionRunner`. `transaction.ts` in
 * the service layer names its default `noTransactionRunner` for exactly this
 * reason — a runner that is not one must not be able to pass for one at a call
 * site, and a name is the only thing a reviewer reads.
 */
export function sequentialUnitOfWork(db: Db): TransactionRunner {
  return {
    async run<T>(work: (tx: TransactionHandle) => Promise<T>): Promise<T> {
      const committed: string[] = []

      const handle: SupabaseUnitOfWork = {
        kind: 'supabase-unit-of-work',
        db,
        committed,
        atomic: false,
        record(label: string) {
          committed.push(label)
        },
      }

      try {
        return await work(handle)
      } catch (error) {
        // Nothing committed yet: the failure is the whole story, and wrapping
        // it would bury the real cause under a misleading one.
        if (committed.length === 0) throw error

        // Something did commit. The caller has to be told what, because the
        // repair differs entirely depending on the answer.
        throw new PartialCommitError(committed, error)
      }
    },
  }
}
