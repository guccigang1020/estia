/**
 * The vocabularies, and the one reading of a question that everything else
 * depends on.
 *
 * `isAnswered` looks trivial and is the hinge of `workflow.ts`: a case cannot
 * close over an unanswered question, so a bug that reads a half-filled row as
 * answered is a bug that closes disputes silently. It is tested against both
 * half-filled shapes, because both occur — a screen that stamps the time
 * before the text is saved, and a draft that has text and was never submitted.
 */

import { describe, expect, it } from 'vitest'

import {
  AWAITING_STATUSES,
  INCIDENT_CASE_STATUSES,
  INCIDENT_CASE_STATUS_LABEL,
  INCIDENT_CASE_TYPES,
  INCIDENT_CASE_TYPE_LABEL,
  INCIDENT_ORIGINS,
  INCIDENT_ORIGIN_LABEL,
  QUESTION_AUDIENCES,
  QUESTION_AUDIENCE_LABEL,
  SETTLED_CASE_STATUSES,
  isAnswered,
  isSettledCase,
  unansweredQuestions,
  type CaseQuestion,
} from './types'

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

describe('the vocabularies', () => {
  it('label every value, in Hebrew', () => {
    // A missing label is a screen printing `awaiting_vendor` to a guesthouse
    // owner. The Record type would catch a removal; this catches a value added
    // to the array and forgotten in the map at runtime.
    for (const value of INCIDENT_CASE_TYPES) {
      expect(INCIDENT_CASE_TYPE_LABEL[value]).toBeTruthy()
    }
    for (const value of INCIDENT_CASE_STATUSES) {
      expect(INCIDENT_CASE_STATUS_LABEL[value]).toBeTruthy()
    }
    for (const value of INCIDENT_ORIGINS) {
      expect(INCIDENT_ORIGIN_LABEL[value]).toBeTruthy()
    }
    for (const value of QUESTION_AUDIENCES) {
      expect(QUESTION_AUDIENCE_LABEL[value]).toBeTruthy()
    }
  })

  it('draw the settled and awaiting sets from the status list itself', () => {
    for (const status of SETTLED_CASE_STATUSES) {
      expect(INCIDENT_CASE_STATUSES).toContain(status)
    }
    for (const status of AWAITING_STATUSES) {
      expect(INCIDENT_CASE_STATUSES).toContain(status)
    }
    expect(isSettledCase('closed')).toBe(true)
    expect(isSettledCase('awaiting_vendor')).toBe(false)
  })
})

describe('an unanswered question', () => {
  it('is unanswered when nothing has come back', () => {
    expect(isAnswered(question())).toBe(false)
  })

  it('is still unanswered when only the time was stamped', () => {
    // Somebody clicked "mark answered" and never wrote what the answer was.
    expect(isAnswered(question({ answeredAt: AT }))).toBe(false)
  })

  it('is still unanswered when only the text was drafted', () => {
    expect(isAnswered(question({ answer: 'האורח אמר שכן' }))).toBe(false)
  })

  it('is answered only when both are there', () => {
    const answered = question({ answeredAt: AT, answer: 'האורח אמר שכן' })
    expect(isAnswered(answered)).toBe(true)
    expect(unansweredQuestions([answered, question()])).toHaveLength(1)
  })
})
