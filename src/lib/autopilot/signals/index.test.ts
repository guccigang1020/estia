/**
 * One pass over one villa, through the public surface only.
 *
 * The unit suites each prove one thing. This proves the thing none of them
 * can: that a laundry delay, the shortage it caused, the preparation risk that
 * followed and the arrival risk at the end come out of a whole pass as FOUR
 * signals and ONE incident — and that running the same pass five minutes later
 * produces the same four keys rather than eight rows.
 */

import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../booking/dates'
import type { Signal } from '../types'

import {
  ALL_MODULES,
  arrivalRiskSignals,
  assessArrivalRisk,
  bookingReadiness,
  detectInventory,
  detectLaundry,
  detectPreparation,
  linkCauses,
  zonedInstant,
  type ArrivalBlocker,
  type BookingFacts,
  type Decided,
  type DetectorContext,
} from './index'

const ARRIVAL_AT = zonedInstant('2026-09-12', '15:00', PROPERTY_TIME_ZONE)

const met = (source: string): Decided => ({ met: true, detail: 'בוצע', source })
const unmet = (source: string, detail: string): Decided => ({
  met: false,
  detail,
  source,
})

const FACTS: BookingFacts = {
  bookingId: 'booking-1',
  propertyId: 'villa-1',
  label: 'וילה ים · משפחת כהן',
  arrivalAt: ARRIVAL_AT.toISOString(),
  arrivalDate: '2026-09-12',
  arrivalTime: '15:00',
  guestConfirmation: met('guest_portal'),
  contract: met('contracts'),
  paymentRequirement: met('payments'),
  guestDetails: met('guests'),
  preparation: met('preparation'),
  cleaning: unmet('tasks', 'הניקיון טרם הסתיים.'),
  cleanerAcceptance: met('tasks'),
  inspection: met('tasks'),
  laundry: unmet('laundry', 'הכביסה טרם חזרה.'),
  inventory: unmet('inventory', 'חסרות 6 מגבות.'),
  maintenance: met('maintenance'),
  access: met('access'),
  arrivalInstructions: met('guest_portal'),
}

function pass(now: Date): readonly Signal[] {
  const context: DetectorContext = {
    modules: ALL_MODULES,
    now,
    timeZone: PROPERTY_TIME_ZONE,
  }

  const laundry = detectLaundry(
    [
      {
        orderId: 'order-1',
        propertyId: 'villa-1',
        label: 'וילה ים',
        bookingId: 'booking-1',
        status: 'washing',
        requiredBy: '2026-09-12T09:00:00.000Z',
        confirmedAt: '2026-09-11T09:00:00.000Z',
        expectedBackAt: '2026-09-12T14:00:00.000Z',
        providerName: 'מכבסת הצפון',
      },
    ],
    context,
  )

  const inventory = detectInventory(
    [
      {
        propertyId: 'villa-1',
        label: 'וילה ים',
        itemId: 'towel-large',
        itemLabel: 'מגבות גדולות',
        required: 24,
        available: 18,
        shortfall: 6,
        neededBy: null,
        bookingId: 'booking-1',
      },
    ],
    context,
  )

  const preparation = detectPreparation(
    [
      {
        bookingId: 'booking-1',
        propertyId: 'villa-1',
        label: 'וילה ים · משפחת כהן',
        planGenerated: true,
        planPublished: true,
        percentComplete: 0,
        typicalMinutes: 105,
        arrivalAt: ARRIVAL_AT.toISOString(),
        startedAt: null,
        additionalItems: [],
      },
    ],
    context,
  )

  const blockers: readonly ArrivalBlocker[] = inventory.map((signal) => ({
    key: 'stock.shortfall',
    module: 'inventory',
    label: 'מלאי',
    detail: signal.detail,
    source: 'inventory',
    severity: 'blocking',
    dedupeKey: signal.dedupeKey,
  }))

  const assessment = assessArrivalRisk({
    facts: FACTS,
    readiness: bookingReadiness({ facts: FACTS, modules: ALL_MODULES }),
    preparation: {
      percentComplete: 0,
      typicalMinutes: 105,
      startedAt: null,
      cleanerAssigned: true,
      cleanerAcceptedAt: '2026-09-12T06:00:00.000Z',
    },
    blockers,
    thresholds: { warnSlackMinutes: 60, criticalSlackMinutes: 0 },
    context,
  })

  return linkCauses([
    ...laundry,
    ...inventory,
    ...preparation,
    ...arrivalRiskSignals(assessment, FACTS),
  ])
}

const NOW = zonedInstant('2026-09-12', '13:42', PROPERTY_TIME_ZONE)

describe('one pass over one villa', () => {
  const signals = pass(NOW)

  it('produces four signals', () => {
    expect(signals.map((signal) => signal.code).sort()).toEqual([
      'arrival.not_ready',
      'inventory.shortage',
      'laundry.delivery_late',
      'preparation.behind_schedule',
    ])
  })

  it('produces one incident', () => {
    const roots = signals.filter((signal) => signal.causedBy === undefined)
    expect(roots).toHaveLength(1)
    expect(roots[0]?.code).toBe('laundry.delivery_late')
  })

  it('chains every consequence back to a real key', () => {
    const keys = new Set(signals.map((signal) => signal.dedupeKey))
    for (const signal of signals) {
      if (signal.causedBy === undefined) continue
      expect(keys.has(signal.causedBy)).toBe(true)
    }
  })

  it('gives every signal evidence somebody can check', () => {
    for (const signal of signals) {
      expect(signal.evidence.length).toBeGreaterThan(0)
      for (const item of signal.evidence) {
        expect(item.source.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('the same pass, five minutes later', () => {
  it('is the same four problems and not eight rows', () => {
    const first = pass(NOW)
    const second = pass(new Date(NOW.getTime() + 5 * 60 * 1000))

    expect(second.map((signal) => signal.dedupeKey)).toEqual(
      first.map((signal) => signal.dedupeKey),
    )
    expect(new Set(first.map((signal) => signal.dedupeKey)).size).toBe(4)
  })

  it('holds no clock reading in any key', () => {
    for (const signal of pass(NOW)) {
      expect(signal.dedupeKey).not.toMatch(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/)
      expect(signal.dedupeKey).not.toMatch(/\b\d{10,}\b/)
    }
  })
})

describe('the same pass for a business with less switched on', () => {
  it('never mentions a module it does not have', () => {
    const context: DetectorContext = {
      modules: {
        ...ALL_MODULES,
        laundry: 'off',
        inventory: {
          ...ALL_MODULES.inventory,
          enabled: false,
          counting: false,
          reservations: false,
          forecast: false,
        },
      },
      now: NOW,
      timeZone: PROPERTY_TIME_ZONE,
    }

    const signals = [
      ...detectLaundry(
        [
          {
            orderId: 'order-1',
            propertyId: 'villa-1',
            label: 'וילה ים',
            bookingId: 'booking-1',
            status: 'washing',
            requiredBy: '2026-09-12T09:00:00.000Z',
            confirmedAt: null,
            expectedBackAt: '2026-09-12T14:00:00.000Z',
            providerName: 'מכבסת הצפון',
          },
        ],
        context,
      ),
      ...detectInventory(
        [
          {
            propertyId: 'villa-1',
            label: 'וילה ים',
            itemId: 'towel-large',
            itemLabel: 'מגבות גדולות',
            required: 24,
            available: 18,
            shortfall: 6,
            neededBy: null,
            bookingId: 'booking-1',
          },
        ],
        context,
      ),
    ]

    expect(signals).toHaveLength(0)
  })
})
