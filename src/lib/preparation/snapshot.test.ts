/**
 * No historical drift.
 *
 * The claim being proved: raising the cleaning rate today does not move a
 * booking that happened last month. That claim is worth a whole test file
 * because the failure is silent — nothing errors, no row is edited, the
 * numbers simply come out different the next time anybody looks, and by then
 * there is nothing to compare against.
 *
 * Each test below changes the *catalogue* after the snapshot was taken and
 * asserts the booking did not move.
 */

import { describe, expect, it } from 'vitest'
import { computeEventPnL, computeVariableCosts } from './costing'
import { computeRequirements, requirementQuantity } from './requirements'
import {
  captureSnapshot,
  deepFreeze,
  resnapshot,
  resolveCatalogue,
  verifySnapshot,
} from './snapshot'
import { estimateStaffing } from './complexity'
import type {
  AllocationContext,
  CostFrequency,
  PreparationCatalogue,
} from './types'
import {
  PROPERTY_ID,
  exampleBooking,
  exampleCatalogue,
} from './testing/example-configuration'

const CAPTURED_AT = '2026-08-27T08:00:00.000Z'
const LATER = '2026-11-01T08:00:00.000Z'
const BOOKING = exampleBooking()

const MONTH: AllocationContext = {
  propertyId: PROPERTY_ID,
  periodDays: 30,
  periodOccupiedNights: 22,
  periodBookings: 8,
  periodGuests: 120,
  periodRevenue: 4_000_000,
  periodUnits: 1,
}

const CONTEXTS: Readonly<Partial<Record<CostFrequency, AllocationContext>>> = {
  monthly: MONTH,
  annual: {
    ...MONTH,
    periodDays: 365,
    periodOccupiedNights: 260,
    periodBookings: 96,
    periodGuests: 1_440,
    periodRevenue: 48_000_000,
  },
}

function snapshotOf(catalogue: PreparationCatalogue = exampleCatalogue()) {
  return captureSnapshot({
    catalogue,
    booking: BOOKING,
    capturedAt: CAPTURED_AT,
  })
}

function profitOf(snapshot: ReturnType<typeof snapshotOf>) {
  const { facts, requirements } = computeRequirements(BOOKING, snapshot)
  return computeEventPnL({
    booking: BOOKING,
    snapshot,
    facts,
    requirements,
    staffing: estimateStaffing({
      facts,
      configuration: snapshot.complexity,
      extraItems: BOOKING.extras.length,
    }),
    contexts: CONTEXTS,
  })
}

/** The catalogue as it will be after somebody edits it in November. */
function editedCatalogue(): PreparationCatalogue {
  const base = exampleCatalogue()

  return exampleCatalogue({
    // Cleaning goes up: base rate ₪350 becomes ₪500.
    variableCosts: base.variableCosts.map((cost) =>
      cost.key === 'cleaning'
        ? {
            ...cost,
            formula: {
              kind: 'sum' as const,
              of: [
                { kind: 'fixed' as const, amount: 50_000 },
                {
                  kind: 'above_threshold' as const,
                  basis: 'guests' as const,
                  threshold: 10,
                  unitAmount: 1_500,
                },
                {
                  kind: 'per_unit' as const,
                  basis: 'extra_beds' as const,
                  unitAmount: 2_000,
                },
              ],
            },
          }
        : cost,
    ),
    // And every guest now gets a second bath towel.
    rules: base.rules.map((rule) =>
      rule.id === 'towel_bath'
        ? { ...rule, quantity: { basis: 'guests' as const, factor: 2 } }
        : rule,
    ),
  })
}

// ── The guarantee ─────────────────────────────────────────────────────────

describe('a booking snapshotted in August', () => {
  const august = snapshotOf()

  it('keeps August requirements when the November rules ask for more', () => {
    const november = snapshotOf(editedCatalogue())

    expect(
      requirementQuantity(
        computeRequirements(BOOKING, august).requirements,
        'bath_towel',
      ),
    ).toBe(25)
    expect(
      requirementQuantity(
        computeRequirements(BOOKING, november).requirements,
        'bath_towel',
      ),
    ).toBe(50)
  })

  it('keeps August costs when the November rate is higher', () => {
    const { facts, requirements } = computeRequirements(BOOKING, august)
    const novemberSnapshot = snapshotOf(editedCatalogue())

    const augustCleaning = computeVariableCosts(august.variableCosts, {
      facts,
      requirements,
    }).find((line) => line.key === 'cleaning')

    const novemberCleaning = computeVariableCosts(
      novemberSnapshot.variableCosts,
      { facts, requirements },
    ).find((line) => line.key === 'cleaning')

    expect(augustCleaning?.amount).toBe(87_500)
    expect(novemberCleaning?.amount).toBe(102_500)
  })

  it('produces the same profit statement however many times it is asked', () => {
    expect(profitOf(august)).toEqual(profitOf(august))
  })

  it('produces a different one only because the snapshot is different', () => {
    expect(profitOf(august).netContribution).not.toBe(
      profitOf(snapshotOf(editedCatalogue())).netContribution,
    )
  })
})

// ── Effective dating, the first defence ───────────────────────────────────

describe('resolving the catalogue on a date', () => {
  const base = exampleCatalogue()
  const catalogue = exampleCatalogue({
    rules: [
      ...base.rules.map((rule) =>
        rule.id === 'towel_bath'
          ? { ...rule, effectiveTo: '2026-10-01' }
          : rule,
      ),
      {
        ...base.rules[0],
        id: 'towel_bath_v2',
        quantity: { basis: 'guests', factor: 2 },
        effectiveFrom: '2026-10-01',
        effectiveTo: null,
      },
    ],
  })

  it('picks the rule that was in force, not the newest one', () => {
    expect(
      resolveCatalogue(catalogue, '2026-09-04').rules.map((rule) => rule.id),
    ).toContain('towel_bath')
    expect(
      resolveCatalogue(catalogue, '2026-09-04').rules.map((rule) => rule.id),
    ).not.toContain('towel_bath_v2')
  })

  it('switches over on the effective date, with no day in both', () => {
    const after = resolveCatalogue(catalogue, '2026-10-01').rules.map(
      (r) => r.id,
    )

    expect(after).toContain('towel_bath_v2')
    expect(after).not.toContain('towel_bath')
  })

  it('resolves rules nested inside an event template too', () => {
    const withRetiredTemplateRule = exampleCatalogue({
      eventTemplates: base.eventTemplates.map((template) => ({
        ...template,
        rules: template.rules.map((rule) =>
          rule.id === 'shabbat_urn_second'
            ? { ...rule, effectiveTo: '2026-01-01' }
            : rule,
        ),
      })),
    })

    const resolved = resolveCatalogue(withRetiredTemplateRule, '2026-09-04')

    expect(
      resolved.eventTemplates[0].rules.map((rule) => rule.id),
    ).not.toContain('shabbat_urn_second')
  })

  it('takes the most recently opened commission agreement', () => {
    const withTwo = exampleCatalogue({
      commissionRules: [
        { ...base.commissionRules[0], id: 'old', rateBasisPoints: 500 },
        {
          ...base.commissionRules[0],
          id: 'new',
          rateBasisPoints: 1_500,
          effectiveFrom: '2026-06-01',
        },
      ],
    })

    expect(resolveCatalogue(withTwo, '2026-09-04').commissionRule?.id).toBe(
      'new',
    )
  })

  it('has no commission agreement when none is in force', () => {
    const expired = exampleCatalogue({
      commissionRules: [
        { ...base.commissionRules[0], effectiveTo: '2026-01-01' },
      ],
    })

    expect(resolveCatalogue(expired, '2026-09-04').commissionRule).toBeNull()
  })
})

// ── The snapshot itself ───────────────────────────────────────────────────

describe('the snapshot', () => {
  it('hashes its contents, not the moment it was taken', () => {
    const morning = captureSnapshot({
      catalogue: exampleCatalogue(),
      booking: BOOKING,
      capturedAt: CAPTURED_AT,
    })
    const evening = captureSnapshot({
      catalogue: exampleCatalogue(),
      booking: BOOKING,
      capturedAt: LATER,
    })

    expect(morning.hash).toBe(evening.hash)
    expect(morning.capturedAt).not.toBe(evening.capturedAt)
  })

  it('gets a different hash the moment anything in it differs', () => {
    expect(snapshotOf().hash).not.toBe(snapshotOf(editedCatalogue()).hash)
  })

  it('verifies against its own hash', () => {
    expect(verifySnapshot(snapshotOf())).toBe(true)
  })

  it('reports a snapshot whose contents were rewritten underneath it', () => {
    const tampered = {
      ...snapshotOf(),
      propertyConfiguration: {
        ...snapshotOf().propertyConfiguration,
        bedrooms: 99,
      },
    }

    expect(verifySnapshot(tampered)).toBe(false)
  })

  it('is frozen all the way down, so history cannot be "just fixed"', () => {
    const snapshot = snapshotOf()

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.rules)).toBe(true)
    expect(Object.isFrozen(snapshot.rules[0])).toBe(true)
    expect(Object.isFrozen(snapshot.rules[0].quantity)).toBe(true)
    expect(() => {
      // Types allow this write; the freeze is what stops it. That is the
      // point — a frozen snapshot defends against code TypeScript approved of.
      snapshot.rules[0].quantity.factor = 9
    }).toThrow(TypeError)
  })

  it('resolves against the arrival date by default', () => {
    expect(snapshotOf().effectiveOn).toBe(BOOKING.stay.checkIn)
  })

  it('carries the price the guest was quoted alongside what it costs', () => {
    expect(snapshotOf().priceLines).toEqual(BOOKING.priceLines)
  })
})

// ── Re-snapshotting ───────────────────────────────────────────────────────

describe('re-snapshotting', () => {
  it('says whether anything actually moved, and names both hashes', () => {
    const previous = snapshotOf()

    const unchanged = resnapshot({
      catalogue: exampleCatalogue(),
      booking: BOOKING,
      capturedAt: LATER,
      previous,
    })
    const changed = resnapshot({
      catalogue: editedCatalogue(),
      booking: BOOKING,
      capturedAt: LATER,
      previous,
    })

    expect(unchanged.changed).toBe(false)
    expect(changed.changed).toBe(true)
    expect(changed.previousHash).toBe(previous.hash)
    expect(changed.snapshot.hash).not.toBe(previous.hash)
  })
})

// ── deepFreeze ────────────────────────────────────────────────────────────

describe('deepFreeze', () => {
  it('freezes nested objects and arrays', () => {
    const value = deepFreeze({ a: { b: [{ c: 1 }] } })

    expect(Object.isFrozen(value.a.b[0])).toBe(true)
  })

  it('passes primitives and null through untouched', () => {
    expect(deepFreeze(null)).toBeNull()
    expect(deepFreeze(7)).toBe(7)
  })

  it('does not recurse forever on a cycle', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(() => deepFreeze(cyclic)).not.toThrow()
  })
})
