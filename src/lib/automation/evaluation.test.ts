/**
 * What a rule decided about one event.
 *
 * The interesting cases are the three this module could get wrong in a way
 * nobody would notice:
 *
 *   · a fact the event did not carry must be UNMET and must say which field —
 *     folding it into "true" is how a rule fires on the wrong rows;
 *   · a payload field no rule compares must not be copied into a table that
 *     will sit for years;
 *   · a tunable threshold must leave this module as a GATE rather than as an
 *     answer, because the number the business stored is one this module is not
 *     allowed to read.
 */

import { describe, expect, it } from 'vitest'

import { candidatesForEvent, factsForEvent, COMPARED_FACTS } from './evaluation'
import { AUTOMATION_TEMPLATES } from './library'
import { parametersFor } from './parameters'

describe('factsForEvent', () => {
  it('keeps only the fields some rule actually compares', () => {
    const facts = factsForEvent({
      nights: 3,
      guestName: 'דנה כהן',
      guestPhone: '+972500000000',
      totalAgorot: 120_000,
    })

    expect(facts).toEqual({ nights: 3 })
    expect(facts).not.toHaveProperty('guestName')
    expect(facts).not.toHaveProperty('guestPhone')
  })

  it('derives the compared fields from the library rather than a list', () => {
    // If this ever disagrees, a template gained a condition and the extractor
    // silently stopped supplying the fact it compares — a rule that looks
    // configured and never fires.
    const fromLibrary = new Set(
      AUTOMATION_TEMPLATES.flatMap((template) =>
        template.rule.conditions.map((condition) => condition.field),
      ),
    )
    expect([...COMPARED_FACTS].sort()).toEqual([...fromLibrary].sort())
  })

  it('omits a nested value rather than flattening it', () => {
    const facts = factsForEvent({ nights: { value: 3 } })
    expect(facts).not.toHaveProperty('nights')
  })

  it('omits a number that is not finite', () => {
    expect(factsForEvent({ nights: Number.NaN })).not.toHaveProperty('nights')
  })

  it('keeps an explicit null, which is a different answer from absence', () => {
    expect(factsForEvent({ nights: null })).toEqual({ nights: null })
  })

  it('answers with nothing for a payload that is not an object', () => {
    expect(factsForEvent(null)).toEqual({})
    expect(factsForEvent('booking')).toEqual({})
    expect(factsForEvent([1, 2])).toEqual({})
  })
})

describe('candidatesForEvent', () => {
  it('produces nothing for an event no shipped rule listens to', () => {
    // Recording fourteen "this rule was not supposed to run" rows per event is
    // the noise that makes an audit trail unreadable.
    expect(candidatesForEvent('guest.link_opened', {})).toEqual([])
  })

  it('produces one candidate per rule that listens, and only those', () => {
    const candidates = candidatesForEvent('payment.failed', {})
    expect(candidates.map((entry) => entry.templateId)).toEqual([
      'payment-failed-alert',
    ])
  })

  it('carries the library answer for a rule nobody has touched', () => {
    const [alert] = candidatesForEvent('payment.failed', {})
    // Ships ON: an internal alert nobody would think to go and enable, and
    // being wrong about it costs nothing.
    expect(alert.shippedEnabled).toBe(true)

    const [instructions] = candidatesForEvent('booking.pre_arrival', {})
    // Ships OFF: it speaks to a guest.
    expect(instructions.shippedEnabled).toBe(false)
  })

  it('carries every action the rule would perform, with its note', () => {
    const [confirmed] = candidatesForEvent('booking.confirmed', {})
    expect(confirmed.wouldPerform.map((action) => action.kind)).toEqual([
      'notify_team',
      'create_task',
    ])
    expect(confirmed.wouldPerform[0].note.length).toBeGreaterThan(0)
  })

  it('is met when the rule has no conditions at all', () => {
    const [alert] = candidatesForEvent('payment.failed', {})
    expect(alert.conditionsMet).toBe(true)
    expect(alert.reason).toBeNull()
    expect(alert.gates).toEqual([])
  })
})

describe('a tunable threshold leaves as a gate', () => {
  const templateId = 'review-request-after-stay'

  it('is not decided here, because the stored number is unreadable', () => {
    const [review] = candidatesForEvent('booking.completed', { nights: 3 })

    expect(review.templateId).toBe(templateId)
    // Every condition a parameter cannot touch held — there are none — so this
    // is true and the real answer is still open.
    expect(review.conditionsMet).toBe(true)
    expect(review.gates).toEqual([
      {
        key: 'minimum_nights',
        operator: 'at_least',
        fact: 3,
        shipped: 2,
      },
    ])
  })

  it('sends a null fact when the event did not carry it', () => {
    const [review] = candidatesForEvent('booking.completed', {})
    // Null, not zero and not omitted. The recorder fails closed on it, exactly
    // as conditions.ts does, and a zero would have compared as a real stay of
    // no nights.
    expect(review.gates[0].fact).toBeNull()
  })

  it('sends a null fact when the payload carried something uncomparable', () => {
    const [review] = candidatesForEvent('booking.completed', { nights: '3' })
    // `'3' === 3` is false in conditions.ts, deliberately, and coercing here
    // would make the two disagree about the same event.
    expect(review.gates[0].fact).toBeNull()
  })

  it('ships the same threshold the parameter catalogue declares', () => {
    const [review] = candidatesForEvent('booking.completed', { nights: 3 })
    const [parameter] = parametersFor(templateId)
    expect(review.gates[0].shipped).toBe(parameter.shipped)
  })
})

/**
 * WHAT IS NOT TESTED HERE, AND WHY IT CANNOT BE YET.
 *
 * `reason` carries the sentence `evaluateConditions` produced for a condition
 * that a parameter cannot touch — and the shipped library has no such condition.
 * Its only conditional rule is the tunable one, whose comparison leaves as a
 * gate. So the branch is written, it is the evaluator's own tested output, and
 * it has no shipped rule to exercise it end to end. Asserting it against a rule
 * this test invented would prove the test, not the library.
 */
describe('the shipped library, as it actually is', () => {
  it('has exactly one rule with a condition, and it is the tunable one', () => {
    const conditional = AUTOMATION_TEMPLATES.filter(
      (template) => template.rule.conditions.length > 0,
    )
    expect(conditional.map((template) => template.rule.id)).toEqual([
      'review-request-after-stay',
    ])
    expect(parametersFor('review-request-after-stay')).toHaveLength(1)
  })
})
