/**
 * The dashboard contract, and the two traps in it.
 *
 * Trap one: a metric is an aggregate, and an aggregate computed over rows the
 * caller may not see hands them the contents of those rows in one number. A
 * property manager must never receive an organization-wide figure, and no
 * amount of row-level security prevents that on its own.
 *
 * Trap two: a metric the actor may not see must be *absent*. Not zero, not a
 * locked tile carrying the real value in a prop that a developer console
 * reveals in four keystrokes.
 */

import { describe, expect, it } from 'vitest'
import {
  computeDashboard,
  evaluateState,
  type DashboardRequest,
  type DashboardResponse,
} from './dashboard'
import { METRIC_IDS, METRICS, type MetricId } from './dictionary'
import { InMemoryMetricSource, makeBooking, makeUnit } from './memory-source'
import { MetricScopeError, type ResolvedScope } from './scope'
import type { MetricSource } from './source'
import type { MetricComparison } from './periods'
import type { BookingFactRow, OutOfServiceRow, UnitInventoryRow } from './rows'
import type { MetricRange } from './types'
import type { Actor, Scope } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import { ValidationError } from '../errors/app-error'

// ── Fixtures ──────────────────────────────────────────────────────────────

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

const OWNER_GRANTS: readonly Grant[] = [
  'availability.view',
  'booking.view',
  'booking.view_price',
  'booking.view_source',
  'commission.view',
  'agent_statement.view',
  'finance.view',
  'payment.view',
  'lead.view',
  'report.financial.view',
  'report.financial.export',
]

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'user-1',
    organizationId: 'org-a',
    membershipStatus: 'active',
    grants: new Set<Grant>(OWNER_GRANTS),
    scope: { kind: 'all_organization' } as Scope,
    entitlements: EVERY_ENTITLEMENT,
    ...overrides,
  }
}

const MARCH: MetricRange = { start: '2026-03-01', end: '2026-04-01' }

/**
 * Two properties. Three units. One stay in each property, and one in February
 * so that a previous-period comparison has something to compare against.
 *
 *   organization-wide March revenue = 120,000 + 200,000 = 320,000 agorot
 *   prop-1 only                     = 120,000
 */
const UNITS: readonly UnitInventoryRow[] = [
  makeUnit({ unitId: 'unit-1', propertyId: 'prop-1' }),
  makeUnit({ unitId: 'unit-2', propertyId: 'prop-1' }),
  makeUnit({ unitId: 'unit-3', propertyId: 'prop-2' }),
]

const BOOKINGS: readonly BookingFactRow[] = [
  makeBooking({
    bookingId: 'march-prop-1',
    propertyId: 'prop-1',
    unitId: 'unit-1',
    checkIn: '2026-03-01',
    checkOut: '2026-03-05',
    createdOn: '2026-02-01',
    committedOn: '2026-02-01',
    roomRevenue: 100_000,
    ancillaryRevenue: 20_000,
    collected: 60_000,
    source: 'direct_website',
  }),
  makeBooking({
    bookingId: 'march-prop-2',
    propertyId: 'prop-2',
    unitId: 'unit-3',
    checkIn: '2026-03-01',
    checkOut: '2026-03-06',
    createdOn: '2026-02-01',
    committedOn: '2026-02-01',
    roomRevenue: 200_000,
    ancillaryRevenue: 0,
    commission: 30_000,
    collected: 200_000,
    source: 'booking_com',
  }),
  makeBooking({
    bookingId: 'february-prop-1',
    propertyId: 'prop-1',
    unitId: 'unit-1',
    checkIn: '2026-02-10',
    checkOut: '2026-02-13',
    createdOn: '2026-01-05',
    committedOn: '2026-01-05',
    roomRevenue: 60_000,
    collected: 60_000,
    source: 'direct_website',
  }),
]

function world(): InMemoryMetricSource {
  return new InMemoryMetricSource({ units: UNITS, bookings: BOOKINGS })
}

function request(overrides: Partial<DashboardRequest> = {}): DashboardRequest {
  return {
    scope: { organizationId: 'org-a' },
    range: MARCH,
    comparison: 'none',
    metrics: METRIC_IDS,
    ...overrides,
  }
}

const NOW = new Date('2026-04-02T09:00:00Z')

async function dashboard(
  overrides: {
    actor?: Actor
    request?: Partial<DashboardRequest>
    source?: MetricSource
  } = {},
): Promise<DashboardResponse> {
  return computeDashboard({
    actor: overrides.actor ?? actor(),
    request: request(overrides.request),
    source: overrides.source ?? world(),
    now: NOW,
  })
}

function valueOf(response: DashboardResponse, id: MetricId): number | null {
  const result = response.metrics.find((metric) => metric.id === id)
  expect(result, `metric ${id} is missing from the response`).toBeDefined()
  return result?.value ?? null
}

// ── The happy path ────────────────────────────────────────────────────────

describe('a dashboard for somebody allowed to see everything', () => {
  it('answers every requested metric in one call', async () => {
    const response = await dashboard()
    expect(response.metrics.map((metric) => metric.id).sort()).toEqual(
      [...METRIC_IDS].sort(),
    )
    expect(response.withheld).toEqual([])
  })

  it('carries the label and the tooltip with the value', async () => {
    const response = await dashboard()
    const occupancy = response.metrics.find(
      (metric) => metric.id === 'occupancy',
    )
    expect(occupancy?.name).toBe(METRICS.occupancy.name)
    expect(occupancy?.description).toBe(METRICS.occupancy.description)
    expect(occupancy?.formatted).toBe('9.7%')
  })

  it('reports the organization-wide figures', async () => {
    const response = await dashboard()
    // 9 occupied of 93 available → 9.7%; 320,000 agorot of revenue.
    expect(valueOf(response, 'occupancy')).toBe(9.7)
    expect(valueOf(response, 'revenue')).toBe(320_000)
  })

  it('reads the clock that was injected, not the wall', async () => {
    const response = await dashboard()
    expect(response.generatedAt).toBe(NOW.toISOString())
  })

  it('queries the source once per window, not once per metric', async () => {
    const source = world()
    await dashboard({ source })
    expect(source.calls).toEqual({
      loadUnits: 1,
      loadOutOfService: 1,
      loadBookings: 1,
    })
  })
})

// ── Trap two: a withheld metric is absent ─────────────────────────────────

describe('a metric the actor may not see', () => {
  const clerk = actor({
    grants: new Set<Grant>(['availability.view', 'booking.view']),
  })

  it('is absent from the response, not zeroed', async () => {
    const response = await dashboard({ actor: clerk })
    const returned = response.metrics.map((metric) => metric.id)

    expect(returned).toContain('occupancy')
    expect(returned).not.toContain('revenue')
    expect(returned).not.toContain('adr')
    expect(returned).not.toContain('outstanding_balance')
    expect(returned).not.toContain('commission_cost')
  })

  it('is named in `withheld` so the interface can explain the gap', async () => {
    const response = await dashboard({ actor: clerk })
    expect(response.withheld).toContain('revenue')
    expect(response.withheld).toContain('commission_cost')
    expect(response.withheld).not.toContain('occupancy')
  })

  it('leaves no trace of the figure anywhere in the payload', async () => {
    const response = await dashboard({ actor: clerk })
    const serialised = JSON.stringify(response)
    expect(serialised).not.toContain('320000')
    expect(serialised).not.toContain('200000')
  })

  it('reads nothing at all when no metric survives', async () => {
    const source = world()
    const stranger = actor({ grants: new Set<Grant>() })
    const response = await computeDashboard({
      actor: stranger,
      request: request({ metrics: ['revenue', 'occupancy'] }),
      source,
      now: NOW,
    })

    expect(response.metrics).toEqual([])
    expect(response.withheld).toEqual(['revenue', 'occupancy'])
    // Not a performance point: rows this person may not aggregate are never
    // read in the first place.
    expect(source.calls).toEqual({
      loadUnits: 0,
      loadOutOfService: 0,
      loadBookings: 0,
    })
  })
})

describe('an aggregate and its detail are separate rights', () => {
  it('gives the total without the ledger behind it', async () => {
    const shiftManager = actor({
      grants: new Set<Grant>(['finance.view']),
    })
    const response = await dashboard({
      actor: shiftManager,
      request: { metrics: ['outstanding_balance'] },
    })

    const outstanding = response.metrics[0]
    expect(outstanding.value).toBe(60_000)
    expect(outstanding.detailAvailable).toBe(false)
  })

  it('opens the ledger to somebody holding the payment right', async () => {
    const response = await dashboard({
      request: { metrics: ['outstanding_balance'] },
    })
    expect(response.metrics[0].detailAvailable).toBe(true)
  })
})

// ── Trap one: scope leakage through an aggregate ──────────────────────────

describe('a property manager never receives an organization-wide figure', () => {
  const manager = actor({
    userId: 'manager-1',
    scope: { kind: 'properties', propertyIds: ['prop-1'] },
  })

  it('narrows an unfiltered request to the properties they hold', async () => {
    const response = await dashboard({ actor: manager })
    expect(response.scope.propertyIds).toEqual(['prop-1'])
  })

  it('reports their property, not the business', async () => {
    const theirs = await dashboard({ actor: manager })
    const everything = await dashboard()

    expect(valueOf(theirs, 'revenue')).toBe(120_000)
    expect(valueOf(theirs, 'revenue')).not.toBe(valueOf(everything, 'revenue'))
    // 4 occupied of 62 available, not 9 of 93.
    expect(valueOf(theirs, 'occupancy')).toBe(6.5)
    expect(valueOf(theirs, 'occupancy')).not.toBe(
      valueOf(everything, 'occupancy'),
    )
  })

  it('leaks no part of the other property, in any metric', async () => {
    const serialised = JSON.stringify(await dashboard({ actor: manager }))
    expect(serialised).not.toContain('320000') // organization revenue
    expect(serialised).not.toContain('200000') // the other property's stay
    expect(serialised).not.toContain('30000') // its commission
  })

  it('refuses a property they do not hold rather than answering emptily', async () => {
    await expect(
      dashboard({
        actor: manager,
        request: { scope: { organizationId: 'org-a', propertyId: 'prop-2' } },
      }),
    ).rejects.toThrow(MetricScopeError)
  })

  it('allows the property they do hold', async () => {
    const response = await dashboard({
      actor: manager,
      request: { scope: { organizationId: 'org-a', propertyId: 'prop-1' } },
    })
    expect(valueOf(response, 'revenue')).toBe(120_000)
  })

  it('stays narrow even when the source hands back the whole organization', async () => {
    // Defence in depth. A query written wrong is a bug; a query written wrong
    // that widens an aggregate is a breach, so the rows are filtered again
    // after they arrive.
    const leaky: MetricSource = {
      async loadUnits(): Promise<readonly UnitInventoryRow[]> {
        return UNITS
      },
      async loadOutOfService(): Promise<readonly OutOfServiceRow[]> {
        return []
      },
      async loadBookings(): Promise<readonly BookingFactRow[]> {
        return BOOKINGS
      },
    }

    const response = await dashboard({ actor: manager, source: leaky })
    expect(valueOf(response, 'revenue')).toBe(120_000)
    expect(valueOf(response, 'occupancy')).toBe(6.5)
  })

  it.each([
    ['properties', { kind: 'properties', propertyIds: ['prop-1'] } as Scope],
    ['units', { kind: 'units', unitIds: ['unit-1'] } as Scope],
  ])(
    'never resolves a %s membership to the whole organization',
    async (_label, scope) => {
      const response = await dashboard({ actor: actor({ scope }) })
      const unrestricted =
        response.scope.propertyIds === null && response.scope.unitIds === null
      expect(unrestricted).toBe(false)
    },
  )
})

describe('scopes that have no aggregate form', () => {
  it('refuses another customer outright', async () => {
    await expect(
      dashboard({ request: { scope: { organizationId: 'org-b' } } }),
    ).rejects.toMatchObject({ refusal: 'cross_organization' })
  })

  it('refuses a suspended member', async () => {
    await expect(
      dashboard({ actor: actor({ membershipStatus: 'suspended' }) }),
    ).rejects.toMatchObject({ refusal: 'membership_not_active' })
  })

  it.each(['own_records', 'team'] as const)(
    'refuses a %s membership rather than widening it',
    async (kind) => {
      const scope = (
        kind === 'own_records'
          ? { kind: 'own_records' }
          : { kind: 'team', teamIds: ['team-1'] }
      ) as Scope
      await expect(
        dashboard({ actor: actor({ scope }) }),
      ).rejects.toMatchObject({ refusal: 'scope_not_aggregatable' })
    },
  )

  it('treats an empty scope list as reaching nothing, not everything', async () => {
    await expect(
      dashboard({
        actor: actor({ scope: { kind: 'properties', propertyIds: [] } }),
      }),
    ).rejects.toMatchObject({ refusal: 'out_of_scope' })
  })

  it('lets platform staff see the organization they are inside', async () => {
    const staff = actor({
      isPlatformStaff: true,
      scope: { kind: 'own_records' },
    })
    const response = await dashboard({ actor: staff })
    expect(valueOf(response, 'revenue')).toBe(320_000)
  })
})

// ── Comparisons, end to end ───────────────────────────────────────────────

describe('comparing against the previous period', () => {
  it('states the baseline window and its figure', async () => {
    const response = await dashboard({
      request: { comparison: 'previous_period', metrics: ['revenue'] },
    })
    expect(response.comparisonRange).toEqual({
      start: '2026-02-01',
      end: '2026-03-01',
    })
    // February held one stay worth 60,000.
    expect(response.metrics[0].comparison?.value).toBe(60_000)
    expect(response.metrics[0].trend).toBe('up')
  })

  it('refuses to draw a conclusion from a shorter month', async () => {
    const response = await dashboard({
      request: { comparison: 'previous_period', metrics: ['revenue'] },
    })
    const revenue = response.metrics[0]
    expect(revenue.comparison?.comparable).toBe(false)
    // The delta is shown; the colour is not, because February is three nights
    // shorter and that alone would explain a difference.
    expect(revenue.state).toBe('neutral')
  })

  it('still compares a rate, which length does not distort', async () => {
    const response = await dashboard({
      request: { comparison: 'previous_period', metrics: ['occupancy'] },
    })
    expect(response.metrics[0].comparison?.comparable).toBe(true)
  })

  it('has no comparison at all when none was asked for', async () => {
    const response = await dashboard({ request: { comparison: 'none' } })
    expect(response.comparisonRange).toBeNull()
    for (const metric of response.metrics) {
      expect(metric.comparison).toBeNull()
      expect(metric.trend).toBe('unknown')
    }
  })
})

describe('a comparison window with nothing in it', () => {
  it('says so, rather than reporting a total collapse', async () => {
    // The property joined ESTIA on 1 March. February is not a bad month; it is
    // a month the system knows nothing about.
    const source = new InMemoryMetricSource({
      units: [
        makeUnit({
          unitId: 'unit-1',
          propertyId: 'prop-1',
          inServiceFrom: '2026-03-01',
        }),
      ],
      bookings: [
        makeBooking({
          bookingId: 'first-ever',
          checkIn: '2026-03-01',
          checkOut: '2026-03-05',
          createdOn: '2026-03-01',
          committedOn: '2026-03-01',
          roomRevenue: 100_000,
        }),
      ],
    })

    const response = await dashboard({
      source,
      request: { comparison: 'previous_period', metrics: ['revenue'] },
    })

    const revenue = response.metrics[0]
    expect(revenue.value).toBe(100_000)
    expect(revenue.comparison?.empty).toBe(true)
    expect(revenue.comparison?.value).toBeNull()
    expect(revenue.comparison?.deltaPercent).toBeNull()
    expect(revenue.trend).toBe('unknown')
    // Emphatically not a crisis.
    expect(revenue.state).toBe('neutral')
  })
})

// ── State, decided by meaning ─────────────────────────────────────────────

function comparison(
  overrides: Partial<MetricComparison> = {},
): MetricComparison {
  return {
    basis: 'previous_period',
    range: { start: '2026-02-01', end: '2026-03-01' },
    value: 100,
    delta: 10,
    deltaPercent: 10,
    direction: 'up',
    empty: false,
    comparable: true,
    nights: 31,
    baselineNights: 31,
    ...overrides,
  }
}

describe('a rise is not automatically good news', () => {
  it('calls a rise in cancellations a warning', () => {
    // Below the absolute threshold, so this is the trend rule alone.
    const state = evaluateState(METRICS.cancellation_rate, 5, comparison())
    expect(state).toBe('warning')
    expect(state).not.toBe('positive')
  })

  it('calls a fall in cancellations good news', () => {
    expect(
      evaluateState(
        METRICS.cancellation_rate,
        5,
        comparison({ delta: -10, deltaPercent: -10, direction: 'down' }),
      ),
    ).toBe('positive')
  })

  it('calls a rise in occupancy good news', () => {
    expect(evaluateState(METRICS.occupancy, 70, comparison())).toBe('positive')
  })

  it('calls a fall in occupancy a warning', () => {
    expect(
      evaluateState(
        METRICS.occupancy,
        70,
        comparison({ delta: -10, deltaPercent: -10, direction: 'down' }),
      ),
    ).toBe('warning')
  })

  it('escalates a severe adverse move to critical', () => {
    expect(
      evaluateState(
        METRICS.occupancy,
        70,
        comparison({ delta: -40, deltaPercent: -40, direction: 'down' }),
      ),
    ).toBe('critical')
  })

  it('ignores a change too small to mean anything', () => {
    expect(
      evaluateState(
        METRICS.occupancy,
        70,
        comparison({ delta: 0.5, deltaPercent: 0.5 }),
      ),
    ).toBe('neutral')
  })

  it('lets an absolute threshold beat a flattering trend', () => {
    // Occupancy doubled — and is still 8%. That is not a success story.
    expect(
      evaluateState(
        METRICS.occupancy,
        8,
        comparison({ delta: 4, deltaPercent: 100 }),
      ),
    ).toBe('critical')
  })

  it('has no opinion about a metric with no direction of goodness', () => {
    expect(evaluateState(METRICS.lead_time, 30, comparison())).toBe('neutral')
  })

  it('has no opinion when there is no value', () => {
    expect(evaluateState(METRICS.occupancy, null, comparison())).toBe('neutral')
  })

  it('has no opinion when the windows are not comparable', () => {
    expect(
      evaluateState(
        METRICS.revenue,
        100_000,
        comparison({ comparable: false }),
      ),
    ).toBe('neutral')
  })
})

// ── Bad requests ──────────────────────────────────────────────────────────

describe('a malformed request', () => {
  it('names an unknown metric rather than silently dropping it', async () => {
    await expect(
      computeDashboard({
        actor: actor(),
        request: {
          ...request(),
          metrics: ['profit' as MetricId],
        },
        source: world(),
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('refuses a reversed window', async () => {
    await expect(
      dashboard({
        request: { range: { start: '2026-04-01', end: '2026-03-01' } },
      }),
    ).rejects.toThrow(RangeError)
  })
})

// ── The cache key travels with the answer ─────────────────────────────────

describe('the response carries its own cache key', () => {
  it('differs between two actors with different reach', async () => {
    const wide = await dashboard()
    const narrow = await dashboard({
      actor: actor({ scope: { kind: 'properties', propertyIds: ['prop-1'] } }),
    })
    expect(wide.cacheKey).not.toBe(narrow.cacheKey)
  })

  it('is identical for two people with identical access — and so is the answer', async () => {
    const scope: ResolvedScope = {
      organizationId: 'org-a',
      propertyIds: null,
      unitIds: null,
    }
    const first = await dashboard({ actor: actor({ userId: 'user-1' }) })
    const second = await dashboard({ actor: actor({ userId: 'user-2' }) })

    expect(first.cacheKey).toBe(second.cacheKey)
    // The key may only be shared because the responses genuinely match.
    expect(first.metrics).toEqual(second.metrics)
    expect(first.scope).toEqual(scope)
  })
})
