import { describe, expect, it } from 'vitest'

import {
  ACTION_SAFETY_LEVELS,
  AUTOPILOT_ACTION_OUTCOMES,
  AUTOPILOT_CAPABILITY_STATES,
  AUTOPILOT_DISPOSITIONS,
  AUTOPILOT_SUPPRESSION_REASONS,
} from '@/lib/contracts/states'
import { noteIsRequiredFor } from '@/lib/platform/autopilot'

import {
  ACTION_OUTCOME_LABEL,
  CAPABILITY_STATE_LABEL,
  CAPABILITY_STATE_MEANING,
  capabilityStateOptions,
  DISPOSITION_LABEL,
  percentage,
  SAFETY_LEVEL_LABEL,
  suppressionReasonLabel,
} from './labels'

/**
 * The console's Hebrew, and the one place where the FORM'S refusal has to
 * match the OPERATION'S. A browser that lets a suspension through without a
 * note is a browser that shows a database error to a support operator.
 */

describe('capabilityStateOptions', () => {
  it('offers every state the schema has, in the declared order', () => {
    expect(capabilityStateOptions().map((option) => option.value)).toEqual([
      ...AUTOPILOT_CAPABILITY_STATES,
    ])
  })

  it('demands a note in the form for exactly the states the rule demands one for', () => {
    for (const option of capabilityStateOptions()) {
      expect(option.noteRequired).toBe(noteIsRequiredFor(option.value))
    }

    // Named explicitly as well, so that a change to `noteIsRequiredFor` that
    // relaxed both sides at once would still be visible here.
    const required = capabilityStateOptions()
      .filter((option) => option.noteRequired)
      .map((option) => option.value)
    expect(required).toEqual(['suspended', 'disabled'])
  })

  it('demands an end date for a trial and for nothing else', () => {
    const required = capabilityStateOptions()
      .filter((option) => option.trialEndRequired)
      .map((option) => option.value)
    expect(required).toEqual(['trial'])
  })

  it('carries a Hebrew label and a sentence of meaning for every state', () => {
    for (const option of capabilityStateOptions()) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.meaning.length).toBeGreaterThan(0)
    }
  })
})

describe('the label maps are total over their unions', () => {
  it('covers every capability state', () => {
    for (const state of AUTOPILOT_CAPABILITY_STATES) {
      expect(CAPABILITY_STATE_LABEL[state]).toBeTruthy()
      expect(CAPABILITY_STATE_MEANING[state]).toBeTruthy()
    }
  })

  it('covers every action outcome, disposition and safety level', () => {
    for (const outcome of AUTOPILOT_ACTION_OUTCOMES) {
      expect(ACTION_OUTCOME_LABEL[outcome]).toBeTruthy()
    }
    for (const disposition of AUTOPILOT_DISPOSITIONS) {
      expect(DISPOSITION_LABEL[disposition]).toBeTruthy()
    }
    for (const level of ACTION_SAFETY_LEVELS) {
      expect(SAFETY_LEVEL_LABEL[level]).toBeTruthy()
    }
  })
})

describe('suppressionReasonLabel', () => {
  it('translates every reason the contract currently names', () => {
    for (const reason of AUTOPILOT_SUPPRESSION_REASONS) {
      expect(suppressionReasonLabel(reason)).not.toBe(reason)
    }
  })

  it('shows an unknown code as itself rather than as "אחר"', () => {
    // `suppressed_reason` is a text column so the vocabulary can grow without
    // a migration. A reason this file has not heard of is a thing to notice.
    expect(suppressionReasonLabel('some_new_reason')).toBe('some_new_reason')
    expect(suppressionReasonLabel(null)).toBe('—')
  })
})

describe('percentage', () => {
  it('renders an absent rate as an em dash and never as 0%', () => {
    expect(percentage(null)).toBe('—')
    expect(percentage(0)).toBe('0%')
    expect(percentage(2 / 3)).toBe('67%')
  })
})
