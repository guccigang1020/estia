/**
 * A Supabase client that records instead of connecting.
 *
 * What this is for, and what it is not for. It proves the *mapping*: that a
 * row shaped like the database's becomes a domain object shaped like the
 * domain's, that a `null` lands where the domain expects `null`, and that the
 * filters an adapter builds are the ones it meant to build.
 *
 * **It cannot prove a query is right.** A column name spelled wrongly here is
 * spelled wrongly consistently — the fake returns whatever the test seeded
 * under whatever key it chose, so a select naming `guest_full_name` would pass
 * every unit test and fail on the first real request. That is what
 * `live.integration.test.ts` is for, and it is why that file exists rather
 * than a larger pile of mocks.
 *
 * The recorded filters are the useful half. `queries[0].filters` shows exactly
 * the `eq`/`is`/`lt` chain the adapter built, so a test can assert that a read
 * was scoped by `organization_id` — which is a tenant isolation claim, and one
 * worth making without a database.
 */

import type { Db } from './client'

export interface RecordedFilter {
  op: string
  column: string
  value: unknown
}

export interface RecordedQuery {
  table: string
  verb: 'select' | 'insert' | 'update' | 'delete' | 'upsert'
  columns?: string
  /** The row or rows handed to insert/update/upsert. */
  payload?: unknown
  options?: unknown
  filters: RecordedFilter[]
  /** True when the adapter asked for at most one row. */
  single?: 'single' | 'maybeSingle'
}

/** What the fake should answer with, keyed by `table:verb`. */
export interface FakeResponse {
  data?: unknown
  error?: {
    code: string
    message: string
    details?: string | null
    /**
     * PostgREST passes a raised exception's HINT through, and the invitation
     * acceptance path reads it — `accept_invitation` raises a machine-readable
     * message with a Hebrew hint beside it. Optional because almost nothing
     * else sets one.
     */
    hint?: string | null
  } | null
}

export interface FakeClientOptions {
  /**
   * Responses by `"table"` or by `"table:verb"`, the more specific winning.
   *
   * A queue is allowed: hand an array of responses and each call consumes one.
   * That is how a test drives an adapter that reads the same table twice — the
   * booking adapter re-reads after writing, and the difference between the two
   * reads is the whole point of the re-read.
   */
  responses?: Record<string, FakeResponse | FakeResponse[]>
}

export class FakeSupabaseClient {
  readonly queries: RecordedQuery[] = []
  private readonly responses: Record<string, FakeResponse[]>

  constructor(options: FakeClientOptions = {}) {
    this.responses = {}
    for (const [key, value] of Object.entries(options.responses ?? {})) {
      this.responses[key] = Array.isArray(value) ? [...value] : [value]
    }
  }

  /** The client, typed as one. The cast is the whole point of the fake. */
  asDb(): Db {
    return this as unknown as Db
  }

  /**
   * A recorded `rpc`, seeded under `"rpc:<name>"`.
   *
   * Present because `allocateInvoiceNumber` must be a call to
   * `next_invoice_number()` and never a read-then-write — so a unit test has
   * to be able to assert that it really is one, and with which arguments.
   */
  async rpc(name: string, args?: unknown): Promise<FakeResponse> {
    const query: RecordedQuery = {
      table: `rpc:${name}`,
      verb: 'select',
      payload: args,
      filters: [],
    }
    const response = this.respond(query)
    return {
      data: response.error ? null : (response.data ?? null),
      error: response.error ?? null,
    }
  }

  from(table: string) {
    return new FakeQueryBuilder(this, table)
  }

  /** Called by the builder when the query is finally awaited. */
  respond(query: RecordedQuery): FakeResponse {
    this.queries.push(query)

    const queue =
      this.responses[`${query.table}:${query.verb}`] ??
      this.responses[query.table]

    if (!queue || queue.length === 0) {
      // An unseeded query is a test that does not know what it is asserting.
      // Empty data would let it pass by accident.
      throw new Error(
        `FakeSupabaseClient has no response for ${query.table}:${query.verb}. ` +
          `Seed one under "${query.table}:${query.verb}" or "${query.table}".`,
      )
    }

    return queue.length === 1 ? queue[0] : (queue.shift() as FakeResponse)
  }

  /** Queries against one table, in order. */
  queriesFor(table: string): RecordedQuery[] {
    return this.queries.filter((query) => query.table === table)
  }
}

/**
 * The chainable part.
 *
 * `then` is what makes an instance awaitable: `@supabase/supabase-js` builders
 * are thenables rather than promises, so an adapter can keep chaining filters
 * right up until the `await`. Reproducing that is what lets the adapters be
 * written naturally instead of around the test double.
 */
class FakeQueryBuilder implements PromiseLike<FakeResponse> {
  private readonly query: RecordedQuery

  constructor(
    private readonly client: FakeSupabaseClient,
    table: string,
  ) {
    this.query = { table, verb: 'select', filters: [] }
  }

  select(columns?: string): this {
    // A select after an insert is the `RETURNING` clause, not a second query.
    if (this.query.verb === 'select') this.query.verb = 'select'
    this.query.columns = columns
    return this
  }

  insert(payload: unknown): this {
    this.query.verb = 'insert'
    this.query.payload = payload
    return this
  }

  update(payload: unknown): this {
    this.query.verb = 'update'
    this.query.payload = payload
    return this
  }

  upsert(payload: unknown, options?: unknown): this {
    this.query.verb = 'upsert'
    this.query.payload = payload
    this.query.options = options
    return this
  }

  delete(): this {
    this.query.verb = 'delete'
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

  gt(column: string, value: unknown): this {
    return this.filter('gt', column, value)
  }

  gte(column: string, value: unknown): this {
    return this.filter('gte', column, value)
  }

  in(column: string, value: unknown): this {
    return this.filter('in', column, value)
  }

  /**
   * PostgREST's `or`, which takes one filter STRING rather than a column and
   * a value — `property_id.is.null,property_id.eq.<uuid>`.
   *
   * Recorded under the column name 'or' so an assertion can read it back the
   * same way it reads every other filter. It exists because some reads are
   * genuinely one read: a policy matrix assembled from the organization's
   * rows and the property's rows fetched a second apart is a matrix nobody
   * configured, and a test that cannot express the real query cannot catch
   * that.
   */
  or(filters: string): this {
    return this.filter('or', 'or', filters)
  }

  order(column: string, options?: unknown): this {
    return this.filter('order', column, options)
  }

  limit(count: number): this {
    return this.filter('limit', 'limit', count)
  }

  single(): this {
    this.query.single = 'single'
    return this
  }

  maybeSingle(): this {
    this.query.single = 'maybeSingle'
    return this
  }

  then<TResult1 = FakeResponse, TResult2 = never>(
    onfulfilled?:
      ((value: FakeResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    let response: FakeResponse
    try {
      response = this.client.respond(this.query)
    } catch (error) {
      return Promise.reject(error).then(onfulfilled, onrejected)
    }
    // `data: null` on error, `error: null` on success — the shape every
    // adapter destructures.
    return Promise.resolve({
      data: response.error ? null : (response.data ?? null),
      error: response.error ?? null,
    } as FakeResponse).then(onfulfilled, onrejected)
  }

  private filter(op: string, column: string, value: unknown): this {
    this.query.filters.push({ op, column, value })
    return this
  }
}

/** Did this query filter on that column? A tenant-scoping assertion. */
export function hasFilter(
  query: RecordedQuery,
  op: string,
  column: string,
  value?: unknown,
): boolean {
  return query.filters.some(
    (filter) =>
      filter.op === op &&
      filter.column === column &&
      (value === undefined || filter.value === value),
  )
}
