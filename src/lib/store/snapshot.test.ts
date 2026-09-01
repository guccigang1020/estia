/**
 * ══════════════════════════════════════════════════════════════════════════
 *  THE LOUDEST TEST IN THIS MODULE.
 *
 *  Changing a product's price must never change an existing order.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * שולחן שוק is ₪1,500 today. A guest buys it. Tomorrow the owner raises it to
 * ₪1,800. The order stays ₪1,500 and the next guest sees ₪1,800.
 *
 * This file drives that scenario literally: it builds the catalogue row, takes
 * a snapshot, MUTATES the catalogue row underneath the snapshot, and asserts
 * the snapshot did not move. It is written before the rest of the module's
 * tests deliberately — it is the rule that costs real money when it is wrong,
 * and the one a future refactor is most likely to break by reaching back for a
 * "fresher" price.
 */

import { describe, expect, it } from 'vitest'

import { draftSubtotalAgorot, snapshotLine } from './snapshot'
import type { BookingFacts, CatalogueItem } from './types'

/* ---------------------------------------------------------------- fixtures -- */

const NOW = new Date('2026-03-01T09:00:00.000Z')
const LATER = new Date('2026-03-02T09:00:00.000Z')

/** ₪1,500, in agorot, as the whole product stores money. */
const FIFTEEN_HUNDRED = 150_000
const EIGHTEEN_HUNDRED = 180_000

function marketTable(overrides: Partial<CatalogueItem> = {}): CatalogueItem {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    categoryId: null,
    name: 'שולחן שוק',
    slug: 'market-table',
    shortDescription: 'שולחן עמוס בטוב של האזור, מוכן להגעה.',
    description: null,
    itemType: 'experience',
    status: 'active',
    pricingModel: 'fixed',
    basePriceAgorot: FIFTEEN_HUNDRED,
    costAgorot: null,
    supplierReference: null,
    taxRateBps: null,
    minQuantity: 1,
    maxQuantity: null,
    maxPerBooking: null,
    unitLabel: null,
    leadTimeHours: 48,
    capacityPerDay: null,
    requiresCapability: null,
    minGuests: null,
    maxGuests: null,
    visibilityRule: 'always',
    visibilityDaysBefore: null,
    requiresApproval: null,
    paymentMode: null,
    fulfilmentKind: 'staff_task',
    fulfilmentRecipe: {
      taskType: 'guest_request',
      title: 'להכין שולחן שוק',
      dueOffsetHours: -3,
      checklist: ['לקנות במכולת', 'לסדר על השולחן'],
    },
    providerId: null,
    customizationQuestions: [],
    cancellationPolicy: { kind: 'free_until_hours', hoursBefore: 48 },
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
    id: '33333333-3333-4333-8333-333333333333',
    organizationId: '22222222-2222-4222-8222-222222222222',
    propertyId: '44444444-4444-4444-8444-444444444444',
    reference: 'BA1B2C000',
    status: 'confirmed',
    checkIn: '2026-03-10',
    checkOut: '2026-03-13',
    adults: 2,
    children: 2,
    infants: 0,
    propertyCapabilities: [],
    balanceAgorot: 500_000,
    isConfirmed: true,
    isPaid: false,
    occasion: null,
    ...overrides,
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */

describe('THE PRICE SNAPSHOT — a catalogue price change must not move a placed order', () => {
  it('keeps the order at ₪1,500 after the owner raises the product to ₪1,800', () => {
    const item = marketTable()

    // ── The guest buys, at today's price ────────────────────────────────
    const placed = snapshotLine({ item, booking: booking(), now: NOW })

    expect(placed.unitPriceAgorot).toBe(FIFTEEN_HUNDRED)
    expect(placed.lineTotalAgorot).toBe(FIFTEEN_HUNDRED)

    // ── The owner raises the price the next day ─────────────────────────
    // Mutated in place, on the very object the snapshot was taken from. If
    // the snapshot held a reference rather than a copy, this is what would
    // reach through and change it.
    item.basePriceAgorot = EIGHTEEN_HUNDRED

    // ── THE ASSERTION ───────────────────────────────────────────────────
    expect(placed.unitPriceAgorot).toBe(FIFTEEN_HUNDRED)
    expect(placed.lineTotalAgorot).toBe(FIFTEEN_HUNDRED)
    expect(draftSubtotalAgorot([placed])).toBe(FIFTEEN_HUNDRED)

    // ── And the NEXT guest sees the new price ───────────────────────────
    const next = snapshotLine({ item, booking: booking(), now: LATER })
    expect(next.unitPriceAgorot).toBe(EIGHTEEN_HUNDRED)

    // The two orders coexist at different prices, which is the whole point.
    expect(placed.unitPriceAgorot).not.toBe(next.unitPriceAgorot)
  })

  it('freezes the name, so an archived product still reads as what it was sold as', () => {
    const item = marketTable()
    const placed = snapshotLine({ item, booking: booking(), now: NOW })

    item.name = 'שולחן שוק — הופסק'
    item.status = 'archived'

    expect(placed.itemNameSnapshot).toBe('שולחן שוק')
  })

  it('freezes the pricing model, so per-guest becoming fixed does not re-price a stay', () => {
    const perGuest = marketTable({
      pricingModel: 'per_guest',
      basePriceAgorot: 12_000,
    })

    // Four heads: two adults and two children.
    const placed = snapshotLine({
      item: perGuest,
      booking: booking(),
      now: NOW,
    })

    expect(placed.pricingModelSnapshot).toBe('per_guest')
    expect(placed.quantity).toBe(4)
    expect(placed.lineTotalAgorot).toBe(48_000)

    perGuest.pricingModel = 'fixed'
    expect(placed.pricingModelSnapshot).toBe('per_guest')
    expect(placed.lineTotalAgorot).toBe(48_000)
  })

  it('freezes the operational recipe, so editing it changes the next sale and not this one', () => {
    const item = marketTable()
    const placed = snapshotLine({ item, booking: booking(), now: NOW })

    // The snapshot must be a COPY. Mutating the catalogue's recipe object is
    // the exact way a shared reference would betray itself.
    item.fulfilmentRecipe.title = 'להכין שולחן שוק — גרסה חדשה'
    item.fulfilmentRecipe.dueOffsetHours = -1

    expect(placed.fulfilmentRecipeSnapshot.title).toBe('להכין שולחן שוק')
    expect(placed.fulfilmentRecipeSnapshot.dueOffsetHours).toBe(-3)
  })

  it('freezes the cancellation policy, so tightening terms in March does not retighten February', () => {
    const item = marketTable()
    const placed = snapshotLine({ item, booking: booking(), now: NOW })

    item.cancellationPolicy.kind = 'non_refundable'
    item.cancellationPolicy.hoursBefore = undefined

    expect(placed.cancellationPolicySnapshot).toEqual({
      kind: 'free_until_hours',
      hoursBefore: 48,
    })
  })

  it('freezes the lead time that was promised', () => {
    const item = marketTable()
    const placed = snapshotLine({ item, booking: booking(), now: NOW })

    item.leadTimeHours = 2

    expect(placed.leadTimeHoursSnapshot).toBe(48)
  })

  it('freezes an option label and its delta, so deleting the group leaves the order readable', () => {
    const item = marketTable({
      options: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          name: 'גודל',
          selection: 'single',
          isRequired: true,
          sortOrder: 0,
          values: [
            {
              id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              label: 'לשמונה סועדים',
              priceDeltaAgorot: 40_000,
              isDefault: false,
              isAvailable: true,
              sortOrder: 0,
            },
          ],
        },
      ],
    })

    const placed = snapshotLine({
      item,
      booking: booking(),
      options: [
        {
          optionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          optionValueId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ],
      now: NOW,
    })

    expect(placed.optionsAgorot).toBe(40_000)
    expect(placed.lineTotalAgorot).toBe(FIFTEEN_HUNDRED + 40_000)
    expect(placed.chosenOptions[0]).toMatchObject({
      optionNameSnapshot: 'גודל',
      valueLabelSnapshot: 'לשמונה סועדים',
      priceDeltaAgorot: 40_000,
    })

    // The owner deletes the whole option group.
    item.options = []

    expect(placed.chosenOptions[0].valueLabelSnapshot).toBe('לשמונה סועדים')
    expect(placed.lineTotalAgorot).toBe(FIFTEEN_HUNDRED + 40_000)
  })

  it('records where the price came from, so a figure can be defended later', () => {
    const item = marketTable()

    expect(
      snapshotLine({ item, booking: booking(), now: NOW }).priceSource,
    ).toBe('catalogue')

    const withOverride = snapshotLine({
      item,
      booking: booking(),
      override: {
        itemId: item.id,
        propertyId: booking().propertyId,
        isAvailable: true,
        priceOverrideAgorot: 120_000,
        leadTimeHoursOverride: null,
        capacityPerDayOverride: null,
        providerOverrideId: null,
        notes: null,
      },
      now: NOW,
    })

    expect(withOverride.unitPriceAgorot).toBe(120_000)
    expect(withOverride.priceSource).toBe('override')
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('the line total agrees with what the database will generate', () => {
  /**
   * `store_order_lines.line_total_agorot` is GENERATED ALWAYS as
   * `(unit + options + addons) * quantity - discount`. `snapshotLine`
   * duplicates that arithmetic so a guest can be shown the figure before the
   * row exists, and this is the assertion that the two agree.
   */
  const generated = (line: {
    unitPriceAgorot: number
    optionsAgorot: number
    addonsAgorot: number
    quantity: number
    lineDiscountAgorot: number
  }) =>
    (line.unitPriceAgorot + line.optionsAgorot + line.addonsAgorot) *
      line.quantity -
    line.lineDiscountAgorot

  it('matches for a plain fixed-price line', () => {
    const placed = snapshotLine({
      item: marketTable(),
      booking: booking(),
      now: NOW,
    })
    expect(placed.lineTotalAgorot).toBe(generated(placed))
  })

  it('matches for a per-night line with an add-on and a discount', () => {
    const item = marketTable({
      pricingModel: 'per_night',
      basePriceAgorot: 9_000,
      addons: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          name: 'תאורה',
          description: null,
          priceAgorot: 15_000,
          pricingModel: 'fixed',
          maxQuantity: 2,
          isActive: true,
          sortOrder: 0,
        },
      ],
    })

    const placed = snapshotLine({
      item,
      // Three nights: 10th to 13th.
      booking: booking(),
      addons: [
        { addonId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', quantity: 1 },
      ],
      lineDiscountAgorot: 2_000,
      now: NOW,
    })

    expect(placed.quantity).toBe(3)
    expect(placed.addonsAgorot).toBe(15_000)
    expect(placed.lineTotalAgorot).toBe(generated(placed))
    expect(placed.lineTotalAgorot).toBe((9_000 + 15_000) * 3 - 2_000)
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('quote-priced products', () => {
  const quoted = () =>
    marketTable({
      name: 'קייטרינג לשלושים איש',
      pricingModel: 'quote',
      basePriceAgorot: null,
    })

  it('refuses to invent a price', () => {
    expect(() =>
      snapshotLine({ item: quoted(), booking: booking(), now: NOW }),
    ).toThrowError(/quote-priced/)
  })

  it('takes the figure a person agreed, and records it as a quote', () => {
    const placed = snapshotLine({
      item: quoted(),
      booking: booking(),
      agreedUnitPriceAgorot: 480_000,
      now: NOW,
    })

    expect(placed.unitPriceAgorot).toBe(480_000)
    expect(placed.priceSource).toBe('quote')
  })

  it('refuses a typed price on a product that already has a catalogue one', () => {
    expect(() =>
      snapshotLine({
        item: marketTable(),
        booking: booking(),
        agreedUnitPriceAgorot: 100,
        now: NOW,
      }),
    ).toThrowError(/catalogue price/)
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('customization answers', () => {
  const withQuestion = () =>
    marketTable({
      customizationQuestions: [
        {
          key: 'wine',
          label: 'איזה יין',
          kind: 'choice',
          required: true,
          choices: ['אדום', 'לבן'],
        },
        { key: 'note', label: 'הערה', kind: 'text', required: false },
      ],
    })

  it('stores the answers with the order', () => {
    const placed = snapshotLine({
      item: withQuestion(),
      booking: booking(),
      answers: { wine: 'אדום', note: 'בלי בצל' },
      now: NOW,
    })

    expect(placed.customizationAnswers).toEqual({
      wine: 'אדום',
      note: 'בלי בצל',
    })
  })

  it('refuses an order missing a required answer', () => {
    expect(() =>
      snapshotLine({ item: withQuestion(), booking: booking(), now: NOW }),
    ).toThrowError(/required answer/)
  })

  it('refuses a choice the product never offered', () => {
    expect(() =>
      snapshotLine({
        item: withQuestion(),
        booking: booking(),
        answers: { wine: 'ערק' },
        now: NOW,
      }),
    ).toThrowError(/not among the offered choices/)
  })

  it('drops keys the product never asked about, so a browser cannot post anything it likes', () => {
    const placed = snapshotLine({
      item: withQuestion(),
      booking: booking(),
      answers: { wine: 'לבן', role: 'owner', discount: 9999 },
      now: NOW,
    })

    expect(placed.customizationAnswers).toEqual({ wine: 'לבן' })
  })
})
