/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * What a console write needs, bound to the request in hand.
 *
 * Nothing here decides anything. It hands `definePlatformOperations` the store
 * and the services `src/lib/persistence` already provides, so that no route
 * invents its own idea of what they are — the same reason
 * `src/app/(app)/_lib/wiring.ts` exists for the customer side.
 *
 * ── The transaction, and an honest note about it ──────────────────────────
 *
 * Without `DATABASE_URL` pointing at the transaction pooler, PostgREST has no
 * multi-statement transaction and the writes are sequential round trips. Each
 * console operation performs exactly ONE database write and then the audit
 * event, so the failure that fallback exposes is precise and worth naming: the
 * suspension could commit and the audit row could not. `PartialCommitError`
 * says which survived, and this is one of the places in the product where the
 * answer matters most — an account turned off with no record of who did it is
 * the thing the audit trail exists to make impossible.
 *
 * The runner is built here rather than imported from
 * `src/app/(app)/_lib/wiring.ts`, which does the identical thing for the
 * customer side. That is not duplication for its own sake: the console is a
 * separate route group with a separate guard precisely so that nothing in it
 * depends on the customer application, and a shared helper is a shared
 * dependency — the one import that makes "these two never touch" untrue.
 */

import type { OperationContext, OperationServices } from '@/lib/service'
import {
  AtomicTransactionUnavailableError,
  SupabaseAuditWriter,
  postgresUnitOfWork,
  sequentialUnitOfWork,
  type Db,
} from '@/lib/persistence'
import {
  platformActorFor,
  platformAuditActor,
  SupabasePlatformStore,
  definePlatformOperations,
  type PlatformOperations,
  type PlatformSession,
} from '@/lib/platform'

/** Logged once per process, not once per write. */
let warnedAboutTransactions = false

/**
 * The operations, bound to this request's database handle.
 *
 * The store is constructed with the staff member's own user id, which the
 * insert policy on `platform_support_sessions` then checks independently —
 * `staff_user_id = auth.uid()`. Two statements of the same rule, and the
 * database's is the one that counts.
 */
export function platformOperations(
  db: Db,
  session: PlatformSession,
): PlatformOperations {
  return definePlatformOperations(new SupabasePlatformStore(db, session.userId))
}

export function platformServices(db: Db): {
  services: OperationServices
  atomic: boolean
} {
  const { transactions, atomic } = runner(db)
  return {
    services: { audit: new SupabaseAuditWriter(db), transactions },
    atomic,
  }
}

/** A real transaction where the connection allows one, and an honest fallback. */
function runner(db: Db): {
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
        '[platform] DATABASE_URL is not set, so a console write and its audit ' +
          'event are two round trips rather than one transaction. An account ' +
          'could be suspended with no record of who did it; PartialCommitError ' +
          'will say which half survived. Point DATABASE_URL at the Supabase ' +
          'transaction pooler (port 6543) to restore atomicity.',
        cause.message,
      )
    }

    return { transactions: sequentialUnitOfWork(db), atomic: false }
  }
}

/**
 * The context for one console action against one organization.
 *
 * The actor is minted per target — see the header of
 * `src/lib/platform/actor.ts` — so it cannot be carried to a second customer,
 * and it holds `platform.*` grants and nothing else.
 */
export function platformOperationContext(input: {
  session: PlatformSession
  organizationId: string
  reason: string | null
  correlationId: string
}): OperationContext {
  return {
    actor: platformActorFor(input.session, input.organizationId),
    auditActor: platformAuditActor(input.session),
    correlationId: input.correlationId,
    reason: input.reason,
  }
}
