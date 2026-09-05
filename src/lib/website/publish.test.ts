/**
 * ROLLING BACK TO v3 CREATES v7, AND DOES NOT DELETE v4, v5 OR v6.
 *
 * The version arithmetic and the transition table, tested without a database
 * because both are pure. The database half — that a version row cannot be
 * updated or deleted at all — is `tg_site_versions_immutable` in 0042 and is
 * asserted by that migration's own rehearsal.
 */

import { describe, expect, it } from 'vitest'

import {
  SITE_TRANSITIONS,
  assertTransition,
  hasUnpublishedChanges,
  liveVersion,
  nextVersionNumber,
  rollbackTargets,
  transitionRefusal,
} from './publish'
import { RESERVED_PAGE_SLUGS } from './operations'
import { DEFAULT_SITE_DESIGN, type Site, type SiteVersion } from './types'

function siteAt(
  status: Site['status'],
  publishedVersionId: string | null,
  publishedAt: string | null = null,
): Site {
  return {
    id: 'site-1',
    organizationId: 'org-1',
    propertyId: null,
    slug: 'galilee',
    name: 'אחוזת הגליל',
    status,
    locale: 'he',
    publishedVersionId,
    publishedAt,
    publishedBy: null,
    design: DEFAULT_SITE_DESIGN,
    version: 1,
  }
}

function version(number: number, id = `v${number}`): SiteVersion {
  return {
    id,
    organizationId: 'org-1',
    siteId: 'site-1',
    versionNumber: number,
    label: null,
    publishedAt: `2026-0${Math.min(9, number)}-01T00:00:00.000Z`,
    publishedBy: null,
    restoredFromVersionId: null,
    // The snapshot's content is irrelevant to versioning; `buildSnapshot` owns
    // that and has its own test.
    snapshot: {
      siteId: 'site-1',
      slug: 'galilee',
      name: 'אחוזת הגליל',
      locale: 'he',
      design: DEFAULT_SITE_DESIGN,
      organizationName: 'אחוזת הגליל',
      pages: [],
      media: [],
      bookableUnitIds: [],
      factManifest: [],
      builtAt: '2026-01-01T00:00:00.000Z',
    },
  }
}

describe('version numbering', () => {
  it('is highest plus one, never count plus one', () => {
    // Counting would reuse a number if a version were ever removed, and two
    // rows claiming to be v5 makes the history unreadable exactly when
    // somebody is working out what was live the day a guest complained.
    expect(nextVersionNumber([version(1), version(3), version(7)])).toBe(8)
  })

  it('starts at 1 for a site that has never been published', () => {
    expect(nextVersionNumber([])).toBe(1)
  })
})

describe('a rollback', () => {
  const versions = [version(1), version(2), version(3), version(4), version(5)]
  const site = siteAt('published', 'v5', '2026-05-01T00:00:00.000Z')

  it('offers every version EXCEPT the one that is live', () => {
    // Rolling back to what is already live is a no-op dressed as an action,
    // and offering it is how somebody publishes a version they did not mean to.
    expect(rollbackTargets(site, versions).map((v) => v.versionNumber)).toEqual(
      [4, 3, 2, 1],
    )
  })

  it('would create version 6 when returning to version 3', () => {
    // The whole design in one assertion: the new number is above every
    // existing one, so v4 and v5 keep their numbers and their rows.
    expect(nextVersionNumber(versions)).toBe(6)
  })

  it('is refused on a site that has never been published', () => {
    expect(transitionRefusal('rollback', siteAt('draft', null))).toContain(
      'מעולם לא פורסם',
    )
    expect(() => assertTransition('rollback', siteAt('draft', null))).toThrow()
  })

  it('is allowed on an unpublished site, because its versions are still there', () => {
    expect(
      transitionRefusal('rollback', siteAt('unpublished', 'v5')),
    ).toBeNull()
  })
})

describe('the transition table', () => {
  it('lets every state publish, because publishing is how a site enters them', () => {
    expect(SITE_TRANSITIONS.publish.from).toEqual([
      'draft',
      'published',
      'unpublished',
    ])
  })

  it('refuses to unpublish a draft, which would be a no-op somebody believed in', () => {
    expect(transitionRefusal('unpublish', siteAt('draft', null))).toContain(
      'עדיין לא פורסם',
    )
  })

  it('refuses to unpublish twice', () => {
    expect(
      transitionRefusal('unpublish', siteAt('unpublished', null)),
    ).toContain('כבר אינו באוויר')
  })
})

describe('which version is live', () => {
  it('is null for an unpublished site even when the pointer lingers', () => {
    // Defence in depth against a row where the status and the pointer
    // disagree. 0042's `sites_published_has_version` should make that
    // impossible; this makes the reading safe if it ever is not.
    expect(liveVersion(siteAt('unpublished', 'v3'), [version(3)])).toBeNull()
  })

  it('is the pointed-at version for a published site', () => {
    expect(
      liveVersion(siteAt('published', 'v3'), [version(3)])?.versionNumber,
    ).toBe(3)
  })
})

describe('the unpublished-changes banner', () => {
  it('is on for a site that has never been published', () => {
    expect(
      hasUnpublishedChanges({
        site: siteAt('draft', null),
        draftUpdatedAt: null,
      }),
    ).toBe(true)
  })

  it('is on when the draft moved after the publish', () => {
    expect(
      hasUnpublishedChanges({
        site: siteAt('published', 'v1', '2026-05-01T10:00:00.000Z'),
        draftUpdatedAt: '2026-05-01T11:00:00.000Z',
      }),
    ).toBe(true)
  })

  it('is off when nothing has been touched since', () => {
    expect(
      hasUnpublishedChanges({
        site: siteAt('published', 'v1', '2026-05-01T12:00:00.000Z'),
        draftUpdatedAt: '2026-05-01T11:00:00.000Z',
      }),
    ).toBe(false)
  })
})

describe('page slugs the route tree already owns', () => {
  it('reserves `book`, because the booking route shadows it', () => {
    // A page saved with this slug is accepted by the database, appears in the
    // studio, appears in the site's navigation, and 404s for every visitor who
    // clicks it — everything except the visitor's experience says it worked.
    // `savePage`'s rule refuses it; this asserts the list it refuses from.
    expect(RESERVED_PAGE_SLUGS).toContain('book')
  })

  it('does not reserve the home page, which is the empty slug', () => {
    expect(RESERVED_PAGE_SLUGS).not.toContain('')
  })
})
