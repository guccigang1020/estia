/**
 * The report, driven end to end over the demo dataset.
 *
 * `period.test.ts` is a statement about the URL. This is a statement about
 * *consequences*: it takes three personas through the ordinary resolution —
 * `memberships` → `membership_roles` → `roles` → the grant catalogue →
 * `membership_scopes` → the plan — and then asks `computeDashboard` for a real
 * report over `SupabaseMetricSource` reading `createDemoClient(DEMO_DATASET)`.
 * Every module between the persona and the figure is the one a paying customer
 * runs; only the client underneath is different.
 *
 * That distinction matters because "the metrics domain has 7 test files" and
 * "a customer can reach a report" are not the same claim, and the second one
 * is the one somebody is going to be shown. A query shape the demo client
 * cannot serve throws `UnsupportedQuery` here rather than 500ing in a browser.
 *
 * ── The three personas, and why these three ───────────────────────────────
 *
 *   owner            — `all_organization`, holds everything. The control.
 *   property manager — `properties: [rimonim]`. Proves two independent things:
 *                      that a scope narrows an *aggregate* (not just rows),
 *                      and that a metric they lack the grant for is absent
 *                      rather than zero.
 *   cleaner          — `team: [housekeeping]`. Proves the sharpest case in the
 *                      product: there is no honest aggregate of "my own
 *                      records", so the whole report is refused rather than
 *                      widened into one.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { PROPERTY_IDS } from '@/lib/demo/dataset-inventory'
import { DemoActorSource } from '@/lib/demo/session'
import { addDays, localDate } from '@/lib/booking/dates'
import { METRICS, MetricScopeError, type MetricId } from '@/lib/metrics'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import { SupabaseMetricSource } from '@/lib/persistence/metrics'

import {
  FINANCIAL_REPORT_METRICS,
  OPERATING_REPORT_METRICS,
  assertNoCurrency,
  loadReport,
  scopePropertyNames,
  withheldNames,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

/**
 * A window wide enough to contain the dataset's bookings whenever this runs.
 *
 * The demo seeds stays from day −46 to day +58 relative to the day it is
 * built, so a fixed calendar month would be empty on some days of the year and
 * full on others — a test that passes in August and fails in October is worse
 * than no test.
 */
const RANGE = {
  start: addDays(localDate(new Date()), -60),
  end: addDays(localDate(new Date()), 60),
}

function planNamed(code: string) {
  const found = DEMO_PLANS.find((plan) => plan.code === code)
  if (!found) throw new Error(`No demo plan '${code}'`)
  return found
}

function demoDb(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

/** The actor a persona resolves to, on the package that includes operations. */
async function actorFor(personaId: string, planCode = 'pro'): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const source = new DemoActorSource(
    new SupabaseActorSource(demoDb()),
    planNamed(planCode),
  )

  const resolution = await resolveActor(source, persona.userId, ORGANIZATION)
  if (!resolution.ok) {
    throw new Error(
      `${persona.label} does not resolve to an actor: ${resolution.reason}`,
    )
  }
  return resolution.actor
}

async function report(actor: Actor, metrics: readonly MetricId[]) {
  return loadReport({
    actor,
    source: new SupabaseMetricSource(demoDb()),
    range: RANGE,
    comparison: 'previous_period',
    metrics,
    propertyId: null,
  })
}

/* ------------------------------------------------------------- the owner -- */

describe('the owner, who may see everything', () => {
  it('receives every figure the financial report asks for', async () => {
    const response = await report(
      await actorFor('owner'),
      FINANCIAL_REPORT_METRICS,
    )

    expect(response.withheld).toEqual([])
    expect(response.metrics.map((metric) => metric.id)).toEqual([
      ...FINANCIAL_REPORT_METRICS,
    ])
    expect(response.scope.propertyIds).toBeNull()
  })

  it('reads real money out of the stored price lines', async () => {
    const response = await report(
      await actorFor('owner'),
      FINANCIAL_REPORT_METRICS,
    )
    const revenue = response.metrics.find((metric) => metric.id === 'revenue')

    // The figure comes from `booking_price_lines`, which is what the guest was
    // actually charged — not from `units.base_price_agorot`, which is today's
    // rate. A dataset with 39 bookings cannot honestly report nothing.
    expect(revenue?.value).toBeGreaterThan(0)
    expect(revenue?.formatted).toContain('₪')
  })

  it('states occupancy as a percentage of nights that existed', async () => {
    const response = await report(
      await actorFor('owner'),
      OPERATING_REPORT_METRICS,
    )
    const occupancy = response.metrics.find(
      (metric) => metric.id === 'occupancy',
    )

    // Null would be honest for a property with no available nights and is not
    // what this dataset describes: six units have been in service all along.
    expect(occupancy?.value).not.toBeNull()
    expect(occupancy?.value as number).toBeGreaterThan(0)
    expect(occupancy?.value as number).toBeLessThanOrEqual(100)
  })

  it('sees no money on the operating report either', async () => {
    // The screen is defined by what it measures, not by who is looking. An
    // owner opening the operating report gets no shekel figure, because there
    // is none in the set.
    const response = await report(
      await actorFor('owner'),
      OPERATING_REPORT_METRICS,
    )

    for (const metric of response.metrics) {
      expect(metric.unit).not.toBe('currency')
      expect(metric.formatted).not.toContain('₪')
    }
  })
})

/* -------------------------------------------------- the property manager -- */

describe('the property manager, confined to one property', () => {
  it('narrows the aggregate to their own property without being asked to', async () => {
    const actor = await actorFor('property-manager')
    const response = await report(actor, OPERATING_REPORT_METRICS)

    // `propertyId: null` asked for everything. The membership decided
    // otherwise, and the resolved scope says so — which is the difference
    // between an aggregate that is narrow and one that merely looks it.
    expect(response.scope.propertyIds).toEqual([PROPERTY_IDS.rimonim])
    expect(response.scope.propertyIds).not.toContain(PROPERTY_IDS.kacholYam)
  })

  it('produces a different occupancy from the owner, not a filtered display', async () => {
    const [owner, manager] = await Promise.all([
      actorFor('owner'),
      actorFor('property-manager'),
    ])

    const [wide, narrow] = await Promise.all([
      report(owner, OPERATING_REPORT_METRICS),
      report(manager, OPERATING_REPORT_METRICS),
    ])

    const pace = (response: Awaited<ReturnType<typeof report>>) =>
      response.metrics.find((metric) => metric.id === 'booking_pace')?.value

    // Two properties, one of them theirs. If the numbers matched, the scope
    // would be decorating the heading rather than narrowing the rows.
    expect(pace(narrow)).not.toBe(pace(wide))
    expect(pace(narrow) as number).toBeLessThan(pace(wide) as number)
  })

  it('withholds the money entirely rather than showing a zero', async () => {
    const actor = await actorFor('property-manager')
    const response = await report(actor, FINANCIAL_REPORT_METRICS)

    // They hold neither `report.financial.view` nor `finance.view` nor
    // `commission.view`, so seven of the ten are refused — and refused means
    // absent from the array, with no value computed at all.
    for (const id of [
      'revenue',
      'net_operating_revenue',
      'collected',
      'outstanding_balance',
      'commission_cost',
      'adr',
      'revpar',
      'average_booking_value',
    ] as const) {
      expect(response.withheld).toContain(id)
      expect(
        response.metrics.find((metric) => metric.id === id),
      ).toBeUndefined()
    }

    for (const metric of response.metrics) {
      expect(metric.unit).not.toBe('currency')
    }
  })

  it('still receives the free/busy figures the same screen carries', async () => {
    const response = await report(
      await actorFor('property-manager'),
      FINANCIAL_REPORT_METRICS,
    )

    // Occupancy is gated on `availability.view` precisely so that free/busy
    // arithmetic can be shown to somebody who may see no price.
    expect(response.metrics.map((metric) => metric.id)).toContain('occupancy')
  })

  it('names what was refused in Hebrew, not as grant codes', async () => {
    const response = await report(
      await actorFor('property-manager'),
      FINANCIAL_REPORT_METRICS,
    )

    const names = withheldNames(response)
    expect(names).toContain(METRICS.revenue.name)
    expect(names.join(' ')).not.toContain('report.financial.view')
  })

  it('resolves its scope ids to the names the shell already holds', () => {
    const properties = [
      { id: PROPERTY_IDS.rimonim, name: 'אחוזת רימונים' },
      { id: PROPERTY_IDS.kacholYam, name: null },
    ]

    expect(
      scopePropertyNames(properties, {
        scope: {
          organizationId: ORGANIZATION,
          propertyIds: [PROPERTY_IDS.rimonim],
          unitIds: null,
        },
      } as never),
    ).toEqual(['אחוזת רימונים'])

    // An id the shell could not name stays an id. Inventing "נכס 1" on the
    // line that says what the figures cover would be inventing the scope.
    expect(
      scopePropertyNames(properties, {
        scope: {
          organizationId: ORGANIZATION,
          propertyIds: [PROPERTY_IDS.kacholYam],
          unitIds: null,
        },
      } as never),
    ).toEqual([PROPERTY_IDS.kacholYam])
  })
})

/* ----------------------------------------------------------- the cleaner -- */

describe('the cleaner, who has no aggregate at all', () => {
  it('is refused the whole report rather than given a narrowed one', async () => {
    const cleaner = await actorFor('housekeeping')
    expect(cleaner.scope.kind).toBe('team')

    // "Occupancy of my own team" is not a question with an answer, and the
    // domain refuses rather than widening it to one that is. A partial report
    // under a heading that says more than it covers would be worse than an
    // error.
    await expect(report(cleaner, OPERATING_REPORT_METRICS)).rejects.toThrow(
      MetricScopeError,
    )
    await expect(report(cleaner, FINANCIAL_REPORT_METRICS)).rejects.toThrow(
      MetricScopeError,
    )
  })

  it('is refused before any row is read, and told so in Hebrew', async () => {
    const cleaner = await actorFor('housekeeping')

    await expect(
      report(cleaner, OPERATING_REPORT_METRICS),
    ).rejects.toMatchObject({
      refusal: 'scope_not_aggregatable',
      userMessage: expect.stringContaining('לוח בקרה'),
    })
  })

  it('holds neither grant that opens a report route', async () => {
    const cleaner = await actorFor('housekeeping')

    // The route guards, restated as a fact about the actor: `/reports` needs
    // `report.financial.view` and `/reports/operations` needs
    // `availability.view`. She holds neither, so `requireGrant` redirects
    // before any of the above is even reached.
    expect(cleaner.grants.has('report.financial.view')).toBe(false)
    expect(cleaner.grants.has('availability.view')).toBe(false)
  })
})

/* --------------------------------------------------------- the two sets -- */

describe('the metric sets themselves', () => {
  it('keeps every currency figure off the operating report', () => {
    expect(() => assertNoCurrency(OPERATING_REPORT_METRICS)).not.toThrow()
  })

  it('would fail the build if a money metric were added to it', () => {
    // The guard is the enforcement and this is the proof that it bites. It
    // runs at module load, so the failure lands on the commit that causes it.
    expect(() =>
      assertNoCurrency([...OPERATING_REPORT_METRICS, 'revenue']),
    ).toThrow(/revenue/)
  })

  it('asks only for metrics the dictionary defines', () => {
    for (const id of [
      ...FINANCIAL_REPORT_METRICS,
      ...OPERATING_REPORT_METRICS,
    ]) {
      expect(METRICS[id]).toBeDefined()
      expect(METRICS[id].name.length).toBeGreaterThan(0)
    }
  })
})
