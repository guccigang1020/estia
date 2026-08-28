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
 *   `AgentRepository`    → `SupabaseAgentRepository`    (agents.ts)
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
 * ── What 0018–0023 unblocked ──────────────────────────────────────────────
 *
 * Five refusals this file used to list are gone, and each was closed by the
 * migration it asked for rather than by relaxing the refusal:
 *
 *   · **`AgentSettingsStore`** → `agent_organization_settings` (0019). The
 *     three ladders are enum columns with CHECK constraints, not jsonb, and
 *     the agent's *status* deliberately stays on `memberships`, named through
 *     a composite foreign key and read here by embedding it.
 *   · **`findUserByPhone`** → `user_profiles.phone_e164`, generated and
 *     globally unique, plus `find_user_id_by_phone(text)` — `security
 *     definer`, gated on `agent.invite`, returning a bare uuid (0020). Not the
 *     admin client, which would have handed this layer the whole table.
 *   · **`findPendingInvitation`** → `agent_invitations` (0019), which is a
 *     different table from `public.invitations` and always was.
 *   · **The commission base enum** → rebuilt with the six members of
 *     `COMMISSION_BASES`, `whole_booking` renamed to `stay_total` (0018). Both
 *     of the finance port's commission methods and the agent write path are
 *     open.
 *   · **`Invoice.paymentIds`** → `public.invoice_payments` (0022), carrying
 *     `booking_id` so both composite foreign keys name it. The jsonb array in
 *     `invoices.metadata` is no longer written or read; the rows must be
 *     backfilled *before* this code runs, or the link is lost.
 *   · **`WorkPlan`, `PreparationSnapshot`, `PreparationCatalogue`** → three
 *     tables (0021), not a projection onto `tasks`. `preparation_snapshots` is
 *     append-only by trigger, which is what keeps a March plan costing what it
 *     cost in March.
 *
 * ── Still not implemented, and exactly why ────────────────────────────────
 *
 * Each of these raises `SchemaNotProvisionedError` — never `null` and never an
 * empty array, because "nothing is configured yet" and "this deployment cannot
 * store the thing at all" need different responses and only one of them is a
 * bug in somebody's data.
 *
 * **`PreparationPorts.loadBooking`.** 0021 added the catalogue, the snapshot
 * and the plan and deliberately did not touch `bookings`. `PreparationBooking`
 * needs the event type, the extras and the sleeping arrangement, and there is
 * no column for any of them. A plan built for the wrong kind of stay is not
 * noticed until the linen runs out.
 *
 * **`PreparationPorts.loadAllocationContexts`.** What is missing here is the
 * *rule*, not the storage. `AllocationContext` is six measured facts about a
 * period, and deciding whether a cancelled booking counts as a booking or
 * whether revenue means gross or net changes the number on an owner's
 * statement. A mapping layer must not make those calls.
 *
 * **A commission owed to an agency and to no named person.** `commissions.
 * agent_user_id` is nullable — an agency keeps the relationship when the
 * individual leaves — and the agent domain's `Commission.agentUserId` is not.
 * The finance port's `Commission` models it correctly and is fine; the agent
 * port needs an agency-only variant before `agents.ts` can read such a row.
 * That is a gap in a domain type, not in the schema.
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
