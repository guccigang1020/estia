/**
 * "This deployment has no table for that yet", recognised rather than guessed.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 *
 * The fiscal reference tables and the guest register tables are created by a
 * migration this worker does not write. Until it runs, a query against them
 * comes back as an error, and there are exactly two honest things a screen can
 * do with that: render "you have no documents", or say the storage is not
 * there. The first is a lie of the specific kind `components/shell-screens/
 * domain-gap.tsx` was built to prevent — a business reading "אין מסמכים"
 * concludes the feature works and has nothing in it, which is the opposite of
 * what is true.
 *
 * So the queries recognise the two shapes a missing table arrives in and hand
 * the page a `not_provisioned` answer, and the page renders `DomainGap` with
 * the table names a migration would create. The day the migration runs, the
 * same screens light up with no code change.
 *
 * ── Why it lives here and is shared ───────────────────────────────────────
 *
 * One copy, imported by both new capabilities, because both are waiting on the
 * same migration and two copies of a five-character SQLSTATE is two places to
 * mistype it. It imports nothing — deliberately: `@/lib/persistence` reaches
 * the driver, and a module in `src/lib` that a screen imports must stay safe
 * for the bundle checker.
 *
 * ── The two codes ─────────────────────────────────────────────────────────
 *
 * `42P01` is Postgres itself: `undefined_table`. `PGRST205` is PostgREST
 * answering before Postgres is reached — the table is not in its schema cache,
 * which is what a Supabase client actually returns for a table that has never
 * existed. Both mean the same thing to a reader and neither is a bug in
 * anybody's data.
 */

/** `undefined_table`, from Postgres. */
export const UNDEFINED_TABLE = '42P01'

/** PostgREST's own: the table is not in the schema cache. */
export const POSTGREST_UNKNOWN_TABLE = 'PGRST205'

/**
 * Is this error the storage being absent, rather than the query being wrong?
 *
 * Narrow on purpose. A permission failure, a bad column and a network drop are
 * all *not* this, and treating any of them as "not provisioned" would hide a
 * real fault behind a reassuring explanation.
 */
export function isMissingTableError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === UNDEFINED_TABLE || code === POSTGREST_UNKNOWN_TABLE
}

/**
 * The answer a read gives when it could not run at all.
 *
 * A discriminated result rather than a thrown error, because a screen has to
 * render something and "the storage is missing" is a state to display, not an
 * exception to report. `tables` is what the caller asked for, so the page can
 * name them without keeping its own list.
 */
export type Provisioned<T> =
  | { state: 'ready'; data: T }
  | { state: 'not_provisioned'; tables: readonly string[] }

/**
 * Run a read, and turn a missing table into a state instead of a throw.
 *
 * Every other failure is rethrown untouched. That is the important half: this
 * helper exists to recognise one specific condition, and a `catch` that
 * swallowed the rest would turn an RLS refusal into "the feature is not built".
 */
export async function readProvisioned<T>(
  tables: readonly string[],
  read: () => Promise<T>,
): Promise<Provisioned<T>> {
  try {
    return { state: 'ready', data: await read() }
  } catch (error) {
    if (isMissingTableError(error)) return { state: 'not_provisioned', tables }
    throw error
  }
}
