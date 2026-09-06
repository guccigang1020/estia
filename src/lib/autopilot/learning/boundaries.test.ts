/**
 * What must never be learned, and the proof that it is not.
 *
 * The property this file exists to assert is not "the code refuses" — it is
 * that the refusal is a RECORD. A boundary that drops a pattern silently is
 * indistinguishable from a detector that found nothing, and nobody can tell a
 * working safety control from a broken feature.
 *
 * So every case below checks two things: the pattern did not become a
 * proposal, and the refusal names the boundary, the field and the value that
 * tripped it.
 */

import { describe, expect, it } from 'vitest'

import {
  LEARNING_BOUNDARIES,
  LearningWriteBarrierError,
  assertLearningWritable,
  screenPattern,
  screenPatterns,
} from './boundaries'
import type { ObservedPattern, PatternSubject } from './patterns'

const NOW = new Date('2026-09-01T09:00:00.000Z')

function pattern(overrides: Partial<ObservedPattern> = {}): ObservedPattern {
  return {
    patternCode: 'quantity_override.pool_towels_5',
    subject: 'preparation_quantity',
    propertyId: 'property-a',
    occurrences: 16,
    opportunities: 20,
    observedFrom: '2026-06-01',
    observedTo: '2026-08-31',
    sample: [
      { reference: 'booking-1', label: 'הזמנה 1', occurredOn: '2026-06-04' },
    ],
    observation: 'נוספו 5 מגבות בריכה ב-16 מתוך 20 הזמנות.',
    suggestion: {
      module: 'preparation',
      statement: 'להוסיף 5 מגבות בריכה כברירת מחדל.',
      expectedImpact: 'חוסך תיקון ידני של תוכנית ההכנה.',
      parameters: { itemCode: 'pool_towels', deltaQuantity: 5 },
      actionKind: 'preparation.generate',
    },
    ...overrides,
  }
}

describe('an ordinary operational pattern', () => {
  it('passes', () => {
    expect(screenPattern(pattern(), NOW).permitted).toBe(true)
  })
})

describe('sensitive personal characteristics', () => {
  it('drops a pattern whose observation is about who the guests are', () => {
    const verdict = screenPattern(
      pattern({
        observation: 'אורחים שלאום שלהם שונה מקבלים מגבות נוספות.',
      }),
      NOW,
    )

    expect(verdict.permitted).toBe(false)
    if (verdict.permitted) throw new Error('unreachable')
    expect(verdict.refusal.boundary).toBe('personal_characteristic')
    expect(verdict.refusal.trigger.where).toBe('observation')
    expect(verdict.refusal.refusedAt).toBe(NOW.toISOString())
    expect(verdict.refusal.explanation.length).toBeGreaterThan(0)
  })

  it('drops one that hides the characteristic in a parameter', () => {
    const verdict = screenPattern(
      pattern({
        suggestion: {
          ...pattern().suggestion,
          parameters: { guest_nationality: 'IL', deltaQuantity: 5 },
        },
      }),
      NOW,
    )

    expect(verdict.permitted).toBe(false)
    if (verdict.permitted) throw new Error('unreachable')
    expect(verdict.refusal.boundary).toBe('personal_characteristic')
    expect(verdict.refusal.trigger.where).toBe('parameters.guest_nationality')
  })

  it('drops a subject outside the closed operational list', () => {
    // The structural mechanism: an invented subject is exactly how a pattern
    // about people would arrive wearing an operational name.
    const verdict = screenPattern(
      pattern({ subject: 'guest_origin' as PatternSubject }),
      NOW,
    )

    expect(verdict.permitted).toBe(false)
    if (verdict.permitted) throw new Error('unreachable')
    expect(verdict.refusal.trigger.where).toBe('subject')
  })
})

describe('permissions, security and autonomy', () => {
  it('drops one that would widen a financial permission', () => {
    const verdict = screenPattern(
      pattern({
        suggestion: {
          ...pattern().suggestion,
          parameters: { spend_limit: 500 },
        },
      }),
      NOW,
    )

    expect(verdict.permitted).toBe(false)
    if (verdict.permitted) throw new Error('unreachable')
    expect(verdict.refusal.boundary).toBe('financial_permission')
  })

  it('drops one that would step around an approval', () => {
    const verdict = screenPattern(
      pattern({
        suggestion: {
          ...pattern().suggestion,
          parameters: { skip_approval: true },
        },
      }),
      NOW,
    )

    expect(verdict.permitted).toBe(false)
    if (verdict.permitted) throw new Error('unreachable')
    expect(verdict.refusal.boundary).toBe('security_control')
  })

  it('drops one that would change how autonomous Autopilot is', () => {
    const verdict = screenPattern(
      pattern({
        suggestion: {
          ...pattern().suggestion,
          parameters: { disposition: 'auto' },
        },
      }),
      NOW,
    )

    expect(verdict.permitted).toBe(false)
    if (verdict.permitted) throw new Error('unreachable')
    expect(verdict.refusal.boundary).toBe('autonomy_change')
  })
})

describe('destructive and money actions', () => {
  it('drops a pattern that would cancel a booking', () => {
    const verdict = screenPattern(
      pattern({
        suggestion: { ...pattern().suggestion, actionKind: 'booking.cancel' },
      }),
      NOW,
    )

    expect(verdict.permitted).toBe(false)
    if (verdict.permitted) throw new Error('unreachable')
    expect(verdict.refusal.boundary).toBe('destructive')
    expect(verdict.refusal.trigger.where).toBe('suggestion.actionKind')
  })

  it('drops a pattern that would request money', () => {
    const verdict = screenPattern(
      pattern({
        suggestion: { ...pattern().suggestion, actionKind: 'payment.request' },
      }),
      NOW,
    )

    expect(verdict.permitted).toBe(false)
    if (verdict.permitted) throw new Error('unreachable')
    expect(verdict.refusal.boundary).toBe('financial_permission')
  })

  it('drops a pattern that would change what the business charges', () => {
    const verdict = screenPattern(
      pattern({
        suggestion: { ...pattern().suggestion, actionKind: 'price.suggest' },
      }),
      NOW,
    )

    expect(verdict.permitted).toBe(false)
  })

  it('drops one naming an action the catalogue does not have', () => {
    // A consequence nobody can look up is one nobody can approve.
    const verdict = screenPattern(
      pattern({
        suggestion: { ...pattern().suggestion, actionKind: 'guest.hypnotise' },
      }),
      NOW,
    )

    expect(verdict.permitted).toBe(false)
    if (verdict.permitted) throw new Error('unreachable')
    expect(verdict.refusal.boundary).toBe('security_control')
  })

  it('allows a message template, which leaves the building but decides nothing', () => {
    const verdict = screenPattern(
      pattern({
        subject: 'message_template',
        suggestion: {
          ...pattern().suggestion,
          module: 'messaging',
          parameters: { templateId: 'template-3' },
          actionKind: 'guest.send_reminder',
        },
      }),
      NOW,
    )

    expect(verdict.permitted).toBe(true)
  })
})

describe('screening a batch', () => {
  it('keeps both halves and throws neither away', () => {
    const result = screenPatterns(
      [
        pattern(),
        pattern({
          patternCode: 'quantity_override.linen_2',
          observation: 'אורחים לפי דת מקבלים סדינים נוספים.',
        }),
      ],
      NOW,
    )

    expect(result.permitted).toHaveLength(1)
    expect(result.refusals).toHaveLength(1)
    expect(result.refusals[0].patternCode).toBe('quantity_override.linen_2')
    expect(LEARNING_BOUNDARIES).toContain(result.refusals[0].boundary)
  })
})

describe('the write barrier', () => {
  it('allows the one table this module owns', () => {
    expect(() =>
      assertLearningWritable('autopilot_rule_candidates'),
    ).not.toThrow()
  })

  it('refuses the policy table, which is what decides what Autopilot does', () => {
    expect(() => assertLearningWritable('autopilot_policies')).toThrow(
      LearningWriteBarrierError,
    )
    expect(() => assertLearningWritable('autopilot_settings')).toThrow(
      LearningWriteBarrierError,
    )
    expect(() => assertLearningWritable('laundry_settings')).toThrow(
      LearningWriteBarrierError,
    )
  })
})
