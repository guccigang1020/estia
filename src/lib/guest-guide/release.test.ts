/**
 * The disclosure rules, tested from the side that matters: a secret is absent
 * before its conditions pass and present after, and nothing in between shows
 * it by halves.
 */

import { describe, expect, it } from 'vitest'

import {
  PAST_ARGUMENT_STATUSES,
  discloseSecrets,
  isJourneyMode,
  noEligibility,
  releaseCondition,
  releaseGuide,
  releaseMet,
  type GuideEligibility,
} from './release'
import {
  GUIDE_RELEASE_MODES,
  JOURNEY_RELEASE_MODES,
  type GuideEntry,
  type GuideReleaseRule,
  type GuideSecret,
} from './types'

const NOW = new Date('2026-09-06T10:00:00.000Z')

function entry(overrides: Partial<GuideEntry> = {}): GuideEntry {
  return {
    id: 'entry-1',
    organizationId: 'org-1',
    propertyId: 'prop-1',
    stage: 'during_stay',
    topic: 'access',
    title: { he: 'כניסה לנכס' },
    body: { he: 'הקוד בתיבה שליד הדלת.' },
    icon: 'key',
    link: null,
    media: [],
    sortOrder: 0,
    isActive: true,
    hasSecret: false,
    release: { mode: 'immediate', hours: 24 },
    version: 1,
    ...overrides,
  }
}

function secret(entryId: string): GuideSecret {
  return {
    entryId,
    organizationId: 'org-1',
    propertyId: 'prop-1',
    value: { he: '4821#' },
    version: 1,
  }
}

describe('the vocabulary is the database vocabulary', () => {
  it('starts with public.guest_arrival_release, in order', () => {
    expect(GUIDE_RELEASE_MODES.slice(0, JOURNEY_RELEASE_MODES.length)).toEqual([
      ...JOURNEY_RELEASE_MODES,
    ])
  })

  it('adds exactly one mode the journey enum does not have', () => {
    const extra = GUIDE_RELEASE_MODES.filter((mode) => !isJourneyMode(mode))
    expect(extra).toEqual(['after_check_in'])
  })

  it('names the same past-argument statuses guest_arrival_released does', () => {
    expect(PAST_ARGUMENT_STATUSES).toEqual([
      'checked_in',
      'in_house',
      'checkout_pending',
      'checked_out',
      'inspection',
      'deposit_release',
      'completed',
      'review_requested',
    ])
  })
})

describe('a sensitive entry before and after its conditions pass', () => {
  const sensitive = entry({
    id: 'door-code',
    hasSecret: true,
    release: { mode: 'after_deposit', hours: 24 },
  })

  it('is absent from the visible set before the deposit settles', () => {
    const disclosure = releaseGuide({
      entries: [sensitive],
      eligibility: noEligibility(),
      now: NOW,
    })

    expect(disclosure.visible).toEqual([])
    expect(disclosure.withheld).toEqual([
      {
        entryId: 'door-code',
        stage: 'during_stay',
        topic: 'access',
        hasSecret: true,
        reason: 'awaiting_deposit',
      },
    ])
  })

  it('discloses no secret while the entry is withheld', () => {
    const disclosure = releaseGuide({
      entries: [sensitive],
      eligibility: noEligibility(),
      now: NOW,
    })

    expect(
      discloseSecrets({ disclosure, secrets: [secret('door-code')] }),
    ).toEqual([])
  })

  it('is present once the deposit settles, and the secret follows', () => {
    const eligibility: GuideEligibility = {
      ...noEligibility(),
      depositSettled: true,
    }
    const disclosure = releaseGuide({
      entries: [sensitive],
      eligibility,
      now: NOW,
    })

    expect(disclosure.visible.map((item) => item.id)).toEqual(['door-code'])
    expect(disclosure.withheld).toEqual([])
    expect(
      discloseSecrets({ disclosure, secrets: [secret('door-code')] }),
    ).toEqual([{ entryId: 'door-code', value: { he: '4821#' } }])
  })

  it('never carries the secret on the entry itself', () => {
    const disclosure = releaseGuide({
      entries: [sensitive],
      eligibility: { ...noEligibility(), depositSettled: true },
      now: NOW,
    })

    // The structural claim, asserted rather than assumed: whatever a bug in
    // this module does, the visible entry is a `GuideEntry` and there is
    // nowhere on it for a code to be.
    const serialised = JSON.stringify(disclosure.visible)
    expect(serialised).not.toContain('4821#')
    expect(Object.keys(disclosure.visible[0])).not.toContain('secret')
  })
})

describe('the conditions', () => {
  const cases: readonly {
    rule: GuideReleaseRule
    passing: Partial<GuideEligibility>
  }[] = [
    { rule: { mode: 'immediate', hours: 24 }, passing: {} },
    {
      rule: { mode: 'after_confirmation', hours: 24 },
      passing: { confirmed: true },
    },
    {
      rule: { mode: 'after_contract', hours: 24 },
      passing: { contractSigned: true },
    },
    {
      rule: { mode: 'after_deposit', hours: 24 },
      passing: { depositSettled: true },
    },
    {
      rule: { mode: 'after_full_payment', hours: 24 },
      passing: { paidInFull: true },
    },
    {
      rule: { mode: 'after_check_in', hours: 24 },
      passing: { bookingStatus: 'in_house' },
    },
    {
      rule: { mode: 'manual', hours: 24 },
      passing: { manuallyReleased: true },
    },
  ]

  for (const { rule, passing } of cases) {
    it(`${rule.mode} is met only by its own condition`, () => {
      expect(releaseMet(rule, noEligibility(), NOW)).toBe(
        rule.mode === 'immediate',
      )
      expect(releaseMet(rule, { ...noEligibility(), ...passing }, NOW)).toBe(
        true,
      )
    })
  }

  it('hours_before withholds when there is no check-in time at all', () => {
    const rule: GuideReleaseRule = { mode: 'hours_before', hours: 24 }
    expect(releaseMet(rule, noEligibility(), NOW)).toBe(false)
  })

  it('after_check_in reads the clock, not the button', () => {
    // A guest whose stay started at 15:00 and whom nobody at the desk has got
    // round to checking in has begun their stay.
    const rule: GuideReleaseRule = { mode: 'after_check_in', hours: 24 }
    const started = new Date('2026-09-06T09:00:00.000Z')
    const notYet = new Date('2026-09-06T15:00:00.000Z')

    expect(
      releaseMet(rule, { ...noEligibility(), checkInAt: started }, NOW),
    ).toBe(true)
    expect(
      releaseMet(rule, { ...noEligibility(), checkInAt: notYet }, NOW),
    ).toBe(false)
    expect(releaseMet(rule, noEligibility(), NOW)).toBe(false)
  })

  it('hours_before opens exactly its window before check-in', () => {
    const rule: GuideReleaseRule = { mode: 'hours_before', hours: 24 }
    const checkInAt = new Date('2026-09-07T11:00:00.000Z')

    expect(releaseMet(rule, { ...noEligibility(), checkInAt }, NOW)).toBe(false)
    expect(
      releaseMet(
        rule,
        { ...noEligibility(), checkInAt },
        new Date('2026-09-06T11:00:00.000Z'),
      ),
    ).toBe(true)
  })

  it('a manual release wins on every mode', () => {
    for (const mode of GUIDE_RELEASE_MODES) {
      expect(
        releaseMet(
          { mode, hours: 24 },
          { ...noEligibility(), manuallyReleased: true },
          NOW,
        ),
      ).toBe(true)
    }
  })

  it('a guest already in the house is past the argument', () => {
    for (const status of PAST_ARGUMENT_STATUSES) {
      expect(
        releaseMet(
          { mode: 'after_full_payment', hours: 24 },
          noEligibility(status),
          NOW,
        ),
      ).toBe(true)
    }
  })
})

describe('the rest of the disclosure', () => {
  it('withholds an inactive entry with its own reason', () => {
    const disclosure = releaseGuide({
      entries: [entry({ isActive: false })],
      eligibility: noEligibility(),
      now: NOW,
    })

    expect(disclosure.visible).toEqual([])
    expect(disclosure.withheld[0].reason).toBe('inactive')
  })

  it('orders the visible entries by stage then by the operator’s order', () => {
    const disclosure = releaseGuide({
      entries: [
        entry({ id: 'c', stage: 'after_checkout', topic: 'checkout' }),
        entry({ id: 'b', stage: 'during_stay', sortOrder: 5 }),
        entry({ id: 'a', stage: 'before_arrival', topic: 'directions' }),
        entry({ id: 'b0', stage: 'during_stay', sortOrder: 1 }),
      ],
      eligibility: noEligibility(),
      now: NOW,
    })

    expect(disclosure.visible.map((item) => item.id)).toEqual([
      'a',
      'b0',
      'b',
      'c',
    ])
  })

  it('drops a secret whose entry was never in the disclosure', () => {
    const disclosure = releaseGuide({
      entries: [entry({ id: 'open' })],
      eligibility: noEligibility(),
      now: NOW,
    })

    expect(
      discloseSecrets({ disclosure, secrets: [secret('some-other-entry')] }),
    ).toEqual([])
  })

  it('describes a rule for the operator without inventing a stay', () => {
    expect(releaseCondition({ mode: 'hours_before', hours: 6 })).toEqual({
      mode: 'hours_before',
      hours: 6,
    })
    expect(releaseCondition({ mode: 'after_deposit', hours: 6 })).toEqual({
      mode: 'after_deposit',
      hours: null,
    })
  })
})
