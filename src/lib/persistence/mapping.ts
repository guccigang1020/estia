/**
 * The border between a row and a domain object.
 *
 * The database speaks `snake_case`, SQL types and `null`. The domain speaks
 * `camelCase`, ISO strings, integer agorot and — in a handful of deliberate
 * places — `undefined`. The two are different languages and this file holds the
 * dictionary, so that no adapter invents its own.
 *
 * ── `null` is not `undefined` ─────────────────────────────────────────────
 *
 * SQL has one absence and TypeScript has two, and which one a column means is a
 * decision, not a formality:
 *
 *   · `booking.property_id`   → `null`      — "no property", a real answer.
 *   · `RoleAssignment.grants` → `undefined` — "not applicable", because a
 *     system role's grants come from the catalogue in code and a `null` there
 *     would read as "this role grants nothing", which is the opposite.
 *
 * `nullToUndefined` exists so the second case is written down rather than
 * achieved by a `?? undefined` somebody deletes as noise.
 *
 * ── Dates ─────────────────────────────────────────────────────────────────
 *
 * Three kinds of value, three helpers, and mixing them up is the classic bug:
 *
 *   · `date`        → `YYYY-MM-DD`, and stays a string. Never a `Date`: a stay
 *     starting `2026-08-01` is that date at the property, and parsing it into
 *     an instant makes it depend on the server's zone.
 *   · `timestamptz` → an ISO 8601 string for the domain's string-typed
 *     timestamps (`Hold.expiresAt`), or a `Date` for its `Date`-typed ones
 *     (`Payment.createdAt`). The domain is not consistent about this; the
 *     helpers are named for which one they produce so a mismatch is a compile
 *     error rather than a runtime surprise.
 *   · `numeric`     → arrives as a *string* from PostgREST, because JSON has
 *     no exact decimal. `asNumber` is what stops `"1.5"` reaching arithmetic.
 */

import type { Row } from './client'

// ── Off the wire ──────────────────────────────────────────────────────────

/**
 * Whatever PostgREST returned, treated as a row.
 *
 * The single place this layer widens a client result, and the reason it is a
 * function rather than a cast at each call site. `SupabaseClient` is used
 * without the generated `Database` generic — see `client.ts` for why — so its
 * result types degrade to a union that includes `GenericStringError` as soon
 * as a select embeds a related table. Casting through here keeps that one
 * concession in one file, next to the helpers that immediately narrow every
 * column back to a checked type.
 *
 * Nothing is trusted after this point: `asString`, `asAgorot` and the rest
 * still validate every field, so a widened row that is the wrong shape fails
 * with a `RowShapeError` naming the column rather than flowing on.
 */
export function toRow(value: unknown): Row {
  return value as Row
}

/** The same, for a result set. */
export function toRows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : []
}

// ── Absence ───────────────────────────────────────────────────────────────

/** SQL `null` → TypeScript `undefined`, for columns where that is the meaning. */
export function nullToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value
}

/** TypeScript `undefined` → SQL `null`, on the way in. */
export function undefinedToNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value
}

// ── Scalars off the wire ──────────────────────────────────────────────────

/**
 * A column that must be a string, or a failure that names the column.
 *
 * Adapters call these rather than casting. A cast turns a renamed column into
 * `undefined` flowing three layers into the domain and surfacing as a blank
 * guest name on a confirmation email; this turns it into one sentence naming
 * the table and the column.
 */
export function asString(row: Row, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new RowShapeError(column, 'string', value)
  }
  return value
}

export function asStringOrNull(row: Row, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string')
    throw new RowShapeError(column, 'string', value)
  return value
}

/**
 * A number, including the `numeric` columns PostgREST sends as strings.
 *
 * `bookings.total_agorot` is an `integer` and arrives as a number;
 * `booking_price_lines.quantity` is a `numeric` and arrives as `"1"`. Both go
 * through here, so a column that changes type between them does not silently
 * start producing string concatenation.
 */
export function asNumber(row: Row, column: string): number {
  const value = row[column]
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  throw new RowShapeError(column, 'number', value)
}

export function asNumberOrNull(row: Row, column: string): number | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  return asNumber(row, column)
}

/**
 * Agorot: an integer, and refused if it is not.
 *
 * Money that has become a float is money that will be wrong by a hundredth of
 * a shekel a few thousand rows later, and the whole product counts in integer
 * agorot precisely so that cannot happen. Catching it at the border is the
 * only place it is cheap to catch.
 */
export function asAgorot(row: Row, column: string): number {
  const value = asNumber(row, column)
  if (!Number.isInteger(value)) {
    throw new RowShapeError(column, 'integer agorot', value)
  }
  return value
}

export function asBoolean(row: Row, column: string): boolean {
  const value = row[column]
  if (typeof value !== 'boolean') {
    throw new RowShapeError(column, 'boolean', value)
  }
  return value
}

/**
 * A `text[]` column.
 *
 * An empty array and a `null` both become `[]`. That is safe here and only
 * here: every array column this layer reads is `NOT NULL DEFAULT '{}'`, so a
 * `null` would mean the schema changed under us, and a crash would be more
 * accurate than an empty list — but every consumer of these arrays treats
 * empty and absent identically, so the distinction has nowhere to go.
 */
export function asStringArray(row: Row, column: string): string[] {
  const value = row[column]
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new RowShapeError(column, 'array', value)
  return value.map((entry) => String(entry))
}

/** A `jsonb` object column, as a plain record. */
export function asJsonRecord(
  row: Row,
  column: string,
): Record<string, unknown> {
  const value = row[column]
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RowShapeError(column, 'json object', value)
  }
  return value as Record<string, unknown>
}

// ── Enums ─────────────────────────────────────────────────────────────────

/**
 * A value that must be one of the domain's frozen vocabulary.
 *
 * Every Postgres enum in `0008`–`0012` was compared, label by label, against
 * its TypeScript counterpart, and they agree today. This exists for the day
 * one of them gains a value the other has not: the row is refused at the
 * border, naming the value, instead of a `BookingStatus` that is not one
 * reaching the state machine and matching no branch.
 */
export function asEnum<T extends string>(
  row: Row,
  column: string,
  allowed: readonly T[],
): T {
  const value = asString(row, column)
  if (!(allowed as readonly string[]).includes(value)) {
    throw new RowShapeError(column, `one of [${allowed.join(', ')}]`, value)
  }
  return value as T
}

export function asEnumOrNull<T extends string>(
  row: Row,
  column: string,
  allowed: readonly T[],
): T | null {
  if (row[column] === null || row[column] === undefined) return null
  return asEnum(row, column, allowed)
}

// ── Dates and timestamps ──────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A `date` column, kept as `YYYY-MM-DD`.
 *
 * PostgREST already sends it in that form. The check is here because a
 * `timestamptz` column read by mistake would arrive as
 * `2026-08-01T00:00:00+00:00`, sort differently, and compare wrongly against
 * every other date in the domain — silently, since it still starts with the
 * right ten characters.
 */
export function asIsoDate(row: Row, column: string): string {
  const value = asString(row, column)
  if (!ISO_DATE.test(value)) {
    throw new RowShapeError(column, 'YYYY-MM-DD date', value)
  }
  return value
}

export function asIsoDateOrNull(row: Row, column: string): string | null {
  if (row[column] === null || row[column] === undefined) return null
  return asIsoDate(row, column)
}

/**
 * A `timestamptz` as an ISO 8601 string, normalised through `Date`.
 *
 * Postgres renders `+00:00`; the domain's string timestamps are compared with
 * `<` against values produced by `toISOString()`, which renders `Z`. Those two
 * spellings of the same instant do not compare equal as strings, and a hold's
 * expiry is exactly such a comparison — so normalising here is not tidiness,
 * it is the difference between a live hold and an expired one.
 */
export function asTimestamp(row: Row, column: string): string {
  const value = asString(row, column)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new RowShapeError(column, 'ISO timestamp', value)
  }
  return parsed.toISOString()
}

export function asTimestampOrNull(row: Row, column: string): string | null {
  if (row[column] === null || row[column] === undefined) return null
  return asTimestamp(row, column)
}

/** A `timestamptz` as a `Date`, for the domain types that want one. */
export function asDate(row: Row, column: string): Date {
  const parsed = new Date(asString(row, column))
  if (Number.isNaN(parsed.getTime())) {
    throw new RowShapeError(column, 'ISO timestamp', row[column])
  }
  return parsed
}

export function asDateOrNull(row: Row, column: string): Date | null {
  if (row[column] === null || row[column] === undefined) return null
  return asDate(row, column)
}

// ── Failure ───────────────────────────────────────────────────────────────

/**
 * A row did not look the way the mapping expected.
 *
 * A plain `Error` and not an `AppError`: this is never a user's doing and
 * never a handled outcome. It means the schema and this file have diverged,
 * which is a deployment problem, and it should reach the error reporter as the
 * bug it is rather than being dressed as a 500 with a Hebrew apology.
 */
export class RowShapeError extends Error {
  constructor(column: string, expected: string, received: unknown) {
    super(
      `Column '${column}' should be ${expected}, received ` +
        `${describe(received)}. The database schema and the mapping in ` +
        `src/lib/persistence have diverged.`,
    )
    this.name = 'RowShapeError'
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined (column absent from the select?)'
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`
  return `${typeof value} ${String(value)}`
}

// ── Writing ───────────────────────────────────────────────────────────────

/**
 * Drop `undefined` keys from an object bound for an insert or update.
 *
 * PostgREST serialises `undefined` to JSON by omitting it on an insert, but on
 * an *update* an explicitly-present key is what distinguishes "set this column
 * to null" from "leave it alone". Building patch objects through here means a
 * `BookingPatch` with `checkIn` absent updates the status and nothing else,
 * instead of blanking the arrival date.
 */
export function definedOnly<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) output[key] = entry
  }
  return output as Partial<T>
}
