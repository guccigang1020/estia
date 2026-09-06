import { describe, expect, it } from 'vitest'

import type { BookingFacts, Decided, PropertyFacts } from './facts'
import { ALL_MODULES, NO_MODULES, type EnabledModules } from './modules'
import {
  READINESS_REQUIREMENTS,
  blockingRequirements,
  bookingReadiness,
  outstandingRequirements,
  propertyReadiness,
} from './readiness'

const met = (source: string): Decided => ({
  met: true,
  detail: 'בוצע',
  source,
})
const unmet = (source: string): Decided => ({
  met: false,
  detail: 'טרם בוצע',
  source,
})
const atRisk = (source: string): Decided => ({
  met: false,
  atRisk: true,
  detail: 'בעבודה',
  source,
})

function booking(overrides: Partial<BookingFacts> = {}): BookingFacts {
  return {
    bookingId: 'booking-1',
    propertyId: 'villa-1',
    label: 'וילה ים · משפחת כהן',
    arrivalAt: '2026-09-12T12:00:00.000Z',
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

describe('the requirement list', () => {
  it('is the eleven, and every one of them is evaluated', () => {
    expect(READINESS_REQUIREMENTS).toHaveLength(11)
    const readiness = bookingReadiness({
      facts: booking(),
      modules: ALL_MODULES,
    })
    expect(readiness.requirements.map((item) => item.key)).toEqual([
      ...READINESS_REQUIREMENTS,
    ])
  })
})

describe('the denominator', () => {
  it('drops a module the business does not have', () => {
    const withoutLaundry: EnabledModules = { ...ALL_MODULES, laundry: 'off' }
    const readiness = bookingReadiness({
      facts: booking({ laundry: unmet('laundry') }),
      modules: withoutLaundry,
    })

    const laundry = readiness.requirements.find(
      (item) => item.key === 'laundry',
    )
    expect(laundry?.status).toBe('not_applicable')
    // The whole point: everything else is met, so this business is at 100 and
    // not stuck at 91 forever.
    expect(readiness.applicable).toBe(10)
    expect(readiness.met).toBe(10)
    expect(readiness.percent).toBe(100)
  })

  it('never counts a not_applicable requirement anywhere', () => {
    const readiness = bookingReadiness({
      facts: booking(),
      modules: NO_MODULES,
    })
    const applicableKeys = readiness.requirements
      .filter((item) => item.status !== 'not_applicable')
      .map((item) => item.key)
    // Only `guest_details`, which belongs to the core product.
    expect(applicableKeys).toEqual(['guest_details'])
    expect(readiness.applicable).toBe(1)
  })

  it('reports null rather than 100 when nothing applies at all', () => {
    const readiness = bookingReadiness({
      facts: booking({ guestDetails: null }),
      modules: NO_MODULES,
    })
    expect(readiness.applicable).toBe(0)
    expect(readiness.percent).toBeNull()
    expect(readiness.met).toBe(0)
  })

  it('is met over applicable and nothing else', () => {
    const readiness = bookingReadiness({
      facts: booking({
        contract: unmet('contracts'),
        cleaning: unmet('tasks'),
      }),
      modules: ALL_MODULES,
    })
    expect(readiness.applicable).toBe(11)
    expect(readiness.met).toBe(9)
    expect(readiness.percent).toBe(Math.round((9 / 11) * 100))
  })
})

describe('a requirement that does not apply to THIS booking', () => {
  it('is not_applicable and says so differently from a switched-off module', () => {
    const moduleOff = bookingReadiness({
      facts: booking(),
      modules: { ...ALL_MODULES, contracts: false },
    })
    const notRequired = bookingReadiness({
      facts: booking({ contract: null }),
      modules: ALL_MODULES,
    })

    const keyOf = (percent: ReturnType<typeof bookingReadiness>): string =>
      percent.requirements.find((item) => item.key === 'contract_signed')
        ?.evidence[0]?.key ?? ''

    expect(keyOf(moduleOff)).toBe('contract_signed.module_off')
    expect(keyOf(notRequired)).toBe('contract_signed.not_required')
  })
})

describe('evidence', () => {
  it('is present on every requirement, met ones included', () => {
    const readiness = bookingReadiness({
      facts: booking(),
      modules: ALL_MODULES,
    })
    for (const requirement of readiness.requirements) {
      expect(requirement.evidence.length).toBeGreaterThan(0)
    }
  })

  it('quotes the owning engine rather than paraphrasing it', () => {
    const readiness = bookingReadiness({
      facts: booking({
        paymentRequirement: {
          met: false,
          detail: 'טרם נרשמה מקדמה — חסרים ₪2,500 מתוך ₪2,500.',
          source: 'payments',
          sourceId: 'pay-1',
        },
      }),
      modules: ALL_MODULES,
    })
    const payment = readiness.requirements.find(
      (item) => item.key === 'payment_requirement',
    )
    expect(payment?.evidence[0]?.source).toBe('payments')
    expect(payment?.evidence[0]?.sourceId).toBe('pay-1')
  })
})

describe('at_risk', () => {
  it('does not count toward the numerator', () => {
    const readiness = bookingReadiness({
      facts: booking({ cleaning: atRisk('tasks') }),
      modules: ALL_MODULES,
    })
    expect(readiness.met).toBe(10)
    expect(
      readiness.requirements.find((item) => item.key === 'cleaning')?.status,
    ).toBe('at_risk')
  })
})

describe('risk', () => {
  it('is ready when everything applicable is met', () => {
    expect(
      bookingReadiness({ facts: booking(), modules: ALL_MODULES }).risk,
    ).toBe('ready')
  })

  it('is ready when nothing applies, rather than alarming a new customer', () => {
    expect(
      bookingReadiness({
        facts: booking({ guestDetails: null }),
        modules: NO_MODULES,
      }).risk,
    ).toBe('ready')
  })

  it('is on_track when only a non-blocking requirement is outstanding', () => {
    expect(
      bookingReadiness({
        facts: booking({ guestConfirmation: unmet('guest_portal') }),
        modules: ALL_MODULES,
      }).risk,
    ).toBe('on_track')
  })

  it('is at_risk when something would stop a guest at the door', () => {
    expect(
      bookingReadiness({
        facts: booking({ access: unmet('access') }),
        modules: ALL_MODULES,
      }).risk,
    ).toBe('at_risk')
  })

  it('never reaches critical, because it does not know what time it is', () => {
    const readiness = bookingReadiness({
      facts: booking({
        access: unmet('access'),
        cleaning: unmet('tasks'),
        maintenance: unmet('maintenance'),
      }),
      modules: ALL_MODULES,
    })
    expect(readiness.risk).toBe('at_risk')
  })
})

describe('property readiness', () => {
  function property(overrides: Partial<PropertyFacts> = {}): PropertyFacts {
    return {
      propertyId: 'villa-1',
      label: 'וילה ים',
      preparation: met('preparation'),
      cleaning: met('tasks'),
      inspection: met('tasks'),
      laundry: met('laundry'),
      inventory: met('inventory'),
      maintenance: met('maintenance'),
      access: met('access'),
      ...overrides,
    }
  }

  it('uses the same eleven and drops the guest-shaped ones', () => {
    const readiness = propertyReadiness({
      facts: property(),
      modules: ALL_MODULES,
    })
    expect(readiness.subject).toEqual({ type: 'property', id: 'villa-1' })
    expect(readiness.applicable).toBe(6)
    expect(readiness.percent).toBe(100)

    const guestShaped = readiness.requirements.filter((item) =>
      [
        'guest_confirmation',
        'contract_signed',
        'payment_requirement',
        'guest_details',
        'arrival_instructions',
      ].includes(item.key),
    )
    expect(guestShaped.every((item) => item.status === 'not_applicable')).toBe(
      true,
    )
  })
})

describe('outstanding and blocking', () => {
  it('never include a requirement that does not apply', () => {
    const readiness = bookingReadiness({
      facts: booking({ cleaning: unmet('tasks') }),
      modules: { ...ALL_MODULES, laundry: 'off' },
    })
    expect(outstandingRequirements(readiness).map((item) => item.key)).toEqual([
      'cleaning',
    ])
    expect(blockingRequirements(readiness).map((item) => item.key)).toEqual([
      'cleaning',
    ])
  })

  it('separates what merely waits from what stops somebody at the door', () => {
    const readiness = bookingReadiness({
      facts: booking({
        guestConfirmation: unmet('guest_portal'),
        access: unmet('access'),
      }),
      modules: ALL_MODULES,
    })
    expect(outstandingRequirements(readiness)).toHaveLength(2)
    expect(blockingRequirements(readiness).map((item) => item.key)).toEqual([
      'access',
    ])
  })
})
