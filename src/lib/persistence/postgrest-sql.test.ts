/**
 * The compiler, without a database.
 *
 * `postgrest-sql.ts` translates the builder every adapter uses into SQL that
 * runs inside a transaction. It is the one piece of this directory where a
 * mistake is *silent*: a filter that failed to compile would widen a read past
 * its tenant, and a payload column that got dropped would write a row missing
 * a value nobody noticed. So the SQL text is asserted directly.
 *
 * Two properties are checked everywhere and matter more than the rest:
 *
 *   · **every value is a parameter.** No test below should ever find a literal
 *     from the input embedded in the SQL text.
 *   · **every identifier is quoted**, and an identifier that is not one is
 *     refused rather than interpolated.
 */

import { describe, expect, it } from 'vitest'

import { UnsupportedQuery, compile, parseSelect } from './postgrest-sql'

describe('parseSelect', () => {
  it('reads a plain column list', () => {
    expect(parseSelect('id, organization_id, check_in')).toEqual([
      { kind: 'column', name: 'id' },
      { kind: 'column', name: 'organization_id' },
      { kind: 'column', name: 'check_in' },
    ])
  })

  it('reads an embed', () => {
    expect(parseSelect('id, guests(full_name)')).toEqual([
      { kind: 'column', name: 'id' },
      {
        kind: 'embed',
        name: 'guests',
        inner: false,
        fields: [{ kind: 'column', name: 'full_name' }],
      },
    ])
  })

  it('distinguishes an inner embed from an outer one', () => {
    const [outer] = parseSelect('guests(full_name)')
    const [inner] = parseSelect('guests!inner(full_name)')
    expect(outer).toMatchObject({ inner: false })
    expect(inner).toMatchObject({ inner: true })
  })

  it('refuses an aliased column rather than dropping the alias', () => {
    // PostgREST would rename the key. Silently ignoring the rename would give
    // the mapper a row with the wrong key and a `RowShapeError` three files
    // away from the cause.
    expect(() => parseSelect('name:full_name')).toThrow(UnsupportedQuery)
  })

  it('refuses unbalanced parentheses', () => {
    expect(() => parseSelect('id, guests(full_name')).toThrow(UnsupportedQuery)
  })
})

describe('compile: select', () => {
  it('parameterises every value and quotes every identifier', () => {
    const { text, params } = compile({
      table: 'bookings',
      verb: 'select',
      returning: 'id, status',
      filters: [
        { op: 'eq', column: 'organization_id', value: 'org-a' },
        { op: 'eq', column: 'id', value: 'booking-1' },
      ],
      order: [],
    })

    expect(text).toContain('from public."bookings" t')
    expect(text).toContain('t."organization_id" = $1')
    expect(text).toContain('t."id" = $2')
    // The tenant id must never reach the SQL text itself.
    expect(text).not.toContain('org-a')
    expect(params).toEqual(['org-a', 'booking-1'])
  })

  it('returns one json document, so rows arrive rendered as PostgREST renders them', () => {
    // This is what makes `asIsoDate` and `asTimestamp` work unchanged over a
    // direct connection: Postgres does the JSON rendering, not the driver.
    const { text } = compile({
      table: 'holds',
      verb: 'select',
      returning: 'id',
      filters: [],
      order: [],
    })
    expect(text).toMatch(/^select coalesce\(jsonb_agg\(to_jsonb\(q\)\)/)
  })

  it('compiles `is null` rather than `= null`', () => {
    const { text, params } = compile({
      table: 'bookings',
      verb: 'select',
      returning: 'id',
      filters: [{ op: 'is', column: 'deleted_at', value: null }],
      order: [],
    })
    // `= NULL` is never true. The difference is every row versus no rows.
    expect(text).toContain('t."deleted_at" is null')
    expect(params).toEqual([])
  })

  it('compiles an empty `in` list to a refusal, not to everything', () => {
    const { text, params } = compile({
      table: 'units',
      verb: 'select',
      returning: 'id',
      filters: [{ op: 'in', column: 'property_id', value: [] }],
      order: [],
    })
    expect(text).toContain('false')
    expect(text).not.toContain('in ()')
    expect(params).toEqual([])
  })

  it('binds one parameter per `in` element', () => {
    const { text, params } = compile({
      table: 'units',
      verb: 'select',
      returning: 'id',
      filters: [{ op: 'in', column: 'property_id', value: ['p1', 'p2'] }],
      order: [],
    })
    expect(text).toContain('t."property_id" in ($1, $2)')
    expect(params).toEqual(['p1', 'p2'])
  })

  it('orders the aggregate as well as the subquery', () => {
    // `jsonb_agg` over an ordered subquery is not *guaranteed* to preserve
    // that order. A price breakdown that shuffled under a planner change is
    // the kind of bug nobody reproduces.
    const { text } = compile({
      table: 'booking_price_lines',
      verb: 'select',
      returning: 'kind, amount_agorot, sort_order',
      filters: [],
      order: [{ column: 'sort_order', ascending: true }],
    })
    expect(text).toContain('jsonb_agg(to_jsonb(q) order by q."sort_order" asc)')
    expect(text).toContain('order by t."sort_order" asc')
  })

  it('adds an ordering column that was not selected, and hides it again', () => {
    const { text, hidden } = compile({
      table: 'payments',
      verb: 'select',
      returning: 'id',
      filters: [],
      order: [{ column: 'created_at', ascending: true }],
    })
    expect(text).toContain('t."created_at" as "created_at"')
    // Added for the aggregate, removed before the mapper sees the row — so a
    // key the adapter did not ask for never reaches the domain.
    expect(hidden).toEqual(['created_at'])
  })

  it('compiles a to-one embed as a correlated json object', () => {
    const { text } = compile({
      table: 'bookings',
      verb: 'select',
      returning: 'id, guests(full_name)',
      filters: [],
      order: [],
    })
    expect(text).toContain('to_jsonb(sub)')
    expect(text).toContain('from public."guests"')
    expect(text).toContain('."id" = t."guest_id"')
    expect(text).toContain('as "guests"')
  })

  it('compiles a to-many embed as a json array that is never null', () => {
    const { text } = compile({
      table: 'invoices',
      verb: 'select',
      returning: 'id, invoice_lines(label, amount_agorot)',
      filters: [],
      order: [],
    })
    // `[]` and not `null`: the mapper reads it with `Array.isArray`, and an
    // invoice with no lines is an invoice with no lines, not a broken read.
    expect(text).toContain("coalesce(jsonb_agg(to_jsonb(sub)), '[]'::jsonb)")
  })

  it('refuses an embed nobody declared', () => {
    // PostgREST resolves embeds from foreign keys. Guessing here would mean
    // reading pg_constraint and picking a winner when two keys are ambiguous,
    // which is a second implementation of the thing this file avoids being.
    expect(() =>
      compile({
        table: 'bookings',
        verb: 'select',
        returning: 'id, payments(status)',
        filters: [],
        order: [],
      }),
    ).toThrow(/not declared in RELATIONS/)
  })

  it('refuses an identifier that is not one', () => {
    expect(() =>
      compile({
        table: 'bookings',
        verb: 'select',
        returning: 'id',
        filters: [
          { op: 'eq', column: 'id"; drop table bookings; --', value: 1 },
        ],
        order: [],
      }),
    ).toThrow(UnsupportedQuery)
  })
})

describe('compile: insert', () => {
  it('sends the payload as one json parameter and lets Postgres cast it', () => {
    // The alternative is deciding in JavaScript whether an array meant
    // `text[]` or a json array. Postgres already knows every column's type.
    const { text, params } = compile({
      table: 'audit_events',
      verb: 'insert',
      payload: {
        organization_id: 'org-a',
        action: 'booking.create',
        before: null,
      },
      filters: [],
      order: [],
    })

    expect(text).toContain(
      'json_populate_recordset(null::public."audit_events", $1::json)',
    )
    expect(text).toContain(
      'insert into public."audit_events" ("organization_id", "action", "before")',
    )
    expect(params).toEqual([
      JSON.stringify([
        { organization_id: 'org-a', action: 'booking.create', before: null },
      ]),
    ])
  })

  it('omits an undefined key entirely, so the column keeps its default', () => {
    // `booking.ts` relies on this: `total_agorot`, `reference` and
    // `guest_token` are owned by triggers and defaults, and sending them as
    // JSON null would overwrite a generated reference with nothing.
    const { text, params } = compile({
      table: 'bookings',
      verb: 'insert',
      payload: { organization_id: 'org-a', total_agorot: undefined },
      filters: [],
      order: [],
    })
    expect(text).toContain('("organization_id")')
    expect(text).not.toContain('total_agorot')
    expect(params).toEqual([JSON.stringify([{ organization_id: 'org-a' }])])
  })

  it('takes the union of keys across a multi-row insert', () => {
    const { text } = compile({
      table: 'booking_price_lines',
      verb: 'insert',
      payload: [
        { booking_id: 'b1', kind: 'accommodation', line_date: '2099-01-01' },
        { booking_id: 'b1', kind: 'cleaning_fee' },
      ],
      filters: [],
      order: [],
    })
    expect(text).toContain('("booking_id", "kind", "line_date")')
  })

  it('wraps a returning clause in a CTE, so the rows are the rows it wrote', () => {
    const { text } = compile({
      table: 'holds',
      verb: 'insert',
      payload: { organization_id: 'org-a' },
      returning: 'id, organization_id',
      filters: [],
      order: [],
    })
    // Not a re-read: another session could have moved the row in between.
    expect(text).toMatch(/^with w as \(insert into public\."holds"/)
    expect(text).toContain('returning *)')
    expect(text).toContain('from w t')
  })

  it('returns only the target table from an update, never the join too', () => {
    // `UPDATE t … FROM r RETURNING *` expands to the target's columns AND the
    // from-list's, so `w` holds two columns called `id` and the projection
    // over it fails with `42702: column reference "id" is ambiguous`. It
    // compiles, it type-checks, and every assertion on the SQL text passes —
    // only running it against a database finds it, which is how it was found.
    const update = compile({
      table: 'bookings',
      verb: 'update',
      payload: { status: 'cancelled' },
      returning: 'id, version',
      filters: [{ op: 'eq', column: 'id', value: 'b1' }],
      order: [],
    })
    expect(update.text).toContain('returning t.*)')

    // An INSERT has no from-list to collide with: `json_populate_recordset`
    // feeds its SELECT rather than joining the target.
    const insert = compile({
      table: 'holds',
      verb: 'insert',
      payload: { organization_id: 'org-a' },
      returning: 'id',
      filters: [],
      order: [],
    })
    expect(insert.text).toContain('returning *)')
    expect(insert.text).not.toContain('returning t.*)')
  })

  it('runs a write with no returning as a bare statement', () => {
    const { text } = compile({
      table: 'booking_price_lines',
      verb: 'insert',
      payload: { booking_id: 'b1' },
      filters: [],
      order: [],
    })
    expect(text).not.toContain('with w as')
    expect(text).not.toContain('jsonb_agg')
  })
})

describe('compile: upsert', () => {
  it('compiles the idempotency reservation to ON CONFLICT DO NOTHING', () => {
    const { text } = compile({
      table: 'idempotency_keys',
      verb: 'upsert',
      payload: {
        organization_id: 'org-a',
        operation: 'booking.create',
        key: 'k1',
      },
      onConflict: 'organization_id,operation,key',
      ignoreDuplicates: true,
      returning: 'organization_id, key',
      filters: [],
      order: [],
    })
    expect(text).toContain(
      'on conflict ("organization_id", "operation", "key") do nothing',
    )
  })

  it('refuses DO UPDATE outright', () => {
    // `do update` on an idempotency key hands it to the second caller and lets
    // both proceed — the exact failure the table exists to prevent. No call
    // site wants it, so the compiler will not produce one.
    expect(() =>
      compile({
        table: 'idempotency_keys',
        verb: 'upsert',
        payload: { key: 'k1' },
        onConflict: 'key',
        ignoreDuplicates: false,
        filters: [],
        order: [],
      }),
    ).toThrow(/ON CONFLICT DO UPDATE/)
  })
})

describe('compile: update and delete', () => {
  it('keeps the optimistic-lock predicate as a parameter', () => {
    const { text, params } = compile({
      table: 'payments',
      verb: 'update',
      payload: { status: 'paid' },
      returning: 'id, version',
      filters: [
        { op: 'eq', column: 'id', value: 'pay-1' },
        { op: 'eq', column: 'version', value: 4 },
      ],
      order: [],
    })
    expect(text).toContain(
      'update public."payments" t set "status" = r."status"',
    )
    expect(text).toContain('t."version" = $3')
    expect(params).toEqual([JSON.stringify({ status: 'paid' }), 'pay-1', 4])
  })

  it('refuses an update with no filters', () => {
    // RLS would still bound it to the tenant, which is exactly why this has to
    // be caught here: "only the whole organization" is not a safe accident.
    expect(() =>
      compile({
        table: 'payments',
        verb: 'update',
        payload: { status: 'paid' },
        filters: [],
        order: [],
      }),
    ).toThrow(/no filters/)
  })

  it('refuses a delete with no filters', () => {
    expect(() =>
      compile({
        table: 'booking_price_lines',
        verb: 'delete',
        filters: [],
        order: [],
      }),
    ).toThrow(/no filters/)
  })

  it('compiles a scoped delete', () => {
    const { text, params } = compile({
      table: 'booking_price_lines',
      verb: 'delete',
      filters: [{ op: 'eq', column: 'booking_id', value: 'b1' }],
      order: [],
    })
    expect(text).toBe(
      'delete from public."booking_price_lines" t where t."booking_id" = $1',
    )
    expect(params).toEqual(['b1'])
  })
})
