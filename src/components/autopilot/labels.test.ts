/**
 * Every vocabulary member has Hebrew, and every one of them is different.
 *
 * ── Why this test exists ─────────────────────────────────────────────────
 *
 * The `Record<Vocabulary, string>` typing already makes a MISSING member a
 * compile error. What it does not catch is a member whose label was pasted
 * from its neighbour and never changed — two dispositions both reading
 * "באישור" would render a matrix in which two columns are indistinguishable,
 * and nothing would fail. So the labels are checked for uniqueness as well as
 * presence, per vocabulary.
 *
 * The suppression reasons are checked hardest, because they are the ones a
 * customer reads at the exact moment they are deciding whether to trust the
 * product: 0046 says a refusal with no reason attached is the fastest way to
 * lose that trust, and a blank or duplicated reason is a refusal with no
 * reason attached.
 */

import { describe, expect, it } from 'vitest'

import {
  ACTION_SAFETY_LEVELS,
  AUTOPILOT_ACTION_OUTCOMES,
  AUTOPILOT_BOOKING_HANDLING,
  AUTOPILOT_CAPABILITY_STATES,
  AUTOPILOT_CONFIDENCE_LEVELS,
  AUTOPILOT_DISPOSITIONS,
  AUTOPILOT_DOMAINS,
  AUTOPILOT_EXCEPTION_STATES,
  AUTOPILOT_LEVELS,
  AUTOPILOT_RISK_STATES,
  AUTOPILOT_RUN_MODES,
  AUTOPILOT_SUPPRESSION_REASONS,
} from '@/lib/contracts/states'

import {
  BOOKING_HANDLING_LABEL,
  CAPABILITY_STATE_LABEL,
  CONFIDENCE_LABEL,
  DISPOSITION_LABEL,
  DISPOSITION_MEANING,
  DOMAIN_LABEL,
  EXCEPTION_STATE_LABEL,
  LEVEL_LABEL,
  LEVEL_MEANING,
  OUTCOME_LABEL,
  RISK_LABEL,
  RUN_MODE_LABEL,
  RUN_MODE_MEANING,
  SAFETY_LEVEL_LABEL,
  SAFETY_LEVEL_MEANING,
  SUPPRESSION_LABEL,
} from './labels'

const TABLES: readonly [
  string,
  readonly string[],
  Readonly<Record<string, string>>,
][] = [
  ['levels', AUTOPILOT_LEVELS, LEVEL_LABEL],
  ['level meanings', AUTOPILOT_LEVELS, LEVEL_MEANING],
  ['run modes', AUTOPILOT_RUN_MODES, RUN_MODE_LABEL],
  ['run mode meanings', AUTOPILOT_RUN_MODES, RUN_MODE_MEANING],
  ['safety levels', ACTION_SAFETY_LEVELS, SAFETY_LEVEL_LABEL],
  ['safety meanings', ACTION_SAFETY_LEVELS, SAFETY_LEVEL_MEANING],
  ['dispositions', AUTOPILOT_DISPOSITIONS, DISPOSITION_LABEL],
  ['disposition meanings', AUTOPILOT_DISPOSITIONS, DISPOSITION_MEANING],
  ['domains', AUTOPILOT_DOMAINS, DOMAIN_LABEL],
  ['risk states', AUTOPILOT_RISK_STATES, RISK_LABEL],
  ['exception states', AUTOPILOT_EXCEPTION_STATES, EXCEPTION_STATE_LABEL],
  ['confidence', AUTOPILOT_CONFIDENCE_LEVELS, CONFIDENCE_LABEL],
  ['outcomes', AUTOPILOT_ACTION_OUTCOMES, OUTCOME_LABEL],
  ['suppression reasons', AUTOPILOT_SUPPRESSION_REASONS, SUPPRESSION_LABEL],
  ['booking handling', AUTOPILOT_BOOKING_HANDLING, BOOKING_HANDLING_LABEL],
  ['capability states', AUTOPILOT_CAPABILITY_STATES, CAPABILITY_STATE_LABEL],
]

describe.each(TABLES)('%s', (_name, vocabulary, labels) => {
  it('has a label for every member', () => {
    for (const member of vocabulary) {
      expect(labels[member], member).toBeTypeOf('string')
      expect(labels[member].trim().length, member).toBeGreaterThan(0)
    }
  })

  it('has no label the vocabulary does not have a member for', () => {
    expect(Object.keys(labels).sort()).toEqual([...vocabulary].sort())
  })

  it('does not repeat a label between two members', () => {
    const values = vocabulary.map((member) => labels[member])
    expect(new Set(values).size).toBe(vocabulary.length)
  })

  it('does not leak the machine name to the reader', () => {
    for (const member of vocabulary) {
      expect(labels[member], member).not.toBe(member)
    }
  })
})

describe('the suppression vocabulary', () => {
  it('never renders a refusal as a blank', () => {
    for (const reason of AUTOPILOT_SUPPRESSION_REASONS) {
      expect(SUPPRESSION_LABEL[reason].length).toBeGreaterThan(3)
    }
  })
})
