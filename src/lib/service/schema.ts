/**
 * A schema validator, written here rather than installed.
 *
 * Three reasons it is not a library. The messages have to be Hebrew, written
 * for the person filling the form, and a translation layer over someone else's
 * error codes is a second place for wording to live. The validator has to
 * report *every* offending field — a form that surfaces its problems one at a
 * time is a form people abandon halfway. And the surface needed is small
 * enough that owning it costs less than owning a dependency that will change
 * its API.
 *
 * The rules it holds:
 *
 *   - **Collect, never short-circuit.** An object gathers issues from all of
 *     its fields, and nested objects gather from theirs.
 *   - **Unknown keys are refused.** A payload carrying `role: "owner"` at an
 *     endpoint that never mentions roles is either a bug or an attempt, and
 *     silently ignoring it is how mass assignment happens.
 *   - **Paths are dotted.** `guest.email`, `nights[0].date` — so the interface
 *     can put the message beside the input that caused it.
 */

import type { FieldIssue } from '../errors/app-error'

export type SchemaResult<T> =
  { ok: true; value: T } | { ok: false; issues: readonly FieldIssue[] }

export interface Schema<T> {
  /** For diagnostics and for the operation's own description. */
  readonly kind: string
  /** Hebrew name of the field, carried into the issue when present. */
  readonly label?: string
  validate(value: unknown, path: string): SchemaResult<T>
}

/** A schema that tolerates absence, and makes its key optional in an object. */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly isOptional: true
}

export type Infer<S> = S extends Schema<infer T> ? T : never

// ── Issue building ────────────────────────────────────────────────────────

function issue(
  path: string,
  code: string,
  message: string,
  label?: string,
): FieldIssue {
  const field = path.length > 0 ? path : 'input'
  return label === undefined
    ? { field, code, message }
    : { field, code, message, label }
}

function fail<T>(...issues: FieldIssue[]): SchemaResult<T> {
  return { ok: false, issues }
}

function ok<T>(value: T): SchemaResult<T> {
  return { ok: true, value }
}

function childPath(path: string, key: string): string {
  return path.length > 0 ? `${path}.${key}` : key
}

// ── Primitives ────────────────────────────────────────────────────────────

export interface StringOptions {
  label?: string
  min?: number
  max?: number
  /** Trimmed before every other check, and the trimmed value is what is kept. */
  trim?: boolean
  pattern?: RegExp
  /** Hebrew explanation of what the pattern wants. */
  patternMessage?: string
}

export function string(options: StringOptions = {}): Schema<string> {
  const { label, min, max, trim = true, pattern, patternMessage } = options

  return {
    kind: 'string',
    label,
    validate(value, path) {
      if (value === undefined || value === null) {
        return fail(issue(path, 'required', 'שדה חובה.', label))
      }
      if (typeof value !== 'string') {
        return fail(issue(path, 'type', 'יש להזין טקסט.', label))
      }

      const candidate = trim ? value.trim() : value

      if (min !== undefined && candidate.length < min) {
        return fail(
          issue(
            path,
            'too_short',
            min === 1 ? 'שדה חובה.' : `יש להזין לפחות ${min} תווים.`,
            label,
          ),
        )
      }
      if (max !== undefined && candidate.length > max) {
        return fail(
          issue(path, 'too_long', `אורך מרבי הוא ${max} תווים.`, label),
        )
      }
      if (pattern && !pattern.test(candidate)) {
        return fail(
          issue(
            path,
            'pattern',
            patternMessage ?? 'הערך אינו בפורמט הנדרש.',
            label,
          ),
        )
      }

      return ok(candidate)
    },
  }
}

export interface NumberOptions {
  label?: string
  min?: number
  max?: number
  integer?: boolean
}

export function number(options: NumberOptions = {}): Schema<number> {
  const { label, min, max, integer = false } = options

  return {
    kind: integer ? 'integer' : 'number',
    label,
    validate(value, path) {
      if (value === undefined || value === null) {
        return fail(issue(path, 'required', 'שדה חובה.', label))
      }
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return fail(issue(path, 'type', 'יש להזין מספר.', label))
      }
      if (!Number.isFinite(value)) {
        return fail(issue(path, 'type', 'יש להזין מספר.', label))
      }
      if (integer && !Number.isInteger(value)) {
        return fail(issue(path, 'not_integer', 'יש להזין מספר שלם.', label))
      }
      if (min !== undefined && value < min) {
        return fail(
          issue(path, 'too_small', `הערך חייב להיות לפחות ${min}.`, label),
        )
      }
      if (max !== undefined && value > max) {
        return fail(
          issue(path, 'too_large', `הערך חייב להיות עד ${max}.`, label),
        )
      }
      return ok(value)
    },
  }
}

/**
 * Money. Agorot, integer, never negative — the charter's rule expressed as a
 * schema so a price cannot arrive as `52.005` shekels and be rounded silently.
 */
export function agorot(
  options: { label?: string; max?: number } = {},
): Schema<number> {
  return number({
    label: options.label,
    integer: true,
    min: 0,
    max: options.max,
  })
}

export function boolean(options: { label?: string } = {}): Schema<boolean> {
  const { label } = options
  return {
    kind: 'boolean',
    label,
    validate(value, path) {
      if (value === undefined || value === null) {
        return fail(issue(path, 'required', 'שדה חובה.', label))
      }
      if (typeof value !== 'boolean') {
        return fail(issue(path, 'type', 'יש לבחור כן או לא.', label))
      }
      return ok(value)
    },
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function uuid(options: { label?: string } = {}): Schema<string> {
  const { label } = options
  return {
    kind: 'uuid',
    label,
    validate(value, path) {
      if (value === undefined || value === null) {
        return fail(issue(path, 'required', 'שדה חובה.', label))
      }
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        return fail(issue(path, 'invalid_id', 'מזהה אינו תקין.', label))
      }
      return ok(value)
    },
  }
}

/**
 * An ISO 8601 instant, parsed to a `Date`.
 *
 * Strings only. Accepting a `Date` here would let an unvalidated object from a
 * request body through on the strength of its prototype.
 */
export function isoDateTime(options: { label?: string } = {}): Schema<Date> {
  const { label } = options
  return {
    kind: 'isoDateTime',
    label,
    validate(value, path) {
      if (value === undefined || value === null) {
        return fail(issue(path, 'required', 'שדה חובה.', label))
      }
      if (typeof value !== 'string') {
        return fail(issue(path, 'type', 'תאריך אינו תקין.', label))
      }
      const parsed = new Date(value)
      if (Number.isNaN(parsed.getTime())) {
        return fail(issue(path, 'invalid_date', 'תאריך אינו תקין.', label))
      }
      return ok(parsed)
    },
  }
}

export function enumOf<const T extends readonly string[]>(
  values: T,
  options: { label?: string } = {},
): Schema<T[number]> {
  const { label } = options
  const allowed = new Set<string>(values)
  return {
    kind: 'enum',
    label,
    validate(value, path) {
      if (value === undefined || value === null) {
        return fail(issue(path, 'required', 'שדה חובה.', label))
      }
      if (typeof value !== 'string' || !allowed.has(value)) {
        return fail(issue(path, 'not_allowed', 'הערך שנבחר אינו חוקי.', label))
      }
      return ok(value as T[number])
    },
  }
}

// ── Combinators ───────────────────────────────────────────────────────────

/** Absent or the inner type. Makes the key optional inside an object. */
export function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  return {
    kind: `optional<${inner.kind}>`,
    label: inner.label,
    isOptional: true,
    validate(value, path) {
      if (value === undefined) return ok(undefined)
      return inner.validate(value, path)
    },
  }
}

/**
 * Explicitly null, or the inner type.
 *
 * Distinct from `optional`: "the guest gave no phone number" and "the caller
 * did not mention the phone number" are different statements, and only the
 * first should clear a stored value.
 */
export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return {
    kind: `nullable<${inner.kind}>`,
    label: inner.label,
    validate(value, path) {
      if (value === null) return ok(null)
      return inner.validate(value, path)
    },
  }
}

export function arrayOf<T>(
  item: Schema<T>,
  options: { label?: string; min?: number; max?: number } = {},
): Schema<T[]> {
  const { label, min, max } = options
  return {
    kind: `array<${item.kind}>`,
    label,
    validate(value, path) {
      if (value === undefined || value === null) {
        return fail(issue(path, 'required', 'שדה חובה.', label))
      }
      if (!Array.isArray(value)) {
        return fail(issue(path, 'type', 'יש להזין רשימה.', label))
      }
      if (min !== undefined && value.length < min) {
        return fail(
          issue(path, 'too_few', `יש לבחור לפחות ${min} פריטים.`, label),
        )
      }
      if (max !== undefined && value.length > max) {
        return fail(
          issue(path, 'too_many', `אפשר לבחור עד ${max} פריטים.`, label),
        )
      }

      const issues: FieldIssue[] = []
      const output: T[] = []
      for (let index = 0; index < value.length; index += 1) {
        const result = item.validate(value[index], `${path}[${index}]`)
        if (result.ok) output.push(result.value)
        else issues.push(...result.issues)
      }

      return issues.length > 0 ? fail<T[]>(...issues) : ok(output)
    },
  }
}

type Shape = Record<string, Schema<unknown>>

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends { readonly isOptional: true } ? K : never
}[keyof S]

type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>

export type InferShape<S extends Shape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>
} & {
  [K in OptionalKeys<S>]?: Infer<S[K]>
}

export interface ObjectOptions {
  label?: string
  /**
   * Accept keys the shape does not name. Off by default, and turning it on
   * should be argued for: a service boundary that ignores extra keys is a
   * service boundary that will one day pass them to an ORM.
   */
  allowUnknown?: boolean
}

export function object<S extends Shape>(
  shape: S,
  options: ObjectOptions = {},
): Schema<InferShape<S>> {
  const { label, allowUnknown = false } = options
  const keys = Object.keys(shape)
  const known = new Set(keys)

  return {
    kind: 'object',
    label,
    validate(value, path) {
      if (value === undefined || value === null) {
        return fail(issue(path, 'required', 'שדה חובה.', label))
      }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return fail(issue(path, 'type', 'מבנה הנתונים אינו תקין.', label))
      }

      const source = value as Record<string, unknown>
      const issues: FieldIssue[] = []
      const output: Record<string, unknown> = {}

      // Every field, always. The first failure does not stop the rest.
      for (const key of keys) {
        const result = shape[key].validate(source[key], childPath(path, key))
        if (result.ok) {
          if (result.value !== undefined || key in source) {
            output[key] = result.value
          }
        } else {
          issues.push(...result.issues)
        }
      }

      if (!allowUnknown) {
        for (const key of Object.keys(source)) {
          if (!known.has(key)) {
            issues.push(
              issue(childPath(path, key), 'unknown_field', 'שדה לא מוכר.'),
            )
          }
        }
      }

      return issues.length > 0
        ? fail<InferShape<S>>(...issues)
        : ok(output as InferShape<S>)
    },
  }
}

/**
 * A cross-field or domain check expressed as part of the schema.
 *
 * Runs only when the inner schema passed, so the predicate never sees a
 * half-parsed value.
 */
export function refine<T>(
  inner: Schema<T>,
  predicate: (value: T) => boolean,
  problem: { code: string; message: string; field?: string },
): Schema<T> {
  return {
    kind: `refine<${inner.kind}>`,
    label: inner.label,
    validate(value, path) {
      const result = inner.validate(value, path)
      if (!result.ok) return result
      if (predicate(result.value)) return result
      return fail<T>(
        issue(
          problem.field ? childPath(path, problem.field) : path,
          problem.code,
          problem.message,
          inner.label,
        ),
      )
    },
  }
}

/** Accepts anything and validates nothing. For operations that take no input. */
export const nothing: Schema<Record<string, never>> = {
  kind: 'nothing',
  validate(value, path) {
    if (value === undefined || value === null) {
      return ok({} as Record<string, never>)
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      return fail(issue(path, 'type', 'מבנה הנתונים אינו תקין.'))
    }
    const extra = Object.keys(value as Record<string, unknown>)
    if (extra.length > 0) {
      return fail<Record<string, never>>(
        ...extra.map((key) =>
          issue(childPath(path, key), 'unknown_field', 'שדה לא מוכר.'),
        ),
      )
    }
    return ok({} as Record<string, never>)
  },
}

/** The builders, grouped, so call sites read as `s.string()` / `s.object()`. */
export const s = {
  agorot,
  arrayOf,
  boolean,
  enumOf,
  isoDateTime,
  nothing,
  nullable,
  number,
  object,
  optional,
  refine,
  string,
  uuid,
}
