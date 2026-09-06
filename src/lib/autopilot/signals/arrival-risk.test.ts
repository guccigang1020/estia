import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../booking/dates'

import {
  arrivalRiskSignals,
  assessArrivalRisk,
  worst,
  type ArrivalBlocker,
  type ArrivalRiskInput,
  type PreparationProgress,
} from './arrival-risk'
import { zonedInstant } from './deadlines'
import type { BookingFacts, Decided } from './facts'
import { ALL_MODULES, NO_MODULES } from './modules'
import { bookingReadiness } from './readiness'

const met = (source: string): Decided => ({ met: true, detail: 'בוצע', source })
const unmet = (source: string): Decided => ({
  met: false,
  detail: 'טרם בוצע',
  source,
})

const ARRIVAL_AT = zonedInstant('2026-09-12', '15:00', PROPERTY_TIME_ZONE)
const NOW = zonedInstant('2026-09-12', '13:42', PROPERTY_TIME_ZONE)

function booking(overrides: Partial<BookingFacts> = {}): BookingFacts {
  return {
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
    cleaning: met('tasks'),
    cleanerAcceptance: met('tasks'),
    inspection: met('tasks'),
    laundry: met('laundry'),
    inventory: met('inventory'),
    maintenance: met('maintenance'),
    access: met('access'),
    arrivalInstructions: met('guest_portal'),
    ...overrides,
  }
}

const NOT_STARTED: PreparationProgress = {
  percentComplete: 0,
  typicalMinutes: 105,
  startedAt: null,
  cleanerAssigned: true,
  cleanerAcceptedAt: '2026-09-12T06:00:00.000Z',
}

function input(overrides: Partial<ArrivalRiskInput> = {}): ArrivalRiskInput {
  const facts = overrides.facts ?? booking()
  return {
    facts,
    readiness:
      overrides.readiness ?? bookingReadiness({ facts, modules: ALL_MODULES }),
    preparation: NOT_STARTED,
    blockers: [],
    thresholds: { warnSlackMinutes: 60, criticalSlackMinutes: 0 },
    context: { modules: ALL_MODULES, now: NOW, timeZone: PROPERTY_TIME_ZONE },
    ...overrides,
  }
}

describe('the sentence a person can act on', () => {
  it('carries the four facts the brief asks for', () => {
    const assessment = assessArrivalRisk(input())
    const byKey = new Map(
      assessment.evidence.map((item) => [item.key, item.value]),
    )

    expect(byKey.get('cleaner.state')).toBe('אישר וטרם התחיל')
    expect(byKey.get('preparation.typical_minutes')).toBe(105)
    expect(byKey.get('arrival.at')).toBe('15:00')
    expect(byKey.get('arrival.now')).toBe('13:42')
    expect(byKey.get('arrival.minutes_to_arrival')).toBe(78)
  })

  it('states the cleaner even when nothing is wrong', () => {
    const assessment = assessArrivalRisk(
      input({
        preparation: {
          ...NOT_STARTED,
          percentComplete: 100,
          startedAt: '2026-09-12T09:00:00.000Z',
        },
      }),
    )
    expect(
      assessment.evidence.some((item) => item.key === 'cleaner.state'),
    ).toBe(true)
  })
})

describe('the arithmetic', () => {
  it('is the work left against the time left', () => {
    const assessment = assessArrivalRisk(input())
    expect(assessment.minutesToArrival).toBe(78)
    expect(assessment.remainingPreparationMinutes).toBe(105)
    expect(assessment.slackMinutes).toBe(-27)
    expect(assessment.state).toBe('critical')
  })

  it('takes the completed part off the remaining time', () => {
    const assessment = assessArrivalRisk(
      input({ preparation: { ...NOT_STARTED, percentComplete: 60 } }),
    )
    expect(assessment.remainingPreparationMinutes).toBe(42)
    expect(assessment.slackMinutes).toBe(36)
    expect(assessment.state).toBe('at_risk')
  })

  it('is on track with comfortable slack and nothing outstanding', () => {
    const assessment = assessArrivalRisk(
      input({ preparation: { ...NOT_STARTED, percentComplete: 90 } }),
    )
    expect(assessment.slackMinutes).toBe(67)
    expect(assessment.state).toBe('ready')
  })

  it('says nothing about slack when the engines gave no duration', () => {
    const assessment = assessArrivalRisk(
      input({ preparation: { ...NOT_STARTED, typicalMinutes: null } }),
    )
    expect(assessment.remainingPreparationMinutes).toBeNull()
    expect(assessment.slackMinutes).toBeNull()
  })
})

describe('blockers', () => {
  const shortage: ArrivalBlocker = {
    key: 'stock.shortfall',
    module: 'inventory',
    label: 'מלאי',
    detail: 'חסרות 6 מגבות',
    source: 'inventory',
    severity: 'blocking',
    dedupeKey: 'inventory.shortage:property:villa-1:towel',
  }

  it('are dropped when the organization does not have the module', () => {
    const assessment = assessArrivalRisk(
      input({
        blockers: [shortage],
        context: {
          modules: { ...ALL_MODULES, inventory: NO_MODULES.inventory },
          now: NOW,
          timeZone: PROPERTY_TIME_ZONE,
        },
      }),
    )
    expect(assessment.blockers).toHaveLength(0)
    expect(
      assessment.evidence.some((item) => item.key === 'stock.shortfall'),
    ).toBe(false)
  })

  it('appear in the evidence when the module is real', () => {
    const assessment = assessArrivalRisk(input({ blockers: [shortage] }))
    expect(assessment.blockers).toHaveLength(1)
    expect(
      assessment.evidence.some((item) => item.key === 'stock.shortfall'),
    ).toBe(true)
  })

  it('stop a booking being ready even with slack to spare', () => {
    const assessment = assessArrivalRisk(
      input({
        blockers: [shortage],
        preparation: { ...NOT_STARTED, percentComplete: 100 },
      }),
    )
    expect(assessment.state).toBe('at_risk')
  })
})

describe('past the arrival', () => {
  it('is critical whatever the arithmetic says', () => {
    const assessment = assessArrivalRisk(
      input({
        facts: booking({ access: unmet('access') }),
        context: {
          modules: ALL_MODULES,
          now: zonedInstant('2026-09-12', '15:30', PROPERTY_TIME_ZONE),
          timeZone: PROPERTY_TIME_ZONE,
        },
      }),
    )
    expect(assessment.minutesToArrival).toBe(-30)
    expect(assessment.state).toBe('critical')
  })
})

describe('with no arrival time fixed', () => {
  it('grades on the requirements alone rather than inventing a clock', () => {
    const facts = booking({ arrivalAt: null, cleaning: unmet('tasks') })
    const assessment = assessArrivalRisk(input({ facts }))
    expect(assessment.minutesToArrival).toBeNull()
    expect(assessment.state).toBe('at_risk')
  })
})

describe('the signal', () => {
  it('is silent when there is nothing to say', () => {
    const assessment = assessArrivalRisk(
      input({ preparation: { ...NOT_STARTED, percentComplete: 100 } }),
    )
    expect(arrivalRiskSignals(assessment, booking())).toHaveLength(0)
  })

  it('keeps one key as the severity escalates', () => {
    const early = assessArrivalRisk(
      input({ preparation: { ...NOT_STARTED, percentComplete: 60 } }),
    )
    const late = assessArrivalRisk(input())

    const earlySignal = arrivalRiskSignals(early, booking())[0]
    const lateSignal = arrivalRiskSignals(late, booking())[0]

    expect(earlySignal?.risk).toBe('at_risk')
    expect(lateSignal?.risk).toBe('critical')
    // The whole point: one exception that got worse, not two exceptions.
    expect(earlySignal?.dedupeKey).toBe(lateSignal?.dedupeKey)
    expect(earlySignal?.code).toBe(lateSignal?.code)
  })

  it('never puts the clock in the key', () => {
    const signal = arrivalRiskSignals(assessArrivalRisk(input()), booking())[0]
    expect(signal?.dedupeKey).toBe('arrival.not_ready:booking:booking-1')
  })

  it('points at the root when a blocker named one', () => {
    const assessment = assessArrivalRisk(
      input({
        blockers: [
          {
            key: 'stock.shortfall',
            module: 'inventory',
            label: 'מלאי',
            detail: 'חסרות 6 מגבות',
            source: 'inventory',
            severity: 'blocking',
            dedupeKey: 'inventory.shortage:property:villa-1:towel',
          },
        ],
      }),
    )
    expect(arrivalRiskSignals(assessment, booking())[0]?.causedBy).toBe(
      'inventory.shortage:property:villa-1:towel',
    )
  })

  it('says what is wrong rather than a bare percentage', () => {
    const assessment = assessArrivalRisk(
      input({ facts: booking({ access: unmet('access') }) }),
    )
    const signal = arrivalRiskSignals(assessment, booking())[0]
    expect(signal?.detail).toContain('כניסה לנכס')
    expect(signal?.detail).not.toMatch(/^\d+%$/)
  })
})

describe('worst', () => {
  it('takes the worst verdict and ignores the ones nobody made', () => {
    expect(worst(['on_track', null, 'critical', 'at_risk'])).toBe('critical')
    expect(worst([null, null])).toBe('on_track')
    expect(worst(['ready'])).toBe('on_track')
  })
})
