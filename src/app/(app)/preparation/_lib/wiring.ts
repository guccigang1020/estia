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
 * ── Read-only, so no unit of work ─────────────────────────────────────────
 *
 * The board reads plans and reads tasks. It builds nothing, saves nothing and
 * completes nothing, so there is no transaction to run, no audit writer to
 * inject and no idempotency store to build. `createPreparationOperations` is
 * deliberately not called here: it is the write side, it needs
 * `OperationServices`, and wiring it for a screen that performs no write would
 * be wiring a mechanism nobody can observe working.
 *
 * That is also why `loadBooking` and `loadAllocationContexts` never fire from
 * this screen. Both still raise `SchemaNotProvisionedError` — see the header
 * of `persistence/preparation.ts` — and both are reached only from
 * `buildPlan`, which is a write.
 *
 * Built per call rather than cached at module scope: the client carries the
 * caller's session, and one shared instance would be one shared identity.
 */

import { SupabasePreparationPorts, type Db } from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

export type PreparationWiring = {
  db: Db
  ports: SupabasePreparationPorts
}

export async function preparationWiring(): Promise<PreparationWiring> {
  const db = await createClient()
  return { db, ports: new SupabasePreparationPorts(db) }
}
