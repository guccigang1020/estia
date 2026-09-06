/**
 * The two refusals that stop a damage case being tidied away instead of
 * settled, plus the third that stops money closing without a decision.
 *
 * Every case in this file is one that has actually happened to somebody: the
 * vendor who never quoted, the guest who never replied, and the ₪1,400 worktop
 * that got closed during a spring clean of the register.
 */

import { describe, expect, it } from 'vitest'

import type { CaseQuestion } from './types'
import {
  CASE_TRANSITIONS,
  availableTransitions,
  checkTransition,
  daysInState,
  isWaitingOnSomebody,
  statusLabel,
  type CaseFacts,
} from './workflow'

const AT = new Date('2026-04-02T08:00:00.000Z')

function question(overrides: Partial<CaseQuestion> = {}): CaseQuestion {
  return {
    id: 'q-1',
    caseId: 'case-1',
    audience: 'guest',
    question: 'האם השיש היה שרוט כשנכנסת?',
    askedAt: AT,
    askedByUserId: 'user-1',
    answeredAt: null,
    answer: null,
    ...overrides,
  }
}

function facts(overrides: Partial<CaseFacts> = {}): CaseFacts {
  return {
    status: 'investigating',
    questions: [],
    hasLiabilityDecision: false,
    recordedCostAgorot: 0,
    ...overrides,
  }
}

describe('a case awaiting a vendor', () => {
  it('cannot silently resolve itself', () => {
    const result = checkTransition(
      facts({ status: 'awaiting_vendor' }),
      'resolved',
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.refusal).toBe('vendor_outstanding')
    // The sentence has to explain the rule, not merely refuse: somebody who
    // reads "not allowed" concludes the product is broken.
    expect(result.ok === false && result.message).toContain('ממתין לספק')
  })

  it('has no such edge in the table at all', () => {
    expect(CASE_TRANSITIONS.awaiting_vendor).not.toContain('resolved')
    expect(CASE_TRANSITIONS.awaiting_vendor).toContain('investigating')
  })

  it('resolves once a person says the wait is over', () => {
    // Back through `investigating`, which is a named act in the audit trail
    // rather than a case that aged out of its own waiting state.
    const back = checkTransition(
      facts({ status: 'awaiting_vendor' }),
      'investigating',
    )
    expect(back.ok).toBe(true)
    expect(
      checkTransition(facts({ status: 'investigating' }), 'resolved').ok,
    ).toBe(true)
  })
})

describe('closing a case', () => {
  it('is refused while a question is outstanding', () => {
    const result = checkTransition(
      facts({ status: 'resolved', questions: [question()] }),
      'closed',
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.refusal).toBe('unanswered_question')
    // The blocking questions come back, so the screen lists them rather than
    // leaving somebody to hunt for which one it meant.
    expect(result.ok === false && result.blocking).toHaveLength(1)
  })

  it('is refused when a half-answered question is the only thing left', () => {
    const half = question({ answeredAt: AT, answer: null })
    const result = checkTransition(
      facts({ status: 'resolved', questions: [half] }),
      'closed',
    )
    expect(result.ok).toBe(false)
  })

  it('is allowed once every question has both a time and an answer', () => {
    const answered = question({ answeredAt: AT, answer: 'כן, זה היה שם' })
    expect(
      checkTransition(
        facts({ status: 'resolved', questions: [answered] }),
        'closed',
      ).ok,
    ).toBe(true)
  })

  it('is refused when money was recorded and nobody decided', () => {
    const result = checkTransition(
      facts({ status: 'resolved', recordedCostAgorot: 140_000 }),
      'closed',
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.refusal).toBe('money_without_decision')
  })

  it('is allowed when the money has a decision behind it', () => {
    expect(
      checkTransition(
        facts({
          status: 'resolved',
          recordedCostAgorot: 140_000,
          hasLiabilityDecision: true,
        }),
        'closed',
      ).ok,
    ).toBe(true)
  })

  it('is allowed with no money and no decision — most cases cost nothing', () => {
    expect(checkTransition(facts({ status: 'resolved' }), 'closed').ok).toBe(
      true,
    )
  })
})

describe('a closed case', () => {
  it('goes nowhere', () => {
    expect(CASE_TRANSITIONS.closed).toEqual([])
    const result = checkTransition(facts({ status: 'closed' }), 'investigating')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.refusal).toBe('terminal')
  })
})

describe('what a screen may offer', () => {
  it('is derived from the same decision the operation makes', () => {
    // One state machine. A button the operation would refuse is never drawn,
    // and the two cannot drift because there is only one function.
    const blocked = facts({ status: 'resolved', questions: [question()] })
    expect(availableTransitions(blocked)).not.toContain('closed')
    expect(availableTransitions(blocked)).toContain('investigating')
  })

  it('offers nothing at all once the case is closed', () => {
    expect(availableTransitions(facts({ status: 'closed' }))).toEqual([])
  })
})

describe('reading the register', () => {
  it('knows which states mean somebody outside owes an answer', () => {
    expect(isWaitingOnSomebody('awaiting_vendor')).toBe(true)
    expect(isWaitingOnSomebody('investigating')).toBe(false)
  })

  it('floors the wait rather than rounding it up', () => {
    const since = new Date('2026-04-01T08:00:00Z')
    expect(daysInState(since, new Date('2026-04-03T07:00:00Z'))).toBe(1)
    expect(daysInState(since, new Date('2026-04-01T07:00:00Z'))).toBe(0)
  })

  it('never hands a screen an untranslated identifier', () => {
    expect(statusLabel('awaiting_vendor')).toBe('ממתין לספק')
  })
})
