/**
 * A real transaction: `BEGIN`, the work, `COMMIT` — or nothing at all.
 *
 * This is the runner `transaction.ts` said did not exist. `sequentialUnitOfWork`
 * is still exported and still honest about what it is; this one is atomic, and
 * the difference is visible on the handle as `atomic: true` so a call site that
 * must not run without a transaction can refuse rather than hope.
 *
 * ############################################################################
 * # THE PART THAT MUST NOT BE GOT WRONG                                      #
 * #                                                                          #
 * # A direct connection is NOT the signed-in user. The pooler authenticates  #
 * # as the owner, which carries BYPASSRLS. Every statement on a fresh        #
 * # connection therefore runs as a superuser and every policy in 0004_rls    #
 * # is skipped — silently, with no error and no log line. Tenant isolation,  #
 * # the guarantee the entire product rests on, would be gone and nothing     #
 * # would look different.                                                    #
 * #                                                                          #
 * # `enterUserContext` below is what stops that, and `assertUserContext`     #
 * # proves it took effect before a single statement of the caller's work is  #
 * # allowed to run.                                                          #
 * ############################################################################
 *
 * ── How the connection becomes the user ───────────────────────────────────
 *
 * Exactly the shape `supabase/tests/isolation.sql` uses, because that file is
 * the reference and a second dialect of the same idea is a second thing to get
 * wrong:
 *
 *     select set_config('request.jwt.claims', <claims>, true);
 *     set local role authenticated;
 *
 * `set local`, so both unwind at `COMMIT` or `ROLLBACK` rather than living on
 * in a pooled connection that another tenant will borrow next. `request.jwt.claims`
 * is what `auth.uid()` reads, and `authenticated` is the role the policies are
 * written against — neither alone is enough. Claims without the role leaves
 * `BYPASSRLS` in place; the role without claims makes `auth.uid()` null, which
 * denies everything and would look like a broken feature rather than a broken
 * guard.
 *
 * ── The user id comes from the session, never from an argument ────────────
 *
 * `db.auth.getUser()`, which verifies the JWT with the auth server rather than
 * trusting a cookie's contents. A runner that took a `userId` parameter would
 * be a runner where one caller passing the wrong string reads another tenant's
 * books, and no policy would stop it because the policy would have been told
 * that *is* the user.
 *
 * **No session means no transaction.** A caller with no signed-in user gets an
 * error, never a connection running unrestricted. Background jobs and webhooks
 * genuinely have no user to act as; they need the admin client and a decision
 * taken deliberately each time, which is what `client.ts` already says.
 *
 * ── Bounded, and released on every path ───────────────────────────────────
 *
 * `statement_timeout` and `idle_in_transaction_session_timeout` are set inside
 * the transaction, so a wedged statement cannot hold row locks — and, on the
 * transaction pooler, cannot hold a pooler slot — indefinitely. Both are `set
 * local` for the same reason as the role.
 *
 * `postgres.js`'s `begin` issues `ROLLBACK` when the callback throws and
 * returns the connection to the pool on both paths, so the release is
 * structural rather than something a `finally` here has to remember.
 */

import { AppError } from '../errors'
import type { TransactionHandle, TransactionRunner } from '../service'
import type { Db } from './client'
import {
  databaseUrlFromEnv,
  looksLikeTransactionPooler,
  postgresPool,
  type PostgresPoolOptions,
  type TransactionSql,
} from './postgres'
import { TransactionClient } from './postgrest-sql'
import type { SupabaseUnitOfWork } from './transaction'

/** Long enough for the largest unit of work here; short enough to not wedge. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 8_000
/** A transaction sitting idle is a bug; it must not hold locks while it does. */
const DEFAULT_IDLE_TIMEOUT_MS = 10_000

export interface PostgresUnitOfWorkOptions {
  /** Defaults to `DATABASE_URL`. */
  url?: string
  statementTimeoutMs?: number
  idleInTransactionTimeoutMs?: number
  pool?: PostgresPoolOptions
}

/**
 * The atomic runner could not be built. Never a silent fallback to the
 * sequential one: a caller that asked for atomicity and did not get it must
 * find out now, not from a half-written booking next week.
 */
export class AtomicTransactionUnavailableError extends AppError {
  constructor(reason: string, cause?: unknown) {
    super({
      code: 'atomic_transaction_unavailable',
      status: 500,
      message: `No atomic transaction could be opened: ${reason}`,
      userMessage:
        'אירעה תקלה במערכת ולכן הפעולה לא בוצעה. נסה שוב בעוד מספר רגעים.',
      retryable: false,
      // Nothing ran, so nothing was written. Saying so is the whole point of
      // the field: the caller can retry without checking anything first.
      dataOutcome: 'not_saved',
      cause,
    })
  }
}

/**
 * The connection did not become the user, and the work was not run.
 *
 * Separate from the class above because the two mean different things to
 * whoever reads the incident: one is "the database was unreachable", this one
 * is "the database was reachable and we were about to talk to it as a
 * superuser". The second is a security event.
 */
export class TenantContextError extends AppError {
  constructor(detail: string) {
    super({
      code: 'tenant_context_not_established',
      status: 500,
      message:
        `Refusing to run a transaction: ${detail}. The connection would have ` +
        `run with BYPASSRLS, so no row level security policy would have ` +
        `applied to any statement in it.`,
      userMessage:
        'אירעה תקלה במערכת ולכן הפעולה לא בוצעה. נסה שוב בעוד מספר רגעים.',
      retryable: false,
      dataOutcome: 'not_saved',
    })
  }
}

/** A whole number of milliseconds, because `SET` cannot take a parameter. */
function timeoutLiteral(milliseconds: number, name: string): string {
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
    throw new AtomicTransactionUnavailableError(
      `${name} must be a positive whole number of milliseconds`,
    )
  }
  return String(milliseconds)
}

/**
 * The claims GoTrue would have set, for the user this session actually is.
 *
 * `sub` is what `auth.uid()` reads and `role` is what `auth.role()` reads;
 * both are required by policies in this schema. `email` and `aud` are included
 * because `auth.jwt()` is a documented thing for a policy to read and an
 * absent key there is a policy that behaves differently over a direct
 * connection than over PostgREST — a difference that would only ever be found
 * in production.
 */
function claimsFor(userId: string, email: string | null): string {
  const claims: Record<string, string> = {
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
  }
  if (email) claims.email = email
  return JSON.stringify(claims)
}

/**
 * Become the user, for the life of this transaction only.
 *
 * Order matters. The claims are set while still privileged, because a role
 * with no rights to the GUC could not set them; the role switch is last, and
 * from that statement on every read and write is the user's.
 */
interface Timeouts {
  statement: string
  idle: string
}

async function enterUserContext(
  tx: TransactionSql,
  userId: string,
  email: string | null,
  timeouts: Timeouts,
): Promise<void> {
  const { statement: statementTimeout, idle: idleTimeout } = timeouts

  await tx.unsafe(`set local statement_timeout = ${statementTimeout}`)
  await tx.unsafe(
    `set local idle_in_transaction_session_timeout = ${idleTimeout}`,
  )
  await tx.unsafe('select set_config($1, $2, true)', [
    'request.jwt.claims',
    claimsFor(userId, email),
  ] as never[])
  await tx.unsafe('set local role authenticated')
}

/**
 * Prove it took.
 *
 * One round trip, run before any of the caller's work, and worth every
 * microsecond: the failure this catches is invisible by construction. If the
 * role did not switch, `current_user` is still the owner and every policy is
 * being skipped. If the claims did not land, `auth.uid()` is null and the
 * transaction would deny everything — which is safe, but is a fault worth
 * naming rather than surfacing as an empty calendar.
 */
async function assertUserContext(
  tx: TransactionSql,
  userId: string,
): Promise<void> {
  const rows = await tx.unsafe(
    `select current_user::text as role, ` +
      `coalesce(auth.uid()::text, '') as uid, ` +
      `(select rolbypassrls from pg_roles where rolname = current_user) as bypassrls`,
  )
  const row = rows[0] as
    { role?: unknown; uid?: unknown; bypassrls?: unknown } | undefined

  if (!row) throw new TenantContextError('the context probe returned no rows')
  if (row.role !== 'authenticated') {
    throw new TenantContextError(
      `current_user is '${String(row.role)}', not 'authenticated'`,
    )
  }
  if (row.bypassrls === true) {
    throw new TenantContextError('the effective role still carries BYPASSRLS')
  }
  if (row.uid !== userId) {
    throw new TenantContextError(
      `auth.uid() is '${String(row.uid)}', not the signed-in user`,
    )
  }
}

/**
 * The signed-in user, verified.
 *
 * `getUser()` and never `getSession()`: the latter returns whatever the cookie
 * claims without checking it, and the whole security of this file is that the
 * id it puts in `sub` is the id of the person actually making the request.
 */
async function currentUser(
  db: Db,
): Promise<{ id: string; email: string | null }> {
  let result
  try {
    result = await db.auth.getUser()
  } catch (error) {
    throw new AtomicTransactionUnavailableError(
      'the signed-in user could not be verified',
      error,
    )
  }

  const user = result.data?.user
  if (result.error || !user) {
    throw new AtomicTransactionUnavailableError(
      'there is no signed-in user. A direct connection with no session would ' +
        'run as the owner with BYPASSRLS, so it is refused. Background work ' +
        'with no user needs the admin client and a deliberate decision',
      result.error,
    )
  }
  return { id: user.id, email: user.email ?? null }
}

/**
 * A `TransactionRunner` that really is one.
 *
 * The Supabase client is still required, and is not decoration: it is where
 * the session comes from, and it remains the client for everything that runs
 * *outside* a unit of work.
 */
export function postgresUnitOfWork(
  db: Db,
  options: PostgresUnitOfWorkOptions = {},
): TransactionRunner {
  const url = options.url ?? databaseUrlFromEnv()
  if (!url) {
    throw new AtomicTransactionUnavailableError(
      'DATABASE_URL is not set. It must point at the Supabase transaction ' +
        'pooler (port 6543) — see the header of postgres.ts for why session ' +
        'mode is not a substitute',
    )
  }
  if (!looksLikeTransactionPooler(url)) {
    // A warning and not a refusal: a self-hosted deployment can put the
    // transaction pooler on any port, and refusing would make this unusable
    // there. What it catches is the common mistake — port 5432 — where a
    // session setting outlives the request that made it.
    console.warn(
      '[persistence] DATABASE_URL does not look like the Supabase transaction ' +
        'pooler (port 6543). Session-mode and direct connections keep session ' +
        'state between borrowers; see src/lib/persistence/postgres.ts.',
    )
  }

  // Validated here rather than inside the transaction, so a bad value fails
  // before a socket is opened instead of after `BEGIN`. These two are the only
  // numbers in this layer that are interpolated rather than bound — `SET`
  // cannot take a parameter — which is exactly why they are checked.
  const timeouts: Timeouts = {
    statement: timeoutLiteral(
      options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      'statementTimeoutMs',
    ),
    idle: timeoutLiteral(
      options.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      'idleInTransactionTimeoutMs',
    ),
  }

  const pool = postgresPool(url, options.pool)

  return {
    async run<T>(work: (tx: TransactionHandle) => Promise<T>): Promise<T> {
      const user = await currentUser(db)

      return pool.begin(async (tx) => {
        await enterUserContext(tx, user.id, user.email, timeouts)
        await assertUserContext(tx, user.id)

        const committed: string[] = []
        const client = new TransactionClient(tx)

        const handle: SupabaseUnitOfWork = {
          kind: 'supabase-unit-of-work',
          db: client.asDb(),
          committed,
          // The flag `sequentialUnitOfWork` sets to false. Here it is earned:
          // a throw from `work` propagates out of `begin`, which issues
          // ROLLBACK, and nothing in `committed` survives.
          atomic: true,
          record(label: string) {
            committed.push(label)
          },
        }

        // No try/catch. A throw must escape so postgres.js rolls back, and
        // wrapping it in `PartialCommitError` — which `sequentialUnitOfWork`
        // is right to do — would be a lie here: there is no partial commit to
        // report, because there is no commit.
        return work(handle)
      }) as Promise<T>
    },
  }
}
