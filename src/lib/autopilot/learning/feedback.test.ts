/**
 * What feedback may change, and the one thing it may never touch.
 *
 * The central assertion is the last describe block: a safety alert is not
 * damped by any amount of dismissal. Everything above it establishes that
 * ordinary damping works, so that the safety case is a demonstrated exception
 * and not a test that would pass because nothing damps anything.
 */

import { describe, expect, it } from 'vitest'

import {
  countDismissals,
  dampingFor,
  shouldRaise,
  QUIET_AT_DISMISSALS,
  VERDICT_WEIGHT,
  type FeedbackRecord,
} from './feedback'

function said(
  verdict: FeedbackRecord['verdict'],
  times: number,
  targetKey = 'laundry_provider.provider_b',
): FeedbackRecord[] {
  return Array.from({ length: times }, (_, i) => ({
    targetKey,
    verdict,
    givenBy: 'user-dana',
    givenAt: `2026-09-0${i + 1}T09:00:00.000Z`,
  }))
}

const ORDINARY = {
  key: 'laundry_provider.provider_b',
  domain: 'laundry',
} as const

describe('counting dismissals', () => {
  it('weights a wrong answer more heavily than an unwanted one', () => {
    expect(VERDICT_WEIGHT.wrong).toBeGreaterThan(VERDICT_WEIGHT.not_helpful)
  })

  it('lets a helpful verdict undo an old dismissal', () => {
    const feedback = [...said('not_helpful', 2), ...said('helpful', 1)]
    expect(countDismissals(feedback, ORDINARY.key)).toBe(1)
  })

  it('never goes below zero', () => {
    expect(countDismissals(said('helpful', 5), ORDINARY.key)).toBe(0)
  })

  it('counts only the target it was asked about', () => {
    const feedback = said('wrong', 3, 'some_other.pattern')
    expect(countDismissals(feedback, ORDINARY.key)).toBe(0)
  })
})

describe('an ordinary suggestion', () => {
  it('is raised every time when nobody has objected', () => {
    const damping = dampingFor(ORDINARY, [])

    expect(damping.raiseEvery).toBe(1)
    expect(damping.quiet).toBe(false)
    expect(shouldRaise(damping, 1)).toBe(true)
  })

  it('is raised less often after one dismissal', () => {
    const damping = dampingFor(ORDINARY, said('not_helpful', 1))

    expect(damping.raiseEvery).toBeGreaterThan(1)
    expect(damping.quiet).toBe(false)
    expect(shouldRaise(damping, 1)).toBe(false)
    expect(shouldRaise(damping, 2)).toBe(true)
  })

  it('goes quiet after repeated dismissal, and says why', () => {
    const damping = dampingFor(
      ORDINARY,
      said('not_helpful', QUIET_AT_DISMISSALS),
    )

    expect(damping.quiet).toBe(true)
    expect(shouldRaise(damping, 100)).toBe(false)
    expect(damping.explanation).toContain(String(QUIET_AT_DISMISSALS))
  })

  it('reports the count behind the decision', () => {
    expect(dampingFor(ORDINARY, said('wrong', 1)).dismissals).toBe(2)
  })
})

describe('a safety alert', () => {
  const SAFETY = { key: 'safety.guest_locked_out', domain: 'safety' } as const

  it('is never damped, however many times it is dismissed', () => {
    // Twenty dismissals. Somebody who dismissed the first nineteen because
    // they resolved themselves has not said the twentieth does not matter.
    const damping = dampingFor(SAFETY, said('wrong', 20, SAFETY.key))

    expect(damping.exempt).toBe(true)
    expect(damping.raiseEvery).toBe(1)
    expect(damping.quiet).toBe(false)
    expect(shouldRaise(damping, 1)).toBe(true)
    expect(shouldRaise(damping, 7)).toBe(true)
  })

  it('still counts the dismissals, so a manager can see them', () => {
    const damping = dampingFor(SAFETY, said('not_helpful', 4, SAFETY.key))

    expect(damping.dismissals).toBe(4)
    expect(damping.quiet).toBe(false)
  })

  it('exempts a critical alert in any domain when the caller marks it', () => {
    const damping = dampingFor(
      {
        key: 'guest_access.no_code',
        domain: 'guest_access',
        criticalAlert: true,
      },
      said('wrong', 10, 'guest_access.no_code'),
    )

    expect(damping.exempt).toBe(true)
    expect(damping.quiet).toBe(false)
    expect(damping.raiseEvery).toBe(1)
  })

  it('damps the same domain when the alert is not marked critical', () => {
    // The exemption is a decision the caller makes from the signal it holds,
    // not something this module guesses from a domain name.
    const damping = dampingFor(
      { key: 'guest_access.no_code', domain: 'guest_access' },
      said('wrong', 10, 'guest_access.no_code'),
    )

    expect(damping.exempt).toBe(false)
    expect(damping.quiet).toBe(true)
  })
})
