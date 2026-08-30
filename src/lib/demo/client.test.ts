/**
 * What the demo client must get right.
 *
 * The bar is not "it returns some rows". It is that a screen written against
 * PostgREST cannot tell the difference — which means the interesting tests here
 * are the ones about *refusal*. A filter this client does not implement must
 * throw, loudly, rather than return the rows it would have returned without it.
 * A demo that quietly widens a query is a demo that shows the viewer somebody
 * else's data and tells them it is their own.
 */

import { describe, expect, it } from 'vitest'

import { PG_ERROR } from '../persistence/errors'
import { UnsupportedQuery } from '../persistence/postgrest-sql'
import { DemoDatabase, MissingDemoTable, createDemoClient } from './client'
import type { DemoDataset } from './types'

/* --------------------------------------------------------------- fixture -- */

const ORG = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-0000000000ff'

function dataset(): DemoDataset {
  return {
    organizationId: ORG,
    tables: {
      organizations: [
        { id: ORG, name: 'אסתיא', slug: 'estia', version: 1 },
        { id: OTHER, name: 'אחר', slug: 'other', version: 1 },
      ],
      guests: [
        { id: 'g1', organization_id: ORG, full_name: 'דנה כהן' },
        { id: 'g2', organization_id: ORG, full_name: 'יוסי לוי' },
        { id: 'g9', organization_id: OTHER, full_name: 'זרה' },
      ],
      units: [
        { id: 'u1', organization_id: ORG, property_id: 'p1', name: 'סוויטה' },
        { id: 'u2', organization_id: ORG, property_id: 'p1', name: 'בקתה' },
      ],
      properties: [{ id: 'p1', organization_id: ORG, name: 'הגליל' }],
      bookings: [
        {
          id: 'b1',
          organization_id: ORG,
          property_id: 'p1',
          unit_id: 'u1',
          guest_id: 'g1',
          reference: 'B0001',
          status: 'confirmed',
          check_in: '2026-03-10',
          check_out: '2026-03-12',
          total_agorot: 40000,
          deleted_at: null,
          version: 1,
        },
        {
          id: 'b2',
          organization_id: ORG,
          property_id: 'p1',
          unit_id: 'u2',
          guest_id: 'g2',
          reference: 'B0002',
          status: 'inquiry',
          check_in: '2026-04-01',
          check_out: '2026-04-03',
          total_agorot: 0,
          deleted_at: null,
          version: 1,
        },
        {
          id: 'b3',
          organization_id: ORG,
          property_id: 'p1',
          unit_id: 'u1',
          guest_id: 'g1',
          reference: 'B0003',
          status: 'cancelled',
          check_in: '2026-01-05',
          check_out: '2026-01-06',
          total_agorot: 0,
          deleted_at: '2026-01-07T09:00:00.000Z',
          version: 2,
        },
      ],
      booking_price_lines: [
        { id: 'l1', booking_id: 'b1', amount_agorot: 30000, quantity: '1' },
        { id: 'l2', booking_id: 'b1', amount_agorot: 10000, quantity: '1' },
      ],
      idempotency_keys: [],
      memberships: [],
      user_profiles: [
        { id: 'pr1', user_id: 'user-1', phone_normalized: '+972500000001' },
      ],
    },
  }
}

function client() {
  return createDemoClient(dataset())
}

/* ---------------------------------------------------------------- filters -- */

describe('filters', () => {
  it('narrows by eq, and does not leak the other tenant', async () => {
    const { data } = await client()
      .from('guests')
      .select('id, full_name')
      .eq('organization_id', ORG)

    expect((data as { id: string }[]).map((row) => row.id)).toEqual([
      'g1',
      'g2',
    ])
  })

  it('compares as the database would, across JSON types', async () => {
    // PostgREST sends every value as text and lets Postgres cast it, so a
    // filter written as a number matches a column stored as a string.
    const { data } = await client()
      .from('booking_price_lines')
      .select('id')
      .eq('quantity', 1)

    expect(data).toHaveLength(2)
  })

  it('treats a missing key and an explicit null alike for is(null)', async () => {
    const { data } = await client()
      .from('bookings')
      .select('id')
      .is('deleted_at', null)

    expect((data as { id: string }[]).map((row) => row.id)).toEqual([
      'b1',
      'b2',
    ])
  })

  it('excludes nulls from neq, exactly as SQL does', async () => {
    // `<>` against null is unknown, and an unknown predicate drops the row.
    // `loadPlan` relies on this when it writes `.neq('status', 'cancelled')`.
    const { data } = await client()
      .from('bookings')
      .select('id, status')
      .neq('status', 'inquiry')

    expect((data as { id: string }[]).map((row) => row.id)).toEqual([
      'b1',
      'b3',
    ])
  })

  it('orders dates lexicographically, which is chronologically', async () => {
    const { data } = await client()
      .from('bookings')
      .select('id')
      .gte('check_in', '2026-02-01')
      .lt('check_in', '2026-05-01')

    expect((data as { id: string }[]).map((row) => row.id)).toEqual([
      'b1',
      'b2',
    ])
  })

  it('matches nothing for an empty in() list', async () => {
    const { data } = await client().from('units').select('id').in('id', [])
    expect(data).toEqual([])
  })

  it('honours ilike wildcards and the backslash escape', async () => {
    const { data } = await client()
      .from('guests')
      .select('id')
      .ilike('full_name', '%כהן%')

    expect((data as { id: string }[]).map((row) => row.id)).toEqual(['g1'])
  })

  it('does not let an escaped % behave as a wildcard', async () => {
    const { data } = await client()
      .from('guests')
      .select('id')
      .ilike('full_name', '\\%')

    expect(data).toEqual([])
  })
})

/* --------------------------------------------------------------- ordering -- */

describe('ordering', () => {
  it('orders ascending and descending', async () => {
    const ascending = await client()
      .from('bookings')
      .select('id')
      .order('check_in')
    expect((ascending.data as { id: string }[]).map((row) => row.id)).toEqual([
      'b3',
      'b1',
      'b2',
    ])

    const descending = await client()
      .from('bookings')
      .select('id')
      .order('check_in', { ascending: false })
    expect((descending.data as { id: string }[]).map((row) => row.id)).toEqual([
      'b2',
      'b1',
      'b3',
    ])
  })

  it('orders by a column that was not selected', async () => {
    // PostgREST does; the transaction compiler goes to trouble to reproduce it.
    const { data } = await client()
      .from('bookings')
      .select('id')
      .order('reference', { ascending: false })

    expect((data as { id: string }[]).map((row) => row.id)).toEqual([
      'b3',
      'b2',
      'b1',
    ])
  })

  it('puts nulls last ascending and first descending, as Postgres does', async () => {
    // `b3` is the only booking with a `deleted_at`. Ascending puts the nulls
    // after it; descending puts them before it.
    const ascending = await client()
      .from('bookings')
      .select('id')
      .order('deleted_at')
    expect((ascending.data as { id: string }[])[0].id).toBe('b3')

    const descending = await client()
      .from('bookings')
      .select('id')
      .order('deleted_at', { ascending: false })
    expect(
      (descending.data as { id: string }[]).map((row) => row.id).at(-1),
    ).toBe('b3')
  })

  it('applies limit after ordering, not before', async () => {
    const { data } = await client()
      .from('bookings')
      .select('id')
      .order('check_in', { ascending: false })
      .limit(1)

    expect(data).toEqual([{ id: 'b2' }])
  })

  it('treats range as inclusive at both ends', async () => {
    const { data } = await client()
      .from('bookings')
      .select('id')
      .order('check_in')
      .range(0, 1)

    expect((data as { id: string }[]).map((row) => row.id)).toEqual([
      'b3',
      'b1',
    ])
  })
})

/* ----------------------------------------------------------------- embeds -- */

describe('embeds', () => {
  it('renders a to-one embed as an object', async () => {
    const { data } = await client()
      .from('bookings')
      .select('id, guests(full_name)')
      .eq('id', 'b1')
      .single()

    expect(data).toEqual({ id: 'b1', guests: { full_name: 'דנה כהן' } })
  })

  it('renders a to-many embed as an array, and an empty one as []', async () => {
    const withLines = await client()
      .from('bookings')
      .select('id, booking_price_lines(amount_agorot)')
      .eq('id', 'b1')
      .single()
    expect(withLines.data).toEqual({
      id: 'b1',
      booking_price_lines: [{ amount_agorot: 30000 }, { amount_agorot: 10000 }],
    })

    const without = await client()
      .from('bookings')
      .select('id, booking_price_lines(amount_agorot)')
      .eq('id', 'b2')
      .single()
    expect(without.data).toEqual({ id: 'b2', booking_price_lines: [] })
  })

  it('keeps the parent when a non-inner embed is missing', async () => {
    // The bookings list depends on this: a reader without `guest.view` must
    // lose the name, never the booking.
    const db = new DemoDatabase(dataset())
    db.rows('bookings')[0].guest_id = null

    const { data } = await createDemoClient(db)
      .from('bookings')
      .select('id, guests(full_name)')
      .eq('id', 'b1')
      .single()

    expect(data).toEqual({ id: 'b1', guests: null })
  })

  it('drops the parent when an !inner embed is missing', async () => {
    const db = new DemoDatabase(dataset())
    db.rows('bookings')[0].guest_id = null

    const { data } = await createDemoClient(db)
      .from('bookings')
      .select('id, guests!inner(full_name)')
      .eq('id', 'b1')

    expect(data).toEqual([])
  })

  it('resolves an embed nested two deep', async () => {
    // `membership_roles → roles!inner → role_permissions` is the only nested
    // embed in the codebase, and it is how every grant reaches the engine.
    const db = new DemoDatabase({
      organizationId: ORG,
      tables: {
        membership_roles: [{ id: 'mr1', membership_id: 'm1', role_id: 'r1' }],
        roles: [{ id: 'r1', code: 'cleaner', is_system: false }],
        role_permissions: [
          { id: 'rp1', role_id: 'r1', permission_code: 'task.view' },
          { id: 'rp2', role_id: 'r1', permission_code: 'task.complete' },
        ],
      },
    })

    const { data } = await createDemoClient(db)
      .from('membership_roles')
      .select('roles!inner(code, role_permissions(permission_code))')
      .eq('membership_id', 'm1')

    expect(data).toEqual([
      {
        roles: {
          code: 'cleaner',
          role_permissions: [
            { permission_code: 'task.view' },
            { permission_code: 'task.complete' },
          ],
        },
      },
    ])
  })

  it('narrows the parent through a filter on an !inner embed', async () => {
    // The guest-name search in the bookings list, exactly as written.
    const { data } = await client()
      .from('bookings')
      .select('id, guests!inner(full_name)')
      .ilike('guests.full_name', '%לוי%')

    expect(data).toEqual([{ id: 'b2', guests: { full_name: 'יוסי לוי' } }])
  })
})

/* ------------------------------------------------------------ cardinality -- */

describe('single and maybeSingle', () => {
  it('answers PGRST116 when single() matches no row', async () => {
    const { data, error } = await client()
      .from('bookings')
      .select('id')
      .eq('id', 'nope')
      .single()

    expect(data).toBeNull()
    expect(error?.code).toBe(PG_ERROR.NO_ROWS)
    expect(error?.details).toContain('0 rows')
  })

  it('answers PGRST116 when single() matches more than one', async () => {
    const { error } = await client()
      .from('bookings')
      .select('id')
      .eq('organization_id', ORG)
      .single()

    expect(error?.code).toBe(PG_ERROR.NO_ROWS)
  })

  it('answers null and no error when maybeSingle() matches nothing', async () => {
    // Absence is an answer here, not a fault — `loadMembership` depends on it.
    const { data, error } = await client()
      .from('memberships')
      .select('id')
      .eq('user_id', 'nobody')
      .maybeSingle()

    expect(data).toBeNull()
    expect(error).toBeNull()
  })

  it('still errors when maybeSingle() matches more than one', async () => {
    const { error } = await client()
      .from('bookings')
      .select('id')
      .eq('organization_id', ORG)
      .maybeSingle()

    expect(error?.code).toBe(PG_ERROR.NO_ROWS)
  })
})

/* ---------------------------------------------------------------- counting -- */

describe('count and head', () => {
  it('returns the count and no rows for a head request', async () => {
    const { data, count, error } = await client()
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ORG)
      .is('deleted_at', null)

    expect(data).toBeNull()
    expect(error).toBeNull()
    expect(count).toBe(2)
  })

  it('counts everything that matched, not just the page', async () => {
    const { count, data } = await client()
      .from('bookings')
      .select('id', { count: 'exact' })
      .limit(1)

    expect(count).toBe(3)
    expect(data).toHaveLength(1)
  })
})

/* ----------------------------------------------------------------- writes -- */

describe('writes', () => {
  it('persists an insert into the same rows a later read sees', async () => {
    // The walkability claim: create a booking, find it on the list.
    const db = new DemoDatabase(dataset())
    const supabase = createDemoClient(db)

    await supabase.from('guests').insert({
      organization_id: ORG,
      full_name: 'מיכל ברק',
    })

    const { data } = await createDemoClient(db)
      .from('guests')
      .select('full_name')
      .eq('organization_id', ORG)

    expect(data).toContainEqual({ full_name: 'מיכל ברק' })
  })

  it('fills in the columns the database owns', async () => {
    const supabase = client()
    const { data } = await supabase
      .from('bookings')
      .insert({
        organization_id: ORG,
        property_id: 'p1',
        unit_id: 'u1',
        guest_id: 'g1',
        check_in: '2026-06-01',
        check_out: '2026-06-03',
      })
      .select('id, reference, version, created_at')
      .single()

    const row = data as Record<string, string | number>
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.reference).toMatch(/^B[0-9A-F]{8}$/)
    expect(row.version).toBe(1)
    expect(typeof row.created_at).toBe('string')
  })

  it('answers data: null for a write with no returning clause', async () => {
    const { data, error } = await client()
      .from('guests')
      .insert({ organization_id: ORG, full_name: 'ללא' })

    expect(data).toBeNull()
    expect(error).toBeNull()
  })

  it('reports a unique violation as 23505', async () => {
    const { data, error } = await client()
      .from('bookings')
      .insert({
        organization_id: ORG,
        property_id: 'p1',
        unit_id: 'u1',
        guest_id: 'g1',
        reference: 'B0001',
        check_in: '2026-06-01',
        check_out: '2026-06-03',
      })
      .select('id')

    expect(data).toBeNull()
    expect(error?.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
    expect(error?.message).toContain('unique constraint')
  })

  it('writes nothing and returns nothing for an ignored upsert conflict', async () => {
    // How `begin()` learns somebody else reserved the key first.
    const db = new DemoDatabase(dataset())
    const supabase = createDemoClient(db)
    const row = { organization_id: ORG, operation: 'book', key: 'k1' }

    const first = await supabase
      .from('idempotency_keys')
      .upsert(row, {
        onConflict: 'organization_id,operation,key',
        ignoreDuplicates: true,
      })
      .select('id')
    expect(first.data).toHaveLength(1)

    const second = await supabase
      .from('idempotency_keys')
      .upsert(row, {
        onConflict: 'organization_id,operation,key',
        ignoreDuplicates: true,
      })
      .select('id')
    expect(second.data).toEqual([])
    expect(db.rows('idempotency_keys')).toHaveLength(1)
  })

  it('increments version and stamps updated_at on an update', async () => {
    // Optimistic locking is built on this: a stale write must match no rows.
    const db = new DemoDatabase(dataset())
    const supabase = createDemoClient(db)

    const { data } = await supabase
      .from('bookings')
      .update({ status: 'confirmed' })
      .eq('id', 'b2')
      .eq('version', 1)
      .select('version, status')
      .single()

    expect(data).toMatchObject({ version: 2, status: 'confirmed' })

    const stale = await supabase
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('id', 'b2')
      .eq('version', 1)
      .select('id')
    expect(stale.data).toEqual([])
  })

  it('deletes only the matching rows', async () => {
    const db = new DemoDatabase(dataset())
    await createDemoClient(db)
      .from('booking_price_lines')
      .delete()
      .eq('id', 'l1')

    expect(db.rows('booking_price_lines')).toHaveLength(1)
  })

  it('keeps a booking total equal to the sum of its price lines', async () => {
    // `tg_price_lines_recalc_total`. A total that disagrees with the breakdown
    // is a bug the product does not have, so the demo must not invent it.
    const db = new DemoDatabase(dataset())
    const supabase = createDemoClient(db)

    await supabase
      .from('booking_price_lines')
      .insert({ booking_id: 'b1', amount_agorot: 5000, quantity: '1' })
    expect(db.rows('bookings')[0].total_agorot).toBe(45000)

    await supabase.from('booking_price_lines').delete().eq('id', 'l2')
    expect(db.rows('bookings')[0].total_agorot).toBe(35000)
  })
})

/* -------------------------------------------------------------- functions -- */

describe('rpc', () => {
  it('allocates invoice numbers in sequence, per series', async () => {
    const supabase = client()
    const call = (series: string) =>
      supabase.rpc('next_invoice_number', {
        target_organization_id: ORG,
        target_series: series,
        target_year: 2026,
      })

    expect((await call('tax')).data).toBe(1)
    expect((await call('tax')).data).toBe(2)
    expect((await call('receipt')).data).toBe(1)
  })

  it('finds a user by normalised phone, and null for nobody', async () => {
    const supabase = client()
    const found = await supabase.rpc('find_user_id_by_phone', {
      phone_e164: '+972500000001',
    })
    expect(found.data).toBe('user-1')

    const missing = await supabase.rpc('find_user_id_by_phone', {
      phone_e164: '+972599999999',
    })
    expect(missing.data).toBeNull()
  })
})

/* -------------------------------------------------------------- identity -- */

describe('auth', () => {
  it('answers getUser with whoever the client was built for', async () => {
    const user = { id: 'user-1', email: 'dana@example.test' }
    const supabase = createDemoClient(dataset(), user)

    expect((await supabase.auth.getUser()).data.user).toBe(user)
    expect((await client().auth.getUser()).data.user).toBeNull()
  })
})

/* ------------------------------------------------------------- refusals -- */

/**
 * The half of this file that matters most.
 *
 * Every case below would be trivial to "support" by ignoring the part that is
 * not understood, and every one of them would then return rows the caller did
 * not ask for. Against a real database RLS would catch some of that; here there
 * is nothing underneath, so refusing is the whole of the safety.
 */
describe('refusals', () => {
  it('throws rather than returning every row for an unknown table', async () => {
    await expect(client().from('incidents').select('id')).rejects.toThrow(
      MissingDemoTable,
    )
  })

  it('throws on an embed that is not declared', async () => {
    await expect(
      client().from('bookings').select('id, invoices(id)'),
    ).rejects.toThrow(UnsupportedQuery)
  })

  it('throws on an update with no filters instead of rewriting the table', async () => {
    await expect(
      client().from('bookings').update({ status: 'cancelled' }),
    ).rejects.toThrow(UnsupportedQuery)
  })

  it('throws on a delete with no filters', async () => {
    await expect(client().from('bookings').delete()).rejects.toThrow(
      UnsupportedQuery,
    )
  })

  it('throws on an upsert that would resolve a conflict by overwriting', async () => {
    await expect(
      client().from('idempotency_keys').upsert(
        { organization_id: ORG, operation: 'book', key: 'k1' },
        {
          onConflict: 'organization_id,operation,key',
          ignoreDuplicates: false,
        },
      ),
    ).rejects.toThrow(UnsupportedQuery)
  })

  it('throws on an upsert with no conflict target', async () => {
    await expect(
      client()
        .from('idempotency_keys')
        .upsert({ organization_id: ORG, operation: 'book', key: 'k2' }),
    ).rejects.toThrow(UnsupportedQuery)
  })

  it('throws when a filter narrows through a non-inner embed', async () => {
    // PostgREST would leave every parent row in place, so the search would
    // silently return the whole list. A broken search beats a lying one.
    await expect(
      client()
        .from('bookings')
        .select('id, guests(full_name)')
        .ilike('guests.full_name', '%לוי%'),
    ).rejects.toThrow(UnsupportedQuery)
  })

  it('throws when a filter names an embed the select does not ask for', async () => {
    await expect(
      client().from('bookings').select('id').eq('guests.full_name', 'דנה כהן'),
    ).rejects.toThrow(UnsupportedQuery)
  })

  it('throws on is() with anything but null or a boolean', async () => {
    await expect(
      client().from('bookings').select('id').is('status', 'confirmed'),
    ).rejects.toThrow(UnsupportedQuery)
  })

  it('throws on a planner-estimated count, which it cannot honestly give', async () => {
    expect(() =>
      client().from('bookings').select('id', { count: 'estimated' }),
    ).toThrow(UnsupportedQuery)
  })

  it('throws on ordering by a referenced table', async () => {
    expect(() =>
      client()
        .from('bookings')
        .select('id, guests(full_name)')
        .order('full_name', { referencedTable: 'guests' }),
    ).toThrow(UnsupportedQuery)
  })

  it('throws on an unimplemented database function', async () => {
    await expect(client().rpc('purge_expired_holds')).rejects.toThrow(
      UnsupportedQuery,
    )
  })
})
