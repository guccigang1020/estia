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

import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
  type Db,
} from '@/lib/persistence'
import type { OperationServices } from '@/lib/service'
import {
  defineLaundryOrderOperations,
  type LaundryOperationPorts,
  type LaundryOrderOperations,
} from '@/lib/laundry'
import { createClient } from '@/lib/supabase/server'

import { transactionRunner } from '../../_lib/wiring'
import { loadOrder, propertyNames } from './queries'

export type LaundryWiring = {
  db: Db
  operations: LaundryOrderOperations
  services: OperationServices
  /** False when the writes are sequential rather than one transaction. */
  atomic: boolean
}

/**
 * The reads the operations perform, bound to this request.
 *
 * `loadOrder` goes through the same query the screens use, so an operation can
 * never act on a row a screen could not have shown — row level security
 * narrows both identically because it is one query.
 *
 * `messageContext` supplies everything the renderer needs that is not on the
 * order. Note what it does NOT supply: there is no guest, no booking and no
 * price, because `MessageViewInput` has nowhere to put one. See the header of
 * `src/lib/laundry/message.ts`.
 */
export function laundryPorts(organizationName: string): LaundryOperationPorts {
  return {
    async loadOrder(orderId) {
      const { order } = await loadOrder(orderId)
      return order
    },

    async messageContext(order) {
      const supabase = await createClient()

      // The provider's own contact details, read here rather than passed in,
      // because only a caller holding `laundry.provider_manage` can read them
      // and the send operation is gated on `laundry.order_send`. A person who
      // may send but may not manage providers gets a message with no contact
      // line rather than a failed send.
      const { data } = order.providerId
        ? await supabase
            .from('laundry_providers')
            .select('contact_name, phone')
            .eq('id', order.providerId)
            .maybeSingle()
        : { data: null }

      const contact = data as {
        contact_name: string | null
        phone: string | null
      } | null

      const { data: settings } = await supabase
        .from('laundry_settings')
        .select('standing_notes')
        .is('property_id', null)
        .maybeSingle()

      return {
        organizationName,
        propertyNames: await propertyNames(),
        contactName: contact?.contact_name ?? null,
        contactPhone: contact?.phone ?? null,
        standingNotes:
          (settings as { standing_notes: string | null } | null)
            ?.standing_notes ?? null,
      }
    },
  }
}

/**
 * The operations that act on an order that already exists.
 *
 * Deliberately not the creation half. Creating needs a `ConsolidatedRun` built
 * from preparation requirements, which no screen in this wave assembles — see
 * the report. Wiring a factory that needs an argument nobody has would mean
 * constructing an empty run, and an empty run is a silent zero-line order.
 */
export async function laundryOperations(
  organizationName: string,
): Promise<LaundryWiring> {
  const db = await createClient()
  const { transactions, atomic } = transactionRunner(db)

  return {
    db,
    operations: defineLaundryOrderOperations({
      db,
      ports: laundryPorts(organizationName),
    }),
    services: {
      audit: new SupabaseAuditWriter(db),
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
