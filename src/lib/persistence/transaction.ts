/**
 * Atomicity: the honest runner, and the real one beside it.
 *
 * ############################################################################
 * # `sequentialUnitOfWork` IS NOT A TRANSACTION, and is still exported.      #
 * # A unit of work that fails half way leaves the successful half durable,   #
 * # and `PartialCommitError` says which half.                                #
 * #                                                                          #
 * # `postgresUnitOfWork` in `atomic-transaction.ts` IS one. Wire that for    #
 * # anything that touches a booking or money.                                #
 * ############################################################################
 *
 * ── Why the honest one had to exist first ─────────────────────────────────
 *
 * `TransactionRunner.run(work)` takes a JavaScript closure. Making that closure
 * atomic means running it between a `BEGIN` and a `COMMIT` on one connection.
 * Supabase is reached here over PostgREST, which is stateless HTTP: every
 * request is its own implicit transaction and there is no session to hold a
 * `BEGIN` open across three of them. That is not a gap a cleverer call to
 * `@supabase/supabase-js` would close — a JavaScript function cannot execute
 * inside a Postgres transaction over HTTP.
 *
 * Two fixes were possible, and the second was taken:
 *
 *   1. **A Postgres function per operation, invoked by RPC.** The usual
 *      answer, and it works. It was rejected because it splits the business
 *      rules across two languages and two places: the service pipeline exists
 *      so that every operation takes one path, and moving half of each
 *      operation into `plpgsql` dissolves exactly that.
 *
 *   2. **A direct Postgres connection** through the transaction pooler, with a
 *      real `BEGIN`/`COMMIT` and `set local role` so row level security still
 *      applies. This is what `atomic-transaction.ts` does. The port is
 *      unchanged, every adapter is unchanged, and the one new dependency is a
 *      Postgres driver.
 *
 * ── What was atomic even before that ──────────────────────────────────────
 *
 * More than nothing, and the most important part. **A single statement is
 * atomic, and it takes its triggers with it.** Inserting one booking row fires
 * `tg_bookings_sync_occupancy`, which projects it into `unit_occupancy`, where
 * the GiST exclusion constraint either accepts it or fails the whole
 * statement. So the double-booking guarantee — the one thing that absolutely
 * must not be racy — has always been intact, because it lives inside one
 * statement in the database.
 *
 * What was not atomic is the *composition*: booking + price lines + audit row
 * + idempotency completion are four statements, and a failure at the third
 * left the first two committed. That is the gap `postgresUnitOfWork` closes.
 *
 * ── So when is the sequential one still right ─────────────────────────────
 *
 * When there is no signed-in user to run as. The atomic runner refuses without
 * one, deliberately — a direct connection with no session runs as the owner
 * with `BYPASSRLS`. A webhook or a nightly sweep therefore keeps this runner
 * and its `PartialCommitError`, which turns the worst version of the failure —
 * silence — into an incident report. It remains a consolation prize, and it
 * remains labelled as one.
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
   * `false` for `sequentialUnitOfWork`, `true` for `postgresUnitOfWork`.
   *
   * Readable so a call site that genuinely must not run without atomicity can
   * refuse rather than hope. Note what it means for `committed`: under the
   * atomic runner that list is what has been *written so far in this
   * transaction*, not what is durable — a rollback takes all of it.
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
 *
 * Now that `postgresUnitOfWork` exists, reach for this one only where there is
 * no session to run as.
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
