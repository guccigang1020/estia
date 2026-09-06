/**
 * The adapter, driven the way the screen drives it.
 *
 * ── What this can and cannot prove ────────────────────────────────────────
 *
 * `fake-client.ts` is unsparing about its own limits and they apply here: a
 * column name spelled wrongly is spelled wrongly consistently, so this cannot
 * prove a query is right against Postgres. What it proves is the three things
 * that would otherwise be found on a customer's screen — that a missing table
 * becomes a stated gap rather than an empty list, that every read is scoped by
 * `organization_id`, and that no query this module issues could bring a door
 * code back.
 *
 * The last of those is the test worth having. It reads the recorded queries
 * rather than the results, so it fails the moment somebody widens
 * `select('entry_id')` — which is the change that would leak a code into a
 * server-rendered page's props, silently, with every existing test still green.
 */

import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient, hasFilter } from '../persistence/fake-client'
import { GUIDE_TABLES, GuestGuideRepository, readGuide } from './repository'

const ORG = 'org-1'
const PROPERTY = 'prop-1'

const GUIDE_ROW = {
  id: 'guide-1',
  organization_id: ORG,
  property_id: PROPERTY,
  status: 'draft',
  languages: ['he', 'en'],
  published_version_id: null,
  published_at: null,
  published_by: null,
  version: 1,
}

function entryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    organization_id: ORG,
    property_id: PROPERTY,
    stage: 'during_stay',
    topic: 'wifi',
    title: { he: 'ויי-פיי' },
    body: { he: 'הרשת נקראת GALIL.' },
    icon: 'wifi',
    link_url: null,
    link_label: null,
    sort_order: 0,
    is_active: true,
    has_secret: true,
    release_mode: 'after_check_in',
    release_hours: 24,
    version: 1,
    ...overrides,
  }
}

function seed(overrides: Record<string, unknown> = {}) {
  return new FakeSupabaseClient({
    responses: {
      property_guides: { data: GUIDE_ROW },
      properties: { data: { id: PROPERTY, name: 'וילה בגליל' } },
      guide_entries: { data: [entryRow()] },
      guide_media: { data: [] },
      guide_entry_secrets: { data: [{ entry_id: 'entry-1' }] },
      guide_recommendations: { data: [] },
      guide_versions: { data: [] },
      ...overrides,
    },
  })
}

describe('the tables may not exist', () => {
  for (const code of ['42P01', 'PGRST205']) {
    it(`turns ${code} into a stated gap naming the tables`, async () => {
      const fake = seed({
        property_guides: { error: { code, message: 'no such relation' } },
      })

      const result = await readGuide(fake.asDb(), ORG, PROPERTY)

      expect(result.state).toBe('not_provisioned')
      expect(result.state === 'not_provisioned' && result.tables).toEqual([
        ...GUIDE_TABLES,
      ])
    })
  }

  it('rethrows anything else rather than claiming the feature is unbuilt', async () => {
    const fake = seed({
      // A row level security refusal. Reporting this as "not provisioned"
      // would tell a business their guide does not exist when in fact they
      // may not read it.
      property_guides: { error: { code: '42501', message: 'denied' } },
    })

    await expect(readGuide(fake.asDb(), ORG, PROPERTY)).rejects.toMatchObject({
      code: '42501',
    })
  })
})

describe('no query this module issues can return a secret', () => {
  it('selects only entry_id from guide_entry_secrets', async () => {
    const fake = seed()
    await readGuide(fake.asDb(), ORG, PROPERTY)

    const secretQueries = fake.queries.filter(
      (query) => query.table === 'guide_entry_secrets',
    )

    expect(secretQueries).toHaveLength(1)
    expect(secretQueries[0].verb).toBe('select')
    // The whole assertion. Widening this string is the change that would put a
    // door code into a server-rendered page's props.
    expect(secretQueries[0].columns).toBe('entry_id')
  })

  it('never selects a value column from anywhere', async () => {
    const fake = seed()
    await readGuide(fake.asDb(), ORG, PROPERTY)

    for (const query of fake.queries) {
      expect(query.columns ?? '').not.toContain('value')
    }
  })

  it('reports which entries have one without reading it', async () => {
    const fake = seed()
    const result = await readGuide(fake.asDb(), ORG, PROPERTY)

    expect(result.state === 'ready' && result.data.entryIdsWithSecret).toEqual([
      'entry-1',
    ])
  })

  it('answers empty rather than failing when the policy refuses the read', async () => {
    // A reader without the grant. `has_secret` on the entry still tells the
    // operator a code belongs there; this read only says whether it is filled
    // in, and a refusal must not blank a screen with five other panels on it.
    const fake = seed({
      guide_entry_secrets: { error: { code: '42501', message: 'denied' } },
    })

    const result = await readGuide(fake.asDb(), ORG, PROPERTY)
    expect(result.state === 'ready' && result.data.entryIdsWithSecret).toEqual(
      [],
    )
  })
})

describe('tenant scope is in the query, not only in the policy', () => {
  it('filters organization_id on every read', async () => {
    const fake = seed()
    await readGuide(fake.asDb(), ORG, PROPERTY)

    expect(fake.queries.length).toBeGreaterThan(0)
    for (const query of fake.queries) {
      expect(hasFilter(query, 'eq', 'organization_id', ORG), query.table).toBe(
        true,
      )
    }
  })

  it('filters property_id on everything a property owns', async () => {
    const fake = seed()
    await readGuide(fake.asDb(), ORG, PROPERTY)

    for (const query of fake.queries) {
      if (query.table === 'guide_versions') continue
      const column = query.table === 'properties' ? 'id' : 'property_id'
      expect(hasFilter(query, 'eq', column, PROPERTY), query.table).toBe(true)
    }
  })
})

describe('the mapping', () => {
  it('reads an entry back with its release rule', async () => {
    const fake = seed()
    const result = await readGuide(fake.asDb(), ORG, PROPERTY)

    expect(result.state === 'ready' && result.data.entries[0].release).toEqual({
      mode: 'after_check_in',
      hours: 24,
    })
  })

  it('fails closed on a release mode it does not recognise', async () => {
    // A row written by a future migration this code does not know about. The
    // safe reading is `manual` — withheld until a person says otherwise —
    // and never `immediate`.
    const fake = seed({
      guide_entries: {
        data: [entryRow({ release_mode: 'after_moon_landing' })],
      },
    })

    const result = await readGuide(fake.asDb(), ORG, PROPERTY)
    expect(
      result.state === 'ready' && result.data.entries[0].release.mode,
    ).toBe('manual')
  })

  it('drops an entry with no Hebrew title rather than promising one', async () => {
    const fake = seed({
      guide_entries: { data: [entryRow({ title: { en: 'Wi-Fi' } })] },
    })

    const result = await readGuide(fake.asDb(), ORG, PROPERTY)
    expect(result.state === 'ready' && result.data.entries).toEqual([])
  })

  it('drops a link whose URL would not survive isSafeUrl', async () => {
    const fake = seed({
      guide_entries: {
        data: [
          entryRow({
            link_url: 'data:text/html,<script>',
            link_label: { he: 'תפריט' },
          }),
        ],
      },
    })

    const result = await readGuide(fake.asDb(), ORG, PROPERTY)
    expect(result.state === 'ready' && result.data.entries[0].link).toBeNull()
  })

  it('drops a recommendation whose source did not survive the read', async () => {
    const fake = seed({
      guide_recommendations: {
        data: [
          {
            id: 'rec-1',
            organization_id: ORG,
            property_id: PROPERTY,
            category: 'restaurant',
            name: { he: 'מסעדה' },
            description: null,
            address: null,
            phone: null,
            url: null,
            minutes_away: null,
            source_kind: null,
            source_user_id: null,
            source_name: null,
            source_url: null,
            sort_order: 0,
            is_active: true,
            version: 1,
          },
        ],
      },
    })

    const result = await readGuide(fake.asDb(), ORG, PROPERTY)
    expect(result.state === 'ready' && result.data.recommendations).toEqual([])
  })
})

describe('the repository on its own', () => {
  it('throws what the database throws', async () => {
    const fake = new FakeSupabaseClient({
      responses: {
        guide_entries: { error: { code: '42P01', message: 'nope' } },
        guide_media: { data: [] },
      },
    })

    // The tolerance for a missing table is a decision `readGuide` opts into.
    // The adapter itself stays a plain adapter, which is what makes the
    // distinction between "absent" and "broken" possible at all.
    await expect(
      new GuestGuideRepository(fake.asDb()).entries(ORG, PROPERTY),
    ).rejects.toMatchObject({ code: '42P01' })
  })
})
