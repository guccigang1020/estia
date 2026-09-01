/**
 * What happens to what a guest bought when the stay itself changes.
 *
 * The three rules, and the three mistakes they prevent:
 *
 *   · a cancelled booking is judged ORDER BY ORDER against the policy each
 *     order was SOLD under — never blanket-cancelled and never
 *     blanket-refunded;
 *   · moved dates re-verify every service and raise an exception rather than
 *     silently carrying a Friday DJ to a Tuesday;
 *   · a changed party recalculates per-guest pricing into an AMENDMENT
 *     requiring consent, never a silent charge.
 */

import { describe, expect, it } from 'vitest'

import {
  planForCancelledBooking,
  planForGuestCountChange,
  planForMovedDates,
} from './propagation'
import type {
  BookingFacts,
  OrderLineSnapshot,
  StoreCancellationPolicy,
  StoreOrder,
} from './types'

const NOW = new Date('2026-03-09T09:00:00.000Z')
/** The stay would have started at three in the afternoon on the 10th. */
const ARRIVAL = new Date('2026-03-10T15:00:00.000Z')

function line(overrides: Partial<OrderLineSnapshot> = {}): OrderLineSnapshot {
  return {
    id: 'line-1',
    orderId: 'order-1',
    itemId: 'item-1',
    packageId: null,
    itemNameSnapshot: 'שולחן שוק',
    itemTypeSnapshot: 'experience',
    pricingModelSnapshot: 'fixed',
    unitPriceAgorot: 150_000,
    optionsAgorot: 0,
    addonsAgorot: 0,
    lineDiscountAgorot: 0,
    quantity: 1,
    lineTotalAgorot: 150_000,
    priceSnapshotAt: '2026-03-01T09:00:00.000Z',
    priceSource: 'catalogue',
    customizationAnswers: {},
    fulfilmentKindSnapshot: 'staff_task',
    fulfilmentRecipeSnapshot: {},
    leadTimeHoursSnapshot: 48,
    cancellationPolicySnapshot: { kind: 'free_until_hours', hoursBefore: 48 },
    providerId: null,
    lineStatus: 'confirmed',
    notes: null,
    sortOrder: 0,
    chosenOptions: [],
    ...overrides,
  }
}

function order(overrides: Partial<StoreOrder> = {}): StoreOrder {
  return {
    id: 'order-1',
    organizationId: 'org-1',
    propertyId: 'property-1',
    bookingId: 'booking-1',
    guestId: 'guest-1',
    reference: 'S-1',
    source: 'guest_portal',
    status: 'confirmed',
    paymentStatus: 'paid',
    paymentMode: 'with_booking',
    currency: 'ILS',
    subtotalAgorot: 150_000,
    discountAgorot: 0,
    taxAgorot: 0,
    totalAgorot: 150_000,
    promoCodeId: null,
    promoCodeSnapshot: null,
    requestedForDate: '2026-03-11',
    requestedForTime: null,
    guestNotes: null,
    internalNotes: null,
    approvedAt: null,
    confirmedAt: null,
    fulfilledAt: null,
    cancelledAt: null,
    cancellationReason: null,
    refundedAt: null,
    amendmentCount: 0,
    createdAt: '2026-03-01T09:00:00.000Z',
    lines: [line()],
    ...overrides,
  }
}

function withPolicy(policy: StoreCancellationPolicy, id: string): StoreOrder {
  return order({
    id,
    reference: `S-${id}`,
    lines: [line({ orderId: id, cancellationPolicySnapshot: policy })],
  })
}

/* ══════════════════════════════════════════════════════════════════════════ */

describe('A CANCELLED BOOKING — never a blanket decision', () => {
  it('gives different answers to two orders on the same booking', () => {
    const plans = planForCancelledBooking({
      orders: [
        // Sold non-refundable: the table was bought from a supplier.
        withPolicy({ kind: 'non_refundable' }, 'table'),
        // Sold free up to 24 hours: the wine has not been opened.
        withPolicy({ kind: 'free_until_hours', hoursBefore: 24 }, 'wine'),
      ],
      arrivalAt: ARRIVAL,
      paidAgorotByOrder: { table: 150_000, wine: 12_000 },
      now: NOW,
    })

    const table = plans.find((plan) => plan.orderId === 'table')
    const wine = plans.find((plan) => plan.orderId === 'wine')

    expect(table?.outcome).toBe('cancel_no_refund')
    expect(table?.refundAgorot).toBe(0)

    // Thirty hours before arrival, so inside the wine's 24-hour free window.
    expect(wine?.outcome).toBe('cancel_refund_full')
    expect(wine?.refundAgorot).toBe(12_000)
  })

  /**
   * The window on the LINE is what decides, and there is no catalogue argument
   * to this function to reach for instead.
   *
   * The cancellation is thirty hours before arrival. An order sold under a
   * 48-hour free window is outside it; one sold under a 24-hour window is
   * inside it. Same moment, same booking, two answers — because the two were
   * sold under different terms and each keeps its own.
   */
  it('judges against the SNAPSHOT policy, and two windows give two answers', () => {
    const plans = planForCancelledBooking({
      orders: [
        withPolicy({ kind: 'free_until_hours', hoursBefore: 48 }, 'strict'),
        withPolicy({ kind: 'free_until_hours', hoursBefore: 24 }, 'lenient'),
      ],
      arrivalAt: ARRIVAL,
      paidAgorotByOrder: { strict: 150_000, lenient: 150_000 },
      now: NOW,
    })

    const strict = plans.find((plan) => plan.orderId === 'strict')
    const lenient = plans.find((plan) => plan.orderId === 'lenient')

    expect(strict?.outcome).toBe('cancel_no_refund')
    expect(strict?.explanation).toContain('48')

    expect(lenient?.outcome).toBe('cancel_refund_full')
    expect(lenient?.refundAgorot).toBe(150_000)
    expect(lenient?.explanation).toContain('24')
  })

  it('refunds by percentage where the policy says so', () => {
    const [plan] = planForCancelledBooking({
      orders: [withPolicy({ kind: 'percentage', refundPercent: 50 }, 'a')],
      arrivalAt: ARRIVAL,
      paidAgorotByOrder: { a: 150_000 },
      now: NOW,
    })

    expect(plan.outcome).toBe('cancel_refund_partial')
    expect(plan.refundAgorot).toBe(75_000)
  })

  it('refunds nothing where nothing was taken, and says so rather than implying a loss', () => {
    const [plan] = planForCancelledBooking({
      orders: [withPolicy({ kind: 'non_refundable' }, 'a')],
      arrivalAt: ARRIVAL,
      now: NOW,
    })

    expect(plan.outcome).toBe('cancel_no_refund_due')
    expect(plan.refundAgorot).toBe(0)
    expect(plan.requiresHuman).toBe(false)
  })

  it('sends an order with no stated policy to a person rather than guessing', () => {
    const [plan] = planForCancelledBooking({
      orders: [withPolicy({ kind: 'unspecified' }, 'a')],
      arrivalAt: ARRIVAL,
      paidAgorotByOrder: { a: 150_000 },
      now: NOW,
    })

    expect(plan.outcome).toBe('needs_decision')
    expect(plan.requiresHuman).toBe(true)
  })

  it('sends an order whose OWN lines disagree to a person', () => {
    const mixed = order({
      id: 'mixed',
      lines: [
        line({
          id: 'a',
          cancellationPolicySnapshot: { kind: 'non_refundable' },
        }),
        line({
          id: 'b',
          cancellationPolicySnapshot: {
            kind: 'free_until_hours',
            hoursBefore: 24,
          },
        }),
      ],
    })

    const [plan] = planForCancelledBooking({
      orders: [mixed],
      arrivalAt: ARRIVAL,
      paidAgorotByOrder: { mixed: 150_000 },
      now: NOW,
    })

    expect(plan.outcome).toBe('needs_decision')
    expect(plan.explanation).toContain('מדיניות ביטול שונה')
  })

  it('sends an already-performed service to a person, because the policy no longer governs', () => {
    const [plan] = planForCancelledBooking({
      orders: [order({ status: 'fulfilled' })],
      arrivalAt: ARRIVAL,
      paidAgorotByOrder: { 'order-1': 150_000 },
      now: NOW,
    })

    expect(plan.outcome).toBe('needs_decision')
    expect(plan.explanation).toContain('כבר בוצע')
  })

  it('leaves an already-closed order alone', () => {
    const plans = planForCancelledBooking({
      orders: [order({ status: 'cancelled' }), order({ status: 'refunded' })],
      arrivalAt: ARRIVAL,
      now: NOW,
    })

    expect(plans).toHaveLength(0)
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('MOVED DATES — every service re-verified on the new date', () => {
  const booking: BookingFacts = {
    id: 'booking-1',
    organizationId: 'org-1',
    propertyId: 'property-1',
    reference: 'B1',
    status: 'confirmed',
    checkIn: '2026-04-10',
    checkOut: '2026-04-13',
    adults: 2,
    children: 0,
    infants: 0,
    propertyCapabilities: [],
    balanceAgorot: 0,
    isConfirmed: true,
    isPaid: false,
    occasion: null,
  }

  it('moves an order whose service still holds', () => {
    const plan = planForMovedDates({
      orders: [order()],
      booking,
      newServiceDateFor: () => '2026-04-11',
      stillAvailable: () => true,
      now: NOW,
    })

    expect(plan.movedOrderIds).toEqual(['order-1'])
    expect(plan.exceptions).toHaveLength(0)
  })

  it('raises an exception where the service is not available on the new date', () => {
    const plan = planForMovedDates({
      orders: [order()],
      booking,
      newServiceDateFor: () => '2026-04-11',
      stillAvailable: () => false,
      now: NOW,
    })

    expect(plan.movedOrderIds).toHaveLength(0)
    expect(plan.exceptions[0].reason).toBe('outside_availability')
  })

  it('never moves an external provider silently — the DJ agreed to a Friday', () => {
    const withProvider = order({
      lines: [
        line({
          itemNameSnapshot: 'תקליטן',
          fulfilmentKindSnapshot: 'external_provider',
          providerId: 'provider-1',
        }),
      ],
    })

    const plan = planForMovedDates({
      orders: [withProvider],
      booking,
      newServiceDateFor: () => '2026-04-11',
      stillAvailable: () => true,
      now: NOW,
    })

    expect(plan.exceptions[0].reason).toBe('provider_must_reconfirm')
    expect(plan.exceptions[0].message).toContain('בקשה חדשה')
  })

  it('raises when the new date is closer than the lead time PROMISED', () => {
    const plan = planForMovedDates({
      orders: [order()],
      booking,
      // A day away, against a promised 48-hour lead time on the line.
      newServiceDateFor: () => '2026-03-10',
      stillAvailable: () => true,
      now: NOW,
    })

    expect(plan.exceptions[0].reason).toBe('lead_time_not_met')
    expect(plan.exceptions[0].message).toContain('48')
  })

  it('raises when the new date has already gone', () => {
    const plan = planForMovedDates({
      orders: [order()],
      booking,
      newServiceDateFor: () => '2026-03-01',
      stillAvailable: () => true,
      now: NOW,
    })

    expect(plan.exceptions[0].reason).toBe('service_date_in_past')
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('A CHANGED PARTY — an amendment, never a silent charge', () => {
  const perGuestOrder = order({
    lines: [
      line({
        itemNameSnapshot: 'ארוחת בוקר',
        pricingModelSnapshot: 'per_guest',
        unitPriceAgorot: 6_000,
        quantity: 2,
        lineTotalAgorot: 12_000,
      }),
    ],
  })

  const grown: BookingFacts = {
    id: 'booking-1',
    organizationId: 'org-1',
    propertyId: 'property-1',
    reference: 'B1',
    status: 'confirmed',
    checkIn: '2026-04-10',
    checkOut: '2026-04-13',
    adults: 2,
    children: 2,
    infants: 0,
    propertyCapabilities: [],
    balanceAgorot: 0,
    isConfirmed: true,
    isPaid: false,
    occasion: null,
  }

  it('recalculates the quantity and requires consent when it costs more', () => {
    const [amendment] = planForGuestCountChange({
      orders: [perGuestOrder],
      booking: grown,
    })

    expect(amendment.previousQuantity).toBe(2)
    expect(amendment.newQuantity).toBe(4)
    expect(amendment.newLineTotalAgorot).toBe(24_000)
    expect(amendment.deltaAgorot).toBe(12_000)
    expect(amendment.requiresConsent).toBe(true)
    expect(amendment.explanation).toContain('אישור האורח')
  })

  it('keeps the SNAPSHOT unit price — only the multiplier moves', () => {
    const [amendment] = planForGuestCountChange({
      orders: [perGuestOrder],
      booking: grown,
    })

    // ₪60 a head, as sold. Four heads. Not this month's breakfast rate.
    expect(amendment.newLineTotalAgorot / amendment.newQuantity).toBe(6_000)
  })

  it('does not require consent when the party shrinks', () => {
    const [amendment] = planForGuestCountChange({
      orders: [perGuestOrder],
      booking: { ...grown, adults: 1, children: 0 },
    })

    expect(amendment.newQuantity).toBe(1)
    expect(amendment.deltaAgorot).toBe(-6_000)
    expect(amendment.requiresConsent).toBe(false)
  })

  it('leaves a fixed-price line entirely alone', () => {
    const amendments = planForGuestCountChange({
      orders: [order()],
      booking: grown,
    })

    expect(amendments).toHaveLength(0)
  })

  it('leaves a per-night line alone — that is the dates’ business, not the party’s', () => {
    const perNight = order({
      lines: [line({ pricingModelSnapshot: 'per_night', quantity: 3 })],
    })

    expect(
      planForGuestCountChange({ orders: [perNight], booking: grown }),
    ).toHaveLength(0)
  })

  it('produces nothing when the party has not actually changed', () => {
    expect(
      planForGuestCountChange({
        orders: [perGuestOrder],
        booking: { ...grown, adults: 2, children: 0 },
      }),
    ).toHaveLength(0)
  })
})
