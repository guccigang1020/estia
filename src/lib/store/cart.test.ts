/**
 * The basket, and the moment before it becomes an order.
 *
 * §12's claim in one file: a product that changed while the guest was looking
 * at it produces a REVALIDATION with words, not a silent charge at the new
 * price, not a charge at the stale one, and not an emptied basket.
 *
 * `idempotency` is here too, because it answers the other half of the same
 * question — what happens when the guest presses send twice.
 */

import { describe, expect, it } from 'vitest'

import { cartCount, isCartExpired, revalidateCart, type Cart } from './cart'
import {
  operationIdempotencyKey,
  submissionFingerprint,
  submissionKey,
} from './idempotency'
import type { EligibilityInput } from './eligibility'
import type { BookingFacts, CatalogueItem, StoreSettings } from './types'

const NOW = new Date('2026-03-01T09:00:00.000Z')

const SETTINGS: StoreSettings = {
  organizationId: 'org-1',
  propertyId: null,
  mode: 'simple',
  defaultPaymentMode: 'with_booking',
  paymentModesEnabled: [],
  approvalRequiredDefault: false,
  guestStoreEnabled: true,
  guestStoreHeading: null,
  guestStoreIntro: null,
  currency: 'ILS',
  orderReferencePrefix: 'S',
  cartTtlHours: 72,
}

const BOOKING: BookingFacts = {
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
}

function item(overrides: Partial<CatalogueItem> = {}): CatalogueItem {
  return {
    id: 'item-1',
    organizationId: 'org-1',
    categoryId: null,
    name: 'שולחן שוק',
    slug: 'market-table',
    shortDescription: null,
    description: null,
    itemType: 'experience',
    status: 'active',
    pricingModel: 'fixed',
    basePriceAgorot: 150_000,
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

function cart(overrides: Partial<Cart['lines'][number]> = {}): Cart {
  return {
    updatedAt: '2026-03-01T08:00:00.000Z',
    lines: [
      {
        itemId: 'item-1',
        quantity: 1,
        optionValueIds: [],
        addons: [],
        answers: {},
        seenUnitPriceAgorot: 150_000,
        seenLineTotalAgorot: 150_000,
        ...overrides,
      },
    ],
  }
}

/** The eligibility question, with everything permissive unless a test says so. */
function eligibilityFor(
  usage: { onDate: number; onBooking: number } = { onDate: 0, onBooking: 0 },
) {
  return (candidate: CatalogueItem): EligibilityInput => ({
    item: candidate,
    settings: SETTINGS,
    booking: BOOKING,
    override: null,
    rules: [],
    occupancy: {
      extendedStay: 'available',
      cleaningWindow: 'available',
      spareCapacity: null,
    },
    usage,
    serviceAt: new Date('2026-03-10T15:00:00.000Z'),
    now: NOW,
    audience: 'guest',
  })
}

/* ══════════════════════════════════════════════════════════════════════════ */

describe('a basket nothing happened to', () => {
  it('passes through unchanged and needs no second confirmation', () => {
    const result = revalidateCart({
      cart: cart(),
      items: [item()],
      overrides: {},
      eligibilityFor: eligibilityFor(),
    })

    expect(result.lines).toHaveLength(1)
    expect(result.changes).toHaveLength(0)
    expect(result.subtotalAgorot).toBe(150_000)
    expect(result.requiresReconfirmation).toBe(false)
  })
})

describe('A PRICE THAT MOVED WHILE THE GUEST WAS LOOKING', () => {
  it('prices at the NEW figure and tells the guest, rather than charging either silently', () => {
    const result = revalidateCart({
      cart: cart(),
      items: [item({ basePriceAgorot: 180_000 })],
      overrides: {},
      eligibilityFor: eligibilityFor(),
    })

    // Priced at what the catalogue says NOW…
    expect(result.lines[0].unitPriceAgorot).toBe(180_000)
    expect(result.subtotalAgorot).toBe(180_000)

    // …and the guest is told, in words, before anything is submitted.
    expect(result.changes[0].kind).toBe('price_increased')
    expect(result.changes[0].deltaAgorot).toBe(30_000)
    expect(result.changes[0].message).toContain('בלי שתאשר')
    expect(result.requiresReconfirmation).toBe(true)
  })

  /**
   * A price that went DOWN still requires a second confirmation.
   *
   * It is a smaller number than the one on the screen in front of the guest,
   * and a total that changes under somebody's hand — in either direction — is
   * a total they did not agree to.
   */
  it('requires reconfirmation even when the price went down', () => {
    const result = revalidateCart({
      cart: cart(),
      items: [item({ basePriceAgorot: 120_000 })],
      overrides: {},
      eligibilityFor: eligibilityFor(),
    })

    expect(result.changes[0].kind).toBe('price_decreased')
    expect(result.requiresReconfirmation).toBe(true)
    expect(result.subtotalAgorot).toBe(120_000)
  })
})

describe('a product that stopped being available', () => {
  it('removes a product that has left the catalogue entirely', () => {
    const result = revalidateCart({
      cart: cart(),
      items: [],
      overrides: {},
      eligibilityFor: eligibilityFor(),
    })

    expect(result.lines).toHaveLength(0)
    expect(result.changes[0].kind).toBe('item_removed')
    expect(result.requiresReconfirmation).toBe(true)
  })

  it('removes a product that was paused, and repeats the reason', () => {
    const result = revalidateCart({
      cart: cart(),
      items: [item({ status: 'paused' })],
      overrides: {},
      eligibilityFor: eligibilityFor(),
    })

    expect(result.lines).toHaveLength(0)
    expect(result.changes[0].kind).toBe('item_unavailable')
    expect(result.changes[0].message).toContain('שולחן שוק')
  })

  it('removes a product that became quote-priced, rather than inventing a number', () => {
    const result = revalidateCart({
      cart: cart(),
      items: [item({ pricingModel: 'quote', basePriceAgorot: null })],
      overrides: {},
      eligibilityFor: eligibilityFor(),
    })

    expect(result.lines).toHaveLength(0)
    expect(result.changes[0].message).toContain('הצעה')
  })
})

describe('THE LAST SLOT', () => {
  it('reduces the quantity to what is left, and says how many that is', () => {
    const result = revalidateCart({
      cart: cart({ quantity: 4 }),
      items: [item({ capacityPerDay: 5 })],
      overrides: {},
      eligibilityFor: eligibilityFor({ onDate: 3, onBooking: 0 }),
    })

    expect(result.lines[0].quantity).toBe(2)
    expect(result.changes[0].kind).toBe('quantity_reduced')
    expect(result.changes[0].message).toContain('2')
  })

  it('removes the line entirely once nothing is left', () => {
    const result = revalidateCart({
      cart: cart({ quantity: 1 }),
      items: [item({ capacityPerDay: 3 })],
      overrides: {},
      eligibilityFor: eligibilityFor({ onDate: 3, onBooking: 0 }),
    })

    expect(result.lines).toHaveLength(0)
    expect(result.changes[0].kind).toBe('item_unavailable')
  })
})

describe('an option that disappeared', () => {
  it('tells the guest to choose again rather than substituting a default', () => {
    const withOption = item({
      options: [
        {
          id: 'opt-1',
          name: 'גודל',
          selection: 'single',
          isRequired: true,
          sortOrder: 0,
          values: [],
        },
      ],
    })

    const result = revalidateCart({
      cart: cart({ optionValueIds: ['value-that-is-gone'] }),
      items: [withOption],
      overrides: {},
      eligibilityFor: eligibilityFor(),
    })

    expect(
      result.changes.some((change) => change.kind === 'option_removed'),
    ).toBe(true)
    expect(result.requiresReconfirmation).toBe(true)
  })
})

describe('a stale basket', () => {
  it('is expired past the organization’s own window', () => {
    expect(
      isCartExpired(
        { lines: [], updatedAt: '2026-02-25T09:00:00.000Z' },
        72,
        NOW,
      ),
    ).toBe(true)
  })

  it('is not expired inside it', () => {
    expect(
      isCartExpired(
        { lines: [], updatedAt: '2026-02-28T09:00:00.000Z' },
        72,
        NOW,
      ),
    ).toBe(false)
  })

  it('counts what is in it, for the badge', () => {
    expect(cartCount(cart({ quantity: 3 }))).toBe(3)
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('THE SUBMISSION KEY — two taps are one order', () => {
  const purchase = {
    organizationId: 'org-1',
    bookingId: 'booking-1',
    requestedForDate: '2026-03-11',
    lines: [
      { itemId: 'item-a', quantity: 2, optionValueIds: ['v2', 'v1'] },
      { itemId: 'item-b', quantity: 1 },
    ],
  }

  it('is the same for a cart whose lines and options are in a different order', () => {
    const reordered = {
      ...purchase,
      lines: [
        { itemId: 'item-b', quantity: 1 },
        { itemId: 'item-a', quantity: 2, optionValueIds: ['v1', 'v2'] },
      ],
    }

    expect(submissionFingerprint(reordered)).toBe(
      submissionFingerprint(purchase),
    )
  })

  it('differs when the quantity differs', () => {
    expect(
      submissionFingerprint({
        ...purchase,
        lines: [{ itemId: 'item-a', quantity: 3 }],
      }),
    ).not.toBe(submissionFingerprint(purchase))
  })

  /**
   * The same massage on Friday and on Saturday is two orders.
   *
   * A key that ignored the date would silently swallow the second, which is
   * the failure mode of an idempotency key that is too coarse — worse than one
   * that is too fine, because the guest loses a purchase they made.
   */
  it('differs when the requested date differs', () => {
    expect(
      submissionFingerprint({ ...purchase, requestedForDate: '2026-03-12' }),
    ).not.toBe(submissionFingerprint(purchase))
  })

  it('differs across organizations, so two tenants can never collide', () => {
    expect(
      submissionFingerprint({ ...purchase, organizationId: 'org-2' }),
    ).not.toBe(submissionFingerprint(purchase))
  })

  /**
   * The PRICE is deliberately not in the key.
   *
   * A price that moved between the two taps is exactly the case
   * `revalidateCart` surfaces. If the price were in the key, the second tap
   * would create a SECOND order at the new price — the outcome this whole
   * module exists to prevent.
   */
  it('is unchanged by a price that moved between the two taps', () => {
    const fingerprint = submissionFingerprint(purchase)
    // There is no price field to change; the assertion is that the shape
    // carries none, which this documents against a future addition.
    expect(fingerprint).not.toMatch(/\d{5,}/)
  })

  it('hashes to a fixed-width hex digest that discloses nothing', async () => {
    const key = await submissionKey(purchase)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).toBe(await submissionKey(purchase))
    expect(key).not.toContain('item-a')
  })

  it('namespaces an operation key so approving cannot replay cancelling', () => {
    expect(operationIdempotencyKey('store.order.approve', 'order-1')).not.toBe(
      operationIdempotencyKey('store.order.cancel', 'order-1'),
    )
  })
})
