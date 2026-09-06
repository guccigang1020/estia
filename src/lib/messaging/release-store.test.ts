/**
 * What the guest message release store actually sends to PostgREST.
 *
 * ══ THE THREE CLAIMS THIS FILE HOLDS ════════════════════════════════════════
 *
 *   1. `transitionGuestMessage` carries `outcome = from` in its predicate.
 *      That single clause is what stops two overlapping sweeps from both
 *      sending, and it is invisible: a store without it passes every
 *      behavioural test anybody would think to write, because the race only
 *      happens under concurrency and only shows up as a guest receiving the
 *      same payment reminder twice.
 *   2. Every write nulls `scheduled_for`. Not tidiness —
 *      `guest_messages_scheduled_only_when_deferred` refuses the row
 *      otherwise, and an omitted column keeps its value, so a patch that
 *      merely failed to mention it would be refused on every single row.
 *   3. A table that does not exist reads as "nothing due" and writes as a
 *      refusal. 0053 may not have been applied, and a sweep that crashed on
 *      that deployment would take the delivery half down with it.
 *
 * The fake client below is a near-copy of the one in
 * `notifications/release-store.test.ts`. Deliberate: a shared helper for this
 * would have to live in a third file that neither module owns, and two twenty-
 * line recorders are cheaper than a dependency between two modules' test
 * suites. The duplication is reported.
 */

import { describe, expect, it } from 'vitest'

import type { Db } from '../persistence'

import { SupabaseGuestMessageReleaseStore } from './release-store'
import type { GuestMessagePatch } from './release'
import { MessagingNotProvisionedError } from './repository'

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
const MESSAGE = '22222222-2222-4222-8222-222222222222'
const BOOKING = '33333333-3333-4333-8333-333333333333'
const GUEST = '44444444-4444-4444-8444-444444444444'

function deferredRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE,
    organization_id: ORGANIZATION,
    property_id: null,
    booking_id: BOOKING,
    guest_id: GUEST,
    kind: 'payment_reminder',
    channel: 'sms',
    subject: null,
    body: 'תזכורת תשלום עבור השהייה.',
    recipient_masked: '•••1234',
    outcome: 'deferred',
    outcome_detail: 'held by quiet hours',
    provider: null,
    provider_message_id: null,
    scheduled_for: '2026-09-06T04:00:00.000Z',
    correlation_id: null,
    dedupe_key: 'payment_reminder:booking:1',
    created_by: null,
    created_at: '2026-09-05T20:10:00.000Z',
    settled_at: null,
    ...overrides,
  }
}

const PATCH: GuestMessagePatch = {
  outcome: 'not_configured',
  outcomeDetail: 'deferred until 2026-09-06T04:00:00.000Z; no provider',
  provider: null,
  providerMessageId: null,
  scheduledFor: null,
  settledAt: new Date('2026-09-06T07:00:00.000Z'),
}

const MISSING_TABLE = {
  code: 'PGRST205',
  message: "Could not find the table 'public.guest_messages'",
}

/* ------------------------------------------------------------------ tests -- */

describe('listDueMessages', () => {
  it('asks for this organization, deferred, and due, oldest first', async () => {
    const { db, statements } = fakeDb(() => ({
      data: [deferredRow()],
      error: null,
    }))

    await new SupabaseGuestMessageReleaseStore(db).listDueMessages({
      organizationId: ORGANIZATION,
      dueBefore: new Date('2026-09-06T07:00:00.000Z'),
      limit: 25,
    })

    const [statement] = statements
    expect(statement.table).toBe('guest_messages')
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
      has(statement, { operator: 'eq', column: 'outcome', value: 'deferred' }),
    ).toBe(true)
    expect(
      has(statement, {
        operator: 'lte',
        column: 'scheduled_for',
        value: '2026-09-06T07:00:00.000Z',
      }),
    ).toBe(true)
    // `(organization_id, scheduled_for)` ascending is guest_messages_due_idx
    // as 0054 rebuilt it.
    expect(statement.order).toEqual({
      column: 'scheduled_for',
      ascending: true,
    })
    expect(statement.limit).toBe(25)
  })

  it('maps the row the release runner reads, with a real scheduled time', async () => {
    const { db } = fakeDb(() => ({ data: [deferredRow()], error: null }))

    const [row] = await new SupabaseGuestMessageReleaseStore(
      db,
    ).listDueMessages({
      organizationId: ORGANIZATION,
      dueBefore: new Date('2026-09-06T07:00:00.000Z'),
      limit: 25,
    })

    expect(row.id).toBe(MESSAGE)
    expect(row.outcome).toBe('deferred')
    // A `Date`, because every staleness comparison in `release.ts` is
    // arithmetic on it and a null would make the whole thing NaN.
    expect(row.scheduledFor).toEqual(new Date('2026-09-06T04:00:00.000Z'))
    expect(row.kind).toBe('payment_reminder')
    expect(row.channel).toBe('sms')
  })

  it('refuses a row that is not deferred, rather than releasing it again', async () => {
    // The query filters on the outcome, so a `sent` row coming back means the
    // filter did not apply — which under the admin client is the shape of
    // mistake that ends with a guest messaged twice.
    const { db } = fakeDb(() => ({
      data: [deferredRow({ outcome: 'sent', provider: 'null' })],
      error: null,
    }))

    await expect(
      new SupabaseGuestMessageReleaseStore(db).listDueMessages({
        organizationId: ORGANIZATION,
        dueBefore: new Date('2026-09-06T07:00:00.000Z'),
        limit: 25,
      }),
    ).rejects.toThrow(/only deferred rows may be released/)
  })

  it('reads a missing table as nothing due, not as a crash', async () => {
    for (const error of [MISSING_TABLE, { code: '42P01' }]) {
      const { db } = fakeDb(() => ({ data: null, error }))

      const rows = await new SupabaseGuestMessageReleaseStore(
        db,
      ).listDueMessages({
        organizationId: ORGANIZATION,
        dueBefore: new Date('2026-09-06T07:00:00.000Z'),
        limit: 25,
      })

      // 0053 may not have been applied. There is nowhere for a deferral to
      // live, so nothing is due — and the delivery half of the sweep still
      // runs.
      expect(rows).toEqual([])
    }
  })

  it('throws on any other refusal', async () => {
    const { db } = fakeDb(() => ({
      data: null,
      error: { code: '42501', message: 'permission denied' },
    }))

    // Swallowing this would turn a broken policy into "nothing to send",
    // which is the most misleading answer this store could give.
    await expect(
      new SupabaseGuestMessageReleaseStore(db).listDueMessages({
        organizationId: ORGANIZATION,
        dueBefore: new Date('2026-09-06T07:00:00.000Z'),
        limit: 25,
      }),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('transitionGuestMessage', () => {
  it('carries the outcome it claims to be moving from', async () => {
    const { db, statements } = fakeDb(() => ({
      data: [{ id: MESSAGE }],
      error: null,
    }))

    await new SupabaseGuestMessageReleaseStore(db).transitionGuestMessage({
      organizationId: ORGANIZATION,
      messageId: MESSAGE,
      from: 'deferred',
      patch: PATCH,
    })

    const [statement] = statements
    expect(statement.operation).toBe('update')
    // ── THE SAFETY PROPERTY ────────────────────────────────────────────────
    // Without this clause two concurrent sweeps both claim the row and the
    // guest gets the same reminder twice.
    expect(
      has(statement, { operator: 'eq', column: 'outcome', value: 'deferred' }),
    ).toBe(true)
    expect(
      has(statement, { operator: 'eq', column: 'id', value: MESSAGE }),
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
    const { db } = fakeDb(() => ({ data: [], error: null }))

    const moved = await new SupabaseGuestMessageReleaseStore(
      db,
    ).transitionGuestMessage({
      organizationId: ORGANIZATION,
      messageId: MESSAGE,
      from: 'deferred',
      patch: PATCH,
    })

    // The loser of the race. It sends nothing and the runner counts it `lost`.
    expect(moved).toBe(false)
  })

  it('nulls scheduled_for in the same statement that leaves deferred', async () => {
    const { db, statements } = fakeDb(() => ({
      data: [{ id: MESSAGE }],
      error: null,
    }))

    await new SupabaseGuestMessageReleaseStore(db).transitionGuestMessage({
      organizationId: ORGANIZATION,
      messageId: MESSAGE,
      from: 'deferred',
      patch: PATCH,
    })

    const payload = statements[0].payload ?? {}
    // Present AND null. `guest_messages_scheduled_only_when_deferred` refuses
    // a non-deferred row that still carries a time, and an omitted column
    // keeps its old value — so leaving it out would fail every write.
    expect(Object.keys(payload)).toContain('scheduled_for')
    expect(payload.scheduled_for).toBeNull()
    expect(payload.outcome).toBe('not_configured')
    expect(payload.settled_at).toBe('2026-09-06T07:00:00.000Z')
    // The body was composed at send time and frozen. A release is the same
    // message going later, not a different message.
    expect(payload).not.toHaveProperty('body')
    expect(payload).not.toHaveProperty('dedupe_key')
  })

  it('fails the write when the table is missing, and never calls it a lost race', async () => {
    const { db } = fakeDb(() => ({ data: null, error: MISSING_TABLE }))

    // `false` means "another sweep got there first", which is a completely
    // different fact from "this row did not move because there is no table".
    await expect(
      new SupabaseGuestMessageReleaseStore(db).transitionGuestMessage({
        organizationId: ORGANIZATION,
        messageId: MESSAGE,
        from: 'deferred',
        patch: PATCH,
      }),
    ).rejects.toBeInstanceOf(MessagingNotProvisionedError)
  })
})
