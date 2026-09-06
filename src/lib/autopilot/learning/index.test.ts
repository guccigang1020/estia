/**
 * The barrel, and the one promise it must keep at the boundary.
 *
 * A module whose central rule is "learning proposes and never adopts" should
 * not export anything that adopts. This asserts that from outside — what a
 * consumer of `@/lib/autopilot/learning` can actually reach — rather than from
 * inside, where every file can see every other file's intent.
 */

import { describe, expect, it } from 'vitest'

import * as learning from './index'

describe('the public surface', () => {
  it('offers the pipeline a caller needs end to end', () => {
    expect(typeof learning.detectPatterns).toBe('function')
    expect(typeof learning.screenPatterns).toBe('function')
    expect(typeof learning.proposeFromPatterns).toBe('function')
    expect(typeof learning.dampingFor).toBe('function')
    expect(typeof learning.rememberPreference).toBe('function')
    expect(typeof learning.buildValueReport).toBe('function')
    expect(typeof learning.SupabaseLearningRepository).toBe('function')
  })

  it('exports no way to adopt a candidate without a decision', () => {
    // `prepareDecision` is the only route to `adopted`, and it refuses without
    // a named person. There is no `adopt`, no `applyCandidate`, no
    // `writePolicy` — the vocabulary itself does not contain one.
    const names = Object.keys(learning).map((name) => name.toLowerCase())

    for (const forbidden of [
      'adopt',
      'applyrule',
      'writepolicy',
      'setpolicy',
    ]) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false)
    }
  })

  it('allows exactly one writable table', () => {
    expect(learning.LEARNING_WRITABLE_TABLES).toEqual([
      'autopilot_rule_candidates',
    ])
  })

  it('runs the whole pipeline over a history without a database', () => {
    const window = { from: '2026-06-01', to: '2026-08-31' }
    const history = {
      ...learning.emptyHistory(window),
      laundryChoices: Array.from({ length: 13 }, (_, i) => ({
        orderId: `order-${i}`,
        propertyId: 'property-a',
        providerId: i < 11 ? 'provider-b' : 'provider-a',
        providerLabel: i < 11 ? 'מכבסת הגליל' : 'מכבסת המרכז',
        defaultProviderId: 'provider-a',
        occurredOn: new Date(Date.UTC(2026, 5, 1 + i * 6))
          .toISOString()
          .slice(0, 10),
      })),
    }

    const result = learning.proposeFromPatterns({
      organizationId: 'org-a',
      patterns: learning.detectPatterns(history),
      now: new Date('2026-09-01T09:00:00.000Z'),
    })

    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].state).toBe('proposed')
    expect(result.proposals[0].proposal.occurrences).toBe(11)
    expect(result.refusals).toHaveLength(0)
  })
})
