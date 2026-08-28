/**
 * `IdempotencyStore`, backed by `public.idempotency_keys`.
 *
 * ── `begin` is one statement ──────────────────────────────────────────────
 *
 * This is the whole reason the two-phase design exists, and `idempotency.ts`
 * in the service layer states it as a requirement rather than a preference:
 * "Must be a single statement in the real implementation. A `select` followed
 * by an `insert` reintroduces exactly the race this exists to close."
 *
 * So the reservation is:
 *
 *     insert into idempotency_keys (...) values (...)
 *       on conflict (organization_id, operation, key) do nothing
 *       returning *
 *
 * — reached through `upsert(..., { ignoreDuplicates: true })`, which is how
 * PostgREST spells `ON CONFLICT DO NOTHING`. One statement, decided by the
 * unique constraint `idempotency_keys_scope_key`. Two requests eight
 * milliseconds apart both run it; exactly one gets a row back.
 *
 * A row back means the key is now held by this attempt: `reserved`.
 *
 * **No row back means somebody else already holds it — and only then is a
 * `select` run**, to say *which* of the three refusals it is. That read cannot
 * reopen the race, because the race was already decided by the insert above
 * it. What is being read is not "may I proceed" — that question has been
 * answered, and the answer was no — but "why not", which is a question about a
 * row that is now guaranteed to exist.
 *
 * ── What a replay actually returns ────────────────────────────────────────
 *
 * `result` is a `jsonb` column, so a replayed result is JSON, not the original
 * object. A `Date` in a result comes back as an ISO string and a `Map` comes
 * back as `{}`. This is a real difference from `InMemoryIdempotencyStore`,
 * which hands back the identical object reference, and it is not one this
 * adapter can paper over: an operation whose result must survive a replay has
 * to return JSON-shaped data. Worth knowing before wiring a result type with a
 * `Date` in it to a route that clients retry.
 *
 * ── Expiry ────────────────────────────────────────────────────────────────
 *
 * Rows carry `expires_at` and are swept by `purge_expired_idempotency_keys()`.
 * This adapter deliberately does *not* filter reads by expiry: the unique
 * constraint does not know about `expires_at`, so a row past its expiry still
 * blocks the insert, and treating it as absent on the read would report
 * `reserved` for a key that was not reserved. Present is present. The sweeper
 * is what makes a key reusable, and it is the database's job.
 */

import type {
  IdempotencyBegin,
  IdempotencyRecord,
  IdempotencyScope,
  IdempotencyStore,
} from '../service'
import type { Db, Row } from './client'
import { asDate, asDateOrNull, asString, toRow } from './mapping'

const COLUMNS =
  'organization_id, operation, key, fingerprint, result, created_at, completed_at'

export class SupabaseIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Db) {}

  async begin(
    scope: IdempotencyScope,
    key: string,
    fingerprint: string,
  ): Promise<IdempotencyBegin> {
    const { data, error } = await this.db
      .from('idempotency_keys')
      .upsert(
        {
          organization_id: scope.organizationId,
          operation: scope.operation,
          key,
          fingerprint,
          // Left unset: `result` stays null and `completed_at` stays null,
          // which is precisely the "reserved, not finished" state, and
          // `expires_at` takes its one-hour default. The trigger
          // `tg_idempotency_extend_on_complete` stretches that to 24 hours the
          // moment the operation completes, so a reservation abandoned by a
          // crashed process frees itself within the hour while a real answer
          // stays replayable for a day.
        },
        {
          onConflict: 'organization_id,operation,key',
          // `ON CONFLICT DO NOTHING`. Not `do update`: overwriting the row
          // would hand the key to the second caller and let both proceed,
          // which is the failure this table exists to prevent.
          ignoreDuplicates: true,
        },
      )
      .select(COLUMNS)

    if (error) throw error

    // One row: this attempt won the insert and now holds the key.
    if (data && data.length > 0) return { status: 'reserved' }

    // No row: somebody else holds it. Now — and only now — find out who.
    const existing = await this.load(scope, key)
    if (!existing) {
      // Vanishingly rare and worth being honest about: the holder abandoned
      // the key between the insert and this read. Nobody holds it now, but
      // this attempt does not hold it either, and claiming `reserved` would be
      // a lie that lets the work run unprotected. `in_flight` sends the caller
      // to retry, which will reserve cleanly.
      return {
        status: 'in_flight',
        record: placeholder(scope, key, fingerprint),
      }
    }

    // Order matters and matches the in-memory reference exactly: a different
    // request under the same key is a mismatch *before* it is anything else.
    // A caller who reused "retry-1" for a new booking must be refused, not
    // handed the previous booking's result.
    if (existing.fingerprint !== fingerprint) {
      return { status: 'mismatch', record: existing }
    }
    if (existing.completedAt === null) {
      return { status: 'in_flight', record: existing }
    }
    return { status: 'replayed', record: existing }
  }

  async complete(
    scope: IdempotencyScope,
    key: string,
    result: unknown,
  ): Promise<void> {
    const { error } = await this.db
      .from('idempotency_keys')
      .update({
        // `null`, not `undefined`: an operation returning nothing has still
        // completed, and the column has to say so.
        result: result === undefined ? null : result,
        completed_at: new Date().toISOString(),
      })
      .eq('organization_id', scope.organizationId)
      .eq('operation', scope.operation)
      .eq('key', key)

    if (error) throw error
    // No row-count check, matching `InMemoryIdempotencyStore.complete`, which
    // returns quietly when the record is gone. Completing a reservation that
    // has been swept is not a failure worth turning a successful operation
    // into a failed one over — the work is done and committed either way.
  }

  async abandon(scope: IdempotencyScope, key: string): Promise<void> {
    const { error } = await this.db
      .from('idempotency_keys')
      .delete()
      .eq('organization_id', scope.organizationId)
      .eq('operation', scope.operation)
      .eq('key', key)

    if (error) throw error
  }

  private async load(
    scope: IdempotencyScope,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const { data, error } = await this.db
      .from('idempotency_keys')
      .select(COLUMNS)
      .eq('organization_id', scope.organizationId)
      .eq('operation', scope.operation)
      .eq('key', key)
      .maybeSingle()

    if (error) throw error
    if (!data) return null
    return toRecord(toRow(data))
  }
}

function toRecord(row: Row): IdempotencyRecord {
  return {
    organizationId: asString(row, 'organization_id'),
    operation: asString(row, 'operation'),
    key: asString(row, 'key'),
    fingerprint: asString(row, 'fingerprint'),
    // `result` is `unknown` in the domain, so it is carried through untouched.
    result: row.result ?? undefined,
    createdAt: asDate(row, 'created_at'),
    completedAt: asDateOrNull(row, 'completed_at'),
  }
}

/**
 * A record for the holder that disappeared while we were looking.
 *
 * The caller only reads `record` for reporting, and the pipeline turns
 * `in_flight` into an `IdempotencyConflictError` without touching it. Inventing
 * a `completedAt` here would be worse than the placeholder: it would make the
 * missing row look like a finished one.
 */
function placeholder(
  scope: IdempotencyScope,
  key: string,
  fingerprint: string,
): IdempotencyRecord {
  return {
    organizationId: scope.organizationId,
    operation: scope.operation,
    key,
    fingerprint,
    result: undefined,
    createdAt: new Date(),
    completedAt: null,
  }
}
