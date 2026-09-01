/**
 * The arithmetic, said out loud.
 *
 * These assertions are written against the worked example on purpose: twenty
 * adults, five children, twenty-five heads, a house with a pool. A manager
 * told the plan needs twenty-five bath towels will ask why, and the sentence
 * this module produces has to answer in the numbers the person can see rather
 * than in the name of a rule they have never heard of.
 */

import { describe, expect, it } from 'vitest'

import { explainRequirement, explanationIndex } from './explain'
import { computeRequirements } from './requirements'
import { captureSnapshot } from './snapshot'
import {
  exampleBooking,
  exampleCatalogue,
} from './testing/example-configuration'
import type { Requirement } from './types'

const SNAPSHOT = captureSnapshot({
  catalogue: exampleCatalogue(),
  booking: exampleBooking(),
  capturedAt: '2026-09-01T06:00:00.000Z',
})

const { facts, requirements } = computeRequirements(exampleBooking(), SNAPSHOT)

function requirement(itemId: string): Requirement {
  const found = requirements.find((entry) => entry.itemId === itemId)
  if (!found) throw new Error(`the example produced no ${itemId}`)
  return found
}

describe('explaining a rule-derived quantity', () => {
  it('names the basis, its value and the multiplier', () => {
    const explanation = explainRequirement(
      requirement('bath_towel'),
      facts,
      SNAPSHOT,
    )

    expect(explanation.calculated).toBe(25)
    expect(explanation.sources[0].sentence).toBe(
      '25 מגבת רחצה = 25 אורחים × 1 לאורח',
    )
  })

  it('shows a divisor only where one is doing something', () => {
    // One hand towel per couple. The divisor is the whole of "per couple", and
    // a sentence that also printed `÷ 1` on every other line would train
    // people to stop reading it.
    const perCouple = explainRequirement(
      requirement('hand_towel'),
      facts,
      SNAPSHOT,
    )
    expect(perCouple.sources[0].sentence).toContain('÷ 2')

    const perGuest = explainRequirement(
      requirement('bath_towel'),
      facts,
      SNAPSHOT,
    )
    expect(perGuest.sources[0].sentence).not.toContain('÷')
  })

  it('says what the margin added, and to what', () => {
    const withBuffer = requirements.find((entry) =>
      entry.sources.some((source) => source.buffered > source.base),
    )
    if (!withBuffer) throw new Error('the example produced no buffered line')

    const explanation = explainRequirement(withBuffer, facts, SNAPSHOT)
    const sentence = explanation.sources.find(
      (source) => source.buffered > source.base,
    )?.sentence

    expect(sentence).toContain('מרווח')
    expect(sentence).toContain('→')
  })
})

describe('explaining what no rule produced', () => {
  it('says a bed line came from the sleeping allocation', () => {
    const beds = requirements.find((entry) =>
      entry.sources.some((source) => source.origin === 'bed'),
    )
    if (!beds) throw new Error('the example allocated no beds')

    const explanation = explainRequirement(beds, facts, SNAPSHOT)
    const bedSource = explanation.sources.find(
      (source) => source.origin === 'bed',
    )

    expect(bedSource?.sentence).toContain('מפריסת המיטות')
  })

  it('falls back to the plain total when the snapshot no longer holds the rule', () => {
    // A rule id with nothing behind it renders the count rather than an
    // invented expression. Printing today's version of the same rule would
    // explain a figure with arithmetic that did not produce it.
    const orphan: Requirement = {
      ...requirement('bath_towel'),
      sources: [
        {
          ruleId: 'a_rule_that_was_deleted',
          origin: 'rule',
          section: 'towels',
          base: 25,
          buffered: 25,
          minutes: 25,
        },
      ],
    }

    const explanation = explainRequirement(orphan, facts, SNAPSHOT)
    expect(explanation.sources[0].sentence).toBe(
      '25 מגבת רחצה — מתוך חוקי הנכס',
    )
  })
})

describe('the index the screen reads', () => {
  it('keys on category and item, the way the requirements were merged', () => {
    // An organization that uses one catalogue id for a cleaning consumable and
    // a kitchen consumable means two different things by it. Keying on the id
    // alone would attach the wrong arithmetic to one of them.
    const index = explanationIndex(requirements, facts, SNAPSHOT)

    expect(index.get('towels bath_towel')?.calculated).toBe(25)
    expect(index.get('bath_towel')).toBeUndefined()
  })

  it('covers every requirement the example produced', () => {
    const index = explanationIndex(requirements, facts, SNAPSHOT)
    expect(index.size).toBe(requirements.length)

    for (const explanation of index.values()) {
      expect(explanation.sources.length).toBeGreaterThan(0)
      for (const source of explanation.sources) {
        expect(source.sentence.length).toBeGreaterThan(0)
      }
    }
  })
})
