/**
 * A CHECK THAT CANNOT BE SOURCED REPORTS `not_assessed`.
 *
 * The rule that makes the quality report worth reading, asserted directly:
 * three checks return `not_assessed` and none of them produces a number, and
 * `not_assessed` never blocks a publish.
 *
 * Also here: only an OPEN blocker blocks, so a person who read a warning and
 * decided to publish anyway is believed.
 */

import { describe, expect, it } from 'vitest'

import { authoredClaim } from './facts'
import {
  blocksPublish,
  runAllPasses,
  runQualityPass,
  summarize,
  type QualityInput,
} from './quality'
import type { SitePage, SiteSection, SiteClaim } from './types'

const USER = '22222222-2222-4222-8222-222222222222'

const heading = authoredClaim({
  key: 'heading',
  text: 'ברוכים הבאים',
  authorUserId: USER,
})!

function page(overrides: Partial<SitePage> = {}): SitePage {
  return {
    id: 'page-home',
    organizationId: 'org-1',
    siteId: 'site-1',
    slug: '',
    kind: 'home',
    title: 'עמוד בית',
    navLabel: null,
    showInNav: true,
    sortOrder: 0,
    isActive: true,
    seo: {
      pageId: 'page-home',
      metaTitle: 'אחוזת הגליל — בית אירוח בראש פינה',
      metaDescription: 'לינה שקטה בגליל העליון.',
      canonicalUrl: null,
      ogMediaId: null,
      indexable: true,
    },
    ...overrides,
  }
}

function section(overrides: Partial<SiteSection> = {}): SiteSection {
  return {
    id: 'section-1',
    organizationId: 'org-1',
    siteId: 'site-1',
    pageId: 'page-home',
    kind: 'hero',
    sortOrder: 0,
    isActive: true,
    boundTo: null,
    claims: [heading],
    layout: {},
    ...overrides,
  }
}

function input(overrides: Partial<QualityInput> = {}): QualityInput {
  return {
    pages: [page()],
    sections: [
      section(),
      section({ id: 'section-book', kind: 'booking_widget' }),
      section({ id: 'section-contact', kind: 'contact_details' }),
    ],
    media: [],
    customDomainAvailable: true,
    hasVerifiedDomain: true,
    ...overrides,
  }
}

describe('what is deliberately NOT scored', () => {
  const findings = runAllPasses(input())

  it('does not score readability, because there is no language engine', () => {
    const finding = findings.find((f) => f.checkCode === 'content.readability')
    expect(finding?.status).toBe('not_assessed')
    expect(finding?.detail).toContain('בלי להמציא')
  })

  it('does not claim a conversion rate, because there is no analytics source', () => {
    const finding = findings.find((f) => f.checkCode === 'conversion.rate')
    expect(finding?.status).toBe('not_assessed')
    // The sentence that matters: a number here would be invented.
    expect(finding?.detail).toContain('מומצא')
  })

  it('does not score load time, because nothing here times a request', () => {
    const finding = findings.find(
      (f) => f.checkCode === 'technical.performance',
    )
    expect(finding?.status).toBe('not_assessed')
  })

  it('counts them separately from real findings, and never as failures', () => {
    const counts = summarize(findings)
    expect(counts.notAssessed).toBe(3)
    // And none of the three is a blocker.
    expect(counts.blockers).toBe(0)
  })

  it('never blocks a publish', () => {
    expect(blocksPublish(findings)).toBe(false)
  })
})

describe('the content pass', () => {
  it('raises a BLOCKER for a claim that cannot be sourced', () => {
    const fabricated: SiteClaim = {
      key: 'body',
      text: 'בווילה בריכה מחוממת.',
      source: 'property',
      sourceId: null,
      sourceField: 'description',
      sourceValue: null,
    }

    const findings = runQualityPass(
      'content',
      input({ sections: [section({ claims: [heading, fabricated] })] }),
    )

    const blocker = findings.find(
      (f) => f.checkCode === 'content.claim_unsourced',
    )
    expect(blocker?.severity).toBe('blocker')
    expect(blocksPublish(findings)).toBe(true)
  })

  it('warns about an empty page rather than blocking it', () => {
    const findings = runQualityPass(
      'content',
      input({ pages: [page()], sections: [] }),
    )

    const finding = findings.find((f) => f.checkCode === 'content.page_empty')
    expect(finding?.severity).toBe('warning')
    expect(blocksPublish(findings)).toBe(false)
  })

  it('says something different about a section bound to nothing', () => {
    const bound = runQualityPass(
      'content',
      input({
        sections: [
          section({
            claims: [],
            boundTo: { source: 'property', id: 'property-a' },
          }),
        ],
      }),
    ).find((f) => f.checkCode === 'content.section_empty')

    const unbound = runQualityPass(
      'content',
      input({ sections: [section({ claims: [] })] }),
    ).find((f) => f.checkCode === 'content.section_empty')

    expect(bound?.detail).toContain('השלימו את פרטי הנכס')
    expect(unbound?.detail).toContain('אינו משויך')
  })
})

describe('the conversion pass', () => {
  it('notices there is no way to book', () => {
    const findings = runQualityPass(
      'conversion',
      input({ sections: [section()] }),
    )

    expect(
      findings.some((f) => f.checkCode === 'conversion.no_booking_path'),
    ).toBe(true)
  })

  it('notices there is no home page at all', () => {
    const findings = runQualityPass(
      'conversion',
      input({ pages: [page({ kind: 'custom', slug: 'about' })] }),
    )

    expect(findings.some((f) => f.checkCode === 'conversion.no_home')).toBe(
      true,
    )
  })

  it('never blocks, because it is advice about marketing', () => {
    const findings = runQualityPass(
      'conversion',
      input({ pages: [], sections: [] }),
    )
    expect(blocksPublish(findings)).toBe(false)
  })
})

describe('the technical pass', () => {
  it('finds a missing search title', () => {
    const findings = runQualityPass(
      'technical',
      input({ pages: [page({ seo: null })] }),
    )

    expect(
      findings.some((f) => f.checkCode === 'technical.meta_title_missing'),
    ).toBe(true)
  })

  it('finds two pages claiming one address', () => {
    const findings = runQualityPass(
      'technical',
      input({
        pages: [page(), page({ id: 'page-two', title: 'שני' })],
      }),
    )

    const finding = findings.find(
      (f) => f.checkCode === 'technical.duplicate_slug',
    )
    expect(finding?.severity).toBe('warning')
  })

  it('finds images a screen reader cannot describe', () => {
    const findings = runQualityPass(
      'technical',
      input({
        media: [
          { id: 'm1', altText: null },
          { id: 'm2', altText: '  ' },
          { id: 'm3', altText: 'חזית הווילה' },
        ],
      }),
    )

    const finding = findings.find(
      (f) => f.checkCode === 'technical.media_without_alt',
    )
    expect(finding?.title).toContain('2')
  })

  it('says what unlocks a custom domain when the plan does not carry it', () => {
    const locked = runQualityPass(
      'technical',
      input({ hasVerifiedDomain: false, customDomainAvailable: false }),
    ).find((f) => f.checkCode === 'technical.no_custom_domain')

    expect(locked?.detail).toContain('שדרוג חבילה')
  })
})

describe('the pre-publish pass', () => {
  it('is the SAME gate the publish operation uses, so the button cannot lie', () => {
    const fabricated: SiteClaim = {
      key: 'body',
      text: 'בווילה בריכה מחוממת.',
      source: 'property',
      sourceId: null,
      sourceField: 'description',
      sourceValue: null,
    }

    const findings = runQualityPass(
      'pre_publish',
      input({ sections: [section({ claims: [fabricated] })] }),
    )

    expect(findings[0].checkCode).toBe('pre_publish.claim_unsourced')
    expect(blocksPublish(findings)).toBe(true)
  })

  it('blocks a site with no live page at all', () => {
    const findings = runQualityPass(
      'pre_publish',
      input({ pages: [page({ isActive: false })], sections: [] }),
    )

    expect(
      findings.some((f) => f.checkCode === 'pre_publish.no_live_page'),
    ).toBe(true)
    expect(blocksPublish(findings)).toBe(true)
  })

  it('is clean for a sound draft', () => {
    expect(blocksPublish(runQualityPass('pre_publish', input()))).toBe(false)
  })
})

describe('a decision a person made', () => {
  it('stops blocking once the finding is accepted', () => {
    // A tool that re-blocks somebody who read a warning and decided to publish
    // is a tool that does not believe them.
    const accepted = runQualityPass('pre_publish', input()).map((finding) => ({
      ...finding,
      severity: 'blocker' as const,
      status: 'accepted' as const,
    }))

    expect(blocksPublish(accepted)).toBe(false)
  })
})
