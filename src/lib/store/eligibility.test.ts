/**
 * Booking-aware eligibility.
 *
 * The point of these tests is that NOTHING about "late checkout" or "pool
 * heating" is in the code. Each case below configures an ordinary catalogue
 * row until it behaves like the thing the brief names, which is the claim
 * §4 actually makes: lead time and capacity are configuration per item.
 */

import { describe, expect, it } from 'vitest'

import { evaluateEligibility, type EligibilityInput } from './eligibility'
import type {
  BookingFacts,
  CatalogueItem,
  StoreAvailabilityRule,
  StoreSettings,
} from './types'

const NOW = new Date('2026-03-01T09:00:00.000Z')

const SETTINGS: StoreSettings = {
  organizationId: 'org-1',
  propertyId: null,
  mode: 'simple',
  defaultPaymentMode: 'with_booking',
  paymentModesEnabled: [],
  approvalRequiredDefault: true,
  guestStoreEnabled: true,
  guestStoreHeading: null,
  guestStoreIntro: null,
  currency: 'ILS',
  orderReferencePrefix: 'S',
  cartTtlHours: 72,
}

function item(overrides: Partial<CatalogueItem> = {}): CatalogueItem {
  return {
    id: 'item-1',
    organizationId: 'org-1',
    categoryId: null,
    name: 'פריט',
    slug: 'item',
    shortDescription: null,
    description: null,
    itemType: 'service',
    status: 'active',
    pricingModel: 'fixed',
    basePriceAgorot: 10_000,
    costAgorot: null,
    supplierReference: null,
    taxRateBps: null,
    minQuantity: 1,
    maxQuantity: null,
    maxPerBooking: null,
    unitLabel: null,
    leadTimeHours: 0,
    capacityPerDay: null,
    requiresCapability: null,
    minGuests: null,
    maxGuests: null,
    visibilityRule: 'always',
    visibilityDaysBefore: null,
    requiresApproval: null,
    paymentMode: null,
    fulfilmentKind: 'none',
    fulfilmentRecipe: {},
    providerId: null,
    customizationQuestions: [],
    cancellationPolicy: { kind: 'unspecified' },
    media: [],
    tags: [],
    audience: {},
    isFeatured: false,
    sortOrder: 0,
    options: [],
    addons: [],
    ...overrides,
  }
}

function booking(overrides: Partial<BookingFacts> = {}): BookingFacts {
  return {
    id: 'booking-1',
    organizationId: 'org-1',
    propertyId: 'property-1',
    reference: 'B1',
    status: 'confirmed',
    checkIn: '2026-03-10',
    checkOut: '2026-03-13',
    adults: 2,
    children: 0,
    infants: 0,
    propertyCapabilities: [],
    balanceAgorot: 0,
    isConfirmed: true,
    isPaid: false,
    occasion: null,
    ...overrides,
  }
}

function ask(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    item: item(),
    settings: SETTINGS,
    booking: booking(),
    override: null,
    rules: [],
    occupancy: {
      extendedStay: 'available',
      cleaningWindow: 'available',
      spareCapacity: null,
    },
    usage: { onDate: 0, onBooking: 0 },
    serviceAt: new Date('2026-03-10T15:00:00.000Z'),
    now: NOW,
    audience: 'guest',
    ...overrides,
  }
}

describe('the store being off refuses everything, and says so first', () => {
  it('refuses before any other reason is reached', () => {
    const verdict = evaluateEligibility(
      ask({
        settings: { ...SETTINGS, mode: 'off' },
        // A lead time that would ALSO refuse. The store-off reason must win,
        // because telling a guest to book earlier for a shop that does not
        // exist is worse than useless.
        item: item({ leadTimeHours: 10_000 }),
      }),
    )

    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toBe('store_off')
  })
})

describe('POOL HEATING — the property has to be able to do it', () => {
  const poolHeating = item({
    name: 'חימום בריכה',
    itemType: 'property_addon',
    requiresCapability: 'heated_pool',
    leadTimeHours: 24,
  })

  it('is refused at a house with no heated pool', () => {
    const verdict = evaluateEligibility(
      ask({
        item: poolHeating,
        booking: booking({ propertyCapabilities: [] }),
      }),
    )

    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toBe('capability_missing')
    expect(verdict.message).toContain('אינו מצויד')
  })

  it('is offered where the property carries the capability', () => {
    const verdict = evaluateEligibility(
      ask({
        item: poolHeating,
        booking: booking({ propertyCapabilities: ['heated_pool'] }),
      }),
    )

    expect(verdict.eligible).toBe(true)
  })

  it('is refused when the lead time is not met, and says how much notice is needed', () => {
    const verdict = evaluateEligibility(
      ask({
        item: poolHeating,
        booking: booking({ propertyCapabilities: ['heated_pool'] }),
        // Twelve hours away; the item wants twenty-four.
        serviceAt: new Date('2026-03-01T21:00:00.000Z'),
      }),
    )

    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toBe('lead_time_not_met')
    expect(verdict.message).toContain('מראש')
  })
})

describe('LATE CHECKOUT — the calendar and the cleaning schedule decide', () => {
  const lateCheckout = item({
    name: 'צ׳ק אאוט מאוחר',
    itemType: 'property_addon',
    leadTimeHours: 2,
  })

  it('is refused when another booking arrives that day', () => {
    const verdict = evaluateEligibility(
      ask({
        item: lateCheckout,
        occupancy: {
          extendedStay: 'conflicting',
          cleaningWindow: 'available',
          spareCapacity: null,
        },
      }),
    )

    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toBe('conflicting_booking')
  })

  it('is refused when the cleaning schedule cannot absorb it', () => {
    const verdict = evaluateEligibility(
      ask({
        item: lateCheckout,
        occupancy: {
          extendedStay: 'available',
          cleaningWindow: 'conflicting',
          spareCapacity: null,
        },
      }),
    )

    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toBe('cleaning_window')
  })

  /**
   * The null occupancy port answers "unknown" to everything, and this is the
   * behaviour that decision produces: the product is OFFERED, with a caveat.
   *
   * Neither of the alternatives is acceptable. Hiding it takes a real sale
   * from a business whose calendar module is not wired yet; promising it makes
   * the product lie.
   */
  it('is offered with a caveat when the calendar cannot be consulted', () => {
    const verdict = evaluateEligibility(
      ask({
        item: lateCheckout,
        occupancy: {
          extendedStay: 'unknown',
          cleaningWindow: 'unknown',
          spareCapacity: null,
        },
      }),
    )

    expect(verdict.eligible).toBe(true)
    expect(verdict.caveats).toContain('occupancy_unknown')
    expect(verdict.caveats).toContain('cleaning_unknown')
  })
})

describe('AN EXTRA MATTRESS — capacity', () => {
  it('is refused once the day is full', () => {
    const verdict = evaluateEligibility(
      ask({
        item: item({ name: 'מזרן נוסף', capacityPerDay: 3 }),
        usage: { onDate: 3, onBooking: 0 },
      }),
    )

    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toBe('capacity_full')
  })

  it('reports how many remain, tightened by the per-booking ceiling', () => {
    const verdict = evaluateEligibility(
      ask({
        item: item({ capacityPerDay: 10, maxPerBooking: 2 }),
        usage: { onDate: 4, onBooking: 1 },
      }),
    )

    expect(verdict.eligible).toBe(true)
    // Six left in the day, one left on this booking. The tighter one wins.
    expect(verdict.remaining).toBe(1)
  })

  it('is refused once this booking has had its allowance', () => {
    const verdict = evaluateEligibility(
      ask({
        item: item({ maxPerBooking: 1 }),
        usage: { onDate: 0, onBooking: 1 },
      }),
    )

    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toBe('max_per_booking_reached')
    expect(verdict.message).toContain('כבר הזמנת')
  })
})

describe('the party band', () => {
  it('refuses a romantic dinner for a party of twenty-five', () => {
    const verdict = evaluateEligibility(
      ask({
        item: item({ name: 'ארוחה זוגית', maxGuests: 2 }),
        booking: booking({ adults: 25 }),
      }),
    )

    expect(verdict.reason).toBe('party_too_large')
  })

  it('refuses a group activity for two', () => {
    const verdict = evaluateEligibility(
      ask({
        item: item({ minGuests: 10 }),
        booking: booking({ adults: 2 }),
      }),
    )

    expect(verdict.reason).toBe('party_too_small')
  })
})

describe('the property override is the strongest statement', () => {
  it('refuses a product switched off at this house, before any other reason', () => {
    const verdict = evaluateEligibility(
      ask({
        item: item({ requiresCapability: 'heated_pool' }),
        override: {
          itemId: 'item-1',
          propertyId: 'property-1',
          isAvailable: false,
          priceOverrideAgorot: null,
          leadTimeHoursOverride: null,
          capacityPerDayOverride: null,
          providerOverrideId: null,
          notes: null,
        },
      }),
    )

    expect(verdict.reason).toBe('not_offered_here')
  })

  it('applies the property lead time in place of the catalogue one', () => {
    const verdict = evaluateEligibility(
      ask({
        item: item({ leadTimeHours: 0 }),
        override: {
          itemId: 'item-1',
          propertyId: 'property-1',
          isAvailable: true,
          priceOverrideAgorot: null,
          leadTimeHoursOverride: 500,
          capacityPerDayOverride: null,
          providerOverrideId: null,
          notes: null,
        },
      }),
    )

    expect(verdict.reason).toBe('lead_time_not_met')
  })
})

describe('availability rules', () => {
  const rule = (
    overrides: Partial<StoreAvailabilityRule> = {},
  ): StoreAvailabilityRule => ({
    id: 'rule-1',
    itemId: null,
    propertyId: null,
    kind: 'blackout',
    weekdays: [],
    fromDate: null,
    toDate: null,
    fromTime: null,
    toTime: null,
    maxPerDay: null,
    isBlocking: true,
    note: null,
    isActive: true,
    ...overrides,
  })

  it('a blackout over the service date refuses, with the owner’s own words', () => {
    const verdict = evaluateEligibility(
      ask({
        rules: [
          rule({
            fromDate: '2026-03-08',
            toDate: '2026-03-12',
            note: 'סגורים לחופשה שנתית.',
          }),
        ],
      }),
    )

    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toBe('blocked_by_rule')
    expect(verdict.message).toBe('סגורים לחופשה שנתית.')
  })

  it('a permitting weekday rule is a whitelist — the DJ works Fridays only', () => {
    // 2026-03-10 is a Tuesday (ISO weekday 2). The rule permits Friday (5).
    const rules = [
      rule({
        kind: 'weekday',
        weekdays: [5],
        isBlocking: false,
        itemId: 'item-1',
      }),
    ]

    expect(evaluateEligibility(ask({ rules })).reason).toBe(
      'outside_permitted_window',
    )

    // The following Friday, 2026-03-13.
    const onFriday = evaluateEligibility(
      ask({ rules, serviceAt: new Date('2026-03-13T20:00:00.000Z') }),
    )
    expect(onFriday.eligible).toBe(true)
  })

  it('a rule may tighten the per-day ceiling below the item’s own', () => {
    const verdict = evaluateEligibility(
      ask({
        item: item({ capacityPerDay: 10 }),
        rules: [
          rule({
            kind: 'season',
            isBlocking: false,
            maxPerDay: 2,
            fromDate: '2026-01-01',
            toDate: '2026-12-31',
          }),
        ],
        usage: { onDate: 2, onBooking: 0 },
      }),
    )

    expect(verdict.reason).toBe('capacity_full')
  })
})

describe('visibility applies to a guest and not to staff', () => {
  const preArrival = item({
    visibilityRule: 'days_before_arrival',
    visibilityDaysBefore: 3,
  })

  it('hides a pre-arrival offer from a guest who is nine days out', () => {
    const verdict = evaluateEligibility(ask({ item: preArrival }))
    expect(verdict.reason).toBe('not_visible_yet')
    expect(verdict.message).toContain('3 ימים לפני ההגעה')
  })

  it('shows it to the guest once the window opens', () => {
    const verdict = evaluateEligibility(
      ask({ item: preArrival, now: new Date('2026-03-08T09:00:00.000Z') }),
    )
    expect(verdict.eligible).toBe(true)
  })

  it('never hides it from a member of staff selling by telephone', () => {
    const verdict = evaluateEligibility(
      ask({ item: preArrival, audience: 'staff' }),
    )
    expect(verdict.eligible).toBe(true)
  })

  it('hides an after-payment offer until the stay is paid', () => {
    const item_ = item({ visibilityRule: 'after_payment' })
    expect(evaluateEligibility(ask({ item: item_ })).reason).toBe(
      'not_visible_yet',
    )
    expect(
      evaluateEligibility(
        ask({ item: item_, booking: booking({ isPaid: true }) }),
      ).eligible,
    ).toBe(true)
  })
})

describe('a paused product is not sold', () => {
  it('refuses anything that is not active', () => {
    for (const status of ['draft', 'paused', 'archived'] as const) {
      expect(evaluateEligibility(ask({ item: item({ status }) })).reason).toBe(
        'item_not_active',
      )
    }
  })
})
