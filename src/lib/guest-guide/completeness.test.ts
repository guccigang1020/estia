/**
 * The report an operator reads before a guest asks.
 *
 * The first test is the one the feature exists for: a guide with no wi-fi
 * entry says so, in the words a guest would use.
 */

import { describe, expect, it } from 'vitest'

import {
  guideCompleteness,
  needsAttention,
  type GuideCompletenessInput,
} from './completeness'
import type { GuideEntry, GuideRecommendation, GuideTopic } from './types'

function entry(
  topic: GuideTopic,
  overrides: Partial<GuideEntry> = {},
): GuideEntry {
  return {
    id: `entry-${topic}`,
    organizationId: 'org-1',
    propertyId: 'prop-1',
    stage: 'during_stay',
    topic,
    title: { he: 'כותרת' },
    body: { he: 'תוכן שאורח יכול לקרוא.' },
    icon: null,
    link: null,
    media: [],
    sortOrder: 0,
    isActive: true,
    hasSecret: false,
    release: { mode: 'immediate', hours: 24 },
    version: 1,
    ...overrides,
  }
}

function input(
  overrides: Partial<GuideCompletenessInput> = {},
): GuideCompletenessInput {
  return {
    entries: [],
    recommendations: [],
    entryIdsWithSecret: [],
    ...overrides,
  }
}

describe('the missing wi-fi entry', () => {
  it('is named, with the question a guest will ask', () => {
    const report = guideCompleteness(input())
    const wifi = report.gaps.find((gap) => gap.topic === 'wifi')

    expect(wifi).toBeDefined()
    expect(wifi?.kind).toBe('topic_missing')
    expect(wifi?.severity).toBe('essential')
    expect(wifi?.detail).toContain('הסיסמה של הוויי-פיי')
  })

  it('is reported first, ahead of everything advisory', () => {
    const report = guideCompleteness(input())
    expect(report.gaps[0].severity).toBe('essential')
    expect(needsAttention(report)).toBe(true)
  })

  it('goes away when a readable entry exists', () => {
    const report = guideCompleteness(input({ entries: [entry('wifi')] }))

    expect(report.gaps.some((gap) => gap.topic === 'wifi')).toBe(false)
    expect(report.covered).toContain('wifi')
  })

  it('does NOT go away for an entry that is only a heading', () => {
    const report = guideCompleteness(
      input({ entries: [entry('wifi', { body: null })] }),
    )
    const wifi = report.gaps.find((gap) => gap.topic === 'wifi')

    expect(wifi?.kind).toBe('entry_empty')
    expect(wifi?.entryId).toBe('entry-wifi')
  })

  it('does not count an entry the operator switched off', () => {
    const report = guideCompleteness(
      input({ entries: [entry('wifi', { isActive: false })] }),
    )
    expect(report.gaps.some((gap) => gap.topic === 'wifi')).toBe(true)
  })
})

describe('a sensitive entry with nothing behind it', () => {
  it('is reported as essential', () => {
    const report = guideCompleteness(
      input({
        entries: [entry('access', { hasSecret: true })],
        entryIdsWithSecret: [],
      }),
    )

    const gap = report.gaps.find((item) => item.kind === 'secret_missing')
    expect(gap?.severity).toBe('essential')
    expect(gap?.entryId).toBe('entry-access')
  })

  it('is not reported once the secret is filled in', () => {
    const report = guideCompleteness(
      input({
        entries: [entry('access', { hasSecret: true })],
        entryIdsWithSecret: ['entry-access'],
      }),
    )

    expect(report.gaps.some((item) => item.kind === 'secret_missing')).toBe(
      false,
    )
  })
})

describe('what it refuses to invent', () => {
  it('says nothing about a pool the property never claimed', () => {
    const report = guideCompleteness(input())
    expect(report.gaps.some((gap) => gap.topic === 'pool')).toBe(false)
  })

  it('reports the pool once the operator says there is one', () => {
    const report = guideCompleteness(input({ amenityTopics: ['pool'] }))
    const pool = report.gaps.find((gap) => gap.topic === 'pool')

    expect(pool?.severity).toBe('optional')
  })

  it('reports a missing translation only for a declared language', () => {
    const withEnglish = guideCompleteness(
      input({ entries: [entry('wifi')], languages: ['he', 'en'] }),
    )
    const hebrewOnly = guideCompleteness(
      input({ entries: [entry('wifi')], languages: ['he'] }),
    )

    expect(
      withEnglish.gaps.some((gap) => gap.kind === 'translation_missing'),
    ).toBe(true)
    expect(
      hebrewOnly.gaps.some((gap) => gap.kind === 'translation_missing'),
    ).toBe(false)
  })

  it('never produces a score', () => {
    const report = guideCompleteness(input())
    expect(Object.keys(report)).toEqual(['gaps', 'counts', 'covered'])
  })
})

describe('media and recommendations', () => {
  it('reports a photograph with no alt text, quietly', () => {
    const report = guideCompleteness(
      input({
        entries: [
          entry('pool', {
            media: [
              {
                id: 'media-1',
                entryId: 'entry-pool',
                kind: 'photo',
                url: 'https://example.com/pool.jpg',
                altText: null,
                sortOrder: 0,
              },
            ],
          }),
        ],
        amenityTopics: ['pool'],
      }),
    )

    const gap = report.gaps.find((item) => item.kind === 'media_alt_missing')
    expect(gap?.severity).toBe('optional')
  })

  it('reports an empty recommendation list', () => {
    const report = guideCompleteness(input())
    expect(report.gaps.some((gap) => gap.kind === 'no_recommendations')).toBe(
      true,
    )
  })

  it('stops reporting it once there is one', () => {
    const recommendation: GuideRecommendation = {
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
    }

    const report = guideCompleteness(
      input({ recommendations: [recommendation] }),
    )
    expect(report.gaps.some((gap) => gap.kind === 'no_recommendations')).toBe(
      false,
    )
  })
})
