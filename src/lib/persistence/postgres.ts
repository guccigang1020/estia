/**
 * The direct Postgres connection, and the two things it must not get wrong.
 *
 * PostgREST is stateless HTTP: every request is its own implicit transaction,
 * so a JavaScript closure cannot run between a `BEGIN` and a `COMMIT` over it.
 * `transaction.ts` says so at length and it is still true. The fix chosen here
 * is the second of the two it names — a real connection, real SQL, real
 * transaction — and this file is the connection half of it.
 *
 * ============================================================================
 * 1 · WHICH POOLER, AND WHY IT IS NOT A DETAIL
 * ============================================================================
 *
 * Supabase offers three ways in, and they are not interchangeable:
 *
 *   · **Direct** (`db.<ref>.supabase.co:5432`) — one real backend per client
 *     connection. IPv6-only on new projects, and a serverless deployment
 *     opening one backend per concurrent function instance exhausts
 *     `max_connections` long before it exhausts anything else. Wrong here.
 *
 *   · **Session mode** (`…pooler.supabase.com:5432`) — a pooled connection is
 *     assigned to a client for the whole life of that client. Session state
 *     survives: `SET`, `SET ROLE`, prepared statements, advisory locks.
 *
 *   · **Transaction mode** (`…pooler.supabase.com:6543`) — a pooled connection
 *     is assigned for the duration of *one transaction* and then handed back.
 *
 * **This code needs transaction mode, and the reason is security rather than
 * capacity.** The unit of work sets a role and a set of JWT claims so that RLS
 * treats the connection as the signed-in user. Under session mode those
 * settings live as long as the client holds the connection, and one leaked
 * `SET ROLE`, or one `set` that was not `set local`, is a connection that the
 * next borrower inherits — a different tenant, already authenticated as
 * somebody else. Under transaction mode the connection is returned at
 * `COMMIT`, and `set local` has already unwound everything by then. The two
 * mechanisms agree: nothing about one request can reach the next.
 *
 * Capacity points the same way. Next.js route handlers are short-lived and
 * numerous; holding a session-mode connection open across the idle time
 * between two requests is exactly the waste the transaction pooler exists to
 * remove.
 *
 * The cost of transaction mode is that **named prepared statements do not
 * work** — a `PREPARE` issued on one borrowed connection is not there on the
 * next. Hence `prepare: false` below. It is not a performance nicety to be
 * tidied away later; turning it on produces intermittent
 * `prepared statement "…" does not exist` under load and nothing else.
 *
 * ============================================================================
 * 2 · THE CONNECTION IS NOT THE USER
 * ============================================================================
 *
 * The role in the connection string owns the schema and carries `BYPASSRLS`.
 * A statement run on a fresh connection is therefore a statement run by a
 * superuser, and every policy in `0004_rls.sql` is skipped in silence. Tenant
 * isolation — the guarantee the whole product rests on — would evaporate with
 * no error, no log line and no failing test.
 *
 * Nothing in *this* file may be used without the preamble in
 * `atomic-transaction.ts`, which is why this file exports a connection factory
 * and not a query function. There is deliberately no `query()` here to call.
 *
 * ============================================================================
 * 3 · LIFETIME
 * ============================================================================
 *
 * One pool per process, memoised on the URL. In a serverless runtime a process
 * is an instance that handles many requests before it is frozen, so a pool
 * that is rebuilt per request would pay a TLS handshake every time and hold
 * more connections than it uses. `max` is small on purpose: the pooler is the
 * pool, and a large client-side pool in front of it just moves the queue.
 *
 * `idle_timeout` closes sockets an idle instance is no longer using, which is
 * what stops a frozen Lambda from holding pooler slots it will never use
 * again.
 */

import postgres from 'postgres'

/** The transaction-scoped connection handed to a unit of work. */
export type Sql = postgres.Sql
/** A transaction-scoped handle, as `sql.begin` yields it. */
export type TransactionSql = postgres.TransactionSql

export interface PostgresPoolOptions {
  /**
   * Connections this process will open through the pooler.
   *
   * Deliberately small. The pooler multiplexes for us, so the only thing a
   * large client pool adds is the number of sockets an idle instance holds.
   */
  max?: number
  /** Seconds an unused socket is kept before it is closed. */
  idleTimeout?: number
  /** Seconds to wait for a connection before failing loudly. */
  connectTimeout?: number
}

const DEFAULTS = {
  max: 3,
  idleTimeout: 20,
  connectTimeout: 10,
} as const

/**
 * The URL of the transaction pooler, read lazily.
 *
 * Lazily, and never through `@/lib/env`: that module validates at import and
 * throws on a missing variable, so importing it here would make the
 * deliberately database-free unit suite require a Supabase project. Every
 * other file in this directory takes its client as an argument for the same
 * reason.
 */
export function databaseUrlFromEnv(): string | undefined {
  const url = process.env.DATABASE_URL
  return url && url.trim() !== '' ? url : undefined
}

/**
 * Is this URL the transaction pooler?
 *
 * A heuristic, and it only ever warns — a self-hosted deployment can put the
 * transaction pooler anywhere. What it catches is the mistake that matters:
 * pointing this at port 5432 (session mode or direct), where a leaked session
 * setting outlives the request that made it.
 */
export function looksLikeTransactionPooler(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.port === '6543'
  } catch {
    return false
  }
}

const pools = new Map<string, Sql>()

/**
 * The pool for this URL, created once per process.
 *
 * `prepare: false` is required by transaction mode — see the header.
 * `onnotice` is silenced because Supabase emits a notice on every `set local`
 * of an unrecognised GUC and the log would be nothing else.
 */
export function postgresPool(
  url: string,
  options: PostgresPoolOptions = {},
): Sql {
  const existing = pools.get(url)
  if (existing) return existing

  const sql = postgres(url, {
    max: options.max ?? DEFAULTS.max,
    idle_timeout: options.idleTimeout ?? DEFAULTS.idleTimeout,
    connect_timeout: options.connectTimeout ?? DEFAULTS.connectTimeout,
    // Transaction mode. Not optional, not a tuning knob. See the header.
    prepare: false,
    // `set local` on a custom GUC produces a notice on every transaction.
    onnotice: () => {},
    // Every value this layer sends is either a scalar or is handed to
    // `json_populate_recordset` as one json parameter, so no bespoke type
    // serialisation is needed and none is configured. Guessing at whether a
    // JavaScript array meant `text[]` or a json array is precisely the bug
    // that approach exists to avoid.
    types: {},
  })

  pools.set(url, sql)
  return sql
}

/** Close and forget the pool for this URL. For tests and for shutdown hooks. */
export async function closePostgresPool(url: string): Promise<void> {
  const sql = pools.get(url)
  if (!sql) return
  pools.delete(url)
  await sql.end({ timeout: 5 })
}

/** Close every pool this process opened. */
export async function closeAllPostgresPools(): Promise<void> {
  const urls = [...pools.keys()]
  await Promise.all(urls.map((url) => closePostgresPool(url)))
}
