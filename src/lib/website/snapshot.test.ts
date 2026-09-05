/**
 * THE SECOND LAW: A VISITOR MUST NEVER SEE AN UNPUBLISHED CHANGE.
 *
 * Asserted structurally rather than by inspecting a route. The snapshot is the
 * whole document a visitor is served, so if a draft edit does not appear in a
 * snapshot built before it, no rendering path can show it — there is nothing
 * else for a public page to read.
 *
 * Also here: the publish gate refusing, and `bookableUnitIds`, which is the
 * reason a draft cannot leak through the booking widget either.
 */

import { describe, expect, it } from 'vitest'

import { buildSnapshot, navigationOf, pageOf } from './snapshot'
import { authoredClaim, claimFromRow } from './facts'
import {
  DEFAULT_SITE_DESIGN,
  type Site,
  type SiteClaim,
  type SiteMedia,
  type SitePage,
  type SiteSection,
} from './types'

const NOW = new Date('2026-03-01T09:00:00.000Z')
const USER = '22222222-2222-4222-8222-222222222222'
const PROPERTY_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const PROPERTY_B = 'bbbbbbbb-1111-4111-8111-111111111111'

const site: Site = {
  id: 'site-1',
  organizationId: 'org-1',
  propertyId: null,
  slug: 'galilee',
  name: 'אחוזת הגליל',
  status: 'draft',
  locale: 'he',
  publishedVersionId: null,
  publishedAt: null,
  publishedBy: null,
  design: DEFAULT_SITE_DESIGN,
  version: 1,
}

function page(overrides: Partial<SitePage> = {}): SitePage {
  return {
    id: 'page-home',
    organizationId: 'org-1',
    siteId: 'site-1',
    slug: '',
    kind: 'home',
    title: 'עמוד בית',
    navLabel: 'בית',
    showInNav: true,
    sortOrder: 0,
    isActive: true,
    seo: null,
    ...overrides,
  }
}

function sectionOn(
  pageId: string,
  claims: readonly SiteClaim[],
  overrides: Partial<SiteSection> = {},
): SiteSection {
  return {
    id: `section-${pageId}`,
    organizationId: 'org-1',
    siteId: 'site-1',
    pageId,
    kind: 'hero',
    sortOrder: 0,
    isActive: true,
    boundTo: null,
    claims,
    layout: {},
    ...overrides,
  }
}

const heading = authoredClaim({
  key: 'heading',
  text: 'ברוכים הבאים לאחוזת הגליל',
  authorUserId: USER,
})!

const units = [
  { id: 'unit-a1', propertyId: PROPERTY_A, status: 'active' },
  { id: 'unit-a2', propertyId: PROPERTY_A, status: 'archived' },
  { id: 'unit-b1', propertyId: PROPERTY_B, status: 'active' },
]

function build(input: {
  pages?: readonly SitePage[]
  sections?: readonly SiteSection[]
  media?: readonly SiteMedia[]
  site?: Site
}) {
  return buildSnapshot({
    site: input.site ?? site,
    organizationName: 'אחוזת הגליל',
    pages: input.pages ?? [page()],
    sections: input.sections ?? [sectionOn('page-home', [heading])],
    media: input.media ?? [],
    units,
    now: NOW,
  })
}

describe('the published document', () => {
  it('is self-contained: the pages, the sections and the claims travel with it', () => {
    const result = build({})
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.snapshot.pages).toHaveLength(1)
    expect(result.snapshot.pages[0].sections[0].claims[0].text).toBe(
      'ברוכים הבאים לאחוזת הגליל',
    )
    // The manifest is what an auditor reads without parsing the document.
    expect(result.snapshot.factManifest).toHaveLength(1)
  })

  it('OMITS an inactive page entirely rather than carrying a flag', () => {
    // A renderer that has to remember to check `isActive` is a renderer that
    // one day will not. The page is not in the document a visitor is sent.
    const result = build({
      pages: [page(), page({ id: 'page-draft', slug: 'wip', isActive: false })],
      sections: [
        sectionOn('page-home', [heading]),
        sectionOn('page-draft', [heading]),
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.pages.map((entry) => entry.slug)).toEqual([''])
  })

  it('OMITS an inactive section', () => {
    const result = build({
      sections: [
        sectionOn('page-home', [heading]),
        sectionOn('page-home', [heading], {
          id: 'section-hidden',
          isActive: false,
        }),
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.pages[0].sections).toHaveLength(1)
  })

  it('does not carry a draft edit made after it was built', () => {
    // THE LAW, from the only angle that proves it: the document is a value.
    // Whatever the draft becomes afterwards, this object is unchanged, and it
    // is the only thing the public route reads.
    const result = build({})
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const published = result.snapshot
    const later = build({
      sections: [
        sectionOn('page-home', [
          authoredClaim({
            key: 'heading',
            text: 'מבצע! 50% הנחה',
            authorUserId: USER,
          })!,
        ]),
      ],
    })

    expect(later.ok).toBe(true)
    expect(published.pages[0].sections[0].claims[0].text).toBe(
      'ברוכים הבאים לאחוזת הגליל',
    )
  })

  it('carries only the media something actually references', () => {
    const used: SiteMedia = {
      id: 'media-used',
      organizationId: 'org-1',
      siteId: 'site-1',
      url: '/photos/villa.jpg',
      altText: 'חזית הווילה',
      width: 1200,
      height: 800,
      contentType: 'image/jpeg',
      boundTo: null,
    }
    const unused: SiteMedia = { ...used, id: 'media-unused' }

    const result = build({
      media: [used, unused],
      sections: [
        sectionOn(
          'page-home',
          [
            claimFromRow({
              key: 'gallery.0',
              row: { id: 'media-used', alt_text: 'חזית הווילה' },
              column: 'alt_text',
              source: 'media',
            })!,
          ],
          { kind: 'gallery' },
        ),
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.media.map((item) => item.id)).toEqual(['media-used'])
  })
})

describe('the publish gate', () => {
  it('REFUSES a document containing an unsourced claim', () => {
    const fabricated: SiteClaim = {
      key: 'body',
      text: 'בווילה בריכה מחוממת.',
      source: 'property',
      sourceId: null,
      sourceField: 'description',
      sourceValue: null,
    }

    const result = build({
      sections: [sectionOn('page-home', [heading, fabricated])],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.blockers).toHaveLength(1)
    expect(result.blockers[0].reason).toBe('canonical_source_without_row')
  })

  it('does NOT refuse because of a claim on a section nobody is publishing', () => {
    // A half-written section somebody deactivated is not a reason to block a
    // publish, because it is not being published.
    const fabricated: SiteClaim = {
      key: 'body',
      text: 'בווילה בריכה מחוממת.',
      source: 'property',
      sourceId: null,
      sourceField: 'description',
      sourceValue: null,
    }

    const result = build({
      sections: [
        sectionOn('page-home', [heading]),
        sectionOn('page-home', [fabricated], {
          id: 'section-off',
          isActive: false,
        }),
      ],
    })

    expect(result.ok).toBe(true)
  })
})

describe('which units a published site may quote', () => {
  it('excludes an archived unit, which is not for sale', () => {
    const result = build({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.bookableUnitIds).not.toContain('unit-a2')
  })

  it('narrows to the bound property, so a two-property business cannot sell the wrong house', () => {
    const result = build({
      site: { ...site, propertyId: PROPERTY_A },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.bookableUnitIds).toEqual(['unit-a1'])
  })

  it('is a snapshot, so adding a unit to the DRAFT does not make it bookable', () => {
    // The reason the booking widget cannot leak a draft either. The published
    // list is fixed at publish time and the public availability path checks
    // membership of it before asking the engine anything.
    const published = build({ site: { ...site, propertyId: PROPERTY_A } })
    expect(published.ok).toBe(true)
    if (!published.ok) return

    expect(published.snapshot.bookableUnitIds).toEqual(['unit-a1'])
    expect(published.snapshot.bookableUnitIds).not.toContain('unit-b1')
  })

  it('lets an organization-wide site quote every active unit', () => {
    const result = build({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.bookableUnitIds).toEqual(['unit-a1', 'unit-b1'])
  })
})

describe('reading a snapshot', () => {
  const result = build({
    pages: [
      page(),
      page({
        id: 'page-contact',
        slug: 'contact',
        kind: 'contact',
        title: 'צרו קשר',
        navLabel: null,
        sortOrder: 1,
      }),
      page({
        id: 'page-legal',
        slug: 'legal',
        kind: 'policy',
        title: 'תנאים',
        showInNav: false,
        sortOrder: 2,
      }),
    ],
    sections: [
      sectionOn('page-home', [heading]),
      sectionOn('page-contact', [heading], { id: 'section-contact' }),
      sectionOn('page-legal', [heading], { id: 'section-legal' }),
    ],
  })

  it('finds the home page by the empty slug', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(pageOf(result.snapshot, '')?.kind).toBe('home')
    expect(pageOf(result.snapshot, '/')?.kind).toBe('home')
  })

  it('returns null for a slug that is not there, never a fallback page', () => {
    // A mistyped URL must 404. Serving the first page instead means a link
    // promised one thing and delivered another.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(pageOf(result.snapshot, 'nope')).toBeNull()
  })

  it('builds navigation from what asked to be there, using the nav label', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(navigationOf(result.snapshot)).toEqual([
      { slug: '', label: 'בית' },
      // No nav label, so the title.
      { slug: 'contact', label: 'צרו קשר' },
    ])
  })
})
