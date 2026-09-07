import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { priceStay, roundAgorot, sumLines } from '../booking/pricing'
import { agentCommissionLine } from '../booking/pricing'
import { known, unknown } from '../revenue/types'
import { computeSpecificity, resolveDerivation, resolveStay } from './resolve'
import {
  SPECIFICITY,
  type PricingContext,
  type RatePlan,
  type RateRule,
} from './types'

/**
 * The proofs of the arithmetic.
 *
 * Every test here corresponds to a numbered rule in `docs/spec/20-pricing.md`
 * §6 or a numbered case in §19, and the numbers in the big one are the
 * specification's own worked example (§7.11) — chosen there precisely because
 * it can be checked with a pencil.
 */

const PLAN: RatePlan = {
  id: '00000000-0000-4000-8000-0000000000p1',
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
  cancellationPolicy: {},
  floorAgorot: 90_000,
  ceilingAgorot: 220_000,
  priority: 10,
  isActive: true,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  version: 1,
}

function rule(overrides: Partial<RateRule> & { id: string }): RateRule {
  return {
    ratePlanId: PLAN.id,
    scopeKind: 'unit',
    scopeId: 'unit-1',
    specificity: 70,
    dateFrom: '2026-09-25',
    dateTo: '2026-10-16',
    weekdays: [],
    nightlyAgorot: 140_000,
    minNights: null,
    priority: 0,
    label: 'עונת סוכות',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    ...overrides,
  }
}

function context(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    organizationId: 'org',
    propertyId: 'property-1',
    unitId: 'unit-1',
    unitGroupId: 'group-1',
    range: { checkIn: '2026-10-02', checkOut: '2026-10-05' },
    guests: 4,
    eventType: null,
    source: 'direct_website',
    grants: new Set<string>(),
    effectiveOn: '2026-03-02',
    baseUnitNightlyAgorot: 100_000,
    unitStandardGuests: 2,
    unitMinNights: 1,
    propertyMinNights: 1,
    extraGuestNightlyAgorot: 12_000,
    cleaningFeeAgorot: 25_000,
    depositAgorot: 100_000,
    taxRatePercent: 18,
    plans: [PLAN],
    rules: [],
    calendar: [],
    modifiers: [],
    ...overrides,
  }
}

/** The §7.11 rate card: a Sukkot season rule and a cheaper midweek rule. */
const SUKKOT_RULES: RateRule[] = [
  rule({ id: 'rule-season', specificity: SPECIFICITY.unit }),
  rule({
    id: 'rule-midweek',
    specificity: SPECIFICITY.unitWeekday,
    weekdays: [0, 1, 2, 3, 4],
    nightlyAgorot: 95_000,
    label: 'אמצע שבוע',
  }),
]

const SUKKOT_MODIFIERS: PricingContext['modifiers'] = [
  {
    id: 'mod-weekend',
    kind: 'weekend',
    scopeKind: 'property',
    scopeId: 'property-1',
    ratePlanId: null,
    trigger: { kind: 'weekend', weekdays: [5, 6] },
    adjustKind: 'percent',
    adjustValue: 1_500,
    priority: 0,
    isActive: true,
  },
  {
    id: 'mod-holiday',
    kind: 'holiday',
    scopeKind: 'property',
    scopeId: 'property-1',
    ratePlanId: null,
    trigger: { kind: 'holiday', specialDayKinds: [] },
    adjustKind: 'percent',
    adjustValue: 2_500,
    priority: 0,
    isActive: true,
  },
  {
    id: 'mod-demand',
    kind: 'occupancy',
    scopeKind: 'property',
    scopeId: 'property-1',
    ratePlanId: null,
    trigger: { kind: 'occupancy', fromPercent: 80, toPercent: 100 },
    adjustKind: 'percent',
    adjustValue: 500,
    priority: 0,
    isActive: true,
  },
]

const SUKKOT_OCCUPANCY = {
  '2026-10-02': known(84),
  '2026-10-03': known(84),
  '2026-10-04': known(61),
}

// ── §7.2 · the specificity ladder ─────────────────────────────────────────

describe('the specificity ladder (spec §7.2)', () => {
  it('gives each of the six rule rungs its documented value', () => {
    expect(computeSpecificity('unit', [5, 6])).toBe(80)
    expect(computeSpecificity('unit', [])).toBe(70)
    expect(computeSpecificity('unit_group', [5])).toBe(60)
    expect(computeSpecificity('unit_group', [])).toBe(50)
    expect(computeSpecificity('property', [5, 6])).toBe(40)
    expect(computeSpecificity('property', [])).toBe(30)
  })

  it('is strictly descending, so no two rungs can tie', () => {
    const rungs = [
      computeSpecificity('unit', [5]),
      computeSpecificity('unit', []),
      computeSpecificity('unit_group', [5]),
      computeSpecificity('unit_group', []),
      computeSpecificity('property', [5]),
      computeSpecificity('property', []),
    ]
    expect(rungs).toEqual([...rungs].sort((a, b) => b - a))
    expect(new Set(rungs).size).toBe(rungs.length)
    // The calendar is above every rule and the unit base price below every one.
    expect(SPECIFICITY.rateCalendar).toBeGreaterThan(Math.max(...rungs))
    expect(SPECIFICITY.unitBasePrice).toBeLessThan(Math.min(...rungs))
  })

  /**
   * The ladder is written twice — here and in `public.rate_rule_specificity`
   * — because the database stores the column and the resolver ranks a
   * calendar entry against it, and neither can read the other at the moment it
   * decides. Two definitions of one ladder WILL drift unless something
   * compares them, so this reads the migration and does.
   */
  it('agrees with the ladder the migration writes into the column', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/0072_pricing.sql'),
      'utf8',
    )
    const body = sql.slice(
      sql.indexOf('create or replace function public.rate_rule_specificity'),
      sql.indexOf('comment on function public.rate_rule_specificity'),
    )
    expect(body).toContain(
      `then ${SPECIFICITY.unitWeekday} else ${SPECIFICITY.unit} end`,
    )
    expect(body).toContain(
      `then ${SPECIFICITY.unitGroupWeekday} else ${SPECIFICITY.unitGroup} end`,
    )
    expect(body).toContain(
      `then ${SPECIFICITY.propertyWeekday} else ${SPECIFICITY.property} end`,
    )
  })

  it('lets a more specific rule win the night (spec §6 rule 7)', () => {
    const resolved = resolveStay(
      context({
        rules: [
          rule({
            id: 'rule-property',
            scopeKind: 'property',
            scopeId: 'property-1',
            specificity: SPECIFICITY.property,
            nightlyAgorot: 50_000,
          }),
          rule({ id: 'rule-unit', nightlyAgorot: 140_000 }),
        ],
      }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.resolved.resolution.nights[0].baseSourceId).toBe(
      'rule-unit',
    )
  })

  it('lets a hand-set calendar night outrank every rule', () => {
    const resolved = resolveStay(
      context({
        rules: SUKKOT_RULES,
        calendar: [
          {
            id: 'cal-1',
            unitId: 'unit-1',
            ratePlanId: PLAN.id,
            date: '2026-10-04',
            nightlyAgorot: 111_000,
            source: 'manual',
            suggestionId: null,
            approvedBy: null,
            version: 1,
          },
        ],
      }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const night = resolved.resolved.resolution.nights[2]
    expect(night.baseOrigin).toBe('rate_calendar')
    expect(night.specificity).toBe(SPECIFICITY.rateCalendar)
    expect(night.nightlyAgorot).toBe(111_000)
  })

  it('falls back to the unit base price when no rule touches the night', () => {
    const resolved = resolveStay(context())
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    for (const night of resolved.resolved.resolution.nights) {
      expect(night.baseOrigin).toBe('unit_base_price')
      expect(night.baseAgorot).toBe(100_000)
    }
  })
})

// ── §7.2 · the four tie-breakers, each in isolation ───────────────────────

describe('the tie-breakers (spec §7.2)', () => {
  const at = (overrides: Partial<RateRule> & { id: string }) =>
    resolveStay(
      context({
        range: { checkIn: '2026-10-05', checkOut: '2026-10-06' },
        rules: [rule({ id: 'baseline' }), rule(overrides)],
      }),
    )

  it('breaks first on specificity', () => {
    const resolved = at({
      id: 'more-specific',
      weekdays: [1],
      specificity: SPECIFICITY.unitWeekday,
      nightlyAgorot: 1,
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.resolved.resolution.nights[0].baseSourceId).toBe(
      'more-specific',
    )
  })

  it('then on priority', () => {
    const resolved = at({
      id: 'higher-priority',
      priority: 5,
      nightlyAgorot: 1,
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.resolved.resolution.nights[0].baseSourceId).toBe(
      'higher-priority',
    )
  })

  it('then on the later effective date', () => {
    const resolved = at({
      id: 'newer',
      effectiveFrom: '2026-02-01',
      nightlyAgorot: 1,
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.resolved.resolution.nights[0].baseSourceId).toBe('newer')
  })

  /**
   * The last resort, and the reason it exists: two rules written in the same
   * millisecond with everything else equal must still resolve to the same
   * winner in every process, or one guest gets two different quotes. The
   * database forbids this tie outright; this proves the resolver would survive
   * it anyway, because "must not happen" and "will not happen" differ.
   */
  it('and finally on the id, which is arbitrary but stable', () => {
    const rules = [rule({ id: 'aaa', nightlyAgorot: 1 }), rule({ id: 'zzz' })]
    const forwards = resolveStay(
      context({
        range: { checkIn: '2026-10-05', checkOut: '2026-10-06' },
        rules,
      }),
    )
    const backwards = resolveStay(
      context({
        range: { checkIn: '2026-10-05', checkOut: '2026-10-06' },
        rules: [...rules].reverse(),
      }),
    )
    expect(forwards.ok && backwards.ok).toBe(true)
    if (!forwards.ok || !backwards.ok) return
    expect(forwards.resolved.resolution.nights[0].baseSourceId).toBe('aaa')
    expect(backwards.resolved.resolution.nights[0].baseSourceId).toBe('aaa')
  })
})

// ── §6 rule 9 · the calendar addition is a maximum ────────────────────────

describe('the calendar addition (spec §6 rule 9)', () => {
  it('takes the maximum of the weekend and holiday uplifts, never the sum', () => {
    const resolved = resolveStay(
      context({
        rules: SUKKOT_RULES,
        modifiers: SUKKOT_MODIFIERS,
        occupancyByNight: SUKKOT_OCCUPANCY,
      }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    // 02/10/2026 is a Friday AND chol hamoed Sukkot. Both tests fire.
    const friday = resolved.resolved.resolution.nights[0]
    expect(friday.weekendAdd).toBe(21_000)
    expect(friday.holidayAdd).toBe(35_000)
    expect(friday.calendarAdd).toBe(35_000)
    // The sum would be 56,000 — ₪560 instead of ₪350 — every festival Friday.
    expect(friday.calendarAdd).not.toBe(friday.weekendAdd + friday.holidayAdd)
  })

  it('adds nothing on an ordinary midweek night', () => {
    const resolved = resolveStay(
      context({
        rules: SUKKOT_RULES,
        modifiers: SUKKOT_MODIFIERS,
        occupancyByNight: SUKKOT_OCCUPANCY,
      }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const sunday = resolved.resolved.resolution.nights[2]
    expect(sunday.calendarAdd).toBe(0)
    expect(sunday.nightlyAgorot).toBe(95_000)
  })
})

// ── §6 rule 13 · unknown occupancy is not zero occupancy ──────────────────

describe('the demand addition (spec §6 rule 13)', () => {
  it('adds nothing when occupancy is unknown, and says which it was', () => {
    const resolved = resolveStay(
      context({
        rules: SUKKOT_RULES,
        modifiers: SUKKOT_MODIFIERS,
        occupancyByNight: {
          '2026-10-02': unknown('no_denominator'),
          '2026-10-03': unknown('no_denominator'),
          '2026-10-04': unknown('no_denominator'),
        },
      }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    for (const night of resolved.resolved.resolution.nights) {
      expect(night.demandAdd).toBe(0)
      expect(night.occupancy.known).toBe(false)
    }
    // A property whose units are all out of service would otherwise have
    // fired the cheapest tier, which is the opposite of what a tier is for.
    expect(resolved.resolved.resolution.nights[0].nightlyAgorot).toBe(175_000)
  })

  it('records `no_source` when the caller supplied no occupancy at all', () => {
    const resolved = resolveStay(
      context({ rules: SUKKOT_RULES, modifiers: SUKKOT_MODIFIERS }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const night = resolved.resolved.resolution.nights[0]
    expect(night.occupancy).toEqual({ known: false, reason: 'no_source' })
  })
})

// ── §7.5 · the clamp, and the single rounding ─────────────────────────────

describe('the clamp and the rounding (spec §7.5)', () => {
  it('clamps to the ceiling and records that it did', () => {
    const resolved = resolveStay(
      context({
        range: { checkIn: '2026-10-05', checkOut: '2026-10-06' },
        rules: [rule({ id: 'expensive', nightlyAgorot: 300_000 })],
      }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const night = resolved.resolved.resolution.nights[0]
    expect(night.rawAgorot).toBe(300_000)
    expect(night.nightlyAgorot).toBe(220_000)
    expect(night.clamped).toBe(true)
    expect(night.clampedTo).toBe('ceiling')
  })

  it('clamps to the floor and records that it did', () => {
    const resolved = resolveStay(
      context({
        range: { checkIn: '2026-10-05', checkOut: '2026-10-06' },
        rules: [rule({ id: 'cheap', nightlyAgorot: 10_000 })],
      }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.resolved.resolution.nights[0].clampedTo).toBe('floor')
    expect(resolved.resolved.resolution.nights[0].nightlyAgorot).toBe(90_000)
  })

  /**
   * Half away from zero, on the magnitude. `Math.round(-50.5)` is `-50`, so a
   * half-agora discount would be shaved while a half-agora fee was rounded up
   * — the house winning both coin flips.
   */
  it('rounds symmetrically about zero', () => {
    expect(roundAgorot(50.5)).toBe(51)
    expect(roundAgorot(-50.5)).toBe(-51)
  })

  it('rounds the night once, not each addition', () => {
    const resolved = resolveStay(
      context({
        range: { checkIn: '2026-10-05', checkOut: '2026-10-06' },
        rules: [rule({ id: 'odd', nightlyAgorot: 100_001 })],
        modifiers: [
          {
            ...SUKKOT_MODIFIERS[0],
            trigger: { kind: 'weekend', weekdays: [1] },
            adjustValue: 333,
          },
        ],
      }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const night = resolved.resolved.resolution.nights[0]
    // The uplift is fractional right up to the end; rounding it on its own
    // first would give a different integer.
    expect(Number.isInteger(night.weekendAdd)).toBe(false)
    expect(night.nightlyAgorot).toBe(roundAgorot(night.rawAgorot))
  })
})

// ── §7.11 · the whole worked example ──────────────────────────────────────

describe('the specification worked example (spec §7.11)', () => {
  it('produces exactly the three nightly figures the table gives', () => {
    const resolved = resolveStay(
      context({
        rules: SUKKOT_RULES,
        modifiers: SUKKOT_MODIFIERS,
        occupancyByNight: SUKKOT_OCCUPANCY,
      }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    expect(resolved.resolved.request.nightlyOverrides).toEqual({
      '2026-10-02': 182_000,
      '2026-10-03': 182_000,
      '2026-10-04': 95_000,
    })
  })

  it('and, through priceStay, a total of ₪7,232.76 that is the sum of its lines', () => {
    const resolved = resolveStay(
      context({
        rules: SUKKOT_RULES,
        modifiers: SUKKOT_MODIFIERS,
        occupancyByNight: SUKKOT_OCCUPANCY,
      }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    const quote = priceStay({
      ...resolved.resolved.request,
      discounts: [
        {
          label: 'הזמנה ישירה 5%',
          kind: 'percent',
          value: 5,
          lineKind: 'promotion',
        },
      ],
    })

    expect(quote.totalAgorot).toBe(723_276)
    expect(sumLines(quote.lines)).toBe(quote.totalAgorot)
    expect(quote.stayTotalAgorot).toBe(623_276)
    expect(quote.depositAgorot).toBe(100_000)
    expect(quote.taxAgorot).toBe(95_076)

    // The commission is computed on the stay total and is NOT in the guest's
    // lines. Nobody earns commission on the deposit, which goes back.
    const commission = agentCommissionLine(quote, 10)
    expect(commission.amount).toBe(62_328)
    expect(quote.lines).not.toContain(commission)
    expect(sumLines(quote.lines)).toBe(723_276)
  })
})

// ── §7.8 · choosing a plan, and derivation ────────────────────────────────

describe('choosing a rate plan (spec §7.8)', () => {
  it('refuses rather than falling back to the base price', () => {
    const resolved = resolveStay(
      context({ plans: [{ ...PLAN, channelScope: ['airbnb'] }] }),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.refusal.code).toBe('no_rate_plan')
  })

  it('hides a plan whose grant the actor does not hold', () => {
    const agentPlan: RatePlan = {
      ...PLAN,
      id: 'plan-agent',
      code: 'agent',
      kind: 'agent',
      requiresGrant: 'rate.view_agent',
      priority: 99,
    }
    const withoutGrant = resolveStay(context({ plans: [PLAN, agentPlan] }))
    const withGrant = resolveStay(
      context({
        plans: [PLAN, agentPlan],
        grants: new Set(['rate.view_agent']),
      }),
    )
    expect(withoutGrant.ok && withGrant.ok).toBe(true)
    if (!withoutGrant.ok || !withGrant.ok) return
    expect(withoutGrant.resolved.resolution.ratePlan.id).toBe(PLAN.id)
    expect(withGrant.resolved.resolution.ratePlan.id).toBe('plan-agent')
  })

  it('breaks a priority tie on the code, stably', () => {
    const other: RatePlan = { ...PLAN, id: 'plan-b', code: 'aaa' }
    const forwards = resolveStay(context({ plans: [PLAN, other] }))
    const backwards = resolveStay(context({ plans: [other, PLAN] }))
    expect(forwards.ok && backwards.ok).toBe(true)
    if (!forwards.ok || !backwards.ok) return
    expect(forwards.resolved.resolution.ratePlan.code).toBe('aaa')
    expect(backwards.resolved.resolution.ratePlan.code).toBe('aaa')
  })

  it('resolves a derivation chain of three and refuses one of four', () => {
    const chain = (depth: number): RatePlan[] =>
      Array.from({ length: depth + 1 }, (_, index) => ({
        ...PLAN,
        id: `plan-${index}`,
        code: `plan-${index}`,
        derivation:
          index === depth
            ? null
            : {
                fromRatePlanId: `plan-${index + 1}`,
                adjust: { kind: 'percent' as const, value: -1_000 },
              },
      }))

    const three = resolveDerivation(chain(3)[0], chain(3))
    expect(three.ok).toBe(true)

    const four = resolveDerivation(chain(4)[0], chain(4))
    expect(four.ok).toBe(false)
    if (four.ok) return
    expect(four.refusal.code).toBe('derivation_too_deep')
  })

  it('refuses a derivation that closes a cycle', () => {
    const a: RatePlan = {
      ...PLAN,
      id: 'plan-a',
      code: 'a',
      derivation: {
        fromRatePlanId: 'plan-b',
        adjust: { kind: 'percent', value: -1_000 },
      },
    }
    const b: RatePlan = {
      ...PLAN,
      id: 'plan-b',
      code: 'b',
      derivation: {
        fromRatePlanId: 'plan-a',
        adjust: { kind: 'percent', value: -1_000 },
      },
    }
    const resolved = resolveDerivation(a, [a, b])
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.refusal.code).toBe('derivation_cycle')
  })

  it('applies a derived plan adjustment to the parent rules', () => {
    const parent: RatePlan = { ...PLAN, id: 'plan-parent', code: 'parent' }
    const child: RatePlan = {
      ...PLAN,
      id: 'plan-child',
      code: 'child',
      priority: 99,
      derivation: {
        fromRatePlanId: 'plan-parent',
        adjust: { kind: 'percent', value: -1_000 },
      },
    }
    const resolved = resolveStay(
      context({
        range: { checkIn: '2026-10-05', checkOut: '2026-10-06' },
        plans: [parent, child],
        rules: [
          rule({
            id: 'parent-rule',
            ratePlanId: 'plan-parent',
            nightlyAgorot: 200_000,
          }),
        ],
      }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    // 10% off the parent's ₪2,000, and the child's own ceiling still applies.
    expect(resolved.resolved.resolution.nights[0].nightlyAgorot).toBe(180_000)
    expect(resolved.resolved.resolution.derivedFromPlanIds).toEqual([
      'plan-parent',
    ])
  })
})

// ── §6 rules 2 and 5 · refusing rather than pricing ───────────────────────

describe('refusals (spec §6 rules 2 and 5)', () => {
  it('refuses a range that is not a stay rather than returning zero', () => {
    const resolved = resolveStay(
      context({ range: { checkIn: '2026-10-05', checkOut: '2026-10-05' } }),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.refusal.code).toBe('invalid_range')
  })

  it('refuses a stay below the strictest minimum, naming both numbers', () => {
    const resolved = resolveStay(
      context({
        range: { checkIn: '2026-10-05', checkOut: '2026-10-06' },
        rules: [rule({ id: 'long-only', minNights: 3 })],
      }),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.refusal).toEqual({
      code: 'below_minimum_nights',
      required: 3,
      requested: 1,
    })
  })
})
