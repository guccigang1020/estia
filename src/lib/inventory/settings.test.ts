/**
 * `off` is a first-class answer, and this file is the proof rather than the
 * claim.
 *
 * The rule most likely to be broken by accident is that switching the stock
 * module off must not switch anything else off. Breaking it looks like
 * defensive coding — one `if (available < required) throw` on a shared path —
 * and the symptom is a villa owner who never opened the inventory screen
 * discovering they can no longer confirm a booking.
 *
 * So the first describe below does not test this module in isolation. It runs
 * the *real* preparation pipeline from `src/lib/preparation` with the
 * inventory module off, and asserts that a plan, a cleaner's view, a staffing
 * estimate, the linen requirement the laundry calculation runs on, and the
 * booking's own price lines all come out intact. Only the forecast is missing,
 * and it is missing with a reason rather than as an empty list.
 */

import { describe, expect, it } from 'vitest'

import { computeReadiness, previewPlan, toCleanerView } from '../preparation'
import {
  BOOKING_ID,
  ORGANIZATION_ID,
  exampleBooking,
  exampleCatalogue,
} from '../preparation/testing/example-configuration'

import { forecastStock } from './forecast'
import {
  capabilitiesFor,
  defaultInventorySettings,
  safetyBufferFor,
  startingSettingsFor,
} from './settings'

describe('with the inventory module off', () => {
  const settings = defaultInventorySettings(ORGANIZATION_ID)
  const capabilities = capabilitiesFor(settings)

  it('is the default, and nothing is on', () => {
    expect(settings.mode).toBe('off')
    expect(Object.values(capabilities).every((value) => value === false)).toBe(
      true,
    )
  })

  /**
   * The whole preparation chain, run for real. If any of this ever depends on
   * a stock module being configured, this test is where it is caught.
   */
  const preview = previewPlan({
    catalogue: exampleCatalogue(),
    booking: exampleBooking(),
    capturedAt: '2026-09-01T08:00:00.000Z',
    planId: 'plan-off-test',
  })

  it('preparation still calculates', () => {
    expect(preview.requirements.length).toBeGreaterThan(0)
    expect(preview.plan.sections.length).toBeGreaterThan(0)
    expect(preview.allocation).toBeDefined()
  })

  it('the cleaner’s plan still works', () => {
    const view = toCleanerView({
      plan: preview.plan,
      propertyLabel: 'אחוזת הבדיקה',
      unitLabel: 'הווילה',
      arrivalAt: exampleBooking().arrivalAt,
      guestCount: exampleBooking().guests,
    })

    expect(view.sections.length).toBeGreaterThan(0)
    expect(view.sections.some((section) => section.items.length > 0)).toBe(true)
  })

  it('the laundry calculation still has its numbers', () => {
    // The laundry module consumes linen requirements. It does not consume
    // stock, and must not: what has to be washed is a function of the party
    // and the beds, not of what happens to be in the cupboard.
    const linen = preview.requirements.filter(
      (requirement) => requirement.category === 'linen',
    )
    expect(linen.length).toBeGreaterThan(0)
    expect(linen.every((requirement) => requirement.quantity > 0)).toBe(true)
  })

  it('staffing and readiness still answer', () => {
    expect(preview.staffing.recommendedStaff).toBeGreaterThan(0)
    expect(preview.staffing.estimatedMinutes).toBeGreaterThan(0)

    // Readiness reads the plan, the money and the contract. It has no stock
    // component and must not grow one: a property is ready when it is clean,
    // paid for and signed, not when a cupboard has been counted.
    const readiness = computeReadiness({
      plan: preview.plan,
      payment: { paid: 400_000, due: 640_000 },
      contractSigned: true,
      policy: exampleCatalogue().readinessPolicy,
      arrivalAt: exampleBooking().arrivalAt,
      now: new Date('2026-09-03T08:00:00.000Z'),
    })
    expect(readiness.lines.length).toBeGreaterThan(0)
    expect(readiness.lines.some((line) => line.component === 'towels')).toBe(
      true,
    )
  })

  it('the booking’s money is untouched', () => {
    const booking = exampleBooking()
    expect(booking.id).toBe(BOOKING_ID)
    expect(booking.priceLines.length).toBeGreaterThan(0)
    expect(
      booking.priceLines.reduce((sum, line) => sum + line.amount, 0),
    ).toBeGreaterThan(0)
  })

  it('and only the forecast is skipped — with a reason, not an empty list', () => {
    const result = forecastStock({
      today: '2026-09-04',
      settings,
      capabilities,
      items: [
        {
          itemId: 'bath_towel',
          label: 'מגבת רחצה',
          propertyId: 'property-a',
          location: null,
          unitOfMeasure: 'יח׳',
          onHandClean: 50,
          byState: { available: 50 },
          reservedTotal: 0,
          minQuantity: null,
          parLevel: null,
        },
      ],
      demand: [],
      returns: [],
    })

    expect(result.computed).toBe(false)
    expect(result.skippedReason).toBe('module_off')
    // "We do not do this" and "nothing to report" must not look the same.
    expect(result.rows).toHaveLength(0)
  })

  it('the safety buffer is zero, so nothing can be reported as breached', () => {
    expect(safetyBufferFor(settings, { parLevel: 60, minQuantity: 20 })).toBe(0)
  })
})

describe('the mode sets what is possible; the flags set what is on', () => {
  it('advanced with discrepancy tracking off does not offer discrepancies', () => {
    const settings = {
      ...startingSettingsFor(ORGANIZATION_ID, 'advanced'),
      discrepancyTracking: false,
    }
    const capabilities = capabilitiesFor(settings)

    expect(capabilities.enabled).toBe(true)
    expect(capabilities.transfers).toBe(true)
    expect(capabilities.discrepancies).toBe(false)
  })

  it('basic counts and does not forecast', () => {
    const capabilities = capabilitiesFor(
      startingSettingsFor(ORGANIZATION_ID, 'basic'),
    )

    expect(capabilities.counting).toBe(true)
    expect(capabilities.reservations).toBe(false)
    expect(capabilities.forecast).toBe(false)
    expect(capabilities.circulation).toBe(false)
  })

  it('tracked without a stated turnaround has no circulation', () => {
    const settings = {
      ...startingSettingsFor(ORGANIZATION_ID, 'tracked'),
      linenTurnaroundDays: null,
    }
    const capabilities = capabilitiesFor(settings)

    // The forecast still runs — reservations are the demand — but nothing
    // comes back, because nobody has said how long a wash takes.
    expect(capabilities.forecast).toBe(true)
    expect(capabilities.circulation).toBe(false)
  })

  it('tracked cannot transfer, whatever the flag says', () => {
    const settings = {
      ...startingSettingsFor(ORGANIZATION_ID, 'tracked'),
      transfersEnabled: true,
    }
    expect(capabilitiesFor(settings).transfers).toBe(false)
  })
})

describe('the safety buffer', () => {
  const settings = {
    ...startingSettingsFor(ORGANIZATION_ID, 'tracked'),
    safetyBufferUnits: 10,
    safetyBufferPercent: 20,
  }

  it('takes the larger of the absolute and the percentage', () => {
    // 20% of 60 is 12, which beats the flat ten. Taking the smaller would
    // silently discard whichever the operator actually meant.
    expect(safetyBufferFor(settings, { parLevel: 60, minQuantity: null })).toBe(
      12,
    )
    expect(safetyBufferFor(settings, { parLevel: 20, minQuantity: null })).toBe(
      10,
    )
  })

  it('is a percentage of the par level, never of what is on the shelf', () => {
    // An item with no par gets the absolute alone. A floor derived from the
    // current count shrinks as stock runs down, which is not a floor.
    expect(
      safetyBufferFor(settings, { parLevel: null, minQuantity: null }),
    ).toBe(10)
  })

  it('honours the per-item reorder point set in 0011', () => {
    // A business that never opened the settings screen still gets the
    // behaviour it configured item by item.
    expect(safetyBufferFor(settings, { parLevel: 10, minQuantity: 25 })).toBe(
      25,
    )
  })
})
