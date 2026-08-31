/**
 * What the metric source actually asks the database for.
 *
 * These are not tests about arithmetic — `src/lib/metrics` owns that and is
 * covered there. They are about the columns in the WHERE clause, because a
 * scope filter on a column that does not exist is invisible in every other
 * kind of test: the domain is correct, the numbers add up, and the query
 * quietly returns the wrong rows.
 *
 * That is exactly what happened. `applyScope` is shared by `units`, `holds`
 * and `bookings`, and a unit is `unit_id` on two of those three and `id` on
 * the one table where it *is* the row. Filtering `units` on `unit_id` gave a
 * unit-scoped membership a PostgREST error against Postgres and, against the
 * in-memory demo client, zero available nights — an occupancy figure computed
 * from no inventory at all. Nothing caught it because no demo persona holds a
 * unit scope.
 *
 * `hasFilter` compares values by identity, so it is used here only to ask
 * *whether* a column was filtered. The list itself is asserted separately with
 * `toEqual`, which is the comparison an array needs.
 */

import { describe, expect, it } from 'vitest'

import type { MetricRange } from '@/lib/metrics/types'
import type { ResolvedScope } from '@/lib/metrics/scope'

import {
  FakeSupabaseClient,
  hasFilter,
  type RecordedQuery,
} from './fake-client'
import { SupabaseMetricSource } from './metrics'

const MARCH: MetricRange = { start: '2026-03-01', end: '2026-04-01' }

const UNIT_SCOPED: ResolvedScope = {
  organizationId: 'org-1',
  propertyIds: null,
  unitIds: ['unit-a', 'unit-b'],
}

const PROPERTY_SCOPED: ResolvedScope = {
  organizationId: 'org-1',
  propertyIds: ['property-1'],
  unitIds: null,
}

const ORGANIZATION_WIDE: ResolvedScope = {
  organizationId: 'org-1',
  propertyIds: null,
  unitIds: null,
}

/** Every read here is a list, so an empty array is a valid answer. */
function client(): FakeSupabaseClient {
  return new FakeSupabaseClient({
    responses: {
      units: { data: [] },
      holds: { data: [] },
      bookings: { data: [] },
    },
  })
}

/** The `in` list a query was narrowed by, or `undefined` if it was not. */
function inList(query: RecordedQuery, column: string): unknown {
  return query.filters.find(
    (filter) => filter.op === 'in' && filter.column === column,
  )?.value
}

function readOf(db: FakeSupabaseClient, table: string): RecordedQuery {
  const query = db.queries.find((entry) => entry.table === table)
  if (!query) throw new Error(`the adapter never read ${table}`)
  return query
}

describe('SupabaseMetricSource scope filters', () => {
  it('narrows the units table on id, because there the unit is the row', async () => {
    const db = client()
    await new SupabaseMetricSource(db.asDb()).loadUnits(UNIT_SCOPED, MARCH)

    const read = readOf(db, 'units')

    // The two assertions the defect would have failed, in both directions:
    // the right column is used, and the wrong one is not used at all.
    expect(inList(read, 'id')).toEqual(['unit-a', 'unit-b'])
    expect(read.filters.some((filter) => filter.column === 'unit_id')).toBe(
      false,
    )
  })

  it('still narrows holds on unit_id, where the unit is a reference', async () => {
    const db = client()
    await new SupabaseMetricSource(db.asDb()).loadOutOfService(
      UNIT_SCOPED,
      MARCH,
    )

    // The counterpart. If the fix had been applied to `applyScope` itself
    // rather than at the one call site that needed it, this would fail.
    expect(inList(readOf(db, 'holds'), 'unit_id')).toEqual(['unit-a', 'unit-b'])
  })

  it('narrows by property without touching the unit column', async () => {
    const db = client()
    await new SupabaseMetricSource(db.asDb()).loadUnits(PROPERTY_SCOPED, MARCH)

    const read = readOf(db, 'units')
    expect(inList(read, 'property_id')).toEqual(['property-1'])
    expect(inList(read, 'id')).toBeUndefined()
  })

  it('always bounds the read by the organization, however wide the scope', async () => {
    const db = client()
    await new SupabaseMetricSource(db.asDb()).loadUnits(
      ORGANIZATION_WIDE,
      MARCH,
    )

    const read = readOf(db, 'units')

    // "Not narrowed" means not narrowed *within* the tenant. It never means
    // unbounded, which is the failure this assertion exists to refuse.
    expect(hasFilter(read, 'eq', 'organization_id', 'org-1')).toBe(true)
    expect(read.filters.some((filter) => filter.op === 'in')).toBe(false)
  })
})
