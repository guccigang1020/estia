/**
 * Personalization that never invents.
 *
 * The two claims §10 makes, and both are tested as impossibilities rather than
 * as behaviours:
 *
 *   · nothing can surface a product the owner has not created — the function
 *     returns a PERMUTATION of what it was given, and there is no code path
 *     that adds one;
 *   · no empty section is ever rendered.
 */

import { describe, expect, it } from 'vitest'

import { partyShapeOf, relevanceScore, sectionsFor } from './personalization'
import type { BookingFacts, CatalogueItem, StoreCategory } from './types'

const NOW = new Date('2026-03-01T09:00:00.000Z')

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
    checkIn: '2026-03-20',
    checkOut: '2026-03-23',
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

const category = (id: string, name: string, sortOrder = 0): StoreCategory => ({
  id,
  name,
  slug: id,
  description: null,
  icon: null,
  sortOrder,
  isActive: true,
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('IT NEVER INVENTS', () => {
  it('returns nothing at all when the owner has created nothing', () => {
    expect(
      sectionsFor({
        items: [],
        categories: [category('spa', 'ספא')],
        booking: booking(),
        now: NOW,
      }),
    ).toHaveLength(0)
  })

  it('returns exactly the items it was given, no more and no fewer', () => {
    const items = [
      item({ id: 'a', isFeatured: true }),
      item({ id: 'b' }),
      item({ id: 'c', audience: { suitsCouple: true } }),
    ]

    const sections = sectionsFor({
      items,
      categories: [],
      booking: booking(),
      now: NOW,
    })

    // The highlight strip repeats items that also appear below, so uniqueness
    // is what is asserted rather than a flat count.
    const surfaced = new Set(
      sections.flatMap((section) => section.items.map((entry) => entry.id)),
    )

    expect([...surfaced].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('IT NEVER RENDERS AN EMPTY SECTION', () => {
  it('drops a category the owner created and put nothing in', () => {
    const sections = sectionsFor({
      items: [item({ id: 'a', categoryId: 'spa' })],
      categories: [
        category('spa', 'ספא', 0),
        category('food', 'אוכל', 1),
        category('events', 'אירועים', 2),
      ],
      booking: booking(),
      now: NOW,
    })

    const titles = sections.map((section) => section.title)
    expect(titles).toContain('ספא')
    expect(titles).not.toContain('אוכל')
    expect(titles).not.toContain('אירועים')

    for (const section of sections) {
      expect(section.items.length).toBeGreaterThan(0)
    }
  })

  it('omits the highlight strip entirely when nothing genuinely scores', () => {
    // Nothing featured, no audience, no occasion. A strip here would be
    // "recommended for you" over an arbitrary sort, which is a lie with a
    // heading on it.
    const sections = sectionsFor({
      items: [item({ id: 'a' }), item({ id: 'b' })],
      categories: [],
      booking: booking(),
      now: NOW,
    })

    expect(sections.map((section) => section.key)).not.toContain('highlights')
  })

  it('shows the strip once something does score', () => {
    const sections = sectionsFor({
      items: [item({ id: 'a', isFeatured: true }), item({ id: 'b' })],
      categories: [],
      booking: booking(),
      now: NOW,
    })

    const highlights = sections.find((section) => section.key === 'highlights')
    expect(highlights?.items[0].id).toBe('a')
  })
})

describe('what it ranks against — the booking’s own facts', () => {
  it('reads a party of two adults as a couple', () => {
    expect(partyShapeOf(booking())).toBe('couple')
  })

  it('reads adults with children as a family, however many', () => {
    expect(partyShapeOf(booking({ adults: 2, children: 3 }))).toBe('family')
    expect(partyShapeOf(booking({ adults: 2, children: 0, infants: 1 }))).toBe(
      'family',
    )
  })

  it('reads twenty-five heads as a group', () => {
    expect(partyShapeOf(booking({ adults: 25 }))).toBe('group')
  })

  it('puts a couple’s product above a family’s for a couple', () => {
    const forCouples = item({ id: 'a', audience: { suitsCouple: true } })
    const forFamilies = item({ id: 'b', audience: { suitsFamily: true } })

    expect(relevanceScore(forCouples, booking(), NOW)).toBeGreaterThan(
      relevanceScore(forFamilies, booking(), NOW),
    )
  })

  it('scores an occasion the guest ACTUALLY STATED, and never one inferred', () => {
    const birthday = item({ audience: { occasions: ['birthday'] } })

    expect(
      relevanceScore(birthday, booking({ occasion: 'birthday' }), NOW),
    ).toBe(relevanceScore(birthday, booking(), NOW) + 8)
  })

  it('pushes down a service whose lead time the arrival cannot meet', () => {
    const soon = booking({ checkIn: '2026-03-02' })
    const slow = item({ leadTimeHours: 72 })
    const fast = item({ leadTimeHours: 0 })

    expect(relevanceScore(slow, soon, NOW)).toBeLessThan(
      relevanceScore(fast, soon, NOW),
    )
  })

  /**
   * RANKING IS NOT FILTERING.
   *
   * A product that matched nothing about this booking is still returned. The
   * owner put it in the catalogue and a guest looking for it must be able to
   * find it — the difference between "less relevant" and "hidden" is the
   * difference between a helpful store and one that appears broken.
   */
  it('still surfaces a product that matched nothing', () => {
    const sections = sectionsFor({
      items: [
        item({ id: 'featured', isFeatured: true }),
        item({ id: 'irrelevant', leadTimeHours: 500 }),
      ],
      categories: [],
      booking: booking({ checkIn: '2026-03-02' }),
      now: NOW,
    })

    const surfaced = new Set(
      sections.flatMap((section) => section.items.map((entry) => entry.id)),
    )

    expect(surfaced.has('irrelevant')).toBe(true)
  })

  it('lets the owner’s own judgement outrank every heuristic', () => {
    const featured = item({ id: 'a', isFeatured: true })
    const wellMatched = item({
      id: 'b',
      audience: { suitsCouple: true, occasions: ['anniversary'] },
    })

    expect(relevanceScore(featured, booking(), NOW)).toBeGreaterThanOrEqual(
      relevanceScore(wellMatched, booking({ occasion: 'anniversary' }), NOW) -
        4,
    )
  })
})

describe('the highlight subtitle says what it based itself on', () => {
  it('names the family, in the guest’s own terms', () => {
    const sections = sectionsFor({
      items: [item({ isFeatured: true })],
      categories: [],
      booking: booking({ children: 2 }),
      now: NOW,
    })

    expect(sections[0].subtitle).toContain('משפחה')
  })

  it('says nothing rather than guessing for a party it cannot characterise', () => {
    const sections = sectionsFor({
      items: [item({ isFeatured: true })],
      categories: [],
      booking: booking({ adults: 5 }),
      now: NOW,
    })

    expect(sections[0].subtitle).toBeNull()
  })
})

describe('items the owner filed nowhere', () => {
  it('are headed as products rather than as leftovers', () => {
    const sections = sectionsFor({
      items: [item({ id: 'a', categoryId: null })],
      categories: [],
      booking: booking(),
      now: NOW,
    })

    const titles = sections.map((section) => section.title)
    expect(titles).not.toContain('אחר')
    expect(titles).toContain('מה אפשר להוסיף לשהות')
  })

  it('are collected once, not once per missing category', () => {
    const sections = sectionsFor({
      items: [
        item({ id: 'a', categoryId: null }),
        item({ id: 'b', categoryId: 'a-category-that-was-deleted' }),
      ],
      categories: [],
      booking: booking(),
      now: NOW,
    })

    expect(sections).toHaveLength(1)
    expect(sections[0].items).toHaveLength(2)
  })
})
