/**
 * The two pieces every write path in the app shell needs.
 *
 * Both of these began inside `bookings/_lib/wiring.ts`, because bookings was
 * the first module with a real operation behind it. They are here now because
 * they were never about bookings: a guest, a property and an invitation each
 * need the same transaction runner and the same answer to "whose name goes in
 * the audit trail", and the alternative was `guests/_lib/actions.ts` importing
 * from `bookings/_lib/wiring.ts` — a dependency that says something false
 * about how the two modules relate.
 *
 * Nothing here decides anything. It binds what `src/lib/persistence` already
 * provides to the request in hand, so that a route can hand an operation its
 * services without each route inventing its own idea of what they are.
 */

import type { User } from '@supabase/supabase-js'

import type { AuditActor } from '@/lib/audit/events'
import type { OperationServices } from '@/lib/service'
import {
  AtomicTransactionUnavailableError,
  postgresUnitOfWork,
  sequentialUnitOfWork,
  type Db,
} from '@/lib/persistence'

/** Logged once per process, not once per write. */
let warnedAboutTransactions = false

/**
 * A real transaction where the connection allows one, and an honest fallback
 * where it does not.
 *
 * `postgresUnitOfWork` needs a direct Postgres connection — PostgREST has no
 * multi-statement transaction, so without `DATABASE_URL` the writes are
 * sequential round trips and a failure partway through leaves earlier rows
 * standing. That is a materially weaker guarantee, so it is reported as
 * `atomic: false` rather than hidden, and `PartialCommitError` names what
 * survived.
 *
 * The warning fires once. A message per booking would train everyone to
 * scroll past it.
 */
export function transactionRunner(db: Db): {
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
        '[app] DATABASE_URL is not set, so writes are sequential rather than ' +
          'transactional. A failure after the first row is written leaves the ' +
          'audit event or the rows behind it uncommitted, and ' +
          'PartialCommitError will name which. Point DATABASE_URL at the ' +
          'Supabase transaction pooler (port 6543) to restore atomicity.',
        cause.message,
      )
    }

    return { transactions: sequentialUnitOfWork(db), atomic: false }
  }
}

/**
 * How this person is named in the audit timeline.
 *
 * The authorization engine deals in ids and would be wrong to know a name; the
 * audit trail is worthless without one. Falls back through the profile name,
 * the email, and finally the id — never to a generic word, which would make
 * two different people's actions indistinguishable in a dispute.
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
