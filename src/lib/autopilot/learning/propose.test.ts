/**
 * What may be proposed, and what may never be adopted.
 *
 * The first block is the module's central promise: nothing this file can
 * produce is an adopted rule, and adoption without a named person is refused
 * before it reaches a database that would refuse it again.
 *
 * The rest is about noise. A suggestion built from four occurrences in a year
 * is not a small suggestion, it is a wrong one — and the cost is not the
 * screen space, it is that the next twenty proposals get skimmed.
 */

import { describe, expect, it } from 'vitest'

import { AUTOPILOT_RULE_CANDIDATE_STATES } from '../../contracts/states'

import {
  DEFAULT_THRESHOLDS,
  MissingDeciderError,
  SUBJECT_DOMAIN,
  describePeriod,
  draftFromPattern,
  prepareDecision,
  proposeFromPatterns,
  windowDays,
} from './propose'
import { DAMPING_EXEMPT_DOMAINS, type FeedbackRecord } from './feedback'
import type { ObservedPattern } from './patterns'

const NOW = new Date('2026-09-01T09:00:00.000Z')

function pattern(overrides: Partial<ObservedPattern> = {}): ObservedPattern {
  return {
    patternCode: 'laundry_provider.provider_b',
    subject: 'laundry_provider',
    propertyId: 'property-a',
    occurrences: 11,
    opportunities: 13,
    observedFrom: '2026-06-01',
    observedTo: '2026-08-31',
    sample: [
      { reference: 'order-1', label: 'הזמנה 1', occurredOn: '2026-06-04' },
    ],
    observation: 'ההזמנות נשלחו למכבסת הגליל ב-11 מתוך 13 פעמים.',
    suggestion: {
      module: 'laundry',
      statement: 'להגדיר את מכבסת הגליל כספק ברירת המחדל.',
      expectedImpact: 'מקצר את פתיחת ההזמנה.',
      parameters: { providerId: 'provider-b' },
      actionKind: 'laundry.draft_order',
    },
    ...overrides,
  }
}

describe('a proposal is never an adoption', () => {
  it('cannot be drafted in any state but proposed', () => {
    const draft = draftFromPattern('org-a', pattern())
    expect(draft.state).toBe('proposed')

    // And the states this module cannot express are real states elsewhere —
    // so the restriction is a choice made here, not an absence in the schema.
    expect(AUTOPILOT_RULE_CANDIDATE_STATES).toContain('adopted')
  })

  it('produces no adopted candidate from any pattern', () => {
    const result = proposeFromPatterns({
      organizationId: 'org-a',
      patterns: [pattern(), pattern({ patternCode: 'cleaner_choice.dana' })],
      now: NOW,
    })

    for (const proposal of result.proposals) {
      expect(proposal.state).toBe('proposed')
    }
  })

  it('refuses adoption with no named person', () => {
    expect(() =>
      prepareDecision({
        state: 'adopted',
        decidedBy: '   ',
        decidedAt: NOW.toISOString(),
      }),
    ).toThrow(MissingDeciderError)
  })

  it('refuses adoption with no time', () => {
    expect(() =>
      prepareDecision({
        state: 'adopted',
        decidedBy: 'user-dana',
        decidedAt: 'sometime last week',
      }),
    ).toThrow(MissingDeciderError)
  })

  it('refuses rejection with no named person either', () => {
    // Refusing somebody's habit is also a decision they have to have made.
    expect(() =>
      prepareDecision({
        state: 'rejected',
        decidedBy: '',
        decidedAt: NOW.toISOString(),
      }),
    ).toThrow(MissingDeciderError)
  })

  it('accepts a decision that names both', () => {
    const prepared = prepareDecision({
      state: 'adopted',
      decidedBy: 'user-dana',
      decidedAt: '2026-09-01T09:00:00Z',
    })

    expect(prepared.state).toBe('adopted')
    expect(prepared.decidedBy).toBe('user-dana')
    expect(prepared.decidedAt).toBe(NOW.toISOString())
  })

  it('lets a mute carry no decider, because it is not a decision', () => {
    const prepared = prepareDecision({ state: 'muted' })

    expect(prepared.decidedBy).toBeNull()
    expect(prepared.decidedAt).toBeNull()
  })
})

describe('the proposal a manager reads', () => {
  it('carries the five things the brief requires', () => {
    const [proposal] = proposeFromPatterns({
      organizationId: 'org-a',
      patterns: [pattern()],
      now: NOW,
    }).proposals

    expect(proposal.proposal.observed.length).toBeGreaterThan(0)
    expect(proposal.proposal.occurrences).toBe(11)
    expect(proposal.proposal.period).toContain('2026-06-01')
    expect(proposal.proposal.suggestedRule.length).toBeGreaterThan(0)
    expect(proposal.proposal.expectedImpact.length).toBeGreaterThan(0)
  })

  it('states the denominator alongside the rate', () => {
    const [proposal] = proposeFromPatterns({
      organizationId: 'org-a',
      patterns: [pattern()],
      now: NOW,
    }).proposals

    expect(proposal.proposal.opportunities).toBe(13)
    expect(proposal.proposal.rate).toBe('85%')
  })

  it('carries a sample and a non-blank summary the database will accept', () => {
    const draft = draftFromPattern('org-a', pattern())

    expect(draft.summary.trim().length).toBeGreaterThan(0)
    expect(draft.sample).toHaveLength(1)
  })
})

describe('noise is withheld, and the silence is explained', () => {
  it('withholds four occurrences in a year', () => {
    const result = proposeFromPatterns({
      organizationId: 'org-a',
      patterns: [
        pattern({
          occurrences: 4,
          opportunities: 60,
          observedFrom: '2025-09-01',
          observedTo: '2026-08-31',
        }),
      ],
      now: NOW,
    })

    expect(result.proposals).toHaveLength(0)
    expect(result.withheld[0].reason).toBe('below_occurrence_floor')
    expect(result.withheld[0].explanation).toContain(
      String(DEFAULT_THRESHOLDS.minOccurrences),
    )
  })

  it('withholds a behaviour that is frequent but not the usual choice', () => {
    const result = proposeFromPatterns({
      organizationId: 'org-a',
      patterns: [pattern({ occurrences: 10, opportunities: 100 })],
      now: NOW,
    })

    expect(result.withheld[0].reason).toBe('below_rate_floor')
  })

  it('withholds a window too short to tell a habit from a busy week', () => {
    const result = proposeFromPatterns({
      organizationId: 'org-a',
      patterns: [
        pattern({ observedFrom: '2026-08-20', observedTo: '2026-08-31' }),
      ],
      now: NOW,
    })

    expect(result.withheld[0].reason).toBe('window_too_short')
  })

  it('withholds a rate computed over too few chances', () => {
    const result = proposeFromPatterns({
      organizationId: 'org-a',
      patterns: [pattern({ occurrences: 6, opportunities: 6 })],
      now: NOW,
    })

    expect(result.withheld[0].reason).toBe('below_opportunity_floor')
  })
})

describe('boundaries come before the floors', () => {
  it('refuses a forbidden pattern rather than counting it', () => {
    const result = proposeFromPatterns({
      organizationId: 'org-a',
      patterns: [
        pattern({
          observation: 'אורחים לפי לאום מקבלים מכבסה אחרת.',
        }),
      ],
      now: NOW,
    })

    expect(result.proposals).toHaveLength(0)
    expect(result.withheld).toHaveLength(0)
    expect(result.refusals).toHaveLength(1)
    expect(result.refusals[0].boundary).toBe('personal_characteristic')
  })
})

describe('feedback damps a proposal', () => {
  it('withholds one that has been dismissed repeatedly', () => {
    const feedback: FeedbackRecord[] = Array.from({ length: 3 }, (_, i) => ({
      targetKey: 'laundry_provider.provider_b',
      verdict: 'not_helpful',
      givenBy: 'user-dana',
      givenAt: `2026-08-0${i + 1}T09:00:00.000Z`,
    }))

    const result = proposeFromPatterns({
      organizationId: 'org-a',
      patterns: [pattern()],
      feedback,
      now: NOW,
    })

    expect(result.proposals).toHaveLength(0)
    expect(result.withheld[0].reason).toBe('damped')
  })

  it('never lets a learned preference borrow the safety exemption', () => {
    // Learning produces operational preference and nothing else, so no
    // subject maps onto a domain that is exempt from damping.
    for (const domain of Object.values(SUBJECT_DOMAIN)) {
      expect(DAMPING_EXEMPT_DOMAINS).not.toContain(domain)
    }
  })
})

describe('the period a proposal quotes', () => {
  it('counts both ends of the window', () => {
    expect(windowDays('2026-06-01', '2026-06-01')).toBe(1)
    expect(windowDays('2026-06-01', '2026-06-30')).toBe(30)
  })

  it('reads as a person would say it', () => {
    expect(describePeriod('2026-06-01', '2026-08-31')).toContain('92')
  })
})
