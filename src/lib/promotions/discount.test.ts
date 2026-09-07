import { describe, expect, it } from 'vitest'

import { priceStay, roundAgorot } from '../booking'
import {
  discountAgorot,
  toDiscountRequest,
  type DiscountBase,
} from './discount'
import type { DiscountTerms } from './types'

function base(over: Partial<DiscountBase> = {}): DiscountBase {
  return {
    // The worked example in docs/spec/20-pricing.md §7.11: three nights, two
    // extra guests, a cleaning fee. 556,000 agorot before any discount.
    stayTotalAgorot: 556_000,
    accommodationAgorot: 459_000,
    ...over,
  }
}

const percent = (
  bps: number,
  appliesTo: DiscountTerms['appliesTo'] = 'stay_total',
) =>
  ({ discountKind: 'percent', discountValue: bps, appliesTo }) as DiscountTerms

describe('the worked example in the spec comes out to the number the spec prints', () => {
  it('takes 5% off 556,000 and gets exactly 27,800', () => {
    // §7.11 is chosen so it can be checked with a pencil. If this ever moves,
    // either the rounding changed or the basis did, and both are worth a stop.
    expect(discountAgorot(percent(500), base())).toEqual({ agorot: 27_800 })
  })

  it('produces a booking total of 723,276 when handed to priceStay', () => {
    // The end-to-end claim: this module produces INPUT, priceStay produces the
    // price, and the two together reproduce the spec's invoice line for line.
    const request = toDiscountRequest(percent(500), base(), 'הזמנה ישירה 5%')
    expect(request).not.toBeNull()

    const quote = priceStay({
      range: { checkIn: '2026-10-02', checkOut: '2026-10-05' },
      baseNightlyAgorot: 95_000,
      nightlyOverrides: { '2026-10-02': 182_000, '2026-10-03': 182_000 },
      guests: 4,
      includedGuests: 2,
      extraGuestNightlyAgorot: 12_000,
      cleaningFeeAgorot: 25_000,
      discounts: request === null ? [] : [request],
      taxRatePercent: 18,
      depositAgorot: 100_000,
    })

    expect(quote.totalAgorot).toBe(723_276)
    expect(quote.stayTotalAgorot).toBe(623_276)
    expect(quote.taxAgorot).toBe(95_076)
    // The rule the whole module serves: the total is the sum of the lines.
    expect(quote.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(
      quote.totalAgorot,
    )
  })
})

describe('a percentage rounds in one direction, and it is the guest’s', () => {
  it('rounds a half agora up in magnitude, so the guest gets the larger discount', () => {
    // 1,001 agorot at 5% is 50.05 — not a half. 1,010 at 5% is 50.5 exactly,
    // which is the case that decides the direction.
    expect(
      discountAgorot(percent(500), base({ stayTotalAgorot: 1_010 })),
    ).toEqual({
      agorot: 51,
    })
  })

  it('uses the same rounding roundAgorot does, and not a second definition', () => {
    for (const subtotal of [1_010, 3_333, 7_777, 123_457, 999_999]) {
      for (const bps of [333, 500, 1_250, 3_333]) {
        expect(
          discountAgorot(percent(bps), base({ stayTotalAgorot: subtotal })),
        ).toEqual({ agorot: roundAgorot((subtotal * bps) / 10_000) })
      }
    }
  })

  it('never returns a fraction of an agora', () => {
    for (const bps of [1, 7, 333, 1_667, 9_999]) {
      const result = discountAgorot(percent(bps), base())
      expect(result.agorot).not.toBeNull()
      expect(Number.isInteger(result.agorot as number)).toBe(true)
    }
  })
})

describe('a discount is bounded by what there is to discount', () => {
  it('cannot exceed its own basis, even at 100%', () => {
    expect(discountAgorot(percent(10_000), base())).toEqual({ agorot: 556_000 })
  })

  it('clamps a fixed amount larger than the stay rather than inventing a refund', () => {
    const terms: DiscountTerms = {
      discountKind: 'fixed',
      discountValue: 900_000,
      appliesTo: 'stay_total',
    }
    expect(discountAgorot(terms, base())).toEqual({ agorot: 556_000 })
  })

  it('takes an accommodation-only discount off the accommodation lines alone', () => {
    // 10% of 459,000 and not of 556,000 — the extra-guest and cleaning lines
    // are not accommodation, and §6 rule 32 keeps them out.
    expect(
      discountAgorot(percent(1_000, 'accommodation_only'), base()),
    ).toEqual({
      agorot: 45_900,
    })
  })

  it('reports nothing to discount rather than returning zero silently', () => {
    const result = discountAgorot(
      percent(500),
      base({ stayTotalAgorot: 0, accommodationAgorot: 0 }),
    )
    expect(result).toEqual({ agorot: null, absent: 'nothing_to_discount' })
  })
})

describe('free nights are worth what the nights were worth, or they are absent', () => {
  it('reports the amount absent when the nightly rates were not supplied', () => {
    const terms: DiscountTerms = {
      discountKind: 'free_nights',
      discountValue: 1,
      appliesTo: 'stay_total',
    }
    // A fraction of the subtotal would have been an estimate, and it would be
    // wrong in the expensive direction on exactly the expensive stays.
    expect(discountAgorot(terms, base())).toEqual({
      agorot: null,
      absent: 'nightly_rates_unknown',
    })
  })

  it('gives away the cheapest nights, so the campaign’s cost is predictable', () => {
    const terms: DiscountTerms = {
      discountKind: 'free_nights',
      discountValue: 1,
      appliesTo: 'stay_total',
    }
    const nightly = [182_000, 182_000, 95_000]
    expect(discountAgorot(terms, base({ nightlyAgorot: nightly }))).toEqual({
      agorot: 95_000,
    })
  })

  it('does not reorder the caller’s nights, which are in date order', () => {
    const nightly = [182_000, 95_000, 182_000]
    const copy = [...nightly]
    discountAgorot(
      {
        discountKind: 'free_nights',
        discountValue: 2,
        appliesTo: 'stay_total',
      },
      base({ nightlyAgorot: nightly }),
    )
    expect(nightly).toEqual(copy)
  })

  it('gives away the whole stay when it is shorter than the free-night count', () => {
    const terms: DiscountTerms = {
      discountKind: 'free_nights',
      discountValue: 5,
      appliesTo: 'stay_total',
    }
    expect(
      discountAgorot(terms, base({ nightlyAgorot: [95_000, 95_000] })),
    ).toEqual({ agorot: 190_000 })
  })
})

describe('what is handed to priceStay', () => {
  it('is always a fixed amount, so one arithmetic path produces the money', () => {
    // Handing over a percentage would put the same figure through two
    // different multiply-then-divide orderings, and doubles do not promise
    // those agree.
    const request = toDiscountRequest(percent(333), base(), 'הנחה')
    expect(request?.kind).toBe('fixed')
    expect(request?.value).toBe(discountAgorot(percent(333), base()).agorot)
  })

  it('is a promotion line, not a negotiated discount line', () => {
    expect(toDiscountRequest(percent(500), base(), 'הנחה')?.lineKind).toBe(
      'promotion',
    )
  })

  it('is omitted entirely when the discount works out to nothing', () => {
    // §7.10, and the reason it matters: an omitted line is also a redemption
    // that never happened, so a discount worth zero cannot consume one of a
    // hundred available.
    expect(
      toDiscountRequest(
        percent(500),
        base({ stayTotalAgorot: 0, accommodationAgorot: 0 }),
        'הנחה',
      ),
    ).toBeNull()
    expect(
      toDiscountRequest(
        {
          discountKind: 'free_nights',
          discountValue: 1,
          appliesTo: 'stay_total',
        },
        base(),
        'לילה חינם',
      ),
    ).toBeNull()
  })
})
