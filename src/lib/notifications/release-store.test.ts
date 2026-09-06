/**
 * What the delivery release store actually sends to PostgREST.
 *
 * ══ THE ONE TEST THAT MATTERS ═══════════════════════════════════════════════
 *
 * `transitionDelivery` must carry `status = from` in its predicate. That single
 * clause is the claim that two overlapping sweeps cannot both send, and it is
 * invisible: a store without it passes every behavioural test anybody would
 * think to write, because the race only happens under concurrency and only
 * shows up as a colleague paged twice at three in the morning.
 *
 * So it is asserted directly — the statement is inspected, not described — and
 * separately, the store is asked what it reports when the update matches
 * nothing, which is what the losing sweep sees.
 *
 * ── Why a hand-rolled client and not a mock library ───────────────────────
 *
 * The thing under test IS the statement. A fake that records the chain is the
 * only kind of double that can be asked "did you filter on the status you
 * claimed to filter on"; a mock returning canned rows would answer questions
 * about this file's arithmetic, which has none.
 */

import { describe, expect, it } from 'vitest'

import type { Db } from '../persistence'

import { SupabaseDeliveryReleaseStore } from './release-store'
import type { DeliveryPatch } from './release'

/* ------------------------------------------------------------------ fake -- */

interface Filter {
  operator: string
  column: string
  value: unknown
}

interface Statement {
  table: string
  operation: 'select' | 'update'
  columns: string | null
  filters: Filter[]
  payload: Record<string, unknown> | null
  order: { column: string; ascending: boolean } | null
  limit: number | null
}

interface Answer {
  data: unknown
  error: unknown
}

class Builder implements PromiseLike<Answer> {
  constructor(
    private readonly statement: Statement,
    private readonly answer: (statement: Statement) => Answer,
  ) {}

  select(columns: string): this {
    this.statement.columns = columns
    return this
  }

  update(payload: Record<string, unknown>): this {
    this.statement.operation = 'update'
    this.statement.payload = payload
    return this
  }

  eq(column: string, value: unknown): this {
    this.statement.filters.push({ operator: 'eq', column, value })
    return this
  }

  lte(column: string, value: unknown): this {
    this.statement.filters.push({ operator: 'lte', column, value })
    return this
  }

  order(column: string, options: { ascending: boolean }): this {
    this.statement.order = { column, ascending: options.ascending }
    return this
  }

  limit(count: number): this {
    this.statement.limit = count
    return this
  }

  then<TResult1 = Answer, TResult2 = never>(
    onfulfilled?:
      ((value: Answer) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.answer(this.statement)).then(
      onfulfilled,
      onrejected,
    )
  }
}

function fakeDb(answer: (statement: Statement) => Answer): {
  db: Db
  statements: Statement[]
} {
  const statements: Statement[] = []

  const db = {
    from(table: string) {
      const statement: Statement = {
        table,
        operation: 'select',
        columns: null,
        filters: [],
        payload: null,
        order: null,
        limit: null,
      }
      statements.push(statement)
      return new Builder(statement, answer)
    },
  }

  return { db: db as unknown as Db, statements }
}

function has(statement: Statement, filter: Filter): boolean {
  return statement.filters.some(
    (entry) =>
      entry.operator === filter.operator &&
      entry.column === filter.column &&
      entry.value === filter.value,
  )
}

/* ------------------------------------------------------------------ rows -- */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const DELIVERY = '22222222-2222-4222-8222-222222222222'
const NOTIFICATION = '33333333-3333-4333-8333-333333333333'
const RECIPIENT = '44444444-4444-4444-8444-444444444444'

function dueRow(notifications: unknown) {
  return {
    id: DELIVERY,
    organization_id: ORGANIZATION,
    notification_id: NOTIFICATION,
    channel: 'email',
    scheduled_for: '2026-09-06T04:00:00.000Z',
    notifications,
  }
}

const PARENT = {
  recipient_user_id: RECIPIENT,
  category: 'operations',
  severity: 'urgent',
  title: 'תשלום ממתין',
  body: 'ההזמנה ממתינה לתשלום.',
  action_href: '/bookings/1',
  correlation_id: null,
}

const PATCH: DeliveryPatch = {
  status: 'suppressed',
  provider: null,
  providerMessageId: null,
  errorCode: null,
  errorDetail: 'the recipient said no since it was deferred',
  suppressedReason: 'preference_off',
  attemptedAt: null,
  settledAt: new Date('2026-09-06T07:00:00.000Z'),
}

/* ------------------------------------------------------------------ tests -- */

describe('listDueDeliveries', () => {
  it('asks for this organization, deferred, and due, oldest first', async () => {
    const { db, statements } = fakeDb(() => ({
      data: [dueRow(PARENT)],
      error: null,
    }))

    await new SupabaseDeliveryReleaseStore(db).listDueDeliveries({
      organizationId: ORGANIZATION,
      dueBefore: new Date('2026-09-06T07:00:00.000Z'),
      limit: 25,
    })

    const [statement] = statements
    expect(statement.table).toBe('notification_deliveries')
    // The tenant boundary. Under the admin client there is no policy under
    // this query, so a missing filter here is a cross-tenant read.
    expect(
      has(statement, {
        operator: 'eq',
        column: 'organization_id',
        value: ORGANIZATION,
      }),
    ).toBe(true)
    expect(
      has(statement, { operator: 'eq', column: 'status', value: 'deferred' }),
    ).toBe(true)
    expect(
      has(statement, {
        operator: 'lte',
        column: 'scheduled_for',
        value: '2026-09-06T07:00:00.000Z',
      }),
    ).toBe(true)
    // `(organization_id, scheduled_for)` ascending is notification_deliveries_due_idx.
    expect(statement.order).toEqual({
      column: 'scheduled_for',
      ascending: true,
    })
    expect(statement.limit).toBe(25)
    // The join, without which the gates have no category and no severity.
    expect(statement.columns).toContain('notifications!inner(')
  })

  it('maps the delivery and the seven fields of its notification', async () => {
    const { db } = fakeDb(() => ({ data: [dueRow(PARENT)], error: null }))

    const [row] = await new SupabaseDeliveryReleaseStore(db).listDueDeliveries({
      organizationId: ORGANIZATION,
      dueBefore: new Date('2026-09-06T07:00:00.000Z'),
      limit: 25,
    })

    expect(row).toEqual({
      id: DELIVERY,
      organizationId: ORGANIZATION,
      notificationId: NOTIFICATION,
      channel: 'email',
      scheduledFor: new Date('2026-09-06T04:00:00.000Z'),
      recipientUserId: RECIPIENT,
      category: 'operations',
      severity: 'urgent',
      title: 'תשלום ממתין',
      body: 'ההזמנה ממתינה לתשלום.',
      actionHref: '/bookings/1',
      correlationId: null,
    })
  })

  it('accepts the embedded notification as a one-element array', async () => {
    // PostgREST returns an object for a to-one embed. The client is untyped in
    // its generics slot here, so the shape is not something this file can
    // prove — and a break would only ever appear where the sweep runs.
    const { db } = fakeDb(() => ({ data: [dueRow([PARENT])], error: null }))

    const [row] = await new SupabaseDeliveryReleaseStore(db).listDueDeliveries({
      organizationId: ORGANIZATION,
      dueBefore: new Date('2026-09-06T07:00:00.000Z'),
      limit: 25,
    })

    expect(row.recipientUserId).toBe(RECIPIENT)
  })

  it('asks the database nothing when there is no room in the pass', async () => {
    const { db, statements } = fakeDb(() => ({ data: [], error: null }))

    const rows = await new SupabaseDeliveryReleaseStore(db).listDueDeliveries({
      organizationId: ORGANIZATION,
      dueBefore: new Date('2026-09-06T07:00:00.000Z'),
      limit: 0,
    })

    // PostgREST reads `limit(0)` as unbounded, so an off-by-one upstream would
    // otherwise become a full-table scan.
    expect(rows).toEqual([])
    expect(statements).toHaveLength(0)
  })

  it('throws when the database refuses, rather than reporting nothing due', async () => {
    const { db } = fakeDb(() => ({
      data: null,
      error: { code: '42501', message: 'permission denied' },
    }))

    await expect(
      new SupabaseDeliveryReleaseStore(db).listDueDeliveries({
        organizationId: ORGANIZATION,
        dueBefore: new Date('2026-09-06T07:00:00.000Z'),
        limit: 25,
      }),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('transitionDelivery', () => {
  it('carries the status it claims to be moving from', async () => {
    const { db, statements } = fakeDb(() => ({
      data: [{ id: DELIVERY }],
      error: null,
    }))

    await new SupabaseDeliveryReleaseStore(db).transitionDelivery({
      organizationId: ORGANIZATION,
      deliveryId: DELIVERY,
      from: 'deferred',
      patch: PATCH,
    })

    const [statement] = statements
    expect(statement.operation).toBe('update')
    // ── THE SAFETY PROPERTY ────────────────────────────────────────────────
    // Without this clause two concurrent sweeps both claim the row and the
    // recipient is paged twice. Nothing else in this module would notice.
    expect(
      has(statement, { operator: 'eq', column: 'status', value: 'deferred' }),
    ).toBe(true)
    expect(
      has(statement, { operator: 'eq', column: 'id', value: DELIVERY }),
    ).toBe(true)
    expect(
      has(statement, {
        operator: 'eq',
        column: 'organization_id',
        value: ORGANIZATION,
      }),
    ).toBe(true)
  })

  it('is refused when the row has already moved', async () => {
    // What the losing sweep sees: the conditional update matched nothing
    // because the winner already wrote `pending`. An ordinary outcome of two
    // overlapping passes, and not a failure.
    const { db } = fakeDb(() => ({ data: [], error: null }))

    const moved = await new SupabaseDeliveryReleaseStore(db).transitionDelivery(
      {
        organizationId: ORGANIZATION,
        deliveryId: DELIVERY,
        from: 'deferred',
        patch: PATCH,
      },
    )

    expect(moved).toBe(false)
  })

  it('reports one row moved, and refuses to call two rows a success', async () => {
    const one = fakeDb(() => ({ data: [{ id: DELIVERY }], error: null }))
    expect(
      await new SupabaseDeliveryReleaseStore(one.db).transitionDelivery({
        organizationId: ORGANIZATION,
        deliveryId: DELIVERY,
        from: 'deferred',
        patch: PATCH,
      }),
    ).toBe(true)

    // Two rows for a primary-key filter means the statement matched something
    // this file cannot explain, and a sweep that shrugged at that would be a
    // sweep that mass-updated a tenant.
    const two = fakeDb(() => ({
      data: [{ id: DELIVERY }, { id: 'other' }],
      error: null,
    }))
    expect(
      await new SupabaseDeliveryReleaseStore(two.db).transitionDelivery({
        organizationId: ORGANIZATION,
        deliveryId: DELIVERY,
        from: 'deferred',
        patch: PATCH,
      }),
    ).toBe(false)
  })

  it('writes only the columns a release may change', async () => {
    const { db, statements } = fakeDb(() => ({
      data: [{ id: DELIVERY }],
      error: null,
    }))

    await new SupabaseDeliveryReleaseStore(db).transitionDelivery({
      organizationId: ORGANIZATION,
      deliveryId: DELIVERY,
      from: 'deferred',
      patch: PATCH,
    })

    const payload = statements[0].payload ?? {}
    expect(payload.status).toBe('suppressed')
    expect(payload.suppressed_reason).toBe('preference_off')
    expect(payload.settled_at).toBe('2026-09-06T07:00:00.000Z')
    expect(payload.attempted_at).toBeNull()
    // Not touched: `scheduled_for` is the record of when this became sendable
    // and is the only evidence of how late the sweep was. `channel`, `attempt`
    // and `notification_id` are absent because a release is the same delivery
    // happening later, not a different one.
    expect(payload).not.toHaveProperty('scheduled_for')
    expect(payload).not.toHaveProperty('channel')
    expect(payload).not.toHaveProperty('attempt')
  })
})
