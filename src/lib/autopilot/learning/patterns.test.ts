/**
 * What the detectors must get right.
 *
 * Three properties, and they are the ones a manager's trust rests on:
 *
 *   1. The count and the denominator are both real. "82%" is 16 of 20 and the
 *      object says so, because a rate nobody can decompose is a rate people
 *      learn to ignore.
 *   2. A choice that agrees with the configured default is a chance, not a
 *      behaviour. Proposing a rule that already exists is how a business
 *      learns to stop reading these.
 *   3. Every pattern code the detectors emit is one the database will accept,
 *      whatever the customer's item codes look like.
 */

import { describe, expect, it } from 'vitest'

import {
  detectCleanerPreferences,
  detectLaundryProviderChoices,
  detectPatterns,
  detectPropertyDeviations,
  detectQuantityOverrides,
  emptyHistory,
  isPatternCode,
  occurrenceRate,
  SAMPLE_SIZE,
  toCodeSegment,
  type LaundryChoiceRecord,
  type OperationalHistory,
  type QuantityOverrideRecord,
} from './patterns'

const WINDOW = { from: '2026-06-01', to: '2026-08-31' }

function day(index: number): string {
  const date = new Date(Date.UTC(2026, 5, 1 + index))
  return date.toISOString().slice(0, 10)
}

function summerTowels(count: number, delta: number, from = 0) {
  const rows: QuantityOverrideRecord[] = []
  for (let i = 0; i < count; i += 1) {
    rows.push({
      bookingId: `booking-${from + i}`,
      propertyId: 'property-a',
      itemCode: 'pool_towels',
      itemLabel: 'מגבות בריכה',
      expectedQuantity: 10,
      actualQuantity: 10 + delta,
      occurredOn: day(from + i),
      context: 'קיץ',
    })
  }
  return rows
}

describe('quantity override detection', () => {
  const history: OperationalHistory = {
    ...emptyHistory(WINDOW),
    quantityOverrides: [
      ...summerTowels(16, 5),
      // Four bookings that took the plan as it stood. They are chances, and
      // they belong in the denominator and nowhere else.
      ...summerTowels(4, 0, 16),
    ],
  }

  it('counts the occurrences and the chances it had', () => {
    const [pattern] = detectQuantityOverrides(history)

    expect(pattern.occurrences).toBe(16)
    expect(pattern.opportunities).toBe(20)
    expect(occurrenceRate(pattern)).toBeCloseTo(0.8)
    expect(pattern.observation).toContain('16')
    expect(pattern.observation).toContain('20')
    expect(pattern.observation).toContain('80%')
  })

  it('does not propose the behaviour that already is the default', () => {
    // A zero delta is what the plan said. It must never become a pattern of
    // its own, or every business would be told to keep doing what it does.
    const codes = detectQuantityOverrides(history).map((one) => one.patternCode)

    expect(codes).toHaveLength(1)
    expect(codes[0]).toContain('5')
  })

  it('carries a sample a manager can open', () => {
    const [pattern] = detectQuantityOverrides(history)

    expect(pattern.sample).toHaveLength(SAMPLE_SIZE)
    expect(pattern.sample[0].reference).toMatch(/^booking-/)
    // Newest first: somebody checking a claim opens the most recent case.
    expect(pattern.sample[0].occurredOn > pattern.sample[1].occurredOn).toBe(
      true,
    )
  })

  it('states a window that matches the rows it counted', () => {
    const [pattern] = detectQuantityOverrides(history)

    expect(pattern.observedFrom).toBe(day(0))
    expect(pattern.observedTo).toBe(day(15))
  })
})

describe('cleaner preference detection', () => {
  it('counts assignments against every clean the property had', () => {
    const history: OperationalHistory = {
      ...emptyHistory(WINDOW),
      cleanerAssignments: Array.from({ length: 13 }, (_, i) => ({
        taskId: `task-${i}`,
        propertyId: 'property-a',
        assignedUserId: i < 11 ? 'user-dana' : 'user-ronit',
        assignedUserLabel: i < 11 ? 'דנה' : 'רונית',
        defaultUserId: null,
        occurredOn: day(i),
      })),
    }

    const patterns = detectCleanerPreferences(history)
    const dana = patterns.find((one) => one.patternCode.includes('dana'))

    expect(dana?.occurrences).toBe(11)
    expect(dana?.opportunities).toBe(13)
    expect(dana?.subject).toBe('cleaner_preference')
  })

  it('ignores the assignee the rota already names', () => {
    const history: OperationalHistory = {
      ...emptyHistory(WINDOW),
      cleanerAssignments: Array.from({ length: 10 }, (_, i) => ({
        taskId: `task-${i}`,
        propertyId: 'property-a',
        assignedUserId: 'user-dana',
        assignedUserLabel: 'דנה',
        defaultUserId: 'user-dana',
        occurredOn: day(i),
      })),
    }

    expect(detectCleanerPreferences(history)).toHaveLength(0)
  })
})

describe('laundry provider detection', () => {
  const orders: LaundryChoiceRecord[] = Array.from({ length: 13 }, (_, i) => ({
    orderId: `order-${i}`,
    propertyId: 'property-a',
    providerId: i < 11 ? 'provider-b' : 'provider-a',
    providerLabel: i < 11 ? 'מכבסת הגליל' : 'מכבסת המרכז',
    defaultProviderId: 'provider-a',
    occurredOn: day(i),
  }))

  it('counts the departure from the configured default', () => {
    const [pattern] = detectLaundryProviderChoices({
      ...emptyHistory(WINDOW),
      laundryChoices: orders,
    })

    expect(pattern.occurrences).toBe(11)
    expect(pattern.opportunities).toBe(13)
    expect(pattern.suggestion.module).toBe('laundry')
  })
})

describe('property deviation detection', () => {
  it('names a property that behaves differently from the rest', () => {
    const here: LaundryChoiceRecord[] = Array.from({ length: 10 }, (_, i) => ({
      orderId: `here-${i}`,
      propertyId: 'property-a',
      providerId: 'provider-b',
      providerLabel: 'מכבסת הגליל',
      defaultProviderId: 'provider-a',
      occurredOn: day(i),
    }))

    // Elsewhere the same provider is chosen once in ten.
    const elsewhere: LaundryChoiceRecord[] = Array.from(
      { length: 10 },
      (_, i) => ({
        orderId: `there-${i}`,
        propertyId: 'property-b',
        providerId: i === 0 ? 'provider-b' : 'provider-a',
        providerLabel: i === 0 ? 'מכבסת הגליל' : 'מכבסת המרכז',
        defaultProviderId: 'provider-a',
        occurredOn: day(i),
      }),
    )

    const deviations = detectPropertyDeviations({
      ...emptyHistory(WINDOW),
      laundryChoices: [...here, ...elsewhere],
    })

    const found = deviations.find((one) => one.propertyId === 'property-a')
    expect(found).toBeDefined()
    expect(found?.observation).toContain('100%')
    expect(found?.suggestion.parameters.propertyOnly).toBe(true)
  })
})

describe('pattern codes', () => {
  it('folds any customer identifier into a shape the database accepts', () => {
    expect(isPatternCode(`item.${toCodeSegment('Pool Towels / XL')}`)).toBe(
      true,
    )
    expect(isPatternCode(`item.${toCodeSegment('3M-סדינים')}`)).toBe(true)
    // An identifier that folds to nothing is named rather than blank: the
    // database would refuse an empty segment, and a screen cannot show one.
    expect(toCodeSegment('')).toBe('unknown')
    expect(isPatternCode(`item.${toCodeSegment('')}`)).toBe(true)
  })

  it('emits nothing the database would refuse', () => {
    const history: OperationalHistory = {
      ...emptyHistory(WINDOW),
      quantityOverrides: summerTowels(8, 5),
      laundryChoices: [
        {
          orderId: 'order-1',
          propertyId: 'property-a',
          providerId: '9f1c-מכבסה',
          providerLabel: 'מכבסה',
          defaultProviderId: null,
          occurredOn: day(1),
        },
      ],
    }

    for (const pattern of detectPatterns(history)) {
      expect(isPatternCode(pattern.patternCode)).toBe(true)
    }
  })
})

describe('an empty history', () => {
  it('produces no patterns rather than an empty-looking one', () => {
    expect(detectPatterns(emptyHistory(WINDOW))).toHaveLength(0)
  })
})
