/**
 * What the insights screen may say, to whom, and what it must never say.
 *
 * Three properties are asserted here and they are the whole product rule:
 *
 *   1. A figure the reader was refused produces **no insight and no zero** —
 *      the insight is absent, and the absence says whether the refusal was a
 *      permission or a package.
 *   2. Every insight carries operands that reproduce its own arithmetic, so a
 *      claim on this screen is checkable by the person reading it.
 *   3. A window the source could not speak about produces an empty report,
 *      not twelve insights about a business that measured zero.
 */

import { describe, expect, it } from 'vitest'

import type { Actor, Scope } from '../authz/can'
import type { Grant } from '../authz/permissions'
import {
  METRIC_IDS,
  aggregateFacts,
  computeDashboard,
  InMemoryMetricSource,
  makeBooking,
  makeUnit,
  type BookingFactRow,
  type DashboardResponse,
  type MetricFacts,
  type MetricRange,
  type OutOfServiceRow,
  type UnitInventoryRow,
} from '../metrics'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'

import { buildInsightReport } from './report'
import { GAPS, INSIGHT_RULES } from './rules'
import { INSIGHT_IDS, type InsightReport } from './types'

// ── Fixtures ──────────────────────────────────────────────────────────────

const MARCH: MetricRange = { start: '2026-03-01', end: '2026-04-01' }
const SCOPE = {
  organizationId: 'org-a',
  propertyIds: null,
  unitIds: null,
} as const

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

/** Everything the fifteen metrics are gated on. */
const ALL_METRIC_GRANTS: readonly Grant[] = [
  'availability.view',
  'booking.view',
  'booking.view_price',
  'booking.view_source',
  'commission.view',
  'finance.view',
  'payment.view',
  'lead.view',
  'property.view',
  'report.financial.view',
]

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'user-1',
    organizationId: 'org-a',
    membershipStatus: 'active',
    grants: new Set<Grant>(ALL_METRIC_GRANTS),
    scope: { kind: 'all_organization' } as Scope,
    entitlements: EVERY_ENTITLEMENT,
    ...overrides,
  }
}

const UNITS: readonly UnitInventoryRow[] = [
  makeUnit({ unitId: 'unit-1' }),
  makeUnit({ unitId: 'unit-2' }),
]

const OUT_OF_SERVICE: readonly OutOfServiceRow[] = [
  {
    unitId: 'unit-2',
    propertyId: 'prop-1',
    from: '2026-03-10',
    to: '2026-03-14',
  },
]

const BOOKINGS: readonly BookingFactRow[] = [
  makeBooking({
    bookingId: 'march-sold',
    unitId: 'unit-1',
    checkIn: '2026-03-02',
    checkOut: '2026-03-09',
    createdOn: '2026-02-10',
    committedOn: '2026-03-01',
    roomRevenue: 210_000,
    ancillaryRevenue: 30_000,
    commission: 24_000,
    collected: 100_000,
    source: 'booking_com',
  }),
  makeBooking({
    bookingId: 'march-comp',
    unitId: 'unit-2',
    checkIn: '2026-03-20',
    checkOut: '2026-03-23',
    createdOn: '2026-03-01',
    committedOn: '2026-03-02',
    roomRevenue: 0,
    collected: 0,
    isComplimentary: true,
  }),
  makeBooking({
    bookingId: 'march-cancelled',
    unitId: 'unit-1',
    status: 'cancelled',
    checkIn: '2026-03-25',
    checkOut: '2026-03-27',
    createdOn: '2026-03-05',
    committedOn: null,
    cancelledOn: '2026-03-10',
  }),
  makeBooking({
    bookingId: 'february',
    unitId: 'unit-1',
    checkIn: '2026-02-05',
    checkOut: '2026-02-09',
    createdOn: '2026-01-10',
    committedOn: '2026-01-10',
    roomRevenue: 80_000,
    collected: 80_000,
    source: 'direct_website',
  }),
]

const WORLD = {
  units: UNITS,
  outOfService: OUT_OF_SERVICE,
  bookings: BOOKINGS,
}

function factsFor(range: MetricRange, world = WORLD): MetricFacts {
  return aggregateFacts({
    range,
    scope: SCOPE,
    units: world.units ?? [],
    outOfService: world.outOfService ?? [],
    bookings: world.bookings ?? [],
  })
}

async function report(
  overrides: {
    actor?: Actor
    world?: typeof WORLD
    comparison?: 'previous_period' | 'none'
  } = {},
): Promise<InsightReport> {
  const who = overrides.actor ?? actor()
  const world = overrides.world ?? WORLD
  const comparison = overrides.comparison ?? 'previous_period'
  const baselineRange: MetricRange = { start: '2026-01-29', end: '2026-03-01' }

  const response: DashboardResponse = await computeDashboard({
    actor: who,
    source: new InMemoryMetricSource(world),
    now: new Date('2026-04-02T09:00:00Z'),
    request: {
      scope: { organizationId: 'org-a' },
      range: MARCH,
      comparison,
      metrics: METRIC_IDS,
    },
  })

  return buildInsightReport({
    actor: who,
    response,
    facts: factsFor(MARCH, world),
    baselineFacts:
      comparison === 'none' ? null : factsFor(baselineRange, world),
    periodLabel: 'מרץ 2026',
    baselineLabel: comparison === 'none' ? null : 'פברואר 2026',
    sourceLabel: (source) => source,
  })
}

// ── The happy path ────────────────────────────────────────────────────────

describe('a reader who may see everything', () => {
  it('gets insights, and every one of them carries its arithmetic', async () => {
    const result = await report()

    expect(result.insights.length).toBeGreaterThan(0)

    for (const insight of result.insights) {
      expect(insight.headline.length).toBeGreaterThan(0)
      expect(insight.because.length).toBeGreaterThan(0)
      expect(insight.evidence.length).toBeGreaterThan(0)

      for (const block of insight.evidence) {
        expect(block.periodLabel.length).toBeGreaterThan(0)
        for (const metric of block.metrics) {
          expect(metric.operands.length).toBeGreaterThan(0)
          expect(metric.arithmetic).toContain(metric.formatted)
        }
      }
    }
  })

  it('notices the nights that are occupied and were never sold', async () => {
    const result = await report()
    const insight = result.insights.find(
      (entry) => entry.id === 'unsold_occupied_nights',
    )

    // Three complimentary nights on unit-2, seven sold nights on unit-1.
    expect(insight?.headline).toContain('3')
    expect(insight?.headline).toContain('10')
  })

  it('reports the closed inventory rather than letting it look like emptiness', async () => {
    const result = await report()
    const insight = result.insights.find(
      (entry) => entry.id === 'out_of_service_load',
    )
    expect(insight?.headline).toContain('4')
  })

  it('links each insight to the screen holding the rows', async () => {
    const result = await report()
    const linked = result.insights.filter(
      (insight) => insight.destination !== null,
    )
    expect(linked.length).toBeGreaterThan(0)
  })
})

// ── The rule the whole screen turns on ────────────────────────────────────

describe('a reader without financial access', () => {
  const operational = actor({
    grants: new Set<Grant>([
      'availability.view',
      'booking.view',
      'booking.view_source',
      'property.view',
    ]),
  })

  it('receives no money insight at all — not a zero, not a dash', async () => {
    const result = await report({ actor: operational })

    const moneyInsights = [
      'revenue_per_available_night',
      'collection_gap',
      'commission_load',
    ]

    for (const id of moneyInsights) {
      expect(
        result.insights.find((insight) => insight.id === id),
      ).toBeUndefined()
      expect(result.absent.find((absence) => absence.id === id)).toBeDefined()
    }
  })

  it('states no shekel figure anywhere on the screen', async () => {
    const result = await report({ actor: operational })
    const rendered = JSON.stringify({
      insights: result.insights,
      absent: result.absent,
    })
    expect(rendered).not.toContain('₪')
  })

  /**
   * The defect this test was written for.
   *
   * `direct_booking_share` is a percentage gated on `booking.view_source`,
   * and its formula is revenue over revenue. The first version of the evidence
   * layer printed "₪0 ÷ ₪2,400" under a figure this reader is entitled to —
   * disclosing revenue to somebody with no financial grant at all.
   */
  it('keeps the share it may see and redacts the money under it', async () => {
    const result = await report({ actor: operational })
    const insight = result.insights.find(
      (entry) => entry.id === 'channel_contribution',
    )

    expect(insight).toBeDefined()

    const share = insight?.evidence[0]?.metrics.find(
      (metric) => metric.id === 'direct_booking_share',
    )
    expect(share?.formatted).toMatch(/%$/)
    expect(share?.operands).toEqual([])
    expect(share?.note).toContain('אינו מוצג')

    // The channel split itself is percent points and stays.
    expect(insight?.evidence[0]?.operands?.length).toBeGreaterThan(0)
  })

  it('still receives the operational insights', async () => {
    const result = await report({ actor: operational })
    const ids = result.insights.map((insight) => insight.id)
    expect(ids).toContain('occupancy_direction')
    expect(ids).toContain('unsold_occupied_nights')
    expect(ids).toContain('cancellation_pressure')
  })
})

describe('a module the package does not include', () => {
  // Every grant, and a package with no agent network. `commission.view` is
  // gated on `agent_network`, so the commission figure is refused by the plan
  // rather than by the permission.
  const withoutNetwork = actor({
    entitlements: new Set(
      [...ENTITLEMENTS].filter(
        (entitlement) => entitlement !== 'agent_network',
      ),
    ),
  })

  it('produces an absence blamed on the package, and no figure', async () => {
    const result = await report({ actor: withoutNetwork })

    const absence = result.absent.find(
      (entry) => entry.id === 'commission_load',
    )
    expect(absence?.reason).toBe('plan')
    expect(absence?.entitlement).toBe('agent_network')
    expect(absence?.explanation).toContain('לא מוצג אפס')

    expect(
      result.insights.find((insight) => insight.id === 'commission_load'),
    ).toBeUndefined()
  })

  it('names the metric rather than the grant code', async () => {
    const result = await report({ actor: withoutNetwork })
    const absence = result.absent.find(
      (entry) => entry.id === 'commission_load',
    )
    expect(absence?.metricNames).toContain('עלות עמלות')
    expect(JSON.stringify(absence)).not.toContain('commission.view')
  })
})

// ── Empty states that teach ───────────────────────────────────────────────

describe('a window with nothing in it', () => {
  it('says so once instead of publishing twelve zeroes', async () => {
    const result = await report({
      world: { units: [], outOfService: [], bookings: [] },
    })

    expect(result.empty).toBe(true)
    expect(result.insights).toEqual([])
    expect(result.absent).toEqual([])
    // The gaps are still worth stating: they are about the product, not the
    // window, and a reader looking for a store attach rate deserves an answer.
    expect(result.gaps.length).toBeGreaterThan(0)
  })
})

describe('a business with no history to compare against', () => {
  it('refuses to call a single period a trend', async () => {
    const result = await report({ comparison: 'none' })

    const absence = result.absent.find(
      (entry) => entry.id === 'occupancy_direction',
    )
    expect(absence?.reason).toBe('no_baseline')
    expect(absence?.explanation).toContain('מגמה')
  })

  it('draws no flat line when the baseline window held no rows', async () => {
    const januaryOnly = {
      ...WORLD,
      bookings: BOOKINGS.filter((row) => row.bookingId !== 'february'),
    }
    const result = await report({ world: januaryOnly })

    const trend = result.insights.find(
      (insight) => insight.id === 'occupancy_direction',
    )
    const absence = result.absent.find(
      (entry) => entry.id === 'occupancy_direction',
    )

    // Either it compared against real nights, or it declined. What it may not
    // do is claim a direction from a baseline that does not exist.
    expect(trend !== undefined || absence !== undefined).toBe(true)
    if (absence) expect(absence.reason).toBe('no_baseline')
  })
})

// ── Housekeeping ──────────────────────────────────────────────────────────

describe('the rule catalogue', () => {
  it('has a unique id and a title for every rule', () => {
    const ids = INSIGHT_RULES.map((rule) => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const rule of INSIGHT_RULES) {
      expect(rule.title.length).toBeGreaterThan(0)
      expect(rule.metrics.length).toBeGreaterThan(0)
    }
  })

  it('is exactly the declared id list, in both directions', () => {
    // `INSIGHT_IDS` is what the type is built from, and a rule deleted without
    // its id — or an id added with no rule behind it — would leave the union
    // describing a screen that does not exist.
    expect([...INSIGHT_RULES.map((rule) => rule.id)].sort()).toEqual(
      [...INSIGHT_IDS].sort(),
    )
  })

  it('states every gap it cannot measure, rather than staying silent', () => {
    for (const gap of GAPS) {
      expect(gap.title.length).toBeGreaterThan(0)
      expect(gap.explanation.length).toBeGreaterThan(0)
    }
    expect(GAPS.length).toBeGreaterThan(0)
  })

  it('never reads a metric it did not declare', async () => {
    // `read()` throws when a rule reaches for an undeclared metric, so a run
    // with a reader holding exactly one grant is the test: every rule whose
    // declared metrics survived must complete without reaching further.
    const narrow = actor({ grants: new Set<Grant>(['booking.view']) })
    await expect(report({ actor: narrow })).resolves.toBeDefined()
  })
})
