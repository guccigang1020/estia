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
 *       postgresUnitOfWork,
 *     } from '@/lib/persistence'
 *
 *     const db = await createClient()          // the signed-in user's session
 *     const services = {
 *       audit: new SupabaseAuditWriter(db),
 *       idempotency: new SupabaseIdempotencyStore(db),
 *       transactions: postgresUnitOfWork(db),  // atomic — see below
 *     }
 *
 * `postgresUnitOfWork` needs `DATABASE_URL` pointing at the Supabase
 * **transaction pooler** (port 6543) and refuses to run without a signed-in
 * user. `sequentialUnitOfWork` is still exported for the cases that genuinely
 * have no session — a webhook, a nightly sweep — and is still not a
 * transaction.
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
 *   `FinanceRepository`  → `SupabaseFinanceRepository`  (finance.ts)
 *   `AgentRepository`    → `SupabaseAgentRepository`    (agents.ts), partly
 *   `PreparationPorts`   → `SupabasePreparationPorts`   (preparation.ts), partly
 *   `TransactionRunner`  → `postgresUnitOfWork`         (atomic-transaction.ts)
 *
 * ── Atomicity ─────────────────────────────────────────────────────────────
 *
 * **There is a real transaction now.** `postgresUnitOfWork` opens a direct
 * connection through the transaction pooler, runs `BEGIN`, makes the connection
 * *be* the signed-in user with `set local role authenticated` plus
 * `set local request.jwt.claims`, and commits or rolls back as one unit.
 * `postgrest-sql.ts` compiles the same builder every adapter here already uses
 * into SQL on that connection, so no adapter needed a second implementation and
 * none can tell which client it is holding.
 *
 * Read `atomic-transaction.ts` before touching any of it. The failure it guards
 * against is invisible by construction: a direct connection that has not been
 * made the user runs as the owner, with `BYPASSRLS`, and every policy in
 * `0004_rls` is skipped in silence.
 *
 * ── Still not implemented, and exactly why ────────────────────────────────
 *
 * Each of these raises `SchemaNotProvisionedError` — never `null` and never an
 * empty array, because "nothing is configured yet" and "this deployment cannot
 * store the thing at all" need different responses and only one of them is a
 * bug in somebody's data.
 *
 * **`AgentSettingsStore`** — no `agent_organization_settings` table exists in
 * any migration to 0017. `AgentOrganizationSettings` carries the access,
 * inventory, discount and hold ladders plus a reputation score;
 * `public.memberships` holds the relationship and none of the terms. The rest
 * of `AgentRepository` is implemented: the hold ledger is `public.holds` (0015
 * folded it in and deleted the need for a second table), commissions and their
 * rules are real tables, and discount approvals are `public.approvals`.
 *
 * **`AgentDirectory.findUserByPhone` and `findPendingInvitation`.** The first
 * because `user_profiles.phone` is free text with no E.164 column, and because
 * the question is global while RLS is not — so every answer this layer could
 * give would be a *wrong* "no such user", which sends `identity.ts` down the
 * invite branch and creates a second identity for a person who already has one.
 * It needs a `security definer` lookup that returns a user id and nothing else.
 * The second because `public.invitations` is keyed on email with a role, and
 * carries neither the phone number that is the agent identity nor the ladders
 * acceptance grants.
 *
 * **The commission base enum.** `public.commission_base` has two members,
 * `whole_booking` and `accommodation_only`. `COMMISSION_BASES` in
 * `src/lib/contracts/states.ts` now has six, and `whole_booking` is not one of
 * them. So `stay_total` cannot be stored, and a stored `whole_booking` is not a
 * value any TypeScript union accepts. The finance port's two commission methods
 * are blocked on it outright; the agent side refuses an unstorable base up
 * front rather than letting a raw `22P02` surface from inside a write. One
 * `alter type … add value` per missing member, plus a data migration for the
 * existing rows, closes it.
 *
 * **`PreparationPorts`, except stock.** `WorkPlan`, `PreparationSnapshot` and
 * `PreparationCatalogue` still have no tables. `tasks` is adjacent and is not
 * the same thing: a work plan is a versioned computed artefact with a frozen
 * snapshot beside it, and that snapshot is the entire mechanism preventing
 * historical drift — which is why `operations.ts` deliberately has no
 * `loadCatalogue(bookingId)`. `loadStock` and `loadTransferrableStock` are
 * served from `inventory_items`.
 *
 * **`Invoice.paymentIds`** has no join table and is carried in
 * `invoices.metadata`. That one is a stopgap rather than a refusal, because the
 * alternative was an invoice that silently forgot which payments it accounted
 * for; `finance.ts` flags it and names the table it wants.
 *
 * Two things a future implementer should not have to rediscover:
 *
 *   · **The finance domain pre-increments `version`.** `payments.ts` returns
 *     `version: payment.version + 1` before the record reaches the repository,
 *     and the database increments it *again* in `tg_touch_row`. The
 *     optimistic-lock predicate is therefore
 *     `where version = payment.version - 1`, not `= payment.version`. Getting
 *     that backwards produces a repository that conflicts on every update, or
 *     one that never conflicts at all — and the second failure is silent.
 *
 *   · **`finance_snapshots` is insert-only**, enforced by a statement-level
 *     trigger. A `DELETE` on `bookings` therefore fails even for a booking with
 *     no snapshot, because the cascade attempts the delete and the trigger
 *     refuses the statement. Anything that creates test bookings has to plan
 *     its teardown around this.
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

export { MEMBERSHIP_STATUSES, SupabaseActorSource } from './actor'
export { SupabaseAgentRepository } from './agents'
export { SupabaseAuditWriter } from './audit'
export { SupabaseBookingRepository } from './booking'
export { SupabaseIdempotencyStore } from './idempotency'
export { SupabaseFinanceRepository } from './finance'
export { SupabaseMetricSource } from './metrics'
export { SupabasePreparationPorts } from './preparation'

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
  AtomicTransactionUnavailableError,
  TenantContextError,
  postgresUnitOfWork,
  type PostgresUnitOfWorkOptions,
} from './atomic-transaction'

export {
  closeAllPostgresPools,
  closePostgresPool,
  databaseUrlFromEnv,
  looksLikeTransactionPooler,
  postgresPool,
  type PostgresPoolOptions,
  type Sql,
  type TransactionSql,
} from './postgres'

export {
  TransactionClient,
  UnsupportedQuery,
  compile,
  parseSelect,
  type Compiled,
  type QuerySpec,
} from './postgrest-sql'

export {
  clientFor,
  isSupabaseUnitOfWork,
  recordWrite,
  sequentialUnitOfWork,
  type SupabaseUnitOfWork,
} from './transaction'
