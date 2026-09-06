/**
 * The guide read, driven the way the screen drives it.
 *
 * Two claims worth making without a database, and one of them is the reason
 * the module exists:
 *
 *   · A missing table becomes a stated gap naming the tables, never an empty
 *     guide — which would tell a business the feature works and has nothing
 *     in it.
 *   · Nothing this screen reads could carry a door code. The assertion is on
 *     the recorded QUERIES rather than on the rendered output, because a
 *     component that received a secret and chose not to print it would still
 *     have shipped it inside the page's serialised props.
 */

import { describe, expect, it } from 'vitest'

import type { Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { FakeSupabaseClient } from '@/lib/persistence/fake-client'

import { GUIDE_TABLES, loadGuideScreen, mayReadGuide } from './queries'

const ORG = 'org-1'
const PROPERTY = 'prop-1'
const OTHER_PROPERTY = 'prop-2'

function actorWith(grants: readonly Grant[], scopedTo?: string): Actor {
  return {
    userId: 'user-1',
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope:
      scopedTo === undefined
        ? { kind: 'all_organization' }
        : { kind: 'properties', propertyIds: [scopedTo] },
    entitlements: new Set(),
  }
}

function seed(overrides: Record<string, unknown> = {}) {
  return new FakeSupabaseClient({
    responses: {
      property_guides: {
        data: {
          id: 'guide-1',
          organization_id: ORG,
          property_id: PROPERTY,
          status: 'draft',
          languages: ['he'],
          published_version_id: null,
          published_at: null,
          published_by: null,
          version: 1,
        },
      },
      properties: { data: { id: PROPERTY, name: 'וילה בגליל' } },
      guide_entries: { data: [] },
      guide_media: { data: [] },
      guide_entry_secrets: { data: [] },
      guide_recommendations: { data: [] },
      guide_versions: { data: [] },
      ...overrides,
    },
  })
}

describe('before the migration runs', () => {
  it('states the gap and names the tables', async () => {
    const fake = seed({
      property_guides: { error: { code: 'PGRST205', message: 'unknown' } },
    })

    const screen = await loadGuideScreen(
      fake.asDb(),
      actorWith(['property.view', 'property.update']),
      ORG,
      PROPERTY,
    )

    expect(screen.state).toBe('not_provisioned')
    expect(screen.state === 'not_provisioned' && screen.tables).toEqual([
      ...GUIDE_TABLES,
    ])
  })
})

describe('the screen never reads a secret', () => {
  it('asks guide_entry_secrets for entry_id and nothing else', async () => {
    const fake = seed()
    await loadGuideScreen(
      fake.asDb(),
      actorWith(['property.view', 'property.update']),
      ORG,
      PROPERTY,
    )

    const secretQueries = fake.queries.filter(
      (query) => query.table === 'guide_entry_secrets',
    )
    expect(secretQueries.map((query) => query.columns)).toEqual(['entry_id'])
  })
})

describe('what the screen reports about an empty guide', () => {
  it('leads with the wi-fi entry a guest will ask about', async () => {
    const fake = seed()
    const screen = await loadGuideScreen(
      fake.asDb(),
      actorWith(['property.view', 'property.update']),
      ORG,
      PROPERTY,
    )

    expect(screen.state).toBe('ready')
    if (screen.state !== 'ready') return

    const wifi = screen.data.completeness.gaps.find(
      (gap) => gap.topic === 'wifi',
    )
    expect(wifi?.severity).toBe('essential')
    expect(screen.data.stages.map((stage) => stage.stage)).toEqual([
      'before_arrival',
      'during_stay',
      'after_checkout',
    ])
  })

  it('says plainly whether this reader may change anything', async () => {
    const fake = seed()
    const readOnly = await loadGuideScreen(
      fake.asDb(),
      actorWith(['property.view']),
      ORG,
      PROPERTY,
    )

    expect(readOnly.state === 'ready' && readOnly.data.canEdit).toBe(false)
  })
})

describe('a reader scoped to one property', () => {
  it('may read the property in scope', () => {
    expect(
      mayReadGuide(actorWith(['property.view'], PROPERTY), ORG, PROPERTY),
    ).toBe(true)
  })

  it('may not read another property by typing its id', () => {
    // The second floor. Row level security is the third and would also refuse,
    // but a screen that relied on an empty result set would render an empty
    // guide rather than a refusal.
    expect(
      mayReadGuide(actorWith(['property.view'], PROPERTY), ORG, OTHER_PROPERTY),
    ).toBe(false)
  })

  it('may not read anything without the grant', () => {
    expect(mayReadGuide(actorWith([]), ORG, PROPERTY)).toBe(false)
  })
})
