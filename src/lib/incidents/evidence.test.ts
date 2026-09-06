/**
 * Evidence is a reference. The module stores no bytes.
 *
 * That is the claim this file exists to hold, and it is checked two ways: the
 * record has no field a file could be put in, and `checkEvidence` refuses the
 * three shapes a caller reaches for when they try anyway — a `data:` URI from
 * a browser's `FileReader`, a `blob:` URL that is worthless the moment it is
 * stored, and a bare base64 payload from a naive API client.
 */

import { describe, expect, it } from 'vitest'

import {
  EVIDENCE_KINDS,
  checkEvidence,
  looksLikeInlineBytes,
  pairComparisons,
  tallyEvidence,
  type CaseEvidence,
  type CaseEvidenceDraft,
} from './evidence'

const ORG = 'org-1'
const CASE = 'case-1'
const AT = new Date('2026-04-02T08:00:00.000Z')

function draft(overrides: Partial<CaseEvidenceDraft> = {}): CaseEvidenceDraft {
  return {
    organizationId: ORG,
    caseId: CASE,
    kind: 'after_photo',
    mediaRef: 'incidents/case-1/after-01.jpg',
    contentType: 'image/jpeg',
    byteSize: 244_113,
    statement: null,
    capturedAt: AT,
    source: 'staff',
    recordedByUserId: 'user-1',
    note: null,
    ...overrides,
  }
}

function evidence(overrides: Partial<CaseEvidence> = {}): CaseEvidence {
  return {
    id: 'ev-1',
    organizationId: ORG,
    caseId: CASE,
    kind: 'before_photo',
    mediaRef: 'incidents/case-1/before-01.jpg',
    contentType: 'image/jpeg',
    byteSize: 200_000,
    statement: null,
    capturedAt: AT,
    recordedAt: AT,
    source: 'staff',
    recordedByUserId: 'user-1',
    note: null,
    ...overrides,
  }
}

describe('the module stores no bytes', () => {
  it('has no field on the record a file could go in', () => {
    // The structural half of the rule. `site_media` and `payment_proofs` are
    // shaped the same way and for the same reason: an evidence row whose
    // content an ordinary UPDATE can rewrite is not evidence.
    const keys = Object.keys(evidence())
    for (const forbidden of ['data', 'bytes', 'base64', 'content', 'file']) {
      expect(keys).not.toContain(forbidden)
    }
    expect(keys).toContain('mediaRef')
  })

  it('refuses a data URI', () => {
    const result = checkEvidence(
      draft({ mediaRef: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ' }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain('inline_bytes')
  })

  it('refuses a blob URL, which is a pointer that dies with the tab', () => {
    const result = checkEvidence(
      draft({ mediaRef: 'blob:https://app.estia.co.il/9f1c-4a2b' }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain('inline_bytes')
  })

  it('refuses a bare base64 payload posted as a statement', () => {
    const payload = 'A'.repeat(600)
    const result = checkEvidence(
      draft({ kind: 'staff_statement', mediaRef: null, statement: payload }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain('inline_bytes')
  })

  it('accepts an ordinary storage key', () => {
    expect(checkEvidence(draft()).ok).toBe(true)
    expect(looksLikeInlineBytes('incidents/case-1/after-01.jpg')).toBe(false)
    expect(looksLikeInlineBytes('https://cdn.example.com/a/b/photo.jpg')).toBe(
      false,
    )
  })
})

describe('a reference plus its provenance', () => {
  it('refuses a photograph with nothing to point at', () => {
    const result = checkEvidence(draft({ mediaRef: null }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain(
      'media_kind_without_reference',
    )
  })

  it('refuses a statement with no words', () => {
    const result = checkEvidence(
      draft({ kind: 'guest_statement', mediaRef: null, statement: '   ' }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain(
      'statement_kind_without_text',
    )
  })

  it('refuses one row that is both a file and a statement', () => {
    // Two things a person weighs separately must be two rows, or the note
    // beside a photograph becomes indistinguishable from testimony.
    const result = checkEvidence(draft({ statement: 'הכיריים היו שרוטות' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain(
      'reference_and_statement',
    )
  })

  it('refuses a source outside the four that exist', () => {
    const result = checkEvidence(
      draft({ source: 'anonymous' as CaseEvidenceDraft['source'] }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problems).toContain('no_provenance')
  })

  it('accepts a timestamp, which points at a moment and not a file', () => {
    expect(
      checkEvidence(
        draft({ kind: 'timestamp', mediaRef: null, contentType: null }),
      ).ok,
    ).toBe(true)
  })
})

describe('pairing before and after', () => {
  it('pairs by capture time and leaves the odd one out unpaired', () => {
    const pairs = pairComparisons([
      evidence({ id: 'b1', capturedAt: new Date('2026-04-01T09:00:00Z') }),
      evidence({ id: 'b2', capturedAt: new Date('2026-04-01T09:05:00Z') }),
      evidence({
        id: 'a1',
        kind: 'after_photo',
        capturedAt: new Date('2026-04-05T11:00:00Z'),
      }),
    ])

    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.before.id).toBe('b1')
    expect(pairs[0]?.after.id).toBe('a1')
  })

  it('says nothing about what the pair shows', () => {
    // A pair is two files. Every conclusion lives in `liability.ts` with a
    // person's name on it.
    const pairs = pairComparisons([
      evidence({ id: 'b1' }),
      evidence({ id: 'a1', kind: 'after_photo' }),
    ])
    const keys = Object.keys(pairs[0] ?? {})
    expect(keys.sort()).toEqual(['after', 'before'])
  })
})

describe('the tally', () => {
  it('counts rather than scores', () => {
    const tally = tallyEvidence([
      evidence({ id: 'b1' }),
      evidence({ id: 'a1', kind: 'after_photo' }),
      evidence({
        id: 'g1',
        kind: 'guest_statement',
        source: 'guest',
        mediaRef: null,
        statement: 'זה היה ככה כשהגעתי',
      }),
    ])

    expect(tally.total).toBe(3)
    expect(tally.comparisons).toBe(1)
    expect(tally.fromGuest).toBe(1)
    expect(Object.keys(tally.byKind).sort()).toEqual([...EVIDENCE_KINDS].sort())

    // No score, no confidence, no verdict.
    for (const forbidden of ['score', 'confidence', 'strength', 'verdict']) {
      expect(Object.keys(tally)).not.toContain(forbidden)
    }
  })
})
