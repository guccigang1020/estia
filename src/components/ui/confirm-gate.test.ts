/**
 * The gate in front of an irreversible action.
 *
 * Every assertion here corresponds to a way a booking could be deleted that
 * nobody intended: a second click while the first is running, a half-typed
 * confirmation, a phrase that merely looks close enough.
 */

import { describe, expect, it } from 'vitest'

import { evaluateConfirmGate } from './confirm-gate'

describe('evaluateConfirmGate — an action already running is never fired twice', () => {
  it('shuts the gate while the confirmed action is in flight', () => {
    const verdict = evaluateConfirmGate({ pending: true })

    expect(verdict.canConfirm).toBe(false)
    expect(verdict.reason).toBe('pending')
  })

  it('keeps the gate shut while pending even when the phrase is correct', () => {
    const verdict = evaluateConfirmGate({
      requiredPhrase: 'וילה הגליל',
      typed: 'וילה הגליל',
      pending: true,
    })

    expect(verdict.canConfirm).toBe(false)
    expect(verdict.reason).toBe('pending')
  })

  it('tells the user why the button stopped responding', () => {
    expect(evaluateConfirmGate({ pending: true }).hint).toContain('מתבצעת')
  })
})

describe('evaluateConfirmGate — ordinary confirmation', () => {
  it('opens immediately when no phrase is demanded', () => {
    const verdict = evaluateConfirmGate({})

    expect(verdict.canConfirm).toBe(true)
    expect(verdict.phraseRequired).toBe(false)
    expect(verdict.hint).toBeNull()
  })

  it('treats a whitespace-only phrase as no phrase at all', () => {
    const verdict = evaluateConfirmGate({ requiredPhrase: '   ' })

    expect(verdict.phraseRequired).toBe(false)
    expect(verdict.canConfirm).toBe(true)
  })
})

describe('evaluateConfirmGate — typed confirmation', () => {
  it('refuses an empty input and says what to type', () => {
    const verdict = evaluateConfirmGate({ requiredPhrase: 'וילה הגליל' })

    expect(verdict.canConfirm).toBe(false)
    expect(verdict.reason).toBe('phrase_missing')
    expect(verdict.hint).toContain('וילה הגליל')
  })

  it('refuses a phrase that is merely close', () => {
    const verdict = evaluateConfirmGate({
      requiredPhrase: 'וילה הגליל',
      typed: 'וילה גליל',
    })

    expect(verdict.canConfirm).toBe(false)
    expect(verdict.reason).toBe('phrase_mismatch')
  })

  it('refuses a prefix of the phrase', () => {
    expect(
      evaluateConfirmGate({ requiredPhrase: 'מחיקה', typed: 'מחי' }).canConfirm,
    ).toBe(false)
  })

  it('accepts the exact phrase', () => {
    const verdict = evaluateConfirmGate({
      requiredPhrase: 'וילה הגליל',
      typed: 'וילה הגליל',
    })

    expect(verdict.canConfirm).toBe(true)
    expect(verdict.reason).toBeNull()
    expect(verdict.hint).toBeNull()
  })

  it('forgives whitespace that copy-paste added', () => {
    expect(
      evaluateConfirmGate({
        requiredPhrase: 'וילה הגליל',
        typed: '  וילה   הגליל \n',
      }).canConfirm,
    ).toBe(true)
  })

  it('forgives letter case in a Latin-named unit', () => {
    expect(
      evaluateConfirmGate({
        requiredPhrase: 'Villa Galil',
        typed: 'villa galil',
      }).canConfirm,
    ).toBe(true)
  })

  it('does not forgive a different word that shares a prefix', () => {
    expect(
      evaluateConfirmGate({
        requiredPhrase: 'Villa Galil',
        typed: 'Villa Galilee',
      }).canConfirm,
    ).toBe(false)
  })
})
