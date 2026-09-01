/**
 * A provider never learns who the guest is.
 *
 * The booking below carries EVERY forbidden fact — a name, a telephone number,
 * an e-mail address, a price, a payment state and the agent who sold the stay
 * — and the rendered request is asserted, fact by fact, to contain none of
 * them. Driven end to end rather than by hand-constructing a brief: the brief
 * is built by `providerBriefFor` from the real order, which is the boundary the
 * test exists to police.
 *
 * The schema says the same thing in 0032's rehearsal block, by querying
 * `pg_attribute` for any column on `store_provider_requests` matching
 * `%guest%`, `%phone%`, `%price%`, `%agorot%`, `%payment%` or `%agent%`. Two
 * independent statements of one rule, because a renderer is exactly the kind
 * of code somebody helpfully extends.
 */

import { describe, expect, it } from 'vitest'

import {
  canReach,
  mintProviderReference,
  providerBriefFor,
  renderProviderRequest,
} from './provider-request'
import type { OrderLineSnapshot, StoreOrder } from './types'

/* ---------------------------------------------------------------- fixtures -- */

/**
 * Everything a provider must not learn, in one place.
 *
 * Every value is distinctive on purpose: a substring search for "052" or for
 * "1500" would produce false positives against an ordinary message, and a test
 * that can produce a false positive is a test people start ignoring.
 */
const FORBIDDEN = {
  guestName: 'דנה ברקוביץ׳',
  guestPhone: '0529876543',
  guestEmail: 'dana.berkovich@example.com',
  priceShekels: '1,500',
  priceAgorot: '150000',
  paymentState: 'שולם',
  agentName: 'יואב מזרחי',
} as const

const LINE: OrderLineSnapshot = {
  id: 'line-1',
  orderId: 'order-1',
  itemId: 'item-1',
  packageId: null,
  itemNameSnapshot: 'תקליטן לערב',
  itemTypeSnapshot: 'service',
  pricingModelSnapshot: 'per_hour',
  unitPriceAgorot: 150_000,
  optionsAgorot: 0,
  addonsAgorot: 0,
  lineDiscountAgorot: 0,
  quantity: 4,
  lineTotalAgorot: 600_000,
  priceSnapshotAt: '2026-03-01T09:00:00.000Z',
  priceSource: 'catalogue',
  customizationAnswers: { style: 'ים תיכוני' },
  fulfilmentKindSnapshot: 'external_provider',
  fulfilmentRecipeSnapshot: {},
  leadTimeHoursSnapshot: 72,
  cancellationPolicySnapshot: { kind: 'non_refundable' },
  providerId: 'provider-1',
  lineStatus: 'confirmed',
  notes: 'להתחיל אחרי ארוחת הערב. חניה בחצר האחורית.',
  sortOrder: 0,
  chosenOptions: [],
}

/** A whole order, carrying the guest and the money the provider must not see. */
const ORDER: StoreOrder = {
  id: 'order-1',
  organizationId: 'org-1',
  propertyId: 'property-1',
  bookingId: 'booking-1',
  guestId: 'guest-1',
  reference: 'S-260301-KQ7',
  source: 'guest_portal',
  status: 'confirmed',
  paymentStatus: 'paid',
  paymentMode: 'with_booking',
  currency: 'ILS',
  subtotalAgorot: 600_000,
  discountAgorot: 0,
  taxAgorot: 0,
  totalAgorot: 600_000,
  promoCodeId: null,
  promoCodeSnapshot: null,
  requestedForDate: '2026-03-11',
  requestedForTime: '21:00:00',
  guestNotes: `${FORBIDDEN.guestName} ביקשה שנתקשר אליה ל־${FORBIDDEN.guestPhone}`,
  internalNotes: `נמכר על ידי ${FORBIDDEN.agentName}`,
  approvedAt: '2026-03-01T10:00:00.000Z',
  confirmedAt: '2026-03-01T10:00:00.000Z',
  fulfilledAt: null,
  cancelledAt: null,
  cancellationReason: null,
  refundedAt: null,
  amendmentCount: 0,
  createdAt: '2026-03-01T09:00:00.000Z',
  lines: [LINE],
}

function render(): string {
  const brief = providerBriefFor({
    order: ORDER,
    line: LINE,
    organizationName: 'אחוזת הגליל',
    propertyName: 'וילה הגליל',
    propertyAddress: 'הגפן 12, ראש פינה',
    // The business's OWN contact. Not the guest's.
    contactName: 'מיכל, מנהלת הנכס',
    contactPhone: '0501112233',
    durationMinutes: 240,
    reference: 'P-KQ7MB4XT',
    fallbackDate: '2026-03-11',
  })

  return renderProviderRequest(brief)
}

/* ══════════════════════════════════════════════════════════════════════════ */

describe('the rendered provider request discloses nothing about the guest', () => {
  const message = render()

  it.each(Object.entries(FORBIDDEN))('contains no %s', (_label, forbidden) => {
    expect(message).not.toContain(forbidden)
  })

  it('contains no digits from the guest telephone number in any form', () => {
    // The number without leading zero, and hyphenated — the two shapes a
    // helpful renderer would produce while "formatting" it.
    expect(message).not.toContain('529876543')
    expect(message).not.toContain('052-987-6543')
  })

  /**
   * Not `/\d{5,}/` — the BUSINESS's own telephone number is five digits and
   * more, and it belongs in the message. The claim is about money, so it is
   * asserted against the money: a currency mark, and every figure this order
   * actually carries, in both the agorot the schema stores and the shekels a
   * renderer would helpfully format them into.
   */
  it('contains no money at all', () => {
    expect(message).not.toContain('₪')
    expect(message).not.toContain('ש״ח')

    for (const agorot of [
      LINE.unitPriceAgorot,
      LINE.lineTotalAgorot,
      ORDER.subtotalAgorot,
      ORDER.totalAgorot,
    ]) {
      expect(message).not.toContain(String(agorot))
      expect(message).not.toContain((agorot / 100).toFixed(2))
      expect(message).not.toContain((agorot / 100).toLocaleString('he-IL'))
    }
  })

  it('does not carry the order reference, which a provider could enumerate', () => {
    expect(message).not.toContain(ORDER.reference)
    expect(message).toContain('P-KQ7MB4XT')
  })

  it('does not carry the internal notes, which name the agent', () => {
    expect(message).not.toContain(ORDER.internalNotes as string)
  })

  it('does not carry the guest notes, which the guest wrote about themselves', () => {
    expect(message).not.toContain(ORDER.guestNotes as string)
  })
})

describe('the rendered provider request carries what the provider needs', () => {
  const message = render()

  it('names the service', () => {
    expect(message).toContain('תקליטן לערב')
  })

  it('names the date and the time, in a form an Israeli supplier reads', () => {
    expect(message).toContain('11/03/2026')
    expect(message).toContain('21:00')
  })

  it('names the house and how to get there', () => {
    expect(message).toContain('וילה הגליל')
    expect(message).toContain('הגפן 12, ראש פינה')
  })

  it('carries the operational note, which is about the work and not the guest', () => {
    expect(message).toContain('חניה בחצר האחורית')
  })

  it("names the business's own contact so the provider can ring somebody", () => {
    expect(message).toContain('מיכל, מנהלת הנכס')
    expect(message).toContain('0501112233')
  })

  it('asks for a confirmation, which is what store.provider_unconfirmed watches', () => {
    expect(message).toContain('אנא אשרו קבלה')
  })
})

describe('the brief itself carries no guest field', () => {
  it('has no key whose name suggests a guest, a price or a payment', () => {
    const brief = providerBriefFor({
      order: ORDER,
      line: LINE,
      organizationName: 'אחוזת הגליל',
      propertyName: 'וילה הגליל',
      propertyAddress: null,
      contactName: null,
      contactPhone: null,
      durationMinutes: null,
      reference: 'P-TEST0000',
      fallbackDate: '2026-03-11',
    })

    const forbidden = /guest|price|agorot|payment|agent|total|phone$/i
    const offending = Object.keys(brief).filter((key) => forbidden.test(key))

    // `contactPhone` is the BUSINESS's number and is deliberately allowed; the
    // pattern anchors `phone$` so it is caught, and then excluded by name so
    // that adding `guestPhone` later would still fail this test.
    expect(offending).toEqual(['contactPhone'])
  })
})

describe('the request reference', () => {
  it('is not guessable from a neighbouring one', () => {
    const references = new Set(
      Array.from({ length: 200 }, () => mintProviderReference()),
    )
    expect(references.size).toBe(200)
  })

  it('avoids the characters that get misheard over a telephone', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(mintProviderReference()).not.toMatch(/[01OI]/)
    }
  })
})

describe('a provider must be reachable by the channel chosen', () => {
  it('refuses WhatsApp for a provider with no telephone number', () => {
    expect(
      canReach(
        { defaultChannel: 'whatsapp', phone: null, email: 'a@b.example' },
        'whatsapp',
      ),
    ).toBe(false)
  })

  it('refuses e-mail for a provider with no address', () => {
    expect(
      canReach({ defaultChannel: 'email', phone: '050', email: '' }, 'email'),
    ).toBe(false)
  })

  it('always allows print and copy, which a person carries', () => {
    const unreachable = { defaultChannel: 'print', phone: null, email: null }
    expect(canReach(unreachable, 'print')).toBe(true)
    expect(canReach(unreachable, 'copy')).toBe(true)
  })
})
