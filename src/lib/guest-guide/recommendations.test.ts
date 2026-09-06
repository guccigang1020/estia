/**
 * §44, from the side that matters: nothing gets in without a source, and there
 * is no shape a fabricated recommendation could arrive in.
 */

import { describe, expect, it } from 'vitest'

import {
  byCategory,
  citedSources,
  readSource,
  recommendationFrom,
  recommendationFromForm,
  sourceLabel,
  type RecommendationDraft,
} from './recommendations'
import type { GuideRecommendation } from './types'

function draft(
  overrides: Partial<RecommendationDraft> = {},
): RecommendationDraft {
  return {
    organizationId: 'org-1',
    propertyId: 'prop-1',
    category: 'restaurant',
    name: { he: 'מסעדת הגליל' },
    ...overrides,
  }
}

describe('a recommendation cannot be created without a source', () => {
  it('refuses an absent source', () => {
    expect(recommendationFromForm('rec-1', draft(), undefined)).toEqual({
      ok: false,
      refusal: 'no_source',
    })
  })

  it('refuses a null source', () => {
    expect(recommendationFromForm('rec-1', draft(), null)).toEqual({
      ok: false,
      refusal: 'no_source',
    })
  })

  it('refuses a source that claims a model wrote it', () => {
    // The point of the two-member union. There is no `generated` source, so a
    // caller inventing one is refused by the reader rather than trusted by it.
    expect(
      recommendationFromForm('rec-1', draft(), {
        kind: 'generated',
        model: 'anything',
      }),
    ).toEqual({ ok: false, refusal: 'no_source' })
  })

  it('refuses a business source with no person behind it', () => {
    expect(readSource({ kind: 'business' })).toBeNull()
    expect(readSource({ kind: 'business', enteredByUserId: '  ' })).toBeNull()
  })

  it('refuses a named source with no name', () => {
    expect(readSource({ kind: 'named', name: '' })).toBeNull()
    expect(readSource({ kind: 'named' })).toBeNull()
  })

  it('refuses a named source whose URL is not one we would render', () => {
    expect(
      readSource({
        kind: 'named',
        name: 'משרד התיירות',
        url: 'javascript:alert(1)',
      }),
    ).toBeNull()
  })

  it('accepts a business entry and stamps the person', () => {
    expect(readSource({ kind: 'business', enteredByUserId: 'user-7' })).toEqual(
      {
        kind: 'business',
        enteredByUserId: 'user-7',
      },
    )
  })

  it('accepts a named third party and keeps the name for the guest', () => {
    const source = readSource({
      kind: 'named',
      name: 'עיריית צפת',
      url: 'https://example.org/list',
    })

    expect(source).toEqual({
      kind: 'named',
      name: 'עיריית צפת',
      url: 'https://example.org/list',
    })
    expect(source === null ? '' : sourceLabel(source)).toBe('לפי עיריית צפת')
  })
})

describe('what else it refuses before storing anything', () => {
  const source = { kind: 'business', enteredByUserId: 'user-7' } as const

  it('refuses a name with no Hebrew', () => {
    expect(
      recommendationFrom('rec-1', draft({ name: { en: 'Galilee' } }), source),
    ).toEqual({ ok: false, refusal: 'no_name' })
  })

  it('refuses an unknown category', () => {
    expect(
      recommendationFrom('rec-1', draft({ category: 'nightclub' }), source),
    ).toEqual({ ok: false, refusal: 'unknown_category' })
  })

  it('refuses a URL that is not https or a relative path', () => {
    for (const url of [
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,<script>',
      '//example.com/list',
      'ftp://example.com',
    ]) {
      expect(recommendationFrom('rec-1', draft({ url }), source)).toEqual({
        ok: false,
        refusal: 'unsafe_url',
      })
    }
  })

  it('accepts https and a relative path', () => {
    for (const url of ['https://example.com/menu', '/places/galilee']) {
      const result = recommendationFrom('rec-1', draft({ url }), source)
      expect(result.ok).toBe(true)
    }
  })

  it('refuses a distance nobody walks', () => {
    expect(
      recommendationFrom('rec-1', draft({ minutesAway: 4000 }), source),
    ).toEqual({ ok: false, refusal: 'implausible_distance' })
    expect(
      recommendationFrom('rec-1', draft({ minutesAway: 12.5 }), source),
    ).toEqual({ ok: false, refusal: 'implausible_distance' })
  })

  it('keeps the distance the business stated and computes none', () => {
    const result = recommendationFrom(
      'rec-1',
      draft({ minutesAway: 12 }),
      source,
    )
    expect(result.ok && result.recommendation.minutesAway).toBe(12)
  })
})

describe('the views', () => {
  function item(
    overrides: Partial<GuideRecommendation> = {},
  ): GuideRecommendation {
    return {
      id: 'rec-1',
      organizationId: 'org-1',
      propertyId: 'prop-1',
      category: 'restaurant',
      name: { he: 'מסעדה' },
      description: null,
      address: null,
      phone: null,
      url: null,
      minutesAway: null,
      source: { kind: 'business', enteredByUserId: 'user-7' },
      sortOrder: 0,
      isActive: true,
      version: 1,
      ...overrides,
    }
  }

  it('groups by category in catalogue order and skips empty groups', () => {
    const groups = byCategory([
      item({ id: 'b', category: 'beach' }),
      item({ id: 'a', category: 'restaurant' }),
    ])

    expect(groups.map((group) => group.category)).toEqual([
      'restaurant',
      'beach',
    ])
  })

  it('leaves an inactive recommendation out', () => {
    expect(byCategory([item({ isActive: false })])).toEqual([])
  })

  it('lists the third parties the guide is repeating', () => {
    expect(
      citedSources([
        item({ source: { kind: 'named', name: 'עיריית צפת', url: null } }),
        item({ source: { kind: 'named', name: 'עיריית צפת', url: null } }),
        item(),
      ]),
    ).toEqual(['עיריית צפת'])
  })
})
