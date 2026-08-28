/**
 * The database handle this layer is given.
 *
 * Note what this file does *not* do: it does not construct a client, and it
 * does not import `@/lib/env`. Both would be quiet mistakes.
 *
 * Constructing a client here would mean a second way to reach Supabase beside
 * `src/lib/supabase/server.ts` and `client.ts`, which already own the cookie
 * contract and the key choice. There is one way to reach Supabase and it is
 * not this file; adapters are *handed* the client the caller already built.
 *
 * Importing `env` here would be worse. `src/lib/env.ts` validates at module
 * load and throws on a missing variable, so a single `import` from a test file
 * would make the deliberately database-free unit suite require a Supabase
 * project and three secrets. Every adapter in this directory therefore takes
 * its client as a constructor argument, which is also what lets the unit tests
 * hand it a fake.
 *
 * ── Which client to hand in ───────────────────────────────────────────────
 *
 * The one from `src/lib/supabase/server.ts`, in almost every case. It carries
 * the signed-in user's session, so every query runs as that user and returns
 * only their organization's rows. RLS is the tenant isolation the whole system
 * rests on and the adapters here are written to live inside it, not around it.
 *
 * The admin client from `src/lib/supabase/admin.ts` bypasses RLS completely
 * and is correct only where there is genuinely no user to act as: a payment
 * provider's webhook, a nightly sweep. Reaching for it because a query came
 * back empty removes tenant isolation to fix a permissions bug, which is the
 * one trade this codebase never makes.
 */

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'

/**
 * The client, structurally.
 *
 * Untyped in the generics slot deliberately: the generated `Database` type is
 * not committed to this repository, and pinning the adapters to a type nobody
 * regenerates would give a false sense that a column rename had been caught.
 * The live verification in `live.integration.test.ts` is what actually proves
 * the column names, and it proves them against the real database rather than
 * against a snapshot of it.
 */
export type Db = SupabaseClient

/** What PostgREST hands back when the database refuses. */
export type { PostgrestError }

/**
 * A row as it comes off the wire: snake_case keys, SQL-shaped values.
 *
 * Deliberately not exported as anything more specific. A raw row must never
 * escape into the domain — every adapter maps it in one place per table, and
 * the mapping is where `null` becomes whichever of `null` or `undefined` the
 * domain actually means.
 */
export type Row = Record<string, unknown>
