/**
 * The same queries, over a transaction instead of over HTTP.
 *
 * ── Why this exists rather than a second set of adapters ──────────────────
 *
 * Real atomicity needs a direct Postgres connection (`postgres.ts` says which
 * pooler and why). But every adapter in this directory is written against the
 * PostgREST builder — `.from('bookings').select(…).eq(…).maybeSingle()` — and
 * they are the tested, reviewed description of what this product asks the
 * database for. There were two ways to reach a transaction from them:
 *
 *   1. Rewrite each adapter to speak SQL, and keep the PostgREST version too,
 *      because the non-transactional reads still go over HTTP. Two
 *      descriptions of every query, drifting from the first commit.
 *   2. Compile the builder the adapters already use into SQL, and run it on
 *      the open transaction.
 *
 * This is (2). `clientFor(tx, db)` hands an adapter one of two things — the
 * Supabase client, or this — and the adapter cannot tell, which is the point:
 * there is exactly one description of every query in this codebase.
 *
 * ── This is not a PostgREST reimplementation, and must not become one ─────
 *
 * It supports precisely the shapes the adapters in this directory use, and it
 * **throws** on anything else rather than approximating it. `UnsupportedQuery`
 * failing loudly in a test is cheap; a filter silently ignored inside a
 * transaction is a cross-tenant read. The supported surface:
 *
 *   verbs      select · insert · update · delete · upsert · rpc
 *   filters    eq · neq · is · lt · lte · gt · gte · in
 *   modifiers  order · limit · single · maybeSingle · select(returning)
 *   embeds     only those in RELATIONS below, by name
 *
 * ── Two decisions that remove whole classes of bug ────────────────────────
 *
 * **Every read returns one `jsonb` column, built by Postgres.** The statement
 * is wrapped in `jsonb_agg(to_jsonb(…))`, so the rows arrive having been
 * rendered to JSON by the same code path PostgREST uses. A `date` is
 * `"2099-03-10"` and not a JavaScript `Date`; a `timestamptz` is an ISO string;
 * a `jsonb` column is an object; `numeric` is a number. `mapping.ts` therefore
 * sees exactly what it sees over HTTP, and none of its `asIsoDate` /
 * `asTimestamp` / `asJsonRecord` helpers need a second code path. Had the rows
 * come back as driver-parsed values instead, every one of those helpers would
 * have needed to accept two shapes, and the day somebody forgot would be a
 * wrong date on a contract.
 *
 * **Every write sends its payload as one `json` parameter and lets Postgres
 * cast it**, through `json_populate_recordset(null::public.<table>, $1::json)`.
 * The alternative — deciding in JavaScript whether `['a','b']` meant `text[]`
 * or a JSON array, or whether an object meant `jsonb` or a composite — is
 * guessing at column types from values, which is wrong for at least one column
 * in this schema whichever way you guess. Postgres already knows the type of
 * every column; this asks it.
 *
 * ── What is not handled, deliberately ─────────────────────────────────────
 *
 * `.or()`, `.contains()`, `.overlaps()`, `.range()`, `.not()`, `count`,
 * `head`, and any embed not named below. None is used by this directory. Each
 * throws.
 */

import type { PostgrestErrorLike } from './errors'
import { PG_ERROR } from './errors'
import type { Db, Row } from './client'
import type { TransactionSql } from './postgres'

// ── Failing loudly ────────────────────────────────────────────────────────

/**
 * A query this compiler will not guess at.
 *
 * A programming error, so it throws rather than becoming `{ error }`: an
 * adapter that reached an unsupported shape has a bug, and returning it as a
 * database error would send it through `translateWriteError` and out to a user
 * as though the database had refused something.
 */
export class UnsupportedQuery extends Error {
  constructor(detail: string) {
    super(
      `This query cannot be run inside a transaction: ${detail}. ` +
        `src/lib/persistence/postgrest-sql.ts supports only the shapes the ` +
        `adapters in this directory use, and refuses the rest rather than ` +
        `approximating them.`,
    )
    this.name = 'UnsupportedQuery'
  }
}

// ── Identifiers ───────────────────────────────────────────────────────────

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Quote an identifier, having first proved it is one.
 *
 * Table and column names in this layer come from adapter source, never from a
 * request — but "never" is a claim about today's call sites, and this is the
 * one place where being wrong about it would be an injection. Values never
 * take this path: they are parameters, always.
 */
function ident(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new UnsupportedQuery(`'${name}' is not a valid identifier`)
  }
  return `"${name}"`
}

// ── Embeds ────────────────────────────────────────────────────────────────

interface Relation {
  /** The table the embed reads from. */
  table: string
  /** The column on the parent. */
  localColumn: string
  /** The column on the embedded table. */
  foreignColumn: string
  /** `one` renders an object or null; `many` renders an array. */
  cardinality: 'one' | 'many'
}

/**
 * The embeds that may appear inside a transaction, by name.
 *
 * PostgREST resolves an embed from the foreign keys it finds in the schema
 * cache. Reproducing that would mean reading `pg_constraint` and guessing at
 * ambiguity, which is exactly the "second implementation" this file exists to
 * avoid — so embeds are declared, not discovered, and an undeclared one
 * throws.
 *
 * Only one is needed today. `BOOKING_COLUMNS` in `booking.ts` carries
 * `guests(full_name)`, and `insertBooking` re-reads the booking through it
 * while the transaction is open. Everything else this directory embeds —
 * `roles!inner(…)` in `actor.ts`, the four in `metrics.ts` — belongs to a
 * read-only source that runs before an operation opens its unit of work, and
 * would throw here rather than quietly return a booking with no price lines.
 */
const RELATIONS: Readonly<Record<string, Relation>> = {
  'bookings.guests': {
    table: 'guests',
    localColumn: 'guest_id',
    foreignColumn: 'id',
    cardinality: 'one',
  },
  'bookings.booking_price_lines': {
    table: 'booking_price_lines',
    localColumn: 'id',
    foreignColumn: 'booking_id',
    cardinality: 'many',
  },
  'invoices.invoice_lines': {
    table: 'invoice_lines',
    localColumn: 'id',
    foreignColumn: 'invoice_id',
    cardinality: 'many',
  },
  'credit_notes.credit_note_lines': {
    table: 'credit_note_lines',
    localColumn: 'id',
    foreignColumn: 'credit_note_id',
    cardinality: 'many',
  },
}

// ── The parsed query ──────────────────────────────────────────────────────

export type FilterOp = 'eq' | 'neq' | 'is' | 'lt' | 'lte' | 'gt' | 'gte' | 'in'

export interface Filter {
  op: FilterOp
  column: string
  value: unknown
}

export interface Ordering {
  column: string
  ascending: boolean
}

type SelectField =
  | { kind: 'column'; name: string }
  | { kind: 'star' }
  | { kind: 'embed'; name: string; inner: boolean; fields: SelectField[] }

export interface QuerySpec {
  table: string
  verb: 'select' | 'insert' | 'update' | 'delete' | 'upsert'
  /** The PostgREST select string, or `undefined` for a write with no returning. */
  returning?: string
  payload?: unknown
  /** Comma-separated conflict target, as PostgREST's `onConflict`. */
  onConflict?: string
  ignoreDuplicates?: boolean
  filters: Filter[]
  order: Ordering[]
  limit?: number
}

export interface Compiled {
  text: string
  params: unknown[]
  /** Columns added only so the aggregate could order by them. */
  hidden: string[]
}

// ── Parsing a PostgREST select string ─────────────────────────────────────

/**
 * `'id, guests(full_name), roles!inner(code)'` → a field tree.
 *
 * Hand-written rather than a regex because embeds nest, and a regex that
 * matches balanced parentheses is a regex nobody can fix later.
 */
export function parseSelect(select: string): SelectField[] {
  let index = 0

  function parseList(depth: number): SelectField[] {
    const fields: SelectField[] = []

    for (;;) {
      skipSpace()
      if (index >= select.length) break
      if (select[index] === ')') break

      const field = parseField(depth)
      fields.push(field)

      skipSpace()
      if (select[index] === ',') {
        index += 1
        continue
      }
      break
    }

    return fields
  }

  function parseField(depth: number): SelectField {
    skipSpace()
    const start = index
    while (
      index < select.length &&
      !',()'.includes(select[index] as string) &&
      select[index] !== ' '
    ) {
      index += 1
    }
    const raw = select.slice(start, index).trim()
    if (raw === '') throw new UnsupportedQuery(`empty field in '${select}'`)

    const inner = raw.endsWith('!inner')
    const name = inner ? raw.slice(0, -'!inner'.length) : raw

    if (name.includes('!')) {
      throw new UnsupportedQuery(
        `'${raw}' names an explicit relationship; only '!inner' is understood`,
      )
    }
    if (name.includes(':')) {
      throw new UnsupportedQuery(
        `'${raw}' renames a column, which is not supported`,
      )
    }

    skipSpace()
    if (select[index] === '(') {
      if (depth >= 2) {
        throw new UnsupportedQuery(`'${name}' nests embeds more than two deep`)
      }
      index += 1
      const fields = parseList(depth + 1)
      skipSpace()
      if (select[index] !== ')') {
        throw new UnsupportedQuery(`unbalanced parentheses in '${select}'`)
      }
      index += 1
      return { kind: 'embed', name, inner, fields }
    }

    if (inner) {
      throw new UnsupportedQuery(`'${raw}' marks !inner on a plain column`)
    }
    if (name === '*') return { kind: 'star' }
    return { kind: 'column', name }
  }

  function skipSpace() {
    while (index < select.length && /\s/.test(select[index] as string))
      index += 1
  }

  const parsed = parseList(0)
  skipSpace()
  if (index < select.length) {
    throw new UnsupportedQuery(`trailing input in select '${select}'`)
  }
  return parsed
}

// ── Parameters ────────────────────────────────────────────────────────────

class Params {
  readonly values: unknown[] = []

  /** Bind one value and return its placeholder. */
  bind(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

// ── Compiling ─────────────────────────────────────────────────────────────

/** `t."col" = $1`, and the four shapes that are not that. */
function compileFilter(filter: Filter, alias: string, params: Params): string {
  const column = `${alias}.${ident(filter.column)}`

  switch (filter.op) {
    case 'eq':
      return `${column} = ${params.bind(filter.value)}`
    case 'neq':
      return `${column} <> ${params.bind(filter.value)}`
    case 'lt':
      return `${column} < ${params.bind(filter.value)}`
    case 'lte':
      return `${column} <= ${params.bind(filter.value)}`
    case 'gt':
      return `${column} > ${params.bind(filter.value)}`
    case 'gte':
      return `${column} >= ${params.bind(filter.value)}`
    case 'is': {
      // `.is()` takes null or a boolean and nothing else. `IS NULL` is not
      // `= NULL`, and the difference is every row versus no rows.
      if (filter.value === null) return `${column} is null`
      if (filter.value === true) return `${column} is true`
      if (filter.value === false) return `${column} is false`
      throw new UnsupportedQuery(
        `.is('${filter.column}', …) takes null or a boolean`,
      )
    }
    case 'in': {
      if (!Array.isArray(filter.value)) {
        throw new UnsupportedQuery(`.in('${filter.column}', …) takes an array`)
      }
      // An empty list matches nothing. `in ()` is a syntax error and
      // `in (null)` matches nothing but by accident; `false` says it.
      if (filter.value.length === 0) return 'false'
      const placeholders = filter.value.map((item) => params.bind(item))
      return `${column} in (${placeholders.join(', ')})`
    }
    default: {
      const exhaustive: never = filter.op
      throw new UnsupportedQuery(`filter '${String(exhaustive)}'`)
    }
  }
}

interface FieldSql {
  /** The projected expressions, each already aliased. */
  expressions: string[]
  /** Extra predicates an `!inner` embed adds to the parent. */
  innerPredicates: string[]
}

function compileFields(
  fields: SelectField[],
  table: string,
  alias: string,
  params: Params,
): FieldSql {
  const expressions: string[] = []
  const innerPredicates: string[] = []

  for (const field of fields) {
    if (field.kind === 'star') {
      expressions.push(`${alias}.*`)
      continue
    }

    if (field.kind === 'column') {
      expressions.push(`${alias}.${ident(field.name)} as ${ident(field.name)}`)
      continue
    }

    const relation = RELATIONS[`${table}.${field.name}`]
    if (!relation) {
      throw new UnsupportedQuery(
        `the embed '${field.name}' on '${table}' is not declared in RELATIONS`,
      )
    }

    const child = `e_${expressions.length}_${relation.table}`
    const nested = compileFields(field.fields, relation.table, child, params)
    if (nested.innerPredicates.length > 0) {
      throw new UnsupportedQuery(`'!inner' nested inside '${field.name}'`)
    }

    const join =
      `from public.${ident(relation.table)} ${child} ` +
      `where ${child}.${ident(relation.foreignColumn)} = ` +
      `${alias}.${ident(relation.localColumn)}`

    if (relation.cardinality === 'one') {
      expressions.push(
        `(select to_jsonb(sub) from ` +
          `(select ${nested.expressions.join(', ')} ${join} limit 1) sub) ` +
          `as ${ident(field.name)}`,
      )
    } else {
      expressions.push(
        `(select coalesce(jsonb_agg(to_jsonb(sub)), '[]'::jsonb) from ` +
          `(select ${nested.expressions.join(', ')} ${join}) sub) ` +
          `as ${ident(field.name)}`,
      )
    }

    if (field.inner) {
      innerPredicates.push(`exists (select 1 ${join})`)
    }
  }

  if (expressions.length === 0) {
    throw new UnsupportedQuery(`a select with no fields on '${table}'`)
  }

  return { expressions, innerPredicates }
}

/**
 * Wrap a row-producing query so it comes back as one JSON document.
 *
 * The ordering is applied twice on purpose. Inside, so `limit` takes the right
 * rows; and again on the aggregate, because `jsonb_agg` over an ordered
 * subquery is not *guaranteed* to preserve that order — it happens to today,
 * and a price breakdown that shuffles under a future planner change is the
 * kind of bug nobody reproduces.
 */
function wrapAsJson(inner: string, order: Ordering[]): string {
  const aggOrder =
    order.length > 0
      ? ` order by ${order
          .map((o) => `q.${ident(o.column)} ${o.ascending ? 'asc' : 'desc'}`)
          .join(', ')}`
      : ''
  return (
    `select coalesce(jsonb_agg(to_jsonb(q)${aggOrder}), '[]'::jsonb) as data ` +
    `from (${inner}) q`
  )
}

function orderClause(order: Ordering[], alias: string): string {
  if (order.length === 0) return ''
  const parts = order.map(
    (o) => `${alias}.${ident(o.column)} ${o.ascending ? 'asc' : 'desc'}`,
  )
  return ` order by ${parts.join(', ')}`
}

/**
 * The payload, as one `json` parameter.
 *
 * `json` and not `jsonb`: `jsonb` normalises, and normalising a number the
 * caller wrote as `1.10` before Postgres has seen the column type is a
 * conversion this layer has no business performing.
 */
function payloadParameter(
  payload: unknown,
  params: Params,
  /**
   * `set` for an update, which reads through `json_populate_record` and wants
   * a JSON *object*; `rows` for an insert, which reads through
   * `json_populate_recordset` and wants an array. Getting this wrong is a
   * runtime type error from Postgres rather than anything the type system
   * catches, which is why the two callers pass it explicitly.
   */
  shape: 'rows' | 'set',
): string {
  const rows = Array.isArray(payload) ? payload : [payload]
  if (rows.length === 0) {
    throw new UnsupportedQuery('a write with an empty payload')
  }
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new UnsupportedQuery('a write payload that is not an object')
    }
  }
  const value = shape === 'set' ? rows[0] : rows
  return `${params.bind(JSON.stringify(value))}::json`
}

/**
 * The columns a write names.
 *
 * The union across rows, in first-seen order. `json_populate_recordset` gives
 * NULL for a key a row omits, so a column absent from *every* row takes its
 * database default — which is what `booking.ts` relies on for `reference`,
 * `guest_token` and `total_agorot`, all of which are owned by triggers and
 * must not be sent.
 */
function payloadColumns(payload: unknown): string[] {
  const rows = (Array.isArray(payload) ? payload : [payload]) as Row[]
  const columns: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      // `undefined` is not a value. PostgREST omits it; sending it as JSON
      // `null` would overwrite a column with null instead of leaving it alone.
      if (row[key] === undefined) continue
      if (!columns.includes(key)) columns.push(key)
    }
  }
  if (columns.length === 0) {
    throw new UnsupportedQuery('a write payload with no columns')
  }
  return columns
}

/** Strip `undefined` so `JSON.stringify` and the column list agree. */
function definedRows(payload: unknown): unknown {
  const rows = (Array.isArray(payload) ? payload : [payload]) as Row[]
  const cleaned = rows.map((row) => {
    const out: Row = {}
    for (const [key, value] of Object.entries(row)) {
      if (value !== undefined) out[key] = value
    }
    return out
  })
  return Array.isArray(payload) ? cleaned : cleaned[0]
}

export function compile(spec: QuerySpec): Compiled {
  const params = new Params()
  const table = ident(spec.table)

  // Ordering columns have to exist in the projection for the aggregate to
  // order by them. Any that were not asked for are added and then removed
  // from the rows before they are handed back.
  const hidden: string[] = []

  const buildProjection = (
    alias: string,
    selectString: string,
  ): { expressions: string[]; innerPredicates: string[] } => {
    const fields = parseSelect(selectString)
    const compiled = compileFields(fields, spec.table, alias, params)
    const hasStar = fields.some((f) => f.kind === 'star')
    if (!hasStar) {
      const named = new Set(
        fields
          .filter((f) => f.kind !== 'star')
          .map((f) => (f as { name: string }).name),
      )
      for (const o of spec.order) {
        if (!named.has(o.column)) {
          compiled.expressions.push(
            `${alias}.${ident(o.column)} as ${ident(o.column)}`,
          )
          named.add(o.column)
          hidden.push(o.column)
        }
      }
    }
    return compiled
  }

  if (spec.verb === 'select') {
    const projection = buildProjection('t', spec.returning ?? '*')
    const predicates = [
      ...spec.filters.map((f) => compileFilter(f, 't', params)),
      ...projection.innerPredicates,
    ]
    const where =
      predicates.length > 0 ? ` where ${predicates.join(' and ')}` : ''
    const limit = spec.limit === undefined ? '' : ` limit ${Number(spec.limit)}`
    const inner =
      `select ${projection.expressions.join(', ')} from public.${table} t` +
      where +
      orderClause(spec.order, 't') +
      limit

    return {
      text: wrapAsJson(inner, spec.order),
      params: params.values,
      hidden,
    }
  }

  // ── Writes ──────────────────────────────────────────────────────────────
  //
  // Each is one statement. When a `returning` was asked for, the write becomes
  // a CTE and the projection selects from it — so the rows handed back are the
  // rows this statement wrote, and never a re-read that another session could
  // have moved in between.

  let write: string

  if (spec.verb === 'insert' || spec.verb === 'upsert') {
    const payload = definedRows(spec.payload)
    const columns = payloadColumns(payload)
    const columnList = columns.map(ident).join(', ')
    const source = payloadParameter(payload, params, 'rows')

    let conflict = ''
    if (spec.verb === 'upsert') {
      if (!spec.onConflict) {
        throw new UnsupportedQuery('an upsert with no onConflict target')
      }
      if (!spec.ignoreDuplicates) {
        // `do update` would hand the key to the second caller and let both
        // proceed — the exact failure `idempotency.ts` exists to prevent. No
        // call site wants it, so it is refused rather than implemented.
        throw new UnsupportedQuery(
          'an upsert without ignoreDuplicates (ON CONFLICT DO UPDATE)',
        )
      }
      const target = spec.onConflict
        .split(',')
        .map((column) => ident(column.trim()))
        .join(', ')
      conflict = ` on conflict (${target}) do nothing`
    }

    write =
      `insert into public.${table} (${columnList}) ` +
      `select ${columns.map((c) => `r.${ident(c)}`).join(', ')} ` +
      `from json_populate_recordset(null::public.${table}, ${source}) r` +
      conflict
  } else if (spec.verb === 'update') {
    const payload = definedRows(spec.payload)
    if (Array.isArray(payload)) {
      throw new UnsupportedQuery('an update with an array payload')
    }
    const columns = payloadColumns(payload)
    const source = payloadParameter(payload, params, 'set')
    const assignments = columns
      .map((c) => `${ident(c)} = r.${ident(c)}`)
      .join(', ')
    const predicates = spec.filters.map((f) => compileFilter(f, 't', params))
    if (predicates.length === 0) {
      // An update with no predicate is every row in the table. RLS would still
      // bound it to the tenant, which is precisely why this has to be caught
      // here: "only the whole organization" is not a safe accident.
      throw new UnsupportedQuery('an update with no filters')
    }
    write =
      `update public.${table} t set ${assignments} ` +
      `from json_populate_record(null::public.${table}, ${source}) r ` +
      `where ${predicates.join(' and ')}`
  } else {
    const predicates = spec.filters.map((f) => compileFilter(f, 't', params))
    if (predicates.length === 0) {
      throw new UnsupportedQuery('a delete with no filters')
    }
    write = `delete from public.${table} t where ${predicates.join(' and ')}`
  }

  if (spec.returning === undefined) {
    return { text: write, params: params.values, hidden }
  }

  const projection = buildProjection('t', spec.returning)
  if (projection.innerPredicates.length > 0) {
    throw new UnsupportedQuery("'!inner' in a returning clause")
  }
  // `returning t.*`, not `returning *`, for the two statements that carry a
  // FROM clause.
  //
  // `UPDATE t … FROM r RETURNING *` expands to the target's columns *and* the
  // from-list's, so `w` would hold two columns called `id` and every reference
  // to one afterwards is `42702: column reference "id" is ambiguous`. Found by
  // running the compiled statement against the live database, which is the
  // only way it could have been found: it compiles, it type-checks, and every
  // unit test that asserts on the SQL text passes.
  //
  // An INSERT has no from-list to collide with — `json_populate_recordset`
  // feeds its SELECT rather than joining the target — so it keeps `*`.
  const returning =
    spec.verb === 'update' || spec.verb === 'delete' ? 't.*' : '*'

  const inner = `select ${projection.expressions.join(', ')} from w t`
  const text =
    `with w as (${write} returning ${returning}) ` +
    wrapAsJson(inner, spec.order)

  return { text, params: params.values, hidden }
}

// ── Executing ─────────────────────────────────────────────────────────────

export interface Response<T = unknown> {
  data: T
  error: PostgrestErrorLike | null
}

/** A postgres.js error, translated into the shape adapters already handle. */
export function toPostgrestError(error: unknown): PostgrestErrorLike {
  const candidate = error as Record<string, unknown> | null
  const code = typeof candidate?.code === 'string' ? candidate.code : 'XX000'
  const message =
    typeof candidate?.message === 'string' ? candidate.message : String(error)
  // The constraint name is folded into `details` because that is where
  // `isOccupancyConflict` looks: PostgREST puts it in the message, postgres.js
  // puts it in a separate field, and the adapters must not have to know which
  // driver they are behind.
  const constraint =
    typeof candidate?.constraint_name === 'string'
      ? candidate.constraint_name
      : null
  const detail = typeof candidate?.detail === 'string' ? candidate.detail : null
  const details = [detail, constraint].filter(Boolean).join(' ') || null

  return {
    code,
    message:
      constraint && !message.includes(constraint)
        ? `${message} (constraint ${constraint})`
        : message,
    details,
    hint: typeof candidate?.hint === 'string' ? candidate.hint : null,
  }
}

/** What PostgREST returns when `.single()` did not match exactly one row. */
function noRowsError(count: number): PostgrestErrorLike {
  return {
    code: PG_ERROR.NO_ROWS,
    message: 'JSON object requested, multiple (or no) rows returned',
    details: `The result contains ${count} rows`,
    hint: null,
  }
}

type Cardinality = 'many' | 'single' | 'maybeSingle'

/**
 * The builder, one per `.from(table)`.
 *
 * Thenable rather than a promise, exactly like PostgREST's: the query is not
 * sent until it is awaited, which is what lets `metrics.ts` build a query and
 * narrow it afterwards.
 */
class Builder implements PromiseLike<Response> {
  private spec: QuerySpec
  private cardinality: Cardinality = 'many'

  constructor(
    private readonly sql: TransactionSql,
    table: string,
  ) {
    this.spec = { table, verb: 'select', filters: [], order: [] }
  }

  select(columns = '*'): this {
    if (this.spec.verb === 'select') this.spec.returning = columns
    else this.spec.returning = columns
    return this
  }

  insert(payload: unknown): this {
    this.spec.verb = 'insert'
    this.spec.payload = payload
    this.spec.returning = undefined
    return this
  }

  upsert(
    payload: unknown,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): this {
    this.spec.verb = 'upsert'
    this.spec.payload = payload
    this.spec.onConflict = options?.onConflict
    this.spec.ignoreDuplicates = options?.ignoreDuplicates ?? false
    this.spec.returning = undefined
    return this
  }

  update(payload: unknown): this {
    this.spec.verb = 'update'
    this.spec.payload = payload
    this.spec.returning = undefined
    return this
  }

  delete(): this {
    this.spec.verb = 'delete'
    this.spec.returning = undefined
    return this
  }

  eq(column: string, value: unknown): this {
    return this.filter('eq', column, value)
  }
  neq(column: string, value: unknown): this {
    return this.filter('neq', column, value)
  }
  is(column: string, value: unknown): this {
    return this.filter('is', column, value)
  }
  lt(column: string, value: unknown): this {
    return this.filter('lt', column, value)
  }
  lte(column: string, value: unknown): this {
    return this.filter('lte', column, value)
  }
  gt(column: string, value: unknown): this {
    return this.filter('gt', column, value)
  }
  gte(column: string, value: unknown): this {
    return this.filter('gte', column, value)
  }
  in(column: string, values: readonly unknown[]): this {
    return this.filter('in', column, [...values])
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.spec.order.push({ column, ascending: options?.ascending ?? true })
    return this
  }

  limit(count: number): this {
    this.spec.limit = count
    return this
  }

  single(): this {
    this.cardinality = 'single'
    return this
  }

  maybeSingle(): this {
    this.cardinality = 'maybeSingle'
    return this
  }

  private filter(op: FilterOp, column: string, value: unknown): this {
    this.spec.filters.push({ op, column, value })
    return this
  }

  then<TResult1 = Response, TResult2 = never>(
    onfulfilled?:
      ((value: Response) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  private async execute(): Promise<Response> {
    // A write with no `.select()` still has to run. PostgREST returns
    // `data: null` for it, and so does this.
    const wantsRows =
      this.spec.verb === 'select' || this.spec.returning !== undefined

    let compiled: Compiled
    try {
      compiled = compile(
        this.spec.verb === 'select' && this.spec.returning === undefined
          ? { ...this.spec, returning: '*' }
          : this.spec,
      )
    } catch (error) {
      // `UnsupportedQuery` is a bug in the caller, not a database refusal.
      throw error
    }

    let rows: readonly Row[]
    try {
      const result = await this.sql.unsafe(
        compiled.text,
        compiled.params as never[],
      )
      rows = wantsRows ? ((result[0]?.data ?? []) as Row[]) : []
    } catch (error) {
      return { data: null, error: toPostgrestError(error) }
    }

    if (compiled.hidden.length > 0) {
      for (const row of rows) {
        for (const column of compiled.hidden) delete row[column]
      }
    }

    if (!wantsRows) return { data: null, error: null }

    if (this.cardinality === 'single') {
      if (rows.length !== 1)
        return { data: null, error: noRowsError(rows.length) }
      return { data: rows[0], error: null }
    }
    if (this.cardinality === 'maybeSingle') {
      if (rows.length === 0) return { data: null, error: null }
      if (rows.length > 1)
        return { data: null, error: noRowsError(rows.length) }
      return { data: rows[0], error: null }
    }
    return { data: rows, error: null }
  }
}

/**
 * A `Db`-shaped client that runs on an open transaction.
 *
 * Structurally compatible with `SupabaseClient` for the surface the adapters
 * use, and cast at the boundary — the same trade `fake-client.ts` makes, and
 * for the same reason: the real type has hundreds of members, none of which
 * this directory calls.
 */
export class TransactionClient {
  constructor(private readonly sql: TransactionSql) {}

  from(table: string): Builder {
    return new Builder(this.sql, table)
  }

  /**
   * `rpc`, for the one thing that must be a function call.
   *
   * `next_invoice_number()` is a counter-row lock, and reimplementing it as
   * read-then-write would reintroduce the race that makes two tax invoices
   * share a number. Named-argument syntax, so argument order here cannot
   * silently disagree with the function's signature.
   */
  async rpc(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Response> {
    const params = new Params()
    const entries = Object.entries(args)
    const call = entries
      .map(([key, value]) => `${ident(key)} => ${params.bind(value)}`)
      .join(', ')
    const text = `select to_jsonb(public.${ident(name)}(${call})) as data`

    try {
      const result = await this.sql.unsafe(text, params.values as never[])
      return { data: (result[0]?.data ?? null) as unknown, error: null }
    } catch (error) {
      return { data: null, error: toPostgrestError(error) }
    }
  }

  /** The same object, typed as the client the adapters were written against. */
  asDb(): Db {
    return this as unknown as Db
  }
}
