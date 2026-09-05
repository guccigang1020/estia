/**
 * The screen's read, driven by the people who will actually open it.
 *
 * `loadInsights` is the whole pipeline in one call: `computeDashboard` for the
 * figures, `aggregateFacts` for the operands, `buildInsightReport` for the
 * claims. This file runs it against the actors the demo dataset resolves — the
 * general manager's real grants, the accountant's real grants — over an
 * in-memory metric source, so the assertions are about what those roles
 * actually get rather than about a hand-built grant set.
 *
 * The claim that matters most: **the general manager sees no revenue and no
 * zero.** They hold neither `report.financial.view` nor `finance.view`, so
 * every revenue metric is absent from the response and every money insight is
 * absent from the report with a stated reason — while the one currency figure
 * that genuinely is theirs, what the agent network cost, is still handed over.
 * "This person sees no money" would have been the simpler claim and is false,
 * which is precisely how revenue leaked underneath the channel mix once.
 */

import { describe, expect, it } from 'vitest'
import type { User } from '@supabase/supabase-js'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET } from '@/lib/demo/dataset'
import { person } from '@/lib/demo/dataset-identity'
import { DemoActorSource } from '@/lib/demo/session'
import { CachedMetricSource, INSIGHT_RULES } from '@/lib/insights'
import {
  InMemoryMetricSource,
  METRICS,
  makeBooking,
  makeUnit,
  type MetricRange,
} from '@/lib/metrics'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import { SEED_PLANS } from '@/lib/plans/catalog'

import {
  CURRENCY_INSIGHT_METRICS,
  INSIGHT_METRICS,
  loadInsights,
  type LoadedInsights,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId
const MARCH: MetricRange = { start: '2026-03-01', end: '2026-04-01' }
const NOW = new Date('2026-04-02T09:00:00Z')

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

async function actorFor(key: string, planCode = 'management'): Promise<Actor> {
  const seed = SEED_PLANS.find((entry) => entry.code === planCode)
  if (!seed) throw new Error(`No plan '${planCode}' in the catalogue`)

  const resolution = await resolveActor(
    new DemoActorSource(new SupabaseActorSource(client()), {
      code: seed.code,
      label: seed.name,
      entitlements: seed.entitlements,
    }),
    person(key).userId,
    ORGANIZATION,
  )
  if (!resolution.ok) {
    throw new Error(`${key} does not resolve to an actor: ${resolution.reason}`)
  }
  return resolution.actor
}

/**
 * A month with something in it: a sold stay, a complimentary stay, a closure
 * and a cancellation, so that most rules have something to notice.
 */
function source(): InMemoryMetricSource {
  return new InMemoryMetricSource({
    units: [
      makeUnit({ unitId: 'unit-1', propertyId: 'prop-1' }),
      makeUnit({ unitId: 'unit-2', propertyId: 'prop-1' }),
    ],
    outOfService: [
      {
        unitId: 'unit-2',
        propertyId: 'prop-1',
        from: '2026-03-10',
        to: '2026-03-14',
      },
    ],
    bookings: [
      makeBooking({
        bookingId: 'sold',
        propertyId: 'prop-1',
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
        bookingId: 'comp',
        propertyId: 'prop-1',
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
        bookingId: 'cancelled',
        propertyId: 'prop-1',
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
        propertyId: 'prop-1',
        unitId: 'unit-1',
        checkIn: '2026-02-05',
        checkOut: '2026-02-09',
        createdOn: '2026-01-10',
        committedOn: '2026-01-10',
        roomRevenue: 80_000,
        collected: 80_000,
        source: 'direct_website',
      }),
    ],
  })
}

async function screenFor(key: string): Promise<LoadedInsights> {
  return loadInsights({
    actor: await actorFor(key),
    source: source(),
    range: MARCH,
    comparison: 'previous_period',
    propertyId: null,
    now: NOW,
  })
}

// ── The request ───────────────────────────────────────────────────────────

describe('the metric list', () => {
  it('is derived from the rules, with no duplicates', () => {
    const declared = INSIGHT_RULES.flatMap((rule) => rule.metrics)
    expect(new Set(INSIGHT_METRICS).size).toBe(INSIGHT_METRICS.length)
    expect([...INSIGHT_METRICS].sort()).toEqual([...new Set(declared)].sort())
  })

  it('asks for money even though the route is not gated on it', () => {
    // The point of one screen rather than two: the request carries currency
    // metrics, and `computeDashboard` withholds them per reader.
    expect(CURRENCY_INSIGHT_METRICS.length).toBeGreaterThan(0)
    for (const id of CURRENCY_INSIGHT_METRICS) {
      expect(METRICS[id].unit).toBe('currency')
    }
  })
})

// ── The general manager ───────────────────────────────────────────────────

describe('the general manager, who runs the business and sees no revenue', () => {
  /**
   * They are not simply "money-free", and assuming they were is what leaked.
   *
   * A general manager holds `commission.view` — the agent network is their
   * commercial relationship — so they legitimately receive one currency
   * figure: what the channels and agents cost. They hold neither
   * `report.financial.view` nor `finance.view`, so revenue, ADR, RevPAR, the
   * collected total and the outstanding balance are all refused. A test that
   * asserted "no currency metric" would have been asserting something untrue
   * about the product, and the first version of the evidence layer passed a
   * coarser version of it while printing revenue underneath the channel mix.
   */
  it('is refused every revenue metric, and keeps the one cost that is theirs', async () => {
    const { response } = await screenFor('general-manager')

    const received = response.metrics.map((metric) => metric.id)
    // Only metrics some rule actually asks for; the rest are not in the
    // request at all and so are neither received nor withheld.
    for (const id of [
      'revenue',
      'adr',
      'revpar',
      'collected',
      'outstanding_balance',
    ]) {
      expect(response.withheld).toContain(id)
      expect(received).not.toContain(id)
    }

    expect(received).toContain('commission_cost')
    // Every currency metric they did *not* get is one the request asked for.
    for (const id of CURRENCY_INSIGHT_METRICS) {
      expect(received.includes(id) || response.withheld.includes(id)).toBe(true)
    }
  })

  it('is never shown the revenue that the channel mix is a share of', async () => {
    const { report } = await screenFor('general-manager')
    const mix = report.insights.find(
      (insight) => insight.id === 'channel_contribution',
    )

    const share = mix?.evidence[0]?.metrics.find(
      (metric) => metric.id === 'direct_booking_share',
    )

    expect(share?.formatted).toMatch(/%$/)
    expect(share?.operands).toEqual([])
    expect(share?.note).toContain('אינו מוצג')
    expect(mix?.caveat).toBeUndefined()
  })

  it('gets the money insights as stated absences, never as zeroes', async () => {
    const { report } = await screenFor('general-manager')

    for (const id of ['revenue_per_available_night', 'collection_gap']) {
      expect(report.insights.find((entry) => entry.id === id)).toBeUndefined()
      const absence = report.absent.find((entry) => entry.id === id)
      expect(absence).toBeDefined()
      expect(absence?.explanation).toContain('אפס')
    }
  })

  it('renders no shekel sign anywhere on the screen', async () => {
    const { report } = await screenFor('general-manager')
    expect(JSON.stringify(report)).not.toContain('₪')
  })

  it('still gets the operational insights, with their arithmetic', async () => {
    const { report } = await screenFor('general-manager')
    const ids = report.insights.map((insight) => insight.id)

    expect(ids).toContain('occupancy_direction')
    expect(ids).toContain('out_of_service_load')
    expect(ids).toContain('cancellation_pressure')

    for (const insight of report.insights) {
      expect(insight.evidence.length).toBeGreaterThan(0)
    }
  })
})

// ── The accountant ────────────────────────────────────────────────────────

describe('the accountant, who sees the money and not the calendar', () => {
  it('is handed the currency metrics', async () => {
    const { response } = await screenFor('accountant')
    expect(
      response.metrics.filter((metric) => metric.unit === 'currency').length,
    ).toBeGreaterThan(0)
  })

  it('gets no occupancy insight, because they hold no availability grant', async () => {
    const actor = await actorFor('accountant')
    expect(actor.grants.has('availability.view')).toBe(false)

    const { report } = await screenFor('accountant')
    const absence = report.absent.find(
      (entry) => entry.id === 'occupancy_direction',
    )

    expect(absence?.reason).toBe('permission')
    expect(absence?.metricNames).toContain('תפוסה')
    // The two readers are refused different halves of the same screen, and
    // each is told which — by metric name, never by grant code.
    expect(JSON.stringify(absence)).not.toContain('availability.view')
  })
})

// ── The owner ─────────────────────────────────────────────────────────────

describe('the owner', () => {
  it('receives both halves and no withheld metric', async () => {
    const { response, report } = await screenFor('owner')

    expect(response.withheld).toEqual([])
    const ids = report.insights.map((insight) => insight.id)
    expect(ids).toContain('occupancy_direction')
    expect(ids).toContain('revenue_per_available_night')
  })

  it('reads each window once, however many callers ask for it', async () => {
    // Not primarily a performance assertion. `computeDashboard` and
    // `aggregateFacts` must see the *same rows*, or the arithmetic printed
    // under a figure can disagree with the figure because a booking landed
    // between the two reads. The cache is what makes them one read.
    const owner = await actorFor('owner')

    const uncached = source()
    await loadInsights({
      actor: owner,
      source: uncached,
      range: MARCH,
      comparison: 'previous_period',
      propertyId: null,
      now: NOW,
    })

    const cached = source()
    await loadInsights({
      actor: owner,
      source: new CachedMetricSource(cached),
      range: MARCH,
      comparison: 'previous_period',
      propertyId: null,
      now: NOW,
    })

    // Two windows, asked for twice: once by the dashboard and once for the
    // facts. Four reads of bookings without the wrapper, two with it.
    expect(uncached.calls.loadBookings).toBe(4)
    expect(cached.calls.loadBookings).toBe(2)
  })
})
