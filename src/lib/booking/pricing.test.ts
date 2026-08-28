/**
 * Pricing.
 *
 * One invariant runs through everything below: **the total is the sum of the
 * lines**. It is asserted on every quote in this file, and swept across a range
 * of night counts, guest counts, discounts and tax rates — because a total that
 * disagrees with its own itemisation by one agora is an argument with a guest
 * that the business cannot win, and it will not show up on the round numbers a
 * hand-written test would use.
 *
 * The rounding tests exist for the same reason. Rounding is a decision here,
 * not an accident: half away from zero, on the magnitude, once per line. The
 * tests pin all three parts, including the asymmetric case where a naive
 * `Math.round` would shave a guest's discount while rounding a fee up.
 */

import { describe, expect, it } from 'vitest'
import { ValidationError } from '../errors'
import { addDays } from './dates'
import {
  agentCommissionLine,
  linesOfKind,
  priceStay,
  roundAgorot,
  sumLines,
  taxIncludedIn,
  type StayPricingRequest,
} from './pricing'
import { PRICE_LINE_KINDS, type PriceLine } from './types'

const NIGHT = 120000 // ₪1,200

function request(
  overrides: Partial<StayPricingRequest> = {},
): StayPricingRequest {
  return {
    range: { checkIn: '2026-09-03', checkOut: '2026-09-06' },
    baseNightlyAgorot: NIGHT,
    guests: 2,
    ...overrides,
  }
}

/** The invariant, asserted wherever a quote is produced. */
function expectLinesSumToTotal(quote: {
  lines: readonly PriceLine[]
  totalAgorot: number
}): void {
  expect(sumLines(quote.lines)).toBe(quote.totalAgorot)
  for (const line of quote.lines) {
    expect(Number.isInteger(line.amount)).toBe(true)
    expect(PRICE_LINE_KINDS).toContain(line.kind)
    expect(line.label.length).toBeGreaterThan(0)
  }
}

// ── Accommodation ─────────────────────────────────────────────────────────

describe('accommodation', () => {
  it('bills one line per night and no line for the departure day', () => {
    const quote = priceStay(request())

    const nights = linesOfKind(quote.lines, 'accommodation')
    expect(nights.map((line) => line.date)).toEqual([
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
    ])
    expect(quote.nights).toBe(3)
    expect(quote.totalAgorot).toBe(NIGHT * 3)
    expectLinesSumToTotal(quote)
  })

  it('uses the rate for a specific night where one is set', () => {
    const quote = priceStay(
      request({ nightlyOverrides: { '2026-09-04': 180000 } }),
    )

    expect(quote.totalAgorot).toBe(NIGHT + 180000 + NIGHT)
    expectLinesSumToTotal(quote)
  })

  it('names each night in Hebrew day-month form', () => {
    const quote = priceStay(request())
    expect(quote.lines[0].label).toBe('לינה 3.9')
  })

  it('sums exactly across a calendar of forty different rates', () => {
    const overrides: Record<string, number> = {}
    for (let day = 1; day <= 28; day += 1) {
      const date = `2026-09-${String(day).padStart(2, '0')}`
      overrides[date] = 100000 + day * 137
    }

    const quote = priceStay(
      request({
        range: { checkIn: '2026-09-01', checkOut: '2026-09-28' },
        nightlyOverrides: overrides,
      }),
    )

    expect(quote.nights).toBe(27)
    expectLinesSumToTotal(quote)
  })
})

// ── Extras ────────────────────────────────────────────────────────────────

describe('extras', () => {
  it('charges extra guests per guest per night', () => {
    const quote = priceStay(
      request({ guests: 5, includedGuests: 2, extraGuestNightlyAgorot: 8000 }),
    )

    const extra = linesOfKind(quote.lines, 'extra_guest')[0]
    expect(extra.amount).toBe(3 * 8000 * 3)
    expect(extra.quantity).toBe(9)
    expectLinesSumToTotal(quote)
  })

  it('charges nothing extra when the rate covers everyone', () => {
    const quote = priceStay(
      request({ guests: 2, includedGuests: 4, extraGuestNightlyAgorot: 8000 }),
    )

    expect(linesOfKind(quote.lines, 'extra_guest')).toHaveLength(0)
  })

  it('adds a cleaning fee once, not per night', () => {
    const quote = priceStay(request({ cleaningFeeAgorot: 25000 }))

    expect(linesOfKind(quote.lines, 'cleaning_fee')).toHaveLength(1)
    expect(quote.totalAgorot).toBe(NIGHT * 3 + 25000)
    expectLinesSumToTotal(quote)
  })

  it('multiplies an add-on by its quantity', () => {
    const quote = priceStay(
      request({
        addons: [
          {
            code: 'breakfast',
            label: 'ארוחת בוקר',
            unitPriceAgorot: 7500,
            quantity: 6,
          },
        ],
      }),
    )

    expect(linesOfKind(quote.lines, 'addon')[0].amount).toBe(45000)
    expectLinesSumToTotal(quote)
  })

  it('skips an add-on with no quantity or no price', () => {
    const quote = priceStay(
      request({
        addons: [
          { code: 'a', label: 'ריק', unitPriceAgorot: 0, quantity: 3 },
          { code: 'b', label: 'אפס', unitPriceAgorot: 5000, quantity: 0 },
        ],
      }),
    )

    expect(linesOfKind(quote.lines, 'addon')).toHaveLength(0)
  })
})

// ── Discounts ─────────────────────────────────────────────────────────────

describe('discounts', () => {
  it('records a discount as a negative line, so the total stays a plain sum', () => {
    const quote = priceStay(
      request({
        discounts: [
          {
            label: 'מבצע ספטמבר',
            kind: 'percent',
            value: 10,
            lineKind: 'promotion',
          },
        ],
      }),
    )

    const promotion = linesOfKind(quote.lines, 'promotion')[0]
    expect(promotion.amount).toBe(-36000)
    expect(quote.totalAgorot).toBe(324000)
    expectLinesSumToTotal(quote)
  })

  it('takes stacked percentages against the same subtotal', () => {
    // Order must not change the price a guest was quoted, so two 10% discounts
    // remove 20% and not 19%.
    const quote = priceStay(
      request({
        discounts: [
          { label: 'א', kind: 'percent', value: 10 },
          { label: 'ב', kind: 'percent', value: 10 },
        ],
      }),
    )

    expect(quote.totalAgorot).toBe(360000 - 72000)
    expectLinesSumToTotal(quote)
  })

  it('clamps a discount at the subtotal rather than inventing a refund', () => {
    const quote = priceStay(
      request({ discounts: [{ label: 'הכול', kind: 'fixed', value: 900000 }] }),
    )

    expect(quote.totalAgorot).toBe(0)
    expectLinesSumToTotal(quote)
  })

  it('drops a second discount once nothing is left to discount', () => {
    const quote = priceStay(
      request({
        discounts: [
          { label: 'ראשונה', kind: 'fixed', value: 360000 },
          { label: 'שנייה', kind: 'fixed', value: 50000 },
        ],
      }),
    )

    expect(quote.totalAgorot).toBe(0)
    expect(linesOfKind(quote.lines, 'discount')).toHaveLength(1)
  })

  it('ignores a zero or negative discount', () => {
    const quote = priceStay(
      request({
        discounts: [
          { label: 'אפס', kind: 'fixed', value: 0 },
          { label: 'שלילי', kind: 'fixed', value: -5000 },
        ],
      }),
    )

    expect(quote.totalAgorot).toBe(360000)
  })
})

// ── Tax ───────────────────────────────────────────────────────────────────

describe('tax', () => {
  it('taxes the discounted subtotal, not the list price', () => {
    // Taxing before discounting charges VAT on money nobody paid.
    const quote = priceStay(
      request({
        discounts: [{ label: 'הנחה', kind: 'percent', value: 10 }],
        taxRatePercent: 18,
      }),
    )

    const taxable = 360000 - 36000
    expect(quote.taxAgorot).toBe(Math.round(taxable * 0.18))
    expect(quote.totalAgorot).toBe(taxable + quote.taxAgorot)
    expectLinesSumToTotal(quote)
  })

  it('adds no line when there is no rate', () => {
    expect(linesOfKind(priceStay(request()).lines, 'tax')).toHaveLength(0)
  })

  it('adds no line when the discount took the stay to zero', () => {
    const quote = priceStay(
      request({
        discounts: [{ label: 'הכול', kind: 'fixed', value: 900000 }],
        taxRatePercent: 18,
      }),
    )

    expect(linesOfKind(quote.lines, 'tax')).toHaveLength(0)
    expect(quote.totalAgorot).toBe(0)
  })

  it('computes the tax contained in a tax-inclusive figure for display', () => {
    // 118 including 18% VAT contains 18.
    expect(taxIncludedIn(11800, 18)).toBe(1800)
    expect(taxIncludedIn(10000, 0)).toBe(0)
  })
})

// ── Deposit and commission ────────────────────────────────────────────────

describe('deposit and commission', () => {
  it('charges the deposit and states it separately', () => {
    const quote = priceStay(request({ depositAgorot: 100000 }))

    expect(quote.depositAgorot).toBe(100000)
    expect(quote.totalAgorot).toBe(360000 + 100000)
    expect(quote.stayTotalAgorot).toBe(360000)
    expectLinesSumToTotal(quote)
  })

  it('does not tax the deposit', () => {
    const quote = priceStay(
      request({ depositAgorot: 100000, taxRatePercent: 18 }),
    )

    expect(quote.taxAgorot).toBe(Math.round(360000 * 0.18))
  })

  it('keeps agent commission out of the guest’s total', () => {
    // The business pays it out of what the guest paid. Adding it would inflate
    // the price by money the guest is not being asked for.
    const quote = priceStay(request({ depositAgorot: 100000 }))
    const commission = agentCommissionLine(quote, 12)

    expect(commission.amount).toBe(43200)
    expect(quote.lines).not.toContainEqual(commission)
    expectLinesSumToTotal(quote)
  })
})

// ── Rounding ──────────────────────────────────────────────────────────────

describe('rounding', () => {
  it('rounds half away from zero, matching a guest’s calculator', () => {
    expect(roundAgorot(0.5)).toBe(1)
    expect(roundAgorot(1.5)).toBe(2)
    // Not banker's rounding: 2.5 goes to 3, not to 2.
    expect(roundAgorot(2.5)).toBe(3)
  })

  it('rounds a guest’s half-agora the same way as the business’s', () => {
    // `Math.round(-0.5)` is 0 and `Math.round(-2.5)` is -2 — the house winning
    // both coin flips. Rounding the magnitude and applying the sign does not.
    expect(roundAgorot(-0.5)).toBe(-1)
    expect(roundAgorot(-2.5)).toBe(-3)
    expect(roundAgorot(500.5)).toBe(501)
    expect(roundAgorot(-500.5)).toBe(-501)
  })

  it('never produces negative zero', () => {
    expect(Object.is(roundAgorot(-0.2), 0)).toBe(true)
  })

  it('keeps the total equal to the lines when a percentage lands on a half', () => {
    // 50% of 1001 is 500.5, which rounds to 501, leaving 500 to be taxed.
    const quote = priceStay(
      request({
        range: { checkIn: '2026-09-03', checkOut: '2026-09-04' },
        baseNightlyAgorot: 1001,
        discounts: [{ label: 'חצי', kind: 'percent', value: 50 }],
        taxRatePercent: 50,
      }),
    )

    expect(quote.totalAgorot).toBe(1001 - 501 + 250)
    expectLinesSumToTotal(quote)
  })
})

// ── The invariant, swept ──────────────────────────────────────────────────

describe('the total is always the sum of the lines', () => {
  it('holds across night counts, guests, discounts and taxes', () => {
    const rates = [9999, 100000, 123457]
    const taxRates = [0, 17, 18, 7.5]
    const discounts = [0, 3, 10, 33.3, 100]
    let checked = 0

    for (let nights = 1; nights <= 30; nights += 1) {
      for (const rate of rates) {
        for (const taxRate of taxRates) {
          for (const discount of discounts) {
            const checkOut = addDays('2026-09-01', nights)
            const quote = priceStay({
              range: { checkIn: '2026-09-01', checkOut },
              baseNightlyAgorot: rate,
              guests: 4,
              includedGuests: 2,
              extraGuestNightlyAgorot: 3333,
              cleaningFeeAgorot: 12345,
              addons: [
                {
                  code: 'x',
                  label: 'תוספת',
                  unitPriceAgorot: 777,
                  quantity: 3,
                },
              ],
              discounts:
                discount === 0
                  ? []
                  : [{ label: 'הנחה', kind: 'percent', value: discount }],
              taxRatePercent: taxRate,
              depositAgorot: 50000,
            })

            expectLinesSumToTotal(quote)
            expect(quote.nights).toBe(nights)
            expect(quote.totalAgorot).toBeGreaterThanOrEqual(0)
            checked += 1
          }
        }
      }
    }

    expect(checked).toBe(30 * rates.length * taxRates.length * discounts.length)
  })
})

// ── Refusals ──────────────────────────────────────────────────────────────

describe('bad requests', () => {
  it.each([
    [{ range: { checkIn: '2026-09-06', checkOut: '2026-09-03' } }, 'checkOut'],
    [{ range: { checkIn: '2026-09-03', checkOut: '2026-09-03' } }, 'checkOut'],
    [{ guests: 0 }, 'guests'],
    [{ baseNightlyAgorot: -100 }, 'baseNightlyAgorot'],
    [{ baseNightlyAgorot: 52.005 }, 'baseNightlyAgorot'],
  ])('refuses %o on field %s', (overrides, field) => {
    try {
      priceStay(request(overrides as Partial<StayPricingRequest>))
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect(
        (error as ValidationError).issues.map((issue) => issue.field),
      ).toContain(field)
      return
    }
    throw new Error('expected the price to be refused')
  })

  it('reports every offending field at once', () => {
    try {
      priceStay({
        range: { checkIn: '2026-09-06', checkOut: '2026-09-03' },
        baseNightlyAgorot: -1,
        guests: 0,
      })
    } catch (error) {
      expect((error as ValidationError).issues).toHaveLength(3)
      return
    }
    throw new Error('expected the price to be refused')
  })
})
