/**
 * The demo's database: the same queries, over an array instead of over HTTP.
 *
 * ══ THIS CLIENT DOES NOT ENFORCE ROW LEVEL SECURITY ══════════════════════
 *
 * Say it plainly, because the rest of this codebase rests on the opposite.
 * Against Postgres, `bookings_select` is `organization_id in (select
 * my_organizations())` and a query that forgets its tenant filter returns
 * nothing. Here, a query that forgets its tenant filter returns everything the
 * dataset holds. There is no policy engine behind these arrays and there is no
 * pretending otherwise — not in a comment, not in a screen, not in a caption
 * under the persona switcher.
 *
 * What the demo *does* exercise is `can()`. Every screen still resolves an
 * actor through membership → roles → grants → scope, still calls
 * `requireGrant`, and still hides what the plan does not include. That is the
 * floor the product actually stands on in the browser, and it is a real floor:
 * it is what decides that a cleaner sees no money and an external agent sees no
 * guest telephone number. RLS is the second, independent refusal underneath it,
 * and the demo simply does not have it. The dataset is one organization for
 * exactly that reason — with no second tenant present, there is no boundary
 * here to be wrong about.
 *
 * ── Not a PostgREST reimplementation, and must not become one ─────────────
 *
 * `src/lib/persistence/postgrest-sql.ts` already made this decision once, for
 * the transaction compiler, and this file follows it rather than re-arguing it:
 * the supported surface is precisely what the screens and adapters use, and
 * everything else **throws**. A `.or()` quietly ignored is not a slightly wrong
 * list; it is a list of rows the caller never asked for, and in a product whose
 * every read is scoped by `organization_id` that is the shape of a cross-tenant
 * read. `UnsupportedQuery` in the console is cheap. Wrong rows are not.
 *
 * The select parser is imported from that file, not rewritten here. Two
 * hand-written parsers for one syntax is two things to fix when the syntax
 * grows, and the second one is always the one nobody remembers.
 *
 * ── Values are rendered as PostgREST renders them ─────────────────────────
 *
 * `mapping.ts` is the consumer and it is strict: `asIsoDate` wants
 * `"2099-03-10"` and not a `Date`, `asNumber` accepts the string a `numeric`
 * column arrives as, `asJsonRecord` wants a plain object. So the rows in the
 * dataset are already JSON — the demo stores what the wire would have carried,
 * and this file never converts anything on the way out. The only values it
 * *creates* are the ones the database creates (see `GENERATED` below), and each
 * is written in the shape its column would have arrived in.
 */

import { PG_ERROR, type PostgrestErrorLike } from '../persistence/errors'
import {
  RELATIONS,
  UnsupportedQuery,
  parseSelect,
  type FilterOp,
} from '../persistence/postgrest-sql'
import type { DemoDataset, DemoRow, DemoTables } from './types'

/* ---------------------------------------------------------------- errors -- */

/**
 * A table the dataset does not carry.
 *
 * Deliberately not "no rows". A screen reading `incidents` when the dataset has
 * no `incidents` key is a screen the demo cannot honestly show, and answering
 * `[]` would render it as a clean empty state — which is the demo asserting
 * that this business has no incidents, when in truth nobody wrote any down. An
 * empty array in the dataset says "none, and I meant it"; a missing key says
 * "not thought about yet", and those must not look the same.
 */
export class MissingDemoTable extends Error {
  constructor(table: string) {
    super(
      `The demo dataset has no '${table}' table, so this screen cannot be ` +
        `shown honestly. Add '${table}' to DEMO_DATASET.tables in ` +
        `src/lib/demo/dataset.ts — as an empty array if the answer really is ` +
        `"none", which is a different statement from "not seeded yet".`,
    )
    this.name = 'MissingDemoTable'
  }
}

/* ------------------------------------------------------------- relations -- */

type Relation = (typeof RELATIONS)[string]

/**
 * The embeds the demo can resolve, by name.
 *
 * `RELATIONS` is the set the transaction compiler needs — the re-reads that
 * happen while a unit of work is open. The demo needs a superset, because it
 * also serves the read-only sources that run *before* an operation opens:
 * `actor.ts` resolving roles and the plan, `context.ts` listing workspaces and
 * role badges, the list screens naming a unit or a property. Those are absent
 * from `RELATIONS` on purpose — it throws on them so that a read-only query
 * cannot be issued inside a transaction by accident — so they are added here
 * rather than pushed down into a file whose refusals are load-bearing.
 *
 * Declared, never discovered. PostgREST resolves an embed from the foreign keys
 * in its schema cache; reading `pg_constraint` to reproduce that would be the
 * second implementation this whole approach exists to avoid. An embed that is
 * not written down below throws, and the fix is to write it down.
 */
export const DEMO_RELATIONS: Readonly<Record<string, Relation>> = {
  ...RELATIONS,

  // Identity and authorization: the ordinary path an actor is resolved along.
  'memberships.organizations': {
    table: 'organizations',
    localColumn: 'organization_id',
    foreignColumn: 'id',
    cardinality: 'one',
  },
  'membership_roles.roles': {
    table: 'roles',
    localColumn: 'role_id',
    foreignColumn: 'id',
    cardinality: 'one',
  },
  'roles.role_permissions': {
    table: 'role_permissions',
    localColumn: 'id',
    foreignColumn: 'role_id',
    cardinality: 'many',
  },

  // Plans.
  'organization_subscriptions.plans': {
    table: 'plans',
    localColumn: 'plan_id',
    foreignColumn: 'id',
    cardinality: 'one',
  },

  // The onboarding check for an organization that already has members.
  'organizations.memberships': {
    table: 'memberships',
    localColumn: 'id',
    foreignColumn: 'organization_id',
    cardinality: 'many',
  },

  // Accommodation, as the list screens name it.
  'bookings.units': {
    table: 'units',
    localColumn: 'unit_id',
    foreignColumn: 'id',
    cardinality: 'one',
  },
  'units.properties': {
    table: 'properties',
    localColumn: 'property_id',
    foreignColumn: 'id',
    cardinality: 'one',
  },

  // The four `metrics.ts` reads off a booking to answer the dashboard.
  'bookings.booking_status_history': {
    table: 'booking_status_history',
    localColumn: 'id',
    foreignColumn: 'booking_id',
    cardinality: 'many',
  },
  'bookings.payments': {
    table: 'payments',
    localColumn: 'id',
    foreignColumn: 'booking_id',
    cardinality: 'many',
  },
  'bookings.commissions': {
    table: 'commissions',
    localColumn: 'id',
    foreignColumn: 'booking_id',
    cardinality: 'many',
  },
}

/* -------------------------------------------------- what the database owns -- */

/**
 * Columns Postgres fills in that no caller may supply.
 *
 * This is the one place the demo reproduces database behaviour rather than
 * database *contents*, and it is a short list on purpose. Each entry exists
 * because a screen is otherwise unwalkable, and each corresponds to a default
 * or a trigger written down in `supabase/migrations`:
 *
 *   · `id`, `created_at`, `updated_at`, `version` — `default gen_random_uuid()`,
 *     `default now()` and `tg_touch_row`, on essentially every table since
 *     0001. `version` is the one that matters most: optimistic locking sends
 *     the version it read and expects a stale write to match zero rows, so a
 *     version that never moves turns every second edit into a silent success.
 *   · `bookings.reference` — a booking number is what a person quotes on the
 *     telephone, and `asString(row, 'reference')` throws without one.
 *   · `bookings.guest_token` — the guest portal is a capability URL.
 *
 * A column absent from here is absent from the row, and the mappers say so
 * loudly by name. That is the intended failure: it names a piece of database
 * behaviour the demo has not reproduced, rather than inventing a value.
 */
const GENERATED: Readonly<Record<string, Record<string, () => unknown>>> = {
  bookings: {
    reference: () => `B${randomHex(4).toUpperCase()}`,
    guest_token: () => randomHex(32),
  },
}

/** The four `tg_touch_row` and `default` columns every table shares. */
const UNIVERSAL_INSERT_DEFAULTS: Record<string, () => unknown> = {
  id: () => randomUuid(),
  created_at: () => new Date().toISOString(),
  updated_at: () => new Date().toISOString(),
  version: () => 1,
}

/**
 * The unique constraints the demo enforces, and therefore the ones that can
 * answer `23505`.
 *
 * Not all of them — the schema declares dozens, and reproducing every one would
 * be reimplementing the database a second time in a file that opens by refusing
 * to. These are the ones a demo can actually reach: the idempotency key, whose
 * whole purpose is that the *constraint* is the atomicity and no application
 * check can stand in for it, and the handful that a second click on a form
 * would collide with.
 */
const UNIQUE_KEYS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  organizations: [['slug']],
  memberships: [['user_id', 'organization_id']],
  membership_scopes: [['membership_id']],
  plans: [['code']],
  bookings: [['organization_id', 'reference'], ['guest_token']],
  idempotency_keys: [['organization_id', 'operation', 'key']],
}

/**
 * `bookings.total_agorot` is the sum of the booking's price lines.
 *
 * `tg_bookings_freeze_total` and `tg_price_lines_recalc_total` in 0009. The
 * total is owned by the database in the same way `version` is — a figure a
 * caller typed is discarded, because a total that is not the sum of its lines
 * cannot be explained to the guest who is asking why it is 6,400. The demo
 * keeps that property, because a booking screen whose total disagrees with its
 * own breakdown is a screen demonstrating a bug the product does not have.
 */
function recalculateBookingTotals(db: DemoDatabase, bookingIds: string[]) {
  if (!db.has('bookings') || !db.has('booking_price_lines')) return

  for (const bookingId of new Set(bookingIds)) {
    const booking = db
      .rows('bookings')
      .find((row) => looseEquals(row.id, bookingId))
    if (!booking || !('total_agorot' in booking)) continue

    let total = 0
    for (const line of db.rows('booking_price_lines')) {
      if (looseEquals(line.booking_id, bookingId)) {
        total += Number(line.amount_agorot ?? 0)
      }
    }
    booking.total_agorot = total
  }
}

/* --------------------------------------------------------------- values -- */

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function randomUuid(): string {
  return crypto.randomUUID()
}

/** SQL has one absence; a row that omits a key and a row holding null agree. */
function isNullish(value: unknown): boolean {
  return value === null || value === undefined
}

/**
 * Equality, as the database would decide it.
 *
 * PostgREST sends every filter value as text and lets Postgres cast it to the
 * column's type, so `.eq('adults', 2)` and `.eq('adults', '2')` are the same
 * query against an `integer` column. In memory there is no column type to cast
 * to, so the comparison is made on the string rendering when the two sides
 * disagree about their JavaScript type — which reproduces the cast for every
 * scalar this schema stores, and is the only reading under which a `numeric`
 * arriving as `"1"` matches a filter written as `1`.
 *
 * Null is never equal to anything, including null. `.is()` is how you ask that
 * question, and conflating the two is how a soft-delete filter starts matching
 * live rows.
 */
function looseEquals(left: unknown, right: unknown): boolean {
  if (isNullish(left) || isNullish(right)) return false
  if (typeof left === typeof right) return left === right
  return String(left) === String(right)
}

/**
 * Ordering, as the database would decide it.
 *
 * Numbers numerically, everything else by its string rendering. Postgres would
 * use the column's collation for text, which for Hebrew names is not code-unit
 * order — so a list of guests sorted by name can differ from production here.
 * That is a real limitation and it is written down rather than hidden: it
 * changes the order of a list and never its contents.
 */
function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1
  }
  const a = String(left)
  const b = String(right)
  return a === b ? 0 : a < b ? -1 : 1
}

/** `<`, `<=`, `>`, `>=`: null compares to nothing, exactly as in SQL. */
function compareFilter(rowValue: unknown, filterValue: unknown): number | null {
  if (isNullish(rowValue) || isNullish(filterValue)) return null
  return compareValues(rowValue, filterValue)
}

/**
 * An `ilike` pattern as a regular expression.
 *
 * `%` and `_` are the wildcards, `\` escapes them — `escapeLike` in the
 * bookings query relies on exactly that, so a guest called "100%" matches
 * themselves rather than every guest in the business. Everything else is
 * literal, which means every regex metacharacter in the pattern has to be
 * escaped before the wildcards are put back.
 */
function likePattern(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '\\') {
      index += 1
      const escaped = pattern[index]
      if (escaped === undefined) {
        throw new UnsupportedQuery(`a like pattern ending in a backslash`)
      }
      source += escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      continue
    }
    if (character === '%') {
      source += '.*'
      continue
    }
    if (character === '_') {
      source += '.'
      continue
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'iu')
}

/* ------------------------------------------------------------- the store -- */

/**
 * The rows, for the life of the process.
 *
 * Cloned from the dataset on construction so a write cannot edit the module
 * that declared it — the dataset is a constant, and a demo that mutated it
 * would behave differently on the second `npm run demo` for reasons nobody
 * could see in a diff. After the clone, mutation is the point: create a booking
 * on the calendar and it is on the bookings list, because that is the same row.
 */
export class DemoDatabase {
  private readonly tables: DemoTables

  constructor(readonly dataset: DemoDataset) {
    this.tables = {}
    for (const [name, rows] of Object.entries(dataset.tables)) {
      this.tables[name] = rows.map((row) => ({ ...row }))
    }
  }

  has(table: string): boolean {
    return table in this.tables
  }

  /** The live array. Callers mutate it; that is how a write persists. */
  rows(table: string): DemoRow[] {
    const rows = this.tables[table]
    if (!rows) throw new MissingDemoTable(table)
    return rows
  }
}

/* -------------------------------------------------------------- the spec -- */

type DemoFilterOp = FilterOp | 'ilike' | 'like'

interface DemoFilter {
  op: DemoFilterOp
  /** May be `embed.column`, which narrows through an `!inner` embed. */
  column: string
  value: unknown
}

interface DemoOrdering {
  column: string
  ascending: boolean
  nullsFirst: boolean
}

type SelectField = ReturnType<typeof parseSelect>[number]

/* ------------------------------------------------------------ projection -- */

interface Projected {
  /** The row as the caller asked for it, embeds included. */
  row: DemoRow
  /** The row as it is stored, for ordering by a column that was not selected. */
  source: DemoRow
}

/**
 * Build one row's projection, or `null` when an `!inner` embed excluded it.
 *
 * `!inner` is a filter wearing a join's clothes, and the bookings list has a
 * comment explaining why it must not be used casually: a reader holding
 * `booking.view` but not `guest.view` would see no bookings at all rather than
 * bookings with the name withheld. So it is honoured exactly — inner and empty
 * means the parent is gone — and never approximated.
 */
function project(
  db: DemoDatabase,
  table: string,
  source: DemoRow,
  fields: readonly SelectField[],
): DemoRow | null {
  const row: DemoRow = {}

  for (const field of fields) {
    if (field.kind === 'star') {
      Object.assign(row, source)
      continue
    }

    if (field.kind === 'column') {
      // A column absent from the stored row reads as SQL null, not as a
      // missing key: `asStringOrNull` and friends treat the two alike, and a
      // key that is simply not there would make `'x' in row` answer a question
      // the database never asks.
      row[field.name] = source[field.name] ?? null
      continue
    }

    const relation = DEMO_RELATIONS[`${table}.${field.name}`]
    if (!relation) {
      throw new UnsupportedQuery(
        `the embed '${field.name}' on '${table}' is not declared in ` +
          `DEMO_RELATIONS (src/lib/demo/client.ts)`,
      )
    }

    const local = source[relation.localColumn]
    const related = isNullish(local)
      ? []
      : db
          .rows(relation.table)
          .filter((candidate) =>
            looseEquals(candidate[relation.foreignColumn], local),
          )

    const embedded: DemoRow[] = []
    for (const candidate of related) {
      const inner = project(db, relation.table, candidate, field.fields)
      if (inner) embedded.push(inner)
    }

    if (relation.cardinality === 'one') {
      // PostgREST renders a to-one embed as an object or null. `actor.ts` and
      // the list screens both also accept a one-element array, defensively;
      // the object is what they are written against and what is produced here.
      const first = embedded[0] ?? null
      if (field.inner && first === null) return null
      row[field.name] = first
    } else {
      if (field.inner && embedded.length === 0) return null
      row[field.name] = embedded
    }
  }

  return row
}

/* --------------------------------------------------------------- filters -- */

function matchesFilter(row: DemoRow, filter: DemoFilter): boolean {
  const value = row[filter.column]

  switch (filter.op) {
    case 'eq':
      return looseEquals(value, filter.value)
    case 'neq':
      // `<>` is not "not eq" when either side is null: SQL answers unknown,
      // and an unknown predicate excludes the row. `.neq('status', 'cancelled')`
      // therefore does not return rows whose status is null, which is what
      // `loadPlan` is relying on.
      return !isNullish(value) && !looseEquals(value, filter.value)
    case 'is': {
      if (filter.value === null) return isNullish(value)
      if (filter.value === true) return value === true
      if (filter.value === false) return value === false
      throw new UnsupportedQuery(
        `.is('${filter.column}', …) takes null or a boolean`,
      )
    }
    case 'lt': {
      const order = compareFilter(value, filter.value)
      return order !== null && order < 0
    }
    case 'lte': {
      const order = compareFilter(value, filter.value)
      return order !== null && order <= 0
    }
    case 'gt': {
      const order = compareFilter(value, filter.value)
      return order !== null && order > 0
    }
    case 'gte': {
      const order = compareFilter(value, filter.value)
      return order !== null && order >= 0
    }
    case 'in': {
      if (!Array.isArray(filter.value)) {
        throw new UnsupportedQuery(`.in('${filter.column}', …) takes an array`)
      }
      return filter.value.some((candidate) => looseEquals(value, candidate))
    }
    case 'like':
    case 'ilike': {
      if (typeof filter.value !== 'string') {
        throw new UnsupportedQuery(
          `.${filter.op}('${filter.column}', …) takes a string pattern`,
        )
      }
      if (typeof value !== 'string') return false
      return likePattern(filter.value).test(value)
    }
    default: {
      const exhaustive: never = filter.op
      throw new UnsupportedQuery(`filter '${String(exhaustive)}'`)
    }
  }
}

/* ---------------------------------------------------------------- errors -- */

/** What PostgREST returns when `.single()` did not match exactly one row. */
function noRowsError(count: number): PostgrestErrorLike {
  return {
    code: PG_ERROR.NO_ROWS,
    message: 'JSON object requested, multiple (or no) rows returned',
    details: `The result contains ${count} rows`,
    hint: null,
  }
}

/** What Postgres returns when a unique index was already holding that value. */
function uniqueViolation(table: string, columns: readonly string[]) {
  const constraint = `${table}_${columns.join('_')}_key`
  return {
    code: PG_ERROR.UNIQUE_VIOLATION,
    message: `duplicate key value violates unique constraint "${constraint}"`,
    details: `Key (${columns.join(', ')}) already exists.`,
    hint: null,
  } satisfies PostgrestErrorLike
}

/* --------------------------------------------------------------- results -- */

export interface DemoResponse<T = unknown> {
  data: T
  error: PostgrestErrorLike | null
  /** Present only when the caller asked for one. */
  count?: number | null
}

type Cardinality = 'many' | 'single' | 'maybeSingle'

interface SelectOptions {
  count?: 'exact' | 'planned' | 'estimated'
  head?: boolean
}

/* -------------------------------------------------------------- the builder */

/**
 * One `.from(table)`, thenable exactly as PostgREST's builder is.
 *
 * Not a promise: nothing runs until it is awaited, which is what lets a caller
 * build a query and narrow it afterwards — `filtered()` in the bookings queries
 * returns a half-built builder and the caller adds the order and the limit, and
 * that only works because the object is inert until `then`.
 */
class DemoQueryBuilder implements PromiseLike<DemoResponse> {
  private verb: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
  private returning: string | undefined
  private payload: unknown
  private onConflict: string | undefined
  private ignoreDuplicates = false
  private readonly filters: DemoFilter[] = []
  private readonly orderings: DemoOrdering[] = []
  private limitCount: number | undefined
  private rangeBounds: { from: number; to: number } | undefined
  private cardinality: Cardinality = 'many'
  private options: SelectOptions = {}

  constructor(
    private readonly db: DemoDatabase,
    private readonly table: string,
  ) {}

  select(columns = '*', options: SelectOptions = {}): this {
    this.returning = columns
    this.options = options
    if (options.count && options.count !== 'exact') {
      // `planned` and `estimated` ask Postgres for the planner's guess. There
      // is no planner here, and answering with the exact figure would be this
      // file inventing a guarantee the caller deliberately declined.
      throw new UnsupportedQuery(
        `count: '${options.count}' has no meaning without a query planner`,
      )
    }
    return this
  }

  insert(payload: unknown): this {
    this.verb = 'insert'
    this.payload = payload
    this.returning = undefined
    return this
  }

  upsert(
    payload: unknown,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): this {
    this.verb = 'upsert'
    this.payload = payload
    this.onConflict = options?.onConflict
    this.ignoreDuplicates = options?.ignoreDuplicates ?? false
    this.returning = undefined
    return this
  }

  update(payload: unknown): this {
    this.verb = 'update'
    this.payload = payload
    this.returning = undefined
    return this
  }

  delete(): this {
    this.verb = 'delete'
    this.returning = undefined
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
  like(column: string, pattern: string): this {
    return this.filter('like', column, pattern)
  }
  ilike(column: string, pattern: string): this {
    return this.filter('ilike', column, pattern)
  }

  order(
    column: string,
    options?: {
      ascending?: boolean
      nullsFirst?: boolean
      referencedTable?: string
      foreignTable?: string
    },
  ): this {
    if (options?.referencedTable ?? options?.foreignTable) {
      throw new UnsupportedQuery('ordering by a referenced table')
    }
    const ascending = options?.ascending ?? true
    this.orderings.push({
      column,
      ascending,
      // Postgres puts nulls last on ascending and first on descending unless
      // told otherwise, and PostgREST passes that through. Guessing the other
      // way round moves a row from the top of a list to the bottom.
      nullsFirst: options?.nullsFirst ?? !ascending,
    })
    return this
  }

  limit(count: number): this {
    this.limitCount = count
    return this
  }

  range(from: number, to: number): this {
    // Both ends inclusive, as PostgREST's `Range` header is.
    this.rangeBounds = { from, to }
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

  private filter(op: DemoFilterOp, column: string, value: unknown): this {
    this.filters.push({ op, column, value })
    return this
  }

  then<TResult1 = DemoResponse, TResult2 = never>(
    onfulfilled?:
      ((value: DemoResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    let result: DemoResponse
    try {
      result = this.run()
    } catch (error) {
      return Promise.reject(error).then(onfulfilled, onrejected)
    }
    return Promise.resolve(result).then(onfulfilled, onrejected)
  }

  /* ------------------------------------------------------------ executing -- */

  private run(): DemoResponse {
    switch (this.verb) {
      case 'select':
        return this.runSelect()
      case 'insert':
      case 'upsert':
        return this.runInsert()
      case 'update':
        return this.runUpdate()
      case 'delete':
        return this.runDelete()
    }
  }

  /** The filters that apply to the table itself, not through an embed. */
  private ownFilters(): DemoFilter[] {
    return this.filters.filter((filter) => !filter.column.includes('.'))
  }

  /**
   * Filters written as `embed.column`.
   *
   * PostgREST lets a filter on an embedded column narrow the parent only when
   * the embed is `!inner`, and the bookings guest-name search depends on
   * exactly that. Applying one to a non-inner embed would silently do nothing
   * useful — the parent would survive with an emptied embed — so it throws
   * instead, because a search that returns every booking is worse than a search
   * that reports a bug.
   */
  private embedFilters(): DemoFilter[] {
    return this.filters.filter((filter) => filter.column.includes('.'))
  }

  private matchingRows(): DemoRow[] {
    const own = this.ownFilters()
    return this.db
      .rows(this.table)
      .filter((row) => own.every((filter) => matchesFilter(row, filter)))
  }

  private runSelect(): DemoResponse {
    const fields = parseSelect(this.returning ?? '*')
    const embedFilters = this.embedFilters()

    const projected: Projected[] = []
    for (const source of this.matchingRows()) {
      const row = project(this.db, this.table, source, fields)
      if (row === null) continue
      if (!this.applyEmbedFilters(row, fields, embedFilters)) continue
      projected.push({ row, source })
    }

    this.sort(projected)

    // The count is of everything that matched, before the window — that is
    // what makes it the number `resolveEmptyReason` needs to tell "you have
    // never made a booking" from "your filter hid all four hundred".
    const total = projected.length
    const windowed = this.window(projected).map((entry) => entry.row)

    if (this.options.head) {
      return { data: null, error: null, count: total }
    }

    const counted = this.options.count ? { count: total } : {}

    if (this.cardinality === 'single') {
      if (windowed.length !== 1) {
        return { data: null, error: noRowsError(windowed.length), ...counted }
      }
      return { data: windowed[0], error: null, ...counted }
    }
    if (this.cardinality === 'maybeSingle') {
      if (windowed.length === 0) return { data: null, error: null, ...counted }
      if (windowed.length > 1) {
        return { data: null, error: noRowsError(windowed.length), ...counted }
      }
      return { data: windowed[0], error: null, ...counted }
    }
    return { data: windowed, error: null, ...counted }
  }

  /**
   * Narrow a projected row by its `embed.column` filters.
   *
   * Returns false when the parent should be dropped. The embed's own rows are
   * narrowed in place, which is what PostgREST does: the filter applies to the
   * embedded resource and, because the embed is inner, to the parent as well.
   */
  private applyEmbedFilters(
    row: DemoRow,
    fields: readonly SelectField[],
    filters: readonly DemoFilter[],
  ): boolean {
    for (const filter of filters) {
      const separator = filter.column.indexOf('.')
      const embedName = filter.column.slice(0, separator)
      const column = filter.column.slice(separator + 1)

      if (column.includes('.')) {
        throw new UnsupportedQuery(
          `the filter '${filter.column}' reaches through two embeds`,
        )
      }

      const field = fields.find(
        (candidate) =>
          candidate.kind === 'embed' && candidate.name === embedName,
      )
      if (!field || field.kind !== 'embed') {
        throw new UnsupportedQuery(
          `the filter '${filter.column}' names an embed that this select ` +
            `does not ask for`,
        )
      }
      if (!field.inner) {
        throw new UnsupportedQuery(
          `the filter '${filter.column}' narrows through '${embedName}', ` +
            `which is not '!inner' — PostgREST would leave the parent row in ` +
            `place, so this is a filter that silently does nothing`,
        )
      }

      const embedded = row[embedName]
      const scalar = { op: filter.op, column, value: filter.value }

      if (Array.isArray(embedded)) {
        const kept = (embedded as DemoRow[]).filter((entry) =>
          matchesFilter(entry, scalar),
        )
        if (kept.length === 0) return false
        row[embedName] = kept
        continue
      }

      if (embedded === null || typeof embedded !== 'object') return false
      if (!matchesFilter(embedded as DemoRow, scalar)) return false
    }
    return true
  }

  /**
   * Order, on the stored row rather than the projected one.
   *
   * PostgREST orders by a column whether or not it was selected, and the
   * transaction compiler goes to some trouble to reproduce that by adding
   * hidden columns to its projection. Here the stored row is simply still to
   * hand, so there is nothing to hide and nothing to strip off afterwards.
   */
  private sort(rows: Projected[]): void {
    if (this.orderings.length === 0) return
    rows.sort((left, right) => {
      for (const ordering of this.orderings) {
        const a = left.source[ordering.column]
        const b = right.source[ordering.column]
        const aNull = isNullish(a)
        const bNull = isNullish(b)
        if (aNull || bNull) {
          if (aNull && bNull) continue
          return (aNull ? -1 : 1) * (ordering.nullsFirst ? 1 : -1)
        }
        const order = compareValues(a, b)
        if (order !== 0) return ordering.ascending ? order : -order
      }
      return 0
    })
  }

  private window(rows: Projected[]): Projected[] {
    let result = rows
    if (this.rangeBounds) {
      result = result.slice(
        this.rangeBounds.from,
        this.rangeBounds.to + 1, // inclusive
      )
    }
    if (this.limitCount !== undefined) {
      result = result.slice(0, this.limitCount)
    }
    return result
  }

  /* --------------------------------------------------------------- writes -- */

  private incoming(): DemoRow[] {
    const raw = Array.isArray(this.payload) ? this.payload : [this.payload]
    if (raw.length === 0) {
      throw new UnsupportedQuery('a write with an empty payload')
    }
    return raw.map((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new UnsupportedQuery('a write payload that is not an object')
      }
      const row: DemoRow = {}
      for (const [key, value] of Object.entries(entry as DemoRow)) {
        // `undefined` is not a value. PostgREST omits it, and sending it as
        // null would overwrite a column instead of leaving it alone.
        if (value !== undefined) row[key] = value
      }
      return row
    })
  }

  /**
   * Fill in what the database would have filled in. See `GENERATED`.
   *
   * The universal four are filled unconditionally, and not only on tables whose
   * seeded rows already show them. The two failure modes are not symmetrical: a
   * `version` on a table that has none is a key nobody selects and nobody can
   * see, while a *missing* `version` breaks optimistic locking, and a missing
   * `created_at` reaches a screen as `null` where a date belongs. Inferring the
   * column list from the rows sounded more faithful and was worse — it made the
   * defaults depend on how completely the dataset happened to write out its
   * fixtures, which is the kind of coupling that fails on the one table
   * somebody wrote in a hurry.
   */
  private withDefaults(row: DemoRow): DemoRow {
    const filled: DemoRow = { ...row }

    for (const [column, make] of Object.entries(UNIVERSAL_INSERT_DEFAULTS)) {
      if (column in filled) continue
      filled[column] = make()
    }

    for (const [column, make] of Object.entries(GENERATED[this.table] ?? {})) {
      if (column in filled && !isNullish(filled[column])) continue
      filled[column] = make()
    }

    return filled
  }

  /** The first unique constraint this row would collide with, if any. */
  private collision(row: DemoRow): readonly string[] | null {
    for (const columns of UNIQUE_KEYS[this.table] ?? []) {
      // A key with a null part cannot collide: `null` is distinct from
      // everything, including another null, in a unique index.
      if (columns.some((column) => isNullish(row[column]))) continue

      const clash = this.db
        .rows(this.table)
        .some((existing) =>
          columns.every((column) => looseEquals(existing[column], row[column])),
        )
      if (clash) return columns
    }
    return null
  }

  private runInsert(): DemoResponse {
    if (this.verb === 'upsert') {
      if (!this.onConflict) {
        throw new UnsupportedQuery('an upsert with no onConflict target')
      }
      if (!this.ignoreDuplicates) {
        // `on conflict do update` hands the key to the second caller and lets
        // both proceed — the exact failure `idempotency.ts` exists to prevent.
        // No call site wants it, so it is refused rather than approximated.
        throw new UnsupportedQuery(
          'an upsert without ignoreDuplicates (ON CONFLICT DO UPDATE)',
        )
      }
    }

    const conflictTarget = this.onConflict
      ?.split(',')
      .map((column) => column.trim())

    const written: DemoRow[] = []

    for (const incoming of this.incoming()) {
      const row = this.withDefaults(incoming)

      if (conflictTarget) {
        const duplicate = this.db
          .rows(this.table)
          .some((existing) =>
            conflictTarget.every((column) =>
              looseEquals(existing[column], row[column]),
            ),
          )
        // `do nothing`: the row is not written and is not returned, which is
        // precisely how `begin()` learns that somebody else got there first.
        if (duplicate) continue
      }

      const collision = this.collision(row)
      if (collision) {
        return { data: null, error: uniqueViolation(this.table, collision) }
      }

      this.db.rows(this.table).push(row)
      written.push(row)
    }

    this.afterWrite(written)
    return this.returned(written)
  }

  private runUpdate(): DemoResponse {
    if (this.ownFilters().length === 0) {
      // An update with no predicate is every row in the table. RLS would still
      // bound it to the tenant against Postgres — and there is no RLS here at
      // all, so it is every row in the demo. Refused, as the transaction
      // compiler refuses it, because "only the whole organization" is not a
      // safe accident either.
      throw new UnsupportedQuery('an update with no filters')
    }

    const patch = this.incoming()
    if (patch.length !== 1 || Array.isArray(this.payload)) {
      throw new UnsupportedQuery('an update with an array payload')
    }

    const touched: DemoRow[] = []

    for (const row of this.matchingRows()) {
      Object.assign(row, patch[0])
      // `tg_touch_row`: `updated_at` stamped and `version` incremented on every
      // update, by the database and never by the caller. Optimistic locking is
      // built on this — a writer sends the version it read and a stale write
      // matches zero rows — so a version that does not move here would make the
      // demo quietly accept writes the product refuses.
      row.updated_at = new Date().toISOString()
      if (typeof row.version === 'number') row.version += 1
      touched.push(row)
    }

    this.afterWrite(touched)
    return this.returned(touched)
  }

  private runDelete(): DemoResponse {
    if (this.ownFilters().length === 0) {
      throw new UnsupportedQuery('a delete with no filters')
    }

    const doomed = new Set(this.matchingRows())
    const rows = this.db.rows(this.table)
    const removed = [...doomed]

    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (doomed.has(rows[index])) rows.splice(index, 1)
    }

    this.afterWrite(removed)
    return this.returned(removed)
  }

  /** The triggers that fire on this table. See `recalculateBookingTotals`. */
  private afterWrite(rows: readonly DemoRow[]): void {
    if (this.table === 'booking_price_lines') {
      recalculateBookingTotals(
        this.db,
        rows.map((row) => String(row.booking_id)),
      )
    }
    if (this.table === 'bookings') {
      recalculateBookingTotals(
        this.db,
        rows.map((row) => String(row.id)),
      )
    }
  }

  /**
   * The `RETURNING` clause, or `null`.
   *
   * A write with no `.select()` still runs and answers `data: null`, exactly as
   * PostgREST does. When a select *was* asked for, the rows handed back are the
   * rows this statement wrote — projected through the same code path a read
   * uses, so an embed in a returning clause resolves the same way.
   */
  private returned(rows: readonly DemoRow[]): DemoResponse {
    if (this.returning === undefined) return { data: null, error: null }

    const fields = parseSelect(this.returning)
    const projected: DemoRow[] = []
    for (const source of rows) {
      const row = project(this.db, this.table, source, fields)
      if (row) projected.push(row)
    }

    if (this.cardinality === 'single') {
      if (projected.length !== 1) {
        return { data: null, error: noRowsError(projected.length) }
      }
      return { data: projected[0], error: null }
    }
    if (this.cardinality === 'maybeSingle') {
      if (projected.length === 0) return { data: null, error: null }
      if (projected.length > 1) {
        return { data: null, error: noRowsError(projected.length) }
      }
      return { data: projected[0], error: null }
    }
    return { data: projected, error: null }
  }
}

/* ------------------------------------------------------------- functions -- */

/**
 * The database functions the demo can answer, by name.
 *
 * Two, because two are called. `next_invoice_number` is a counter-row lock in
 * production and the reason two tax invoices cannot share a number; there is no
 * concurrency here to lose that race to, so the demo counts. Anything else
 * throws — an unimplemented function silently returning null would surface as a
 * missing invoice number rather than as a missing function.
 */
const FUNCTIONS: Record<
  string,
  (db: DemoDatabase, args: Record<string, unknown>) => unknown
> = {
  next_invoice_number(_db, args) {
    const key = [
      String(args.target_organization_id ?? ''),
      String(args.target_series ?? ''),
      String(args.target_year ?? ''),
    ].join(':')
    const next = (invoiceNumbers.get(key) ?? 0) + 1
    invoiceNumbers.set(key, next)
    return next
  },

  /**
   * `null` for a number nobody holds — and, in production, also for a caller
   * without `agent.invite`, so that an ordinary user cannot sweep the product
   * for telephone numbers. The demo cannot make that second refusal, because
   * it has no RLS and the function is not a function here; it answers the
   * first question only, which is the one the screen is asking.
   */
  find_user_id_by_phone(db, args) {
    const phone = String(args.phone_e164 ?? '')
    if (phone === '' || !db.has('user_profiles')) return null
    const match = db
      .rows('user_profiles')
      .find(
        (row) =>
          looseEquals(row.phone_normalized, phone) ||
          looseEquals(row.phone, phone),
      )
    return match ? (match.user_id ?? match.id ?? null) : null
  },
}

/** Per-process, like the rows. Reset when the dev server restarts. */
const invoiceNumbers = new Map<string, number>()

/* ---------------------------------------------------------------- client -- */

/**
 * A Supabase-shaped client over the dataset.
 *
 * Structurally compatible with `SupabaseClient` for the surface this codebase
 * uses, and cast at the boundary — the same trade `fake-client.ts` and
 * `TransactionClient` both make, for the same reason: the real type has
 * hundreds of members and this product calls a couple of dozen of them.
 */
export class DemoClient {
  readonly auth: {
    getUser: () => Promise<{
      data: { user: unknown }
      error: PostgrestErrorLike | null
    }>
  }

  constructor(
    readonly database: DemoDatabase,
    /** The signed-in person, or `null` for a signed-out request. */
    private readonly user: unknown = null,
  ) {
    this.auth = {
      getUser: async () => ({ data: { user: this.user }, error: null }),
    }
  }

  from(table: string): DemoQueryBuilder {
    return new DemoQueryBuilder(this.database, table)
  }

  async rpc(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<DemoResponse> {
    const fn = FUNCTIONS[name]
    if (!fn) {
      throw new UnsupportedQuery(
        `the database function '${name}' is not implemented by the demo ` +
          `client (FUNCTIONS in src/lib/demo/client.ts)`,
      )
    }
    return { data: fn(this.database, args), error: null }
  }
}

/**
 * A client over a fresh copy of the dataset.
 *
 * Fresh, so a test gets its own rows. The demo itself shares one — see
 * `sharedDemoDatabase` in `index.ts` — because a booking created on the
 * calendar has to still be there on the bookings list, and that only holds if
 * both requests are looking at the same arrays.
 */
export function createDemoClient(
  dataset: DemoDataset | DemoDatabase,
  user: unknown = null,
): DemoClient {
  const database =
    dataset instanceof DemoDatabase ? dataset : new DemoDatabase(dataset)
  return new DemoClient(database, user)
}
