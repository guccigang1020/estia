/**
 * What a database failure means.
 *
 * The rule this file exists to enforce: **a constraint violation and a network
 * failure must not look the same to the caller.** One means "somebody got
 * there first, the answer may differ in a second"; the other means "we do not
 * know whether anything was written". A layer that caught both and threw
 * `ConflictError` would tell a guest their dates were taken when in fact the
 * Wi-Fi dropped.
 *
 * So translation is by SQLSTATE, exactly, and never by matching on a message
 * string. Postgres message text is localised and is rewritten between major
 * versions; the five-character code is a documented contract.
 *
 * ── The one that matters ──────────────────────────────────────────────────
 *
 * `23P01`, `exclusion_violation`, from `unit_occupancy_no_overlap` — the GiST
 * constraint in `0009_booking_core.sql`. That constraint, and nothing in
 * application code, is what makes a double booking impossible. The
 * availability engine says so itself in its own header.
 *
 * The constraint is not on `bookings`. `bookings` and `holds` each carry an
 * `AFTER INSERT OR UPDATE` trigger that projects the row into
 * `public.unit_occupancy`, and the exclusion lives there — `EXCLUDE USING gist
 * (unit_id WITH =, during WITH &&)`. The practical consequence is that a
 * perfectly ordinary `insert into bookings` fails with a constraint name that
 * mentions neither bookings nor holds, which is confusing exactly once.
 *
 * Verified on the live project rather than read off the migration: an
 * overlapping insert returns `sqlstate=23P01
 * constraint=unit_occupancy_no_overlap`, a same-day turnaround is accepted,
 * and both facts are re-proved by `live.integration.test.ts`.
 */

import { AppError, ConflictError } from '../errors'

// ── SQLSTATE ──────────────────────────────────────────────────────────────

/**
 * The codes this layer reacts to. Everything absent from here is deliberately
 * *not* interpreted: an unrecognised failure is reported as itself rather than
 * guessed at.
 */
export const PG_ERROR = {
  /** Two live occupancies for one unit over overlapping dates. */
  EXCLUSION_VIOLATION: '23P01',
  /** A unique index was already holding that value. */
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  /**
   * Row level security refused the write, or a table grant is missing.
   *
   * Worth reading carefully when it appears: under RLS a *read* the policy
   * forbids returns no rows rather than this code, so `42501` on a select
   * means the grant itself is wrong, not the policy.
   */
  INSUFFICIENT_PRIVILEGE: '42501',
  /** PostgREST, not Postgres: `.single()` matched no row. */
  NO_ROWS: 'PGRST116',
} as const

/** The constraint whose violation is a double booking. */
export const OCCUPANCY_EXCLUSION_CONSTRAINT = 'unit_occupancy_no_overlap'

// ── Recognising a PostgREST error ─────────────────────────────────────────

/** The shape `@supabase/supabase-js` returns in `{ error }`. */
export interface PostgrestErrorLike {
  code: string
  message: string
  details?: string | null
  hint?: string | null
}

export function isPostgrestError(value: unknown): value is PostgrestErrorLike {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.code === 'string' && typeof candidate.message === 'string'
  )
}

/**
 * Is this the double-booking constraint, specifically?
 *
 * Both halves are checked. `23P01` alone would also match a future exclusion
 * constraint on some unrelated table, and reporting that as "those dates are
 * taken" would be a plausible, wrong sentence — the worst kind.
 */
export function isOccupancyConflict(error: unknown): boolean {
  if (!isPostgrestError(error)) return false
  if (error.code !== PG_ERROR.EXCLUSION_VIOLATION) return false
  return mentionsOccupancyConstraint(error)
}

function mentionsOccupancyConstraint(error: PostgrestErrorLike): boolean {
  const haystack = `${error.message} ${error.details ?? ''}`
  return haystack.includes(OCCUPANCY_EXCLUSION_CONSTRAINT)
}

// ── Failures that are the schema's fault, not the user's ──────────────────

/**
 * The adapter was asked for something the database has no table for.
 *
 * A 500, loudly, and never a silent `null`. Some ports in this codebase
 * describe storage that `0008`–`0012` do not yet create; an adapter that
 * answered "nothing found" for those would look like an empty database rather
 * than an unfinished one, and the difference would surface as a wrong number
 * on a statement months later.
 */
export class SchemaNotProvisionedError extends AppError {
  readonly missing: string

  constructor(missing: string, purpose: string) {
    super({
      code: 'schema_not_provisioned',
      status: 500,
      message:
        `This deployment has no '${missing}' storage, which ${purpose} ` +
        `requires. A migration is needed; no application change will do.`,
      userMessage:
        'אירעה תקלה במערכת ולכן הפעולה לא בוצעה. נסה שוב בעוד מספר רגעים.',
      retryable: false,
      dataOutcome: 'not_saved',
    })
    this.missing = missing
  }
}

/**
 * A write failed after earlier writes in the same operation had already
 * committed.
 *
 * This exists because `sequentialUnitOfWork` is not a transaction — see
 * `transaction.ts`, which is unsparing about it. When a unit of work fails
 * half way, the caller is owed the list of what is already durable, because
 * "the booking was not created" and "the booking exists but has no price
 * lines" need different repairs.
 */
export class PartialCommitError extends AppError {
  readonly committed: readonly string[]

  constructor(committed: readonly string[], cause: unknown) {
    super({
      code: 'partial_commit',
      status: 500,
      message:
        `An operation failed after committing ${committed.length} write(s): ` +
        `${committed.join(', ')}. These are durable and were not rolled back.`,
      // `saved`, not `not_saved`. The taxonomy's sentence for it is "your
      // change was saved, but the operation did not complete in full", which
      // is precisely and unfortunately true. Reporting `not_saved` would send
      // the user away believing the booking does not exist while it does.
      dataOutcome: 'saved',
      userMessage:
        'חלק מהשינוי נשמר אך הפעולה לא הושלמה. בדוק את מצב הרשומה לפני ניסיון חוזר.',
      retryable: false,
      cause,
    })
    this.committed = committed
  }
}

// ── Translation ───────────────────────────────────────────────────────────

export interface TranslateOptions {
  /** `booking`, `hold`, `payment` — what the caller was working on. */
  resourceType: string
  resourceId?: string | null
  /** The stay that collided, for the sentence the guest reads. */
  range?: { checkIn: string; checkOut: string }
}

/**
 * Turn a PostgREST error into the domain's error, or hand it back untouched.
 *
 * Untouched is the default and the important half. Only the occupancy
 * exclusion is reinterpreted, because only it has an unambiguous domain
 * meaning. A unique violation could be a duplicate reference, a re-used
 * idempotency key or a second deposit on one booking, and each caller knows
 * which of those it was attempting; guessing here would be worse than not
 * translating at all.
 */
export function translateWriteError(
  error: unknown,
  options: TranslateOptions,
): unknown {
  if (!isOccupancyConflict(error)) return error

  // `ConflictError` is the right class and the domain already uses it this
  // way — see `assertAvailable` in `booking/operations.ts`, which explains why
  // its stable code reads `version_conflict` while the Hebrew says what
  // actually happened. The default message here would say "refresh the page",
  // which is wrong advice: the record is fine, the dates are gone.
  const dates = options.range
    ? ` (${options.range.checkIn} – ${options.range.checkOut})`
    : ''

  return new ConflictError({
    resourceType: options.resourceType,
    resourceId: options.resourceId ?? null,
    // No versions, deliberately. Stating one would imply that reloading the
    // record would help, and it would not: nothing about this record changed.
    userMessage:
      `התאריכים שביקשת${dates} נתפסו זה עתה על ידי הזמנה או החזקה אחרת. ` +
      'בחר תאריכים אחרים או בדוק את היומן מחדש.',
    cause: error,
  })
}

/**
 * Throw whatever `translateWriteError` decided.
 *
 * A separate function so call sites read as one line and cannot accidentally
 * compute a translation and then drop it on the floor.
 */
export function throwWriteError(
  error: unknown,
  options: TranslateOptions,
): never {
  throw translateWriteError(error, options)
}
