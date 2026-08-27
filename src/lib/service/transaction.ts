/**
 * The transaction boundary.
 *
 * The pipeline runs the business change, the audit write and the idempotency
 * completion inside one unit of work. Three things go in together or none of
 * them do:
 *
 *   - a change with no audit row is untraceable;
 *   - an audit row for a rolled-back change is a false record;
 *   - a completed idempotency key for a failed operation refuses the retry
 *     the user was told to make.
 *
 * The runner is injected because this layer does not own the database client.
 * The handle is opaque here and is passed through to `execute`, to the audit
 * writer and to the idempotency store, which do know what it is.
 */

/** Opaque to this layer; the data-access implementation gives it a real type. */
export type TransactionHandle = unknown

export interface TransactionRunner {
  run<T>(work: (tx: TransactionHandle) => Promise<T>): Promise<T>
}

/**
 * Runs the work with no transaction at all.
 *
 * The default, and honest about what it is: with this runner the pipeline's
 * steps are sequential but not atomic. It is correct for tests and for
 * operations that touch nothing transactional, and it is *not* correct for a
 * booking or a payment. Wiring the real runner is a required step, not an
 * optimisation — which is why this is named for what it does rather than
 * called `defaultRunner`.
 */
export const noTransactionRunner: TransactionRunner = {
  async run<T>(work: (tx: TransactionHandle) => Promise<T>): Promise<T> {
    return work(undefined)
  },
}

/**
 * Records commits and rollbacks. For proving the pipeline's ordering.
 */
export class RecordingTransactionRunner implements TransactionRunner {
  commits = 0
  rollbacks = 0

  async run<T>(work: (tx: TransactionHandle) => Promise<T>): Promise<T> {
    try {
      const result = await work({ recording: true })
      this.commits += 1
      return result
    } catch (error) {
      this.rollbacks += 1
      throw error
    }
  }
}
