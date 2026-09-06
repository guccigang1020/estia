/**
 * The wizard's state is a URL, so its correctness is string handling.
 *
 * The claim that matters most is the defaults: a wizard that opened on
 * `autopilot` and `live` would be nudging a customer past the safety the
 * migration deliberately built. 0046 defaults an unconfigured organization to
 * `off` and `simulation`, and the wizard opens where the database already is.
 */

import { describe, expect, it } from 'vitest'

import {
  nextStep,
  parseLevel,
  parseRunMode,
  parseStep,
  previousStep,
  stepHref,
  stepIndex,
  STEP_TITLE,
  WIZARD_STEPS,
  type WizardStep,
} from './wizard'

describe('the steps', () => {
  it('starts at the level and ends at the confirm', () => {
    expect(WIZARD_STEPS[0]).toBe('level')
    expect(WIZARD_STEPS[WIZARD_STEPS.length - 1]).toBe('confirm')
  })

  it('puts simulation immediately before confirm', () => {
    // Not a technical check to be skipped: it is the way this product is
    // meant to be switched on, so it sits between the review and the write.
    expect(nextStep('simulation')).toBe('confirm')
  })

  it('names every step', () => {
    for (const step of WIZARD_STEPS) {
      expect(STEP_TITLE[step].length).toBeGreaterThan(0)
    }
  })

  it('walks forwards and backwards without falling off either end', () => {
    expect(previousStep('level')).toBeNull()
    expect(nextStep('confirm')).toBeNull()

    let step: WizardStep = WIZARD_STEPS[0]
    let visited = 1
    let forward = nextStep(step)
    while (forward !== null) {
      step = forward
      visited += 1
      forward = nextStep(step)
    }
    expect(visited).toBe(WIZARD_STEPS.length)
  })

  it('falls back to the first step for anything unrecognised', () => {
    expect(parseStep(null)).toBe('level')
    expect(parseStep('confirmm')).toBe('level')
    expect(parseStep('confirm')).toBe('confirm')
  })

  it('reports a position for the progress list', () => {
    expect(stepIndex('level')).toBe(0)
    expect(stepIndex('confirm')).toBe(WIZARD_STEPS.length - 1)
  })
})

describe('the choices', () => {
  it('defaults to off and simulation, exactly as the migration does', () => {
    expect(parseLevel(null)).toBe('off')
    expect(parseRunMode(null)).toBe('simulation')
  })

  it('refuses custom as a level, because the matrix is a different conversation', () => {
    expect(parseLevel('custom')).toBe('off')
  })

  it('accepts every rung of the ladder', () => {
    for (const level of ['off', 'advisory', 'assisted', 'autopilot']) {
      expect(parseLevel(level)).toBe(level)
    }
  })

  it('falls back to simulation for an unknown run mode', () => {
    expect(parseRunMode('LIVE')).toBe('simulation')
    expect(parseRunMode('live')).toBe('live')
  })
})

describe('stepHref', () => {
  const choices = { level: 'assisted', runMode: 'simulation' } as const

  it('carries the choices made so far', () => {
    const href = stepHref('modules', choices)
    expect(href).toContain('step=modules')
    expect(href).toContain('level=assisted')
    expect(href).toContain('mode=simulation')
  })

  it('applies an override without losing the rest', () => {
    const href = stepHref('level', choices, { level: 'autopilot' })
    expect(href).toContain('level=autopilot')
    expect(href).toContain('mode=simulation')
  })

  it('round-trips through the parsers', () => {
    const href = stepHref('simulation', choices, { runMode: 'live' })
    const params = new URLSearchParams(href.split('?')[1])
    expect(parseStep(params.get('step'))).toBe('simulation')
    expect(parseLevel(params.get('level'))).toBe('assisted')
    expect(parseRunMode(params.get('mode'))).toBe('live')
  })
})
