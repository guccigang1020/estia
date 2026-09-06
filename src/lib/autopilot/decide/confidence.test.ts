/**
 * Confidence, and the one line it must never cross.
 *
 * The first test in this file is the point of the file: a shortage computed by
 * arithmetic over recorded stock is `high`, and no amount of hedging turns it
 * into "probably six towels". The rest establishes the ceiling — an estimate
 * anywhere under the reasoning caps the answer at `medium`, and nothing
 * measured at all is `low`.
 */

import { describe, expect, it } from 'vitest'

import { AUTOPILOT_CONFIDENCE_LEVELS } from '../../contracts/states'
import type { Evidence } from '../types'

import {
  atMost,
  confidenceFor,
  isAtLeast,
  isEstimatedEvidence,
} from './confidence'

/* ------------------------------------------------------------- fixtures -- */

function evidence(over: Partial<Evidence> & { key: string }): Evidence {
  return {
    label: 'עובדה',
    value: 6,
    source: 'inventory',
    ...over,
  }
}

const COUNTED: Evidence = evidence({
  key: 'stock.on_hand',
  label: 'מלאי נוכחי',
  value: 4,
  source: 'inventory',
})

const REQUIRED: Evidence = evidence({
  key: 'requirement.towels',
  label: 'נדרש להכנה',
  value: 10,
  source: 'preparation',
})

const PROJECTED: Evidence = evidence({
  key: 'stock.projected',
  label: 'מלאי צפוי',
  value: 4,
  source: 'inventory',
})

/* ---------------------------------------------------------------- tests -- */

describe('facts are not judgments', () => {
  it('is high when the reasoning rests only on recorded facts', () => {
    expect(confidenceFor({ evidence: [COUNTED, REQUIRED] })).toBe('high')
  })

  it('is medium as soon as one fact is a projection', () => {
    expect(confidenceFor({ evidence: [PROJECTED, REQUIRED] })).toBe('medium')
  })

  it('is medium when the remedy is a guess, however solid the facts', () => {
    expect(
      confidenceFor({
        evidence: [COUNTED, REQUIRED],
        remedyRestsOnEstimate: true,
      }),
    ).toBe('medium')
  })
})

describe('low', () => {
  it('is low when there is no evidence at all', () => {
    expect(confidenceFor({ evidence: [] })).toBe('low')
  })

  it('is low when every fact was asked for and came back null', () => {
    const unanswered = evidence({ key: 'cleaner.started_at', value: null })
    expect(confidenceFor({ evidence: [unanswered] })).toBe('low')
  })

  it('is low when something that mattered could not be observed', () => {
    expect(
      confidenceFor({
        evidence: [COUNTED, REQUIRED],
        unobserved: ['cleaner.location'],
      }),
    ).toBe('low')
  })

  it('does not count a null value towards being measured', () => {
    const unanswered = evidence({ key: 'provider.confirmed', value: null })
    expect(confidenceFor({ evidence: [unanswered, COUNTED] })).toBe('high')
    expect(confidenceFor({ evidence: [unanswered, PROJECTED] })).toBe('medium')
  })
})

describe('recognising an estimate', () => {
  it('reads the segments of a key, not a substring of it', () => {
    expect(isEstimatedEvidence(evidence({ key: 'duration.typical' }))).toBe(
      true,
    )
    expect(isEstimatedEvidence(evidence({ key: 'usage.predicted' }))).toBe(true)
    expect(isEstimatedEvidence(evidence({ key: 'stock.projected' }))).toBe(true)

    // A recorded fact whose name merely contains an estimate word.
    expect(
      isEstimatedEvidence(evidence({ key: 'desk.expectedly_named' })),
    ).toBe(false)
  })

  it('treats a whole predicting engine as estimating', () => {
    expect(
      isEstimatedEvidence(
        evidence({ key: 'arrivals.count', source: 'forecast' }),
      ),
    ).toBe(true)
    expect(
      isEstimatedEvidence(
        evidence({ key: 'arrivals.count', source: 'bookings' }),
      ),
    ).toBe(false)
  })

  it('believes a caller that declares a key an estimate', () => {
    const odd = evidence({ key: 'towels.number' })

    expect(isEstimatedEvidence(odd)).toBe(false)
    expect(isEstimatedEvidence(odd, ['towels.number'])).toBe(true)
    expect(
      confidenceFor({ evidence: [odd], estimatedKeys: ['towels.number'] }),
    ).toBe('medium')
  })
})

describe('the ladder', () => {
  it('reads its order from AUTOPILOT_CONFIDENCE_LEVELS', () => {
    const [lowest] = AUTOPILOT_CONFIDENCE_LEVELS
    const highest =
      AUTOPILOT_CONFIDENCE_LEVELS[AUTOPILOT_CONFIDENCE_LEVELS.length - 1]

    expect(atMost(highest, lowest)).toBe(lowest)
    expect(atMost(lowest, highest)).toBe(lowest)
    expect(isAtLeast(highest, lowest)).toBe(true)
    expect(isAtLeast(lowest, highest)).toBe(false)
  })

  it('is a ceiling, so the same level passes through unchanged', () => {
    expect(atMost('medium', 'medium')).toBe('medium')
    expect(isAtLeast('medium', 'medium')).toBe(true)
  })
})
