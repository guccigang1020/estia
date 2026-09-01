/**
 * The forecast, and the one case the whole module exists for.
 *
 * The first test in this file is not an example. It is the specification:
 * fifty towels, twenty-five on Friday, thirty on Saturday, and Friday's still
 * in the machine. Any engine that answers "no shortage" there is wrong in the
 * way that costs a changeover, and it is precisely the answer a total gives.
 */

import { describe, expect, it } from 'vitest'

import {
  alertsWorthRaising,
  eventNameFor,
  forecastStock,
  significantRows,
  type ForecastInput,
} from './forecast'
import { capabilitiesFor } from './settings'
import type { DemandLine, ForecastItem, InventorySettings } from './types'

const ORG = 'org-1'
const VILLA_A = 'property-a'
const VILLA_B = 'property-b'
const TOWEL = 'item-towel'

function settings(patch: Partial<InventorySettings> = {}): InventorySettings {
  return {
    organizationId: ORG,
    mode: 'tracked',
    safetyBufferUnits: 0,
    safetyBufferPercent: 0,
    shortageWarningHorizonDays: 7,
    forecastHorizonDays: 30,
    linenTurnaroundDays: 2,
    sharedStock: false,
    reservationsEnabled: true,
    warehouseEnabled: false,
    discrepancyTracking: false,
    transfersEnabled: false,
    ...patch,
  }
}

function towelsAt(propertyId: string, clean: number): ForecastItem {
  return {
    itemId: TOWEL,
    label: 'מגבת גוף',
    propertyId,
    location: 'מחסן ראשי',
    unitOfMeasure: 'יח׳',
    onHandClean: clean,
    byState: { available: clean },
    reservedTotal: 0,
    minQuantity: null,
    parLevel: null,
  }
}

function demand(
  date: string,
  propertyId: string,
  quantity: number,
  bookingId: string,
): DemandLine {
  return {
    date,
    propertyId,
    itemId: TOWEL,
    quantity,
    bookingId,
    reservationId: `res-${bookingId}`,
    label: 'מגבת גוף',
  }
}

function run(patch: Partial<ForecastInput> = {}) {
  const base = settings()
  const input: ForecastInput = {
    today: '2026-09-04',
    horizonDays: 4,
    settings: base,
    capabilities: capabilitiesFor(base),
    items: [towelsAt(VILLA_A, 50)],
    demand: [],
    returns: [],
    ...patch,
  }
  return forecastStock(input)
}

// 2026-09-04 is a Friday; 2026-09-05 a Saturday.
const FRIDAY = '2026-09-04'
const SATURDAY = '2026-09-05'
const SUNDAY = '2026-09-06'

describe('the canonical failing case', () => {
  /**
   * One cupboard, two properties drawing on it. The stock is at Villa A —
   * whose towels go out on Friday and come back Sunday — and the same shared
   * pool is what Villa B's Saturday changeover needs.
   *
   * Written as one stock row at one property with both bookings claiming it,
   * because that is what a business with one linen store and two villas
   * actually has, and it is the arrangement where a total is most confidently
   * wrong.
   */
  const shared: ForecastItem = towelsAt(VILLA_A, 50)

  it('reports five short on Saturday when Friday takes twenty-five and the wash is two days', () => {
    const result = run({
      items: [shared],
      demand: [
        demand(FRIDAY, VILLA_A, 25, 'booking-villa-a'),
        demand(SATURDAY, VILLA_A, 30, 'booking-villa-b'),
      ],
    })

    const saturday = result.rows.find((row) => row.date === SATURDAY)
    expect(saturday).toBeDefined()
    expect(saturday?.required).toBe(30)
    expect(saturday?.expectedClean).toBe(25)
    expect(saturday?.shortage).toBe(5)

    const alert = result.alerts.find((entry) => entry.date === SATURDAY)
    expect(alert?.severity).toBe('critical')
    expect(alert?.shortage).toBe(5)
    // The arithmetic is on the alert, not only in the code that made it.
    expect(alert?.message).toContain('30')
    expect(alert?.message).toContain('25')
    expect(alert?.message).toContain('5')
    expect(alert?.bookingIds).toContain('booking-villa-b')
  })

  it('is a shortage a total would not have found', () => {
    const totalStock = 50
    const largestSingleRequirement = 30
    // The naive answer, stated so the next reader can see it is wrong rather
    // than plausible: 50 ≥ 30, therefore nothing to report.
    expect(totalStock >= largestSingleRequirement).toBe(true)

    const result = run({
      items: [shared],
      demand: [
        demand(FRIDAY, VILLA_A, 25, 'booking-villa-a'),
        demand(SATURDAY, VILLA_A, 30, 'booking-villa-b'),
      ],
    })

    expect(result.alerts).not.toHaveLength(0)
  })

  it('reports it before Saturday', () => {
    const result = run({
      items: [shared],
      demand: [
        demand(FRIDAY, VILLA_A, 25, 'booking-villa-a'),
        demand(SATURDAY, VILLA_A, 30, 'booking-villa-b'),
      ],
    })

    const alert = result.alerts.find((entry) => entry.date === SATURDAY)
    // Raised on the Friday run, one day ahead — which is what makes it
    // actionable rather than a post-mortem.
    expect(alert?.daysAhead).toBe(1)
    expect(eventNameFor(alert!)).toBe('inventory.projected_shortage')
    expect(alertsWorthRaising(result.alerts, settings())).toContain(alert)
  })

  it('finds no shortage when the wash turns round in one day', () => {
    // The same stock, the same bookings, one number different. An engine that
    // always reports a shortage is as useless as one that never does.
    const base = settings({ linenTurnaroundDays: 1 })
    const result = run({
      settings: base,
      capabilities: capabilitiesFor(base),
      items: [shared],
      demand: [
        demand(FRIDAY, VILLA_A, 25, 'booking-villa-a'),
        demand(SATURDAY, VILLA_A, 30, 'booking-villa-b'),
      ],
    })

    const saturday = result.rows.find((row) => row.date === SATURDAY)
    expect(saturday?.incoming).toBe(25)
    expect(saturday?.expectedClean).toBe(50)
    expect(saturday?.shortage).toBe(0)
    expect(result.alerts).toHaveLength(0)
  })

  it('brings Friday’s towels back on Sunday, not before', () => {
    const result = run({
      items: [shared],
      demand: [demand(FRIDAY, VILLA_A, 25, 'booking-villa-a')],
    })

    const byDate = new Map(result.rows.map((row) => [row.date, row]))
    expect(byDate.get(SATURDAY)?.incoming).toBe(0)
    expect(byDate.get(SUNDAY)?.incoming).toBe(25)
    expect(byDate.get(SUNDAY)?.expectedClean).toBe(50)
  })
})

describe('what the engine refuses to guess', () => {
  it('schedules no return at all when the turnaround is unstated', () => {
    // Null is "the business has not said". Guessing short is how a forecast
    // promises towels that are still wet.
    const base = settings({ linenTurnaroundDays: null })
    const result = run({
      settings: base,
      capabilities: capabilitiesFor(base),
      demand: [demand(FRIDAY, VILLA_A, 25, 'booking-villa-a')],
    })

    expect(result.rows.every((row) => row.incoming === 0)).toBe(true)
    // And the position genuinely drains, which over-reports rather than
    // under-reports — the safe direction to be wrong in.
    expect(result.rows.find((row) => row.date === SUNDAY)?.openingClean).toBe(
      25,
    )
  })

  it('does not subtract quantity_reserved as well as the demand lines', () => {
    // The trap: `quantity_reserved` is the running total of the very
    // reservations that make up `demand`. Counting both consumes the same
    // towels twice and manufactures a shortage that does not exist.
    const result = run({
      items: [{ ...towelsAt(VILLA_A, 50), reservedTotal: 25 }],
      demand: [demand(FRIDAY, VILLA_A, 25, 'booking-villa-a')],
    })

    const friday = result.rows.find((row) => row.date === FRIDAY)
    expect(friday?.openingClean).toBe(50)
    expect(friday?.shortage).toBe(0)
    // Carried for display, and only for display.
    expect(friday?.reserved).toBe(25)
  })

  it('counts only allocatable stock as available', () => {
    const result = run({
      items: [
        {
          ...towelsAt(VILLA_A, 18),
          // Sixty owned, eighteen usable. The other forty-two are in a laundry
          // van, damaged or gone.
          byState: {
            available: 18,
            laundry: 30,
            damaged: 8,
            lost: 4,
          },
        },
      ],
      demand: [demand(FRIDAY, VILLA_A, 30, 'booking-villa-a')],
    })

    expect(result.rows[0]?.expectedClean).toBe(18)
    expect(result.rows[0]?.shortage).toBe(12)
  })
})

describe('the safety buffer never causes a shortage', () => {
  it('warns rather than alarms when the remainder drops under the floor', () => {
    const base = settings({ safetyBufferUnits: 10 })
    const result = run({
      settings: base,
      capabilities: capabilitiesFor(base),
      items: [towelsAt(VILLA_A, 30)],
      demand: [demand(FRIDAY, VILLA_A, 25, 'booking-villa-a')],
    })

    const friday = result.rows.find((row) => row.date === FRIDAY)
    expect(friday?.shortage).toBe(0)
    expect(friday?.closingClean).toBe(5)
    expect(friday?.breachesBuffer).toBe(true)

    const alert = result.alerts.find((entry) => entry.date === FRIDAY)
    expect(alert?.severity).toBe('warning')
    expect(alert?.message).toContain('מלאי ביטחון')
  })

  it('never reports a day as both short and merely breaching', () => {
    const base = settings({ safetyBufferUnits: 10 })
    const result = run({
      settings: base,
      capabilities: capabilitiesFor(base),
      items: [towelsAt(VILLA_A, 20)],
      demand: [demand(FRIDAY, VILLA_A, 25, 'booking-villa-a')],
    })

    const friday = result.rows.find((row) => row.date === FRIDAY)
    expect(friday?.shortage).toBe(5)
    expect(friday?.breachesBuffer).toBe(false)
  })
})

describe('honest refusals', () => {
  it('computes nothing and says why when the module is off', () => {
    const base = settings({ mode: 'off' })
    const result = run({ settings: base, capabilities: capabilitiesFor(base) })

    expect(result.computed).toBe(false)
    expect(result.skippedReason).toBe('module_off')
    expect(result.rows).toHaveLength(0)
    expect(result.alerts).toHaveLength(0)
  })

  it('distinguishes "no capability" from "no items"', () => {
    const noReservations = settings({ reservationsEnabled: false })
    expect(
      run({
        settings: noReservations,
        capabilities: capabilitiesFor(noReservations),
      }).skippedReason,
    ).toBe('no_forecast_capability')

    expect(run({ items: [] }).skippedReason).toBe('no_items')
  })
})

describe('transfers are suggestions', () => {
  it('offers another property’s surplus and never spends it twice', () => {
    const base = settings({ mode: 'advanced', transfersEnabled: true })
    const result = run({
      settings: base,
      capabilities: capabilitiesFor(base),
      items: [towelsAt(VILLA_A, 5), towelsAt(VILLA_B, 40)],
      demand: [
        demand(FRIDAY, VILLA_A, 20, 'booking-a'),
        demand(SATURDAY, VILLA_A, 20, 'booking-a2'),
      ],
      propertyNames: new Map([
        [VILLA_A, 'וילה א'],
        [VILLA_B, 'וילה ב'],
      ]),
    })

    const total = result.transfers.reduce((sum, one) => sum + one.quantity, 0)
    expect(result.transfers.length).toBeGreaterThan(0)
    // Villa B holds forty and can never be asked for more than forty.
    expect(total).toBeLessThanOrEqual(40)
    expect(result.transfers[0].fromPropertyId).toBe(VILLA_B)
    expect(result.transfers[0].toPropertyId).toBe(VILLA_A)
    expect(result.transfers[0].fromPropertyName).toBe('וילה ב')
  })

  it('offers none when transfers are not a capability', () => {
    const result = run({
      items: [towelsAt(VILLA_A, 5), towelsAt(VILLA_B, 40)],
      demand: [demand(FRIDAY, VILLA_A, 20, 'booking-a')],
    })

    expect(result.transfers).toHaveLength(0)
  })
})

describe('the rows a screen renders', () => {
  it('drops flat days but keeps today', () => {
    const result = run({
      horizonDays: 7,
      demand: [demand(SATURDAY, VILLA_A, 10, 'booking-a')],
    })

    const shown = significantRows(result.rows, { today: FRIDAY })
    expect(shown.some((row) => row.date === FRIDAY)).toBe(true)
    expect(shown.some((row) => row.date === SATURDAY)).toBe(true)
    expect(shown.length).toBeLessThan(result.rows.length)
  })

  it('clamps a request beyond the organization’s own horizon', () => {
    const base = settings({ forecastHorizonDays: 7 })
    const result = run({
      settings: base,
      capabilities: capabilitiesFor(base),
      horizonDays: 30,
    })

    expect(result.to).toBe('2026-09-11')
  })
})

/**
 * The demo's own numbers, and why the seeded pair does not bite.
 *
 * `src/lib/demo/dataset.ts` seeds 61 clean body towels at אחוזת רימונים, a
 * two-day turnaround, 25 claimed on day +2 and 30 on day +4. That reports no
 * shortage, and it is *right* to: +2 plus a two-day wash is +4, so the first
 * twenty-five land on precisely the morning the thirty are wanted, and 61 − 25
 * is 36, which covers 30 on its own anyway.
 *
 * Two independent reasons, and both have to be removed for the demo to show
 * the behaviour it exists to show. These cases pin the arithmetic so the seed
 * can be corrected against a proof rather than against an argument.
 */
describe('the demo dataset’s towels', () => {
  const demo = settings({ linenTurnaroundDays: 2, safetyBufferPercent: 10 })
  const towels: ForecastItem = {
    ...towelsAt(VILLA_A, 61),
    label: 'מגבת גוף',
    parLevel: 60,
    reservedTotal: 12,
  }

  function demoRun(lines: readonly DemandLine[]) {
    return forecastStock({
      today: FRIDAY,
      horizonDays: 14,
      settings: demo,
      capabilities: capabilitiesFor(demo),
      items: [towels],
      demand: lines,
      returns: [],
    })
  }

  const day = (offset: number): string => {
    const at = new Date(`${FRIDAY}T00:00:00Z`)
    at.setUTCDate(at.getUTCDate() + offset)
    return at.toISOString().slice(0, 10)
  }

  it('reports nothing for the seeded pair, and is right not to', () => {
    const result = demoRun([
      demand(day(2), VILLA_A, 25, 'booking-shabbat'),
      demand(day(4), VILLA_A, 30, 'booking-birthday'),
    ])

    const fourth = result.rows.find((row) => row.date === day(4))
    // The wash lands on exactly the morning the second claim is made.
    expect(fourth?.incoming).toBe(25)
    expect(fourth?.expectedClean).toBe(61)
    expect(result.alerts).toHaveLength(0)
  })

  it('still reports nothing on day +3, because 61 − 25 covers 30', () => {
    // Moving the claim inside the wash window is necessary and not sufficient.
    const result = demoRun([
      demand(day(2), VILLA_A, 25, 'booking-shabbat'),
      demand(day(3), VILLA_A, 30, 'booking-birthday'),
    ])

    const third = result.rows.find((row) => row.date === day(3))
    expect(third?.openingClean).toBe(36)
    expect(third?.incoming).toBe(0)
    expect(third?.shortage).toBe(0)
  })

  it('bites at 40 on day +3: required 40, expected clean 36, shortage 4', () => {
    const result = demoRun([
      demand(day(2), VILLA_A, 25, 'booking-shabbat'),
      demand(day(3), VILLA_A, 40, 'booking-birthday'),
    ])

    const third = result.rows.find((row) => row.date === day(3))
    expect(third?.required).toBe(40)
    expect(third?.expectedClean).toBe(36)
    expect(third?.shortage).toBe(4)

    const alert = result.alerts.find((one) => one.date === day(3))
    expect(alert?.severity).toBe('critical')
    expect(alert?.daysAhead).toBe(3)
    // Inside the seeded seven-day alert horizon, so it is raised rather than
    // merely computed.
    expect(alertsWorthRaising(result.alerts, demo)).toContain(alert)
    expect(eventNameFor(alert!)).toBe('inventory.projected_shortage')
  })
})
