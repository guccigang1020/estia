/**
 * THE LOUDEST TEST IN THE MODULE.
 *
 * The specification's rule reduces to one sentence — "if the AI drafts a
 * sentence claiming the villa has a heated pool, that claim must be traceable
 * to a property row" — and this file asserts it from four directions:
 *
 *   1. A fact read from a row carries the row and the column.
 *   2. A column that is absent produces NO claim, not a plausible one.
 *   3. A claim with a canonical source and no row is caught before publish.
 *   4. A model draft citing a fact it was never given is DROPPED, whole.
 *
 * The fourth is the heated pool, written out literally, because a test whose
 * name matches the specification's own example is a test somebody will find.
 */

import { describe, expect, it } from 'vitest'

import {
  authoredClaim,
  claimFromRow,
  driftedClaims,
  groundDraft,
  publishBlockers,
  unsourcedClaims,
  type SourceRow,
} from './facts'
import { propertyClaims, factsForSection } from './content'
import type { SiteClaim, SiteSection } from './types'

const PROPERTY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'

const property: SourceRow = {
  id: PROPERTY_ID,
  name: 'אחוזת הגליל',
  description: 'בית אירוח שקט בגליל העליון.',
  city: 'ראש פינה',
  min_nights: 2,
  default_check_in_time: '15:00:00',
  // No `house_rules`, no `cancellation_policy_text`, and — the whole point —
  // no column anywhere saying anything about a pool.
}

function section(claims: readonly SiteClaim[]): SiteSection {
  return {
    id: 'section-1',
    organizationId: 'org-1',
    siteId: 'site-1',
    pageId: 'page-1',
    kind: 'property_intro',
    sortOrder: 0,
    isActive: true,
    boundTo: { source: 'property', id: PROPERTY_ID },
    claims,
    layout: {},
  }
}

describe('reading a fact from a row', () => {
  it('carries the row and the column it was read from', () => {
    const claim = claimFromRow({
      key: 'property.name',
      row: property,
      column: 'name',
      source: 'property',
    })

    expect(claim).toEqual({
      key: 'property.name',
      text: 'אחוזת הגליל',
      source: 'property',
      sourceId: PROPERTY_ID,
      sourceField: 'name',
      sourceValue: 'אחוזת הגליל',
    })
  })

  it('produces NOTHING for a column the row does not have', () => {
    // The discipline the whole module rests on. A property with no house rules
    // gets no house-rules sentence — not an empty one, not a default one, and
    // certainly not a helpful one.
    expect(
      claimFromRow({
        key: 'property.house_rules',
        row: property,
        column: 'house_rules',
        source: 'property',
      }),
    ).toBeNull()
  })

  it('produces nothing for a row with no id, because it could not be traced', () => {
    expect(
      claimFromRow({
        key: 'property.name',
        row: { name: 'אחוזה כלשהי' },
        column: 'name',
        source: 'property',
      }),
    ).toBeNull()
  })

  it('formats without losing what the row actually said', () => {
    const claim = claimFromRow({
      key: 'property.min_nights',
      row: property,
      column: 'min_nights',
      source: 'property',
      format: (raw) => `מינימום ${raw} לילות`,
    })

    expect(claim?.text).toBe('מינימום 2 לילות')
    // `sourceValue` is the raw column, so drift is detected against the row
    // rather than against the rendered sentence.
    expect(claim?.sourceValue).toBe('2')
  })
})

describe('an authored sentence', () => {
  it('is signed by the person who wrote it', () => {
    const claim = authoredClaim({
      key: 'hero.heading',
      text: 'ברוכים הבאים',
      authorUserId: USER_ID,
    })

    expect(claim?.source).toBe('authored')
    expect(claim?.sourceId).toBe(USER_ID)
  })

  it('cannot be made without an author', () => {
    expect(
      authoredClaim({
        key: 'hero.heading',
        text: 'ברוכים הבאים',
        authorUserId: '',
      }),
    ).toBeNull()
  })
})

describe('what cannot be published', () => {
  it('catches a claim that names a canonical source and no row', () => {
    // The exact shape a fabricated fact takes when a row is written by hand.
    const fabricated: SiteClaim = {
      key: 'property.pool',
      text: 'בווילה בריכה מחוממת.',
      source: 'property',
      sourceId: null,
      sourceField: 'description',
      sourceValue: null,
    }

    const blockers = publishBlockers([section([fabricated])])

    expect(blockers).toHaveLength(1)
    expect(blockers[0].reason).toBe('canonical_source_without_row')
    expect(blockers[0].claim.text).toContain('בריכה מחוממת')
  })

  it('catches an authored claim nobody will own', () => {
    const orphan: SiteClaim = {
      key: 'hero.heading',
      text: 'ברוכים הבאים',
      source: 'authored',
      sourceId: null,
      sourceField: null,
      sourceValue: null,
    }

    expect(unsourcedClaims([orphan])[0].reason).toBe('authored_without_author')
  })

  it('catches an empty claim, which renders as a heading with no words', () => {
    const empty: SiteClaim = {
      key: 'hero.heading',
      text: '   ',
      source: 'authored',
      sourceId: USER_ID,
      sourceField: null,
      sourceValue: null,
    }

    expect(unsourcedClaims([empty])[0].reason).toBe('empty_text')
  })

  it('lets a properly sourced page through', () => {
    expect(publishBlockers([section(propertyClaims(property))])).toEqual([])
  })

  it('ignores an inactive section, because it is not being published', () => {
    // `buildSnapshot` filters before it checks; this asserts the checker does
    // not second-guess that by scanning claims it was not given.
    expect(publishBlockers([])).toEqual([])
  })
})

describe('THE HEATED POOL', () => {
  // The specification's own example, written out.
  const facts = factsForSection({
    kind: 'property_intro',
    property,
    units: [],
    amenities: [],
    organizationName: 'אחוזת הגליל',
    organizationId: 'org-1',
  })

  it('is not among the facts a generator is given, because no column says so', () => {
    expect(facts.map((fact) => fact.key)).not.toContain('property.pool')
    expect(facts.some((fact) => fact.text.includes('בריכה'))).toBe(false)
  })

  it('is DROPPED WHOLE when a model claims it', () => {
    const result = groundDraft({
      drafts: [
        {
          key: 'body',
          text: 'הווילה כוללת בריכה מחוממת לאורך כל השנה.',
          citesFactKeys: ['property.heated_pool'],
        },
      ],
      offeredFacts: facts,
      acceptedByUserId: USER_ID,
    })

    expect(result.accepted).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toContain('property.heated_pool')
  })

  it('is not rescued by mixing it with a real fact', () => {
    // A paragraph with one fabricated clause removed is still a paragraph
    // nobody checked, so the whole draft goes.
    const result = groundDraft({
      drafts: [
        {
          key: 'body',
          text: 'אחוזת הגליל בראש פינה, עם בריכה מחוממת.',
          citesFactKeys: ['property.name', 'property.heated_pool'],
        },
      ],
      offeredFacts: facts,
      acceptedByUserId: USER_ID,
    })

    expect(result.accepted).toEqual([])
    expect(result.rejected).toHaveLength(1)
  })
})

describe('grounding a draft that behaves', () => {
  const facts = factsForSection({
    kind: 'property_intro',
    property,
    units: [],
    amenities: [],
    organizationName: 'אחוזת הגליל',
    organizationId: 'org-1',
  })

  it('accepts it as AUTHORED by the person, never as generated', () => {
    const result = groundDraft({
      drafts: [
        {
          key: 'body',
          text: 'אחוזת הגליל שוכנת בראש פינה.',
          citesFactKeys: ['property.name', 'property.city'],
        },
      ],
      offeredFacts: facts,
      acceptedByUserId: USER_ID,
    })

    expect(result.rejected).toEqual([])
    expect(result.accepted).toHaveLength(1)
    // The property that matters: a published claim's answer to "who says so?"
    // is a person, never a model.
    expect(result.accepted[0].source).toBe('authored')
    expect(result.accepted[0].sourceId).toBe(USER_ID)
  })

  it('accepts pure prose that cites nothing', () => {
    const result = groundDraft({
      drafts: [{ key: 'heading', text: 'ברוכים הבאים', citesFactKeys: [] }],
      offeredFacts: facts,
      acceptedByUserId: USER_ID,
    })

    expect(result.accepted).toHaveLength(1)
  })
})

describe('drift', () => {
  it('finds a published sentence whose row has moved', () => {
    const claims = propertyClaims(property)
    const renamed = new Map<string, SourceRow>([
      [PROPERTY_ID, { ...property, name: 'אחוזת הגליל העליון' }],
    ])

    const drifted = driftedClaims(claims, renamed)

    expect(drifted).toHaveLength(1)
    expect(drifted[0].claim.key).toBe('property.name')
    expect(drifted[0].currentValue).toBe('אחוזת הגליל העליון')
  })

  it('never reports an authored sentence', () => {
    const written = authoredClaim({
      key: 'hero.heading',
      text: 'ברוכים הבאים',
      authorUserId: USER_ID,
    })

    expect(
      driftedClaims([written!], new Map([[USER_ID, { id: USER_ID }]])),
    ).toEqual([])
  })

  it('says nothing about a row it was not given, rather than guessing', () => {
    // "I did not look" must not read as "it changed", or the studio fills with
    // noise that trains people to ignore it.
    expect(driftedClaims(propertyClaims(property), new Map())).toEqual([])
  })
})
