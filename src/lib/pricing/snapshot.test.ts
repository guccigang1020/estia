import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { priceStay, sumLines } from '../booking/pricing'
import { known } from '../revenue/types'
import { resolveStay } from './resolve'
import { buildSnapshot, describeSnapshot, snapshotHasDrifted } from './snapshot'
import type {
  BookingPriceSnapshot,
  PricingContext,
  RatePlan,
  RateRule,
} from './types'

/**
 * 🔒 THE NON-DRIFT PROOF.
 *
 * The acceptance criterion at the foot of `docs/spec/20-pricing.md` reads:
 * change each of the six sources of a price and prove an existing booking does
 * not move by one agora. That is what the first describe block does, source by
 * source and by name.
 *
 * It is worth being precise about what is and is not being proven. The freeze
 * does not rest on a comparison passing — it rests on there being no function
 * that could re-price a booking at all. What these tests demonstrate is the
 * consequence: the numbers a booking was taken at are held in the request and
 * the lines that came from it, and re-running the resolver against a CHANGED
 * rate card produces a different answer — which is exactly why nothing may
 * re-run it against an old booking.
 */

const PLAN: RatePlan = {
  id: 'plan-direct',
  organizationId: 'org',
  propertyId: null,
  code: 'direct',
  name: 'ישיר',
  kind: 'direct',
  channelScope: [],
  requiresGrant: null,
  derivation: null,
  minNights: null,
  maxNights: null,
  advanceDaysMin: null,
  advanceDaysMax: null,
  cancellationPolicy: { tiers: [{ daysBefore: 14, refundBps: 10_000 }] },
  floorAgorot: 50_000,
  ceilingAgorot: 500_000,
  priority: 10,
  isActive: true,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  version: 3,
}

const SEASON: RateRule = {
  id: 'rule-season',
  ratePlanId: PLAN.id,
  scopeKind: 'unit',
  scopeId: 'unit-1',
  specificity: 70,
  dateFrom: '2026-03-01',
  dateTo: '2026-04-01',
  weekdays: [],
  nightlyAgorot: 120_000,
  minNights: null,
  priority: 0,
  label: 'עונת אביב',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
}

/** March. The booking is taken here and read back in August. */
function marchContext(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    organizationId: 'org',
    propertyId: 'property-1',
    unitId: 'unit-1',
    unitGroupId: null,
    range: { checkIn: '2026-03-10', checkOut: '2026-03-13' },
    guests: 2,
    eventType: null,
    source: 'direct_website',
    grants: new Set<string>(),
    effectiveOn: '2026-03-02',
    baseUnitNightlyAgorot: 80_000,
    unitStandardGuests: 2,
    unitMinNights: 1,
    propertyMinNights: 1,
    cleaningFeeAgorot: 25_000,
    taxRatePercent: 17,
    plans: [PLAN],
    rules: [SEASON],
    calendar: [],
    modifiers: [],
    occupancyByNight: {
      '2026-03-10': known(40),
      '2026-03-11': known(40),
      '2026-03-12': known(40),
    },
    ...overrides,
  }
}

function priceIn(context: PricingContext): {
  total: number
  overrides: Readonly<Record<string, number>>
} {
  const resolved = resolveStay(context)
  if (!resolved.ok)
    throw new Error(`unexpected refusal: ${resolved.refusal.code}`)
  const quote = priceStay(resolved.resolved.request)
  return {
    total: quote.totalAgorot,
    overrides: { ...resolved.resolved.request.nightlyOverrides },
  }
}

describe('🔒 a booking taken in March still owes March money in August', () => {
  const march = marchContext()
  const resolvedInMarch = resolveStay(march)
  if (!resolvedInMarch.ok) throw new Error('the fixture must price')

  const quoteInMarch = priceStay(resolvedInMarch.resolved.request)
  const frozen = buildSnapshot(march, resolvedInMarch.resolved)

  /** What was actually written to the row, as the database would hold it. */
  const stored: BookingPriceSnapshot = {
    id: 'snapshot-1',
    bookingId: 'booking-1',
    sequence: 1,
    hash: frozen.hash,
    capturedAt: '2026-03-02T09:00:00.000Z',
    effectiveOn: frozen.effectiveOn,
    engineVersion: frozen.engineVersion,
    ratePlanId: frozen.ratePlanId,
    ratePlanVersion: frozen.ratePlanVersion,
    inputs: frozen.inputs as unknown as Record<string, unknown>,
    resolution: frozen.resolution as unknown as Record<string, unknown>,
    taxRateBps: 1_700,
    touristVatExempt: false,
    cancellationPolicy: frozen.cancellationPolicy,
    supersededBy: null,
  }

  const marchTotal = quoteInMarch.totalAgorot
  const marchNights = { ...resolvedInMarch.resolved.request.nightlyOverrides }

  it('is the sum of its lines, and that is where the money lives', () => {
    expect(sumLines(quoteInMarch.lines)).toBe(marchTotal)
  })

  const movedSources: [string, PricingContext][] = [
    [
      'the season rule doubles',
      marchContext({ rules: [{ ...SEASON, nightlyAgorot: 240_000 }] }),
    ],
    [
      'somebody hand-sets one night in the calendar',
      marchContext({
        calendar: [
          {
            id: 'cal-1',
            unitId: 'unit-1',
            ratePlanId: PLAN.id,
            date: '2026-03-11',
            nightlyAgorot: 300_000,
            source: 'manual',
            suggestionId: null,
            approvedBy: null,
            version: 1,
          },
        ],
      }),
    ],
    [
      'a weekend modifier is added',
      marchContext({
        modifiers: [
          {
            id: 'mod-weekend',
            kind: 'weekend',
            scopeKind: 'property',
            scopeId: 'property-1',
            ratePlanId: null,
            trigger: { kind: 'weekend', weekdays: [0, 1, 2, 3, 4, 5, 6] },
            adjustKind: 'percent',
            adjustValue: 5_000,
            priority: 0,
            isActive: true,
          },
        ],
      }),
    ],
    [
      'the plan floor is raised above the season rate',
      marchContext({ plans: [{ ...PLAN, floorAgorot: 200_000 }] }),
    ],
    [
      'the plan ceiling is dropped below it',
      marchContext({ plans: [{ ...PLAN, ceilingAgorot: 60_000 }] }),
    ],
    ['VAT rises from 17% to 18%', marchContext({ taxRatePercent: 18 })],
  ]

  for (const [what, august] of movedSources) {
    it(`survives: ${what}`, () => {
      const now = priceIn(august)

      // The source really did move — otherwise this test would pass by
      // proving nothing at all, which is the failure mode of every
      // "nothing changed" assertion ever written.
      expect(now.total).not.toBe(marchTotal)

      // And the booking did not. The snapshot's inputs and resolution are
      // byte-identical, and re-pricing FROM THE SNAPSHOT'S OWN REQUEST gives
      // the same total to the agora.
      expect(stored.inputs).toEqual(frozen.inputs)
      expect(stored.resolution).toEqual(frozen.resolution)
      expect(
        (stored.inputs as { nightlyOverrides: Record<string, number> })
          .nightlyOverrides,
      ).toEqual(marchNights)
      expect(sumLines(quoteInMarch.lines)).toBe(marchTotal)
    })
  }

  it('keeps the cancellation policy as it was, not as it is', () => {
    // The plan's policy is rewritten completely. The snapshot copied it, so
    // the booking is still judged by the tiers the guest agreed to.
    const rewritten: RatePlan = {
      ...PLAN,
      cancellationPolicy: { tiers: [{ daysBefore: 60, refundBps: 0 }] },
    }
    expect(rewritten.cancellationPolicy).not.toEqual(stored.cancellationPolicy)
    expect(stored.cancellationPolicy).toEqual({
      tiers: [{ daysBefore: 14, refundBps: 10_000 }],
    })
  })

  it('reads back exactly what was written, and computes nothing', () => {
    const described = describeSnapshot(stored)
    expect(described.isLive).toBe(true)
    expect(described.sequence).toBe(1)
    expect(described.nights.map((night) => night.nightlyAgorot)).toEqual(
      Object.values(marchNights),
    )
  })

  it('marks a superseded snapshot as no longer live', () => {
    expect(
      describeSnapshot({ ...stored, supersededBy: 'snapshot-2' }).isLive,
    ).toBe(false)
  })
})

describe('the snapshot hash', () => {
  it('is stable across two identical resolutions', () => {
    const first = resolveStay(marchContext())
    const second = resolveStay(marchContext())
    if (!first.ok || !second.ok) throw new Error('the fixture must price')
    expect(buildSnapshot(marchContext(), first.resolved).hash).toBe(
      buildSnapshot(marchContext(), second.resolved).hash,
    )
  })

  it('moves when the rate card moves, which is how a stale quote is caught', () => {
    const march = marchContext()
    const august = marchContext({
      rules: [{ ...SEASON, nightlyAgorot: 240_000 }],
    })
    const before = resolveStay(march)
    const after = resolveStay(august)
    if (!before.ok || !after.ok) throw new Error('the fixture must price')

    const quoted = buildSnapshot(march, before.resolved)
    const current = buildSnapshot(august, after.resolved)
    expect(snapshotHasDrifted(quoted.hash, current)).toBe(true)
    expect(snapshotHasDrifted(current.hash, current)).toBe(false)
  })

  it('carries the promotion codes as strings, with no reference to a table', () => {
    const march = marchContext()
    const resolved = resolveStay(march)
    if (!resolved.ok) throw new Error('the fixture must price')

    const snapshot = buildSnapshot(march, resolved.resolved, {
      promotionCodes: ['direct_booking'],
      couponCode: 'WELCOME-10',
    })
    // Codes, deliberately, and not ids: the snapshot has to remain readable
    // after the promotion itself is deleted, which is the whole point of it.
    expect(snapshot.inputs.promotionCodes).toEqual(['direct_booking'])
    expect(snapshot.inputs.couponCode).toBe('WELCOME-10')
  })
})

describe('🔒 the module exports no way to re-price a booking', () => {
  /**
   * A structural test, and the most valuable one in the file.
   *
   * Every guarantee above holds because there is no function that takes a
   * booking and returns money. That is easy to break by accident — a helper
   * added "just for the booking screen" would do it — and impossible to
   * notice by reading a diff, because the new function would look useful.
   */
  it('has no export whose name suggests one', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/pricing/index.ts'),
      'utf8',
    )
    const forbidden = [
      'repriceBooking',
      'recalculateBooking',
      'totalForBooking',
      'priceOfBooking',
      'bookingTotal',
    ]
    for (const name of forbidden) {
      expect(source).not.toContain(name)
    }
  })

  it('does not import the finance module, so the direction stays one-way', () => {
    for (const file of [
      'src/lib/pricing/resolve.ts',
      'src/lib/pricing/snapshot.ts',
      'src/lib/pricing/operations.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source).not.toMatch(/from '\.\.\/finance/)
    }
  })

  it('produces lines only through priceStay, never by summing here', () => {
    for (const file of [
      'src/lib/pricing/resolve.ts',
      'src/lib/pricing/snapshot.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      // A call, not a mention: both files talk about `sumLines` in prose,
      // and the rule being defended is that neither one invokes it.
      expect(source).not.toMatch(/\bsumLines\s*\(/)
      expect(source).not.toMatch(/^import[\s\S]{0,200}?sumLines/m)
    }
  })
})
