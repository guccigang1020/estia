/**
 * The persistence layer, in one import.
 *
 * Every port in this codebase is declared as an interface and, until now, had
 * exactly one implementation: an in-memory double. This directory is the other
 * one. Nothing here decides anything — the value in each domain is its rules,
 * and those live above this line and are tested without a database. What is
 * here is mapping, and the mapping is where the interesting mistakes are.
 *
 * ── Wiring ────────────────────────────────────────────────────────────────
 *
 *     import { createClient } from '@/lib/supabase/server'
 *     import {
 *       SupabaseActorSource,
 *       SupabaseAuditWriter,
 *       SupabaseBookingRepository,
 *       SupabaseIdempotencyStore,
 *       sequentialUnitOfWork,
 *     } from '@/lib/persistence'
 *
 *     const db = await createClient()          // the signed-in user's session
 *     const services = {
 *       audit: new SupabaseAuditWriter(db),
 *       idempotency: new SupabaseIdempotencyStore(db),
 *       transactions: sequentialUnitOfWork(db), // NOT atomic — read below
 *     }
 *
 * The client is always passed in. No adapter constructs one and no adapter
 * imports `@/lib/env`, so importing any of this from a test does not require a
 * Supabase project or a single secret.
 *
 * ============================================================================
 * WHAT IS WIRED, AND WHAT IS NOT
 * ============================================================================
 *
 * ── Implemented ───────────────────────────────────────────────────────────
 *
 *   `ActorSource`        → `SupabaseActorSource`        (actor.ts)
 *   `AuditWriter`        → `SupabaseAuditWriter`        (audit.ts)
 *   `IdempotencyStore`   → `SupabaseIdempotencyStore`   (idempotency.ts)
 *   `BookingRepository`  → `SupabaseBookingRepository`  (booking.ts)
 *     — which is `AvailabilitySource` + `BookingStore` + `HoldStore`
 *   `MetricSource`       → `SupabaseMetricSource`       (metrics.ts)
 *
 * ── Not implemented, and why ──────────────────────────────────────────────
 *
 * The schema moved during this work — `0013`–`0016` were applied to the live
 * project while these files were being written — so read the note against each
 * one rather than assuming. Where a port is absent because no table existed,
 * that is a gap in the schema and not in the effort: an adapter that stored a
 * domain concept in a `metadata` jsonb blob because no column existed would be
 * deciding the shape of the money schema by the back door.
 *
 * **`TransactionRunner` — no atomic implementation exists, anywhere.**
 * `sequentialUnitOfWork` is exported and is named for what it does. Read the
 * header of `transaction.ts` before wiring a booking or a payment to it: the
 * reason is structural, not lazy, and there are exactly two real fixes.
 *
 * **`FinanceRepository` and `AgentRepository` — buildable now; they were not
 * when this work started.** Migrations `0013`–`0016` landed while this
 * directory was being written and added, among others, `finance_snapshots`,
 * `invoice_lines`, `credit_note_lines`, `payment_provider_events`,
 * `payment_schedules`, `expense_rules`, `agencies`,
 * `agent_commission_rules` and `commission_statements` — precisely the storage
 * whose absence made these two ports unimplementable. They are the obvious
 * next piece of work and nothing about them is blocked any more; they are
 * absent here because the schema arrived after the plan did, and guessing at
 * fourteen new tables without reading them would be the opposite of what the
 * rest of this directory does.
 *
 * Two things a future implementer should not have to rediscover:
 *
 *   · **The finance domain pre-increments `version`.** `payments.ts` returns
 *     `version: payment.version + 1` before the record reaches the
 *     repository, and the database increments it *again* in `tg_touch_row`.
 *     The optimistic-lock predicate is therefore
 *     `where version = payment.version - 1`, not `= payment.version`. Getting
 *     that backwards produces a repository that conflicts on every update, or
 *     one that never conflicts at all — and the second failure is silent.
 *
 *   · **`finance_snapshots` is insert-only, enforced by a statement-level
 *     trigger.** That means a `DELETE` on `bookings` fails even for a booking
 *     with no snapshot, because the cascade attempts the delete and the
 *     trigger refuses the statement. Anything that creates test bookings has
 *     to plan its teardown around this.
 *
 * **`PreparationPorts` — no storage exists for any of it, still.** `WorkPlan`,
 * `PreparationSnapshot` and `PreparationCatalogue` have no tables in any
 * migration up to `0016`. `tasks`, `task_checklists` and `inventory_items` are
 * adjacent and are not the same things: a work plan is a versioned computed
 * artefact with a frozen snapshot, and projecting it onto a task list would
 * lose the snapshot — which is the entire mechanism preventing historical
 * drift, and the reason `operations.ts` has no `loadCatalogue(bookingId)`.
 * `loadStock` alone could be served from `inventory_items` today.
 *
 * ── One thing to know before reading any adapter ──────────────────────────
 *
 * Every query runs as the signed-in user under row level security, and that is
 * load-bearing rather than incidental. Several reads here return less to a
 * less-privileged caller *by design*: `booking_price_lines` needs
 * `booking.view_price`, `guests` needs `guest.view`. A `BookingSnapshot` is
 * therefore not automatically a complete one, and the adapters say so where it
 * happens. Reaching for the admin client to make one of those reads "work"
 * would delete the tenant isolation the whole system rests on.
 */

export { SupabaseActorSource } from './actor'
export { SupabaseAuditWriter } from './audit'
export { SupabaseBookingRepository } from './booking'
export { SupabaseIdempotencyStore } from './idempotency'
export { SupabaseMetricSource } from './metrics'

export type { Db, PostgrestError, Row } from './client'

export {
  OCCUPANCY_EXCLUSION_CONSTRAINT,
  PG_ERROR,
  PartialCommitError,
  SchemaNotProvisionedError,
  isOccupancyConflict,
  isPostgrestError,
  translateWriteError,
  type PostgrestErrorLike,
  type TranslateOptions,
} from './errors'

export {
  RowShapeError,
  asAgorot,
  asBoolean,
  asDate,
  asDateOrNull,
  asEnum,
  asEnumOrNull,
  asIsoDate,
  asIsoDateOrNull,
  asJsonRecord,
  asNumber,
  asNumberOrNull,
  asString,
  asStringArray,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  definedOnly,
  nullToUndefined,
  toRow,
  toRows,
  undefinedToNull,
} from './mapping'

export {
  clientFor,
  isSupabaseUnitOfWork,
  recordWrite,
  sequentialUnitOfWork,
  type SupabaseUnitOfWork,
} from './transaction'
