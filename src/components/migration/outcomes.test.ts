import { describe, expect, it } from 'vitest'

import { RECORD_OUTCOMES } from '@/lib/migration/types'

import {
  OUTCOME_MEANING,
  OUTCOME_ORDER,
  isFailure,
  isWrite,
  outcomeTone,
  unorderedOutcomes,
} from './outcomes'

describe('every outcome is accounted for', () => {
  it('has a sentence for each one', () => {
    for (const outcome of RECORD_OUTCOMES) {
      expect(OUTCOME_MEANING[outcome].length).toBeGreaterThan(0)
    }
  })

  it('orders all of them and invents none', () => {
    expect(unorderedOutcomes()).toEqual([])
    expect(OUTCOME_ORDER.length).toBe(RECORD_OUTCOMES.length)
    expect(new Set(OUTCOME_ORDER).size).toBe(OUTCOME_ORDER.length)
  })

  it('puts the failures first, because they are the only ones to act on', () => {
    expect(OUTCOME_ORDER[0]).toBe('failed')
  })
})

describe('what counts as a problem', () => {
  it('treats only a failure as one', () => {
    const problems = RECORD_OUTCOMES.filter(isFailure)
    expect(problems).toEqual(['failed'])
  })

  it('does not colour the idempotent skip as a warning', () => {
    // The second run of the same file produces this for every row. Making it
    // loud would tell an operator their correct import broke.
    expect(outcomeTone('skipped_unchanged')).toBe('neutral')
  })

  it('does not treat a stale record as a failure', () => {
    expect(isFailure('needs_manual_update')).toBe(false)
    expect(OUTCOME_MEANING.needs_manual_update).toContain('כפילות')
  })

  it('counts only a create or an update as a write', () => {
    expect(RECORD_OUTCOMES.filter(isWrite)).toEqual(['created', 'updated'])
  })
})

describe('tones', () => {
  it('gives the loud tone to the failure alone', () => {
    const loud = RECORD_OUTCOMES.filter(
      (outcome) => outcomeTone(outcome) === 'accent',
    )
    expect(loud).toEqual(['failed'])
  })

  it('marks the two writes with the brand tone', () => {
    expect(outcomeTone('created')).toBe('brand')
    expect(outcomeTone('updated')).toBe('brand')
  })
})
