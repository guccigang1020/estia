/**
 * Reading the stored rules back.
 *
 * Two things are worth a test here and the rest is mapping.
 *
 * The first is the null property. `property_id is null` is the
 * organization-wide row, and asking PostgREST for it with `eq` produces
 * `property_id=eq.null`, which matches nothing — so the write path would decide
 * there was no row, insert a second one, and hit the partial unique index. The
 * two calls look almost identical in the source and behave completely
 * differently, so which one is issued is asserted rather than assumed.
 *
 * The second is a parameter that is not a number. `0067` refuses to store one
 * and `conditions.ts` would evaluate one as `not_comparable` forever, so it is
 * dropped on the way in and the rule keeps its shipped threshold — visible on
 * the screen as a number that did not change, rather than as a rule that
 * quietly stops matching.
 */

import { describe, expect, it } from 'vitest'

import type { Db } from '../persistence/client'
import { AutomationRuleRepository } from './repository'

const ORG = '11111111-1111-4111-8111-111111111111'

interface Issued {
  filters: Record<string, unknown>
  /** Columns asked for with `is`, which is the null-safe comparison. */
  nulls: string[]
}

function fakeDb(rows: readonly Record<string, unknown>[], issued: Issued): Db {
  const chain = {
    eq(column: string, value: unknown) {
      issued.filters[column] = value
      return chain
    },
    is(column: string, value: unknown) {
      issued.nulls.push(column)
      issued.filters[column] = value
      return chain
    },
    async maybeSingle() {
      return { data: rows[0] ?? null, error: null }
    },
    then(resolve: (result: { data: unknown; error: unknown }) => void) {
      resolve({ data: rows, error: null })
    },
  }

  return {
    from() {
      return { select: () => chain }
    },
  } as unknown as Db
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    template_id: 'review-request-after-stay',
    property_id: null,
    enabled: true,
    parameters: { minimum_nights: 4 },
    enabled_at: '2026-09-01T09:00:00.000Z',
    enabled_by: 'user-1',
    disabled_at: null,
    updated_at: '2026-09-01T09:00:00.000Z',
    version: 2,
    ...overrides,
  }
}

describe('reading one rule for one scope', () => {
  it('asks for the organization-wide row with `is`, never `eq`', async () => {
    const issued: Issued = { filters: {}, nulls: [] }
    await new AutomationRuleRepository(fakeDb([row()], issued)).rule(
      ORG,
      'review-request-after-stay',
      null,
    )

    expect(issued.nulls).toEqual(['property_id'])
    expect(issued.filters).toMatchObject({
      organization_id: ORG,
      template_id: 'review-request-after-stay',
      property_id: null,
    })
  })

  it('asks for a property row with `eq`', async () => {
    const issued: Issued = { filters: {}, nulls: [] }
    await new AutomationRuleRepository(fakeDb([row()], issued)).rule(
      ORG,
      'review-request-after-stay',
      'property-1',
    )

    expect(issued.nulls).toEqual([])
    expect(issued.filters).toMatchObject({ property_id: 'property-1' })
  })

  it('answers null when nothing is stored', async () => {
    const issued: Issued = { filters: {}, nulls: [] }
    const found = await new AutomationRuleRepository(fakeDb([], issued)).rule(
      ORG,
      'review-request-after-stay',
      null,
    )
    expect(found).toBeNull()
  })
})

describe('the mapping', () => {
  it('reads a row into the shape the resolver expects', async () => {
    const issued: Issued = { filters: {}, nulls: [] }
    const found = await new AutomationRuleRepository(
      fakeDb([row()], issued),
    ).rule(ORG, 'review-request-after-stay', null)

    expect(found).toEqual({
      id: 'row-1',
      templateId: 'review-request-after-stay',
      propertyId: null,
      enabled: true,
      parameters: { minimum_nights: 4 },
      enabledAt: '2026-09-01T09:00:00.000Z',
      enabledBy: 'user-1',
      disabledAt: null,
      updatedAt: '2026-09-01T09:00:00.000Z',
      version: 2,
    })
  })

  it('drops a parameter no condition could compare, keeping the rest', async () => {
    const issued: Issued = { filters: {}, nulls: [] }
    const found = await new AutomationRuleRepository(
      fakeDb([row({ parameters: { minimum_nights: '4', other: 7 } })], issued),
    ).rule(ORG, 'review-request-after-stay', null)

    expect(found?.parameters).toEqual({ other: 7 })
  })

  it('treats a parameters column that is not an object as no parameters', async () => {
    const issued: Issued = { filters: {}, nulls: [] }
    for (const value of [null, [1, 2], 'nothing']) {
      const found = await new AutomationRuleRepository(
        fakeDb([row({ parameters: value })], issued),
      ).rule(ORG, 'review-request-after-stay', null)
      expect(found?.parameters).toEqual({})
    }
  })

  it('reads every row in the organization, both scopes together', async () => {
    const issued: Issued = { filters: {}, nulls: [] }
    const all = await new AutomationRuleRepository(
      fakeDb([row(), row({ id: 'row-2', property_id: 'property-1' })], issued),
    ).stored(ORG)

    expect(all.map((entry) => entry.propertyId)).toEqual([null, 'property-1'])
    // Not narrowed to one property: the resolver needs the property rows even
    // in the organization view, to say that three properties have overridden a
    // rule for themselves.
    expect(issued.filters).toEqual({ organization_id: ORG })
  })
})
