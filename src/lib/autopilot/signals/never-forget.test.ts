import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../booking/dates'

import { zonedInstant } from './deadlines'
import type { BookingFacts, Decided, DetectorContext } from './facts'
import { ALL_MODULES, NO_MODULES } from './modules'
import {
  NEVER_FORGET_CHECKS,
  NEVER_FORGET_LABEL,
  sweep,
  sweepBooking,
  type NeverForgetPolicy,
} from './never-forget'

const met = (source: string): Decided => ({ met: true, detail: 'בוצע', source })
const unmet = (source: string, detail = 'טרם בוצע'): Decided => ({
  met: false,
  detail,
  source,
})

const ARRIVAL_AT = zonedInstant('2026-09-12', '15:00', PROPERTY_TIME_ZONE)

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

/** Everything due 24 hours out, warning a further 12 hours before that. */
const POLICY: NeverForgetPolicy = Object.fromEntries(
  NEVER_FORGET_CHECKS.map((check) => [
    check,
    {
      hoursBeforeArrival: 24,
      warnMinutesBefore: 720,
      criticalMinutesBefore: 0,
    },
  ]),
)

function context(now: Date): DetectorContext {
  return { modules: ALL_MODULES, now, timeZone: PROPERTY_TIME_ZONE }
}

/** Thirty hours before arrival: inside the warning, outside critical. */
const WARNING = new Date(ARRIVAL_AT.getTime() - 30 * 60 * 60 * 1000)
/** Twenty hours before arrival: the deadline has passed. */
const PAST = new Date(ARRIVAL_AT.getTime() - 20 * 60 * 60 * 1000)
/** Nine days out: nothing is a problem yet. */
const EARLY = new Date(ARRIVAL_AT.getTime() - 9 * 24 * 60 * 60 * 1000)

describe('the eight checks', () => {
  it('are all covered and all labelled', () => {
    expect(NEVER_FORGET_CHECKS).toHaveLength(8)
    for (const check of NEVER_FORGET_CHECKS) {
      expect(NEVER_FORGET_LABEL[check].length).toBeGreaterThan(0)
    }
  })

  it('raise every outstanding one once the deadline is near', () => {
    const signals = sweepBooking({
      facts: booking({
        contract: unmet('contracts'),
        paymentRequirement: unmet('payments'),
        cleanerAcceptance: unmet('tasks'),
        laundry: unmet('laundry'),
        access: unmet('access'),
        arrivalInstructions: unmet('guest_portal'),
        inspection: unmet('tasks'),
        guestDetails: unmet('guests'),
      }),
      policy: POLICY,
      context: context(WARNING),
    })
    expect(signals).toHaveLength(8)
    expect(signals.every((signal) => signal.risk === 'at_risk')).toBe(true)
  })
})

describe('sweeping is not nagging', () => {
  it('says nothing nine days out', () => {
    expect(
      sweepBooking({
        facts: booking({ contract: unmet('contracts') }),
        policy: POLICY,
        context: context(EARLY),
      }),
    ).toHaveLength(0)
  })

  it('says nothing about what is already done', () => {
    expect(
      sweepBooking({
        facts: booking(),
        policy: POLICY,
        context: context(PAST),
      }),
    ).toHaveLength(0)
  })

  it('says nothing about a check the organization never scheduled', () => {
    expect(
      sweepBooking({
        facts: booking({ contract: unmet('contracts') }),
        policy: {},
        context: context(PAST),
      }),
    ).toHaveLength(0)
  })

  it('says nothing when there is no arrival to count back from', () => {
    expect(
      sweepBooking({
        facts: booking({ arrivalAt: null, contract: unmet('contracts') }),
        policy: POLICY,
        context: context(PAST),
      }),
    ).toHaveLength(0)
  })
})

describe('module awareness', () => {
  it('never mentions a module the business does not have', () => {
    const signals = sweepBooking({
      facts: booking({
        contract: unmet('contracts'),
        laundry: unmet('laundry'),
        access: unmet('access'),
        guestDetails: unmet('guests'),
      }),
      policy: POLICY,
      context: { modules: NO_MODULES, now: PAST, timeZone: PROPERTY_TIME_ZONE },
    })
    // Only the core-product check survives.
    expect(signals.map((signal) => signal.code)).toEqual([
      'guest.details_incomplete',
    ])
  })

  it('drops the inspection for a business that inspects nothing', () => {
    const signals = sweepBooking({
      facts: booking({ inspection: unmet('tasks') }),
      policy: POLICY,
      context: {
        modules: { ...ALL_MODULES, inspection: false },
        now: PAST,
        timeZone: PROPERTY_TIME_ZONE,
      },
    })
    expect(signals).toHaveLength(0)
  })

  it('drops a check whose fact does not apply to this booking', () => {
    expect(
      sweepBooking({
        facts: booking({ contract: null }),
        policy: POLICY,
        context: context(PAST),
      }),
    ).toHaveLength(0)
  })
})

describe('escalation', () => {
  it('keeps the same key as at_risk becomes critical', () => {
    const facts = booking({ contract: unmet('contracts') })
    const early = sweepBooking({
      facts,
      policy: POLICY,
      context: context(WARNING),
    })
    const late = sweepBooking({ facts, policy: POLICY, context: context(PAST) })

    expect(early[0]?.risk).toBe('at_risk')
    expect(late[0]?.risk).toBe('critical')
    expect(early[0]?.dedupeKey).toBe(late[0]?.dedupeKey)
  })

  it('gives the same key on two passes five minutes apart', () => {
    const facts = booking({ laundry: unmet('laundry') })
    const first = sweepBooking({
      facts,
      policy: POLICY,
      context: context(PAST),
    })
    const second = sweepBooking({
      facts,
      policy: POLICY,
      context: context(new Date(PAST.getTime() + 5 * 60 * 1000)),
    })
    expect(first[0]?.dedupeKey).toBe(second[0]?.dedupeKey)
    expect(first[0]?.dedupeKey).not.toContain('2026-09')
  })

  it('never collides two checks on one booking', () => {
    const signals = sweepBooking({
      facts: booking({
        contract: unmet('contracts'),
        paymentRequirement: unmet('payments'),
        access: unmet('access'),
      }),
      policy: POLICY,
      context: context(PAST),
    })
    expect(new Set(signals.map((signal) => signal.dedupeKey)).size).toBe(
      signals.length,
    )
  })
})

describe('what the signal carries', () => {
  it('quotes the owning engine and adds the deadline', () => {
    const signal = sweepBooking({
      facts: booking({
        paymentRequirement: unmet(
          'payments',
          'טרם נרשמה מקדמה — חסרים ₪2,500 מתוך ₪2,500.',
        ),
      }),
      policy: POLICY,
      context: context(PAST),
    })[0]

    expect(signal?.detail).toBe('טרם נרשמה מקדמה — חסרים ₪2,500 מתוך ₪2,500.')
    expect(signal?.evidence[0]?.source).toBe('payments')
    expect(signal?.dueAt).toBeDefined()
    expect(signal?.warnAt).toBeDefined()
    expect(signal?.criticalAt).toBeDefined()
    expect(signal?.propertyId).toBe('villa-1')
  })

  it('routes the contract to payment_risk and the cleaner to staff', () => {
    const signals = sweepBooking({
      facts: booking({
        contract: unmet('contracts'),
        cleanerAcceptance: unmet('tasks'),
      }),
      policy: POLICY,
      context: context(PAST),
    })
    const byCode = new Map(
      signals.map((signal) => [signal.code, signal.domain]),
    )
    expect(byCode.get('contract.unsigned')).toBe('payment_risk')
    expect(byCode.get('cleaning.not_accepted')).toBe('staff')
  })
})

describe('sweep over a day', () => {
  it('walks every booking', () => {
    const signals = sweep(
      [
        booking({ contract: unmet('contracts') }),
        booking({ bookingId: 'booking-2', access: unmet('access') }),
      ],
      POLICY,
      context(PAST),
    )
    expect(signals).toHaveLength(2)
    expect(new Set(signals.map((signal) => signal.dedupeKey)).size).toBe(2)
  })
})
