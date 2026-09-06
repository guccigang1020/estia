/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Where the laundry domain meets the request.
 *
 * The same shape `finance/_lib/wiring.ts` has, and for the same reason: it
 * takes the request-scoped Supabase client — the one that runs as the signed-in
 * user under row level security — and builds the operations on top of it, so
 * that authorization, validation, the version check, the audit event and
 * idempotency are unskippable rather than remembered.
 *
 * ── NEVER IMPORT THIS FROM A CLIENT COMPONENT ─────────────────────────────
 *
 * It reaches `@/lib/persistence`, which reaches the `postgres` driver, which
 * imports `fs`. In a browser bundle that is not a broken page — it is every
 * page in the application returning 500 with `Can't resolve 'fs'`, for every
 * user, from one import. That happened on this dev server while the laundry
 * screens were being verified, caused by exactly this chain in another module.
 *
 * A form calls a Server Action in `actions.ts`; the action calls this. The
 * client never imports either. `src/lib/laundry/client-safety.test.ts` walks
 * the import graph and fails if it ever does.
 */

import type { Actor } from '@/lib/authz/can'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
  type Db,
} from '@/lib/persistence'
import type { OperationServices } from '@/lib/service'
import {
  SupabaseLaundryRepository,
  defineLaundryOrderOperations,
  laundryOperationPorts,
  type LaundryOperationPorts,
  type LaundryOrderOperations,
  type LaundryRepository,
} from '@/lib/laundry'
import { createClient } from '@/lib/supabase/server'

import { transactionRunner } from '../../_lib/wiring'
import { domainEventBus } from '../../_lib/events'

export type LaundryWiring = {
  db: Db
  operations: LaundryOrderOperations
  services: OperationServices
  /** False when the writes are sequential rather than one transaction. */
  atomic: boolean
}

/**
 * The adapter, bound to this request.
 *
 * It lives here rather than in `queries.ts` for a reason worth stating:
 * `createClient` reaches `src/lib/env.ts`, which validates at module load and
 * throws on a missing variable. A single import of it from `queries.ts` made
 * the deliberately database-free unit suite demand a Supabase project and
 * three secrets — `queries.test.ts` could not load at all. So `queries.ts`
 * constructs nothing and is handed a repository; this file, which already
 * builds clients and is never imported by a test, is where the construction
 * belongs. `src/lib/persistence/client.ts` makes the same argument for the
 * same reason.
 *
 * Always the request-scoped client, never the admin one: reaching for the
 * admin client because a read came back empty removes tenant isolation to fix
 * a permissions bug.
 */
export async function laundryRepository(): Promise<LaundryRepository> {
  return new SupabaseLaundryRepository(await createClient())
}

/**
 * The reads the operations perform, bound to this request and this tenant.
 *
 * ── This function used to hold two unscoped queries of its own ────────────
 *
 * It read `laundry_providers` filtered only by `id`, and `laundry_settings`
 * filtered only by `property_id is null` — which in an organization that is
 * not the reader's returns another business's standing note, and in demo mode,
 * where there is no policy engine at all, returns it to anybody. Both are gone.
 * `SupabaseLaundryRepository.messageContext` performs the same three reads with
 * `organization_id` in every one of them.
 *
 * `LaundryOperationPorts.loadOrder` takes an id and no organization, because
 * the pipeline hands an operation a resource id and nothing else. So the tenant
 * is closed over here, where the actor is known — which is the only place it
 * can be closed over honestly. An adapter that read the tenant off the row it
 * was about to return would be asking the row to vouch for itself.
 *
 * What `messageContext` still does NOT supply: no guest, no booking and no
 * price, because `MessageViewInput` has nowhere to put one. See the header of
 * `src/lib/laundry/message.ts`.
 */
export function laundryPorts(db: Db, actor: Actor): LaundryOperationPorts {
  return laundryOperationPorts(
    new SupabaseLaundryRepository(db),
    actor.organizationId,
  )
}

/**
 * The operations that act on an order that already exists.
 *
 * Deliberately not the creation half. Creating needs a `ConsolidatedRun` built
 * from preparation requirements, which no screen in this wave assembles — see
 * the report. Wiring a factory that needs an argument nobody has would mean
 * constructing an empty run, and an empty run is a silent zero-line order.
 */
export async function laundryOperations(actor: Actor): Promise<LaundryWiring> {
  const db = await createClient()
  const { transactions, atomic } = transactionRunner(db)

  return {
    db,
    operations: defineLaundryOrderOperations({
      db,
      ports: laundryPorts(db, actor),
    }),
    services: {
      audit: new SupabaseAuditWriter(db),
      events: domainEventBus(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
      onEventError: (error) => {
        // Reported, never rethrown. A notification that failed must not undo a
        // send that already reached the provider.
        console.error('[laundry] domain event delivery failed', error)
      },
    },
    atomic,
  }
}
