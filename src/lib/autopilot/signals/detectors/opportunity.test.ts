import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../../booking/dates'
import { AUTOPILOT_DOMAINS } from '../../../contracts/states'
import { zonedInstant } from '../deadlines'
import type { DetectorContext } from '../facts'
import { ALL_MODULES } from '../modules'

import { detectOpportunity, type EmptyNightFacts } from './opportunity'

/** 22:30 in Israel on the eleventh — already the twelfth in UTC. */
const NOW = zonedInstant('2026-09-11', '22:30', PROPERTY_TIME_ZONE)

function context(now: Date = NOW): DetectorContext {
  return { modules: ALL_MODULES, now, timeZone: PROPERTY_TIME_ZONE }
}

function night(overrides: Partial<EmptyNightFacts> = {}): EmptyNightFacts {
  return {
    propertyId: 'villa-1',
    label: 'וילה ים',
    date: '2026-09-12',
    bookable: true,
    gapNights: 1,
    previousCheckOut: null,
    nextCheckIn: null,
    ...overrides,
  }
}

describe('detectOpportunity', () => {
  it('never offers a night availability has not cleared', () => {
    expect(
      detectOpportunity([night({ bookable: false })], context()),
    ).toHaveLength(0)
  })

  it('never offers a night that has already begun', () => {
    expect(
      detectOpportunity([night({ date: '2026-09-10' })], context()),
    ).toHaveLength(0)
  })

  it('judges "already begun" by the property clock, not by UTC', () => {
    // At 22:30 in Israel it is the eleventh. A UTC slice would already say the
    // twelfth and would throw tonight's own night away.
    expect(
      detectOpportunity([night({ date: '2026-09-11' })], context()),
    ).toHaveLength(1)
  })
})

describe('an opportunity is not an emergency', () => {
  it('is emitted at on_track and takes its place from the domain', () => {
    const signal = detectOpportunity([night()], context())[0]
    expect(signal?.risk).toBe('on_track')
    expect(signal?.domain).toBe('sales_opportunity')
    // Below every operational failure in the triage.
    expect(AUTOPILOT_DOMAINS.indexOf('sales_opportunity')).toBeGreaterThan(
      AUTOPILOT_DOMAINS.indexOf('arrival_risk'),
    )
  })
})

describe('a gap between two bookings', () => {
  it('is a different conversation from a quiet week', () => {
    const orphan = detectOpportunity(
      [
        night({
          previousCheckOut: '2026-09-12',
          nextCheckIn: '2026-09-13',
        }),
      ],
      context(),
    )[0]
    const quiet = detectOpportunity([night({ gapNights: 11 })], context())[0]

    expect(orphan?.code).toBe('opportunity.booking_gap')
    expect(quiet?.code).toBe('opportunity.empty_night')
    expect(orphan?.dedupeKey).not.toBe(quiet?.dedupeKey)
  })
})

describe('keys', () => {
  it('hold the date, because the date is which night', () => {
    const signal = detectOpportunity([night()], context())[0]
    expect(signal?.dedupeKey).toBe(
      'opportunity.empty_night:property:villa-1:2026-09-12',
    )
  })

  it('are the same for the same night five minutes later', () => {
    const first = detectOpportunity([night()], context())[0]
    const later = detectOpportunity(
      [night()],
      context(new Date(NOW.getTime() + 300_000)),
    )[0]
    expect(first?.dedupeKey).toBe(later?.dedupeKey)
  })

  it('never collide across nights or properties', () => {
    const signals = detectOpportunity(
      [
        night({ date: '2026-09-12' }),
        night({ date: '2026-09-13' }),
        night({ date: '2026-09-12', propertyId: 'villa-2' }),
      ],
      context(),
    )
    expect(new Set(signals.map((signal) => signal.dedupeKey)).size).toBe(3)
  })
})
