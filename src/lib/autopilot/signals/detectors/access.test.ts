import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../../booking/dates'
import type { DetectorContext } from '../facts'
import { ALL_MODULES, NO_MODULES, type EnabledModules } from '../modules'

import { detectAccess, type AccessFacts } from './access'

const NOW = new Date('2026-09-12T10:00:00.000Z')

function context(modules: EnabledModules = ALL_MODULES): DetectorContext {
  return { modules, now: NOW, timeZone: PROPERTY_TIME_ZONE }
}

function booking(overrides: Partial<AccessFacts> = {}): AccessFacts {
  return {
    bookingId: 'booking-1',
    propertyId: 'villa-1',
    label: 'וילה ים · משפחת כהן',
    arrivalAt: '2026-09-12T12:00:00.000Z',
    codeRequired: true,
    codeGeneratedAt: null,
    instructionsRequired: true,
    instructionsReleasedAt: null,
    ...overrides,
  }
}

describe('detectAccess', () => {
  it('says nothing to a business with neither module', () => {
    expect(detectAccess([booking()], context(NO_MODULES))).toHaveLength(0)
  })

  it('says nothing when the code exists and the guest can see it', () => {
    expect(
      detectAccess(
        [
          booking({
            codeGeneratedAt: '2026-09-11T09:00:00.000Z',
            instructionsReleasedAt: '2026-09-11T09:00:00.000Z',
          }),
        ],
        context(),
      ),
    ).toHaveLength(0)
  })

  it('raises the two failures separately, because two people fix them', () => {
    const signals = detectAccess([booking()], context())
    expect(signals.map((signal) => signal.code)).toEqual([
      'access.code_missing',
      'access.instructions_unreleased',
    ])
    expect(new Set(signals.map((signal) => signal.dedupeKey)).size).toBe(2)
  })

  it('sits in the guest_access domain, above the money', () => {
    for (const signal of detectAccess([booking()], context())) {
      expect(signal.domain).toBe('guest_access')
    }
  })
})

describe('the two modules are asked separately', () => {
  it('still sends an address for a business with no smart locks', () => {
    const signals = detectAccess(
      [booking()],
      context({ ...ALL_MODULES, access: false }),
    )
    expect(signals.map((signal) => signal.code)).toEqual([
      'access.instructions_unreleased',
    ])
  })

  it('still asks for a code for a business with no guest portal', () => {
    const signals = detectAccess(
      [booking()],
      context({ ...ALL_MODULES, guest_portal: false }),
    )
    expect(signals.map((signal) => signal.code)).toEqual([
      'access.code_missing',
    ])
  })

  it('asks for nothing the booking itself does not need', () => {
    expect(
      detectAccess(
        [booking({ codeRequired: false, instructionsRequired: false })],
        context(),
      ),
    ).toHaveLength(0)
  })
})

describe('keys', () => {
  it('are stable across passes', () => {
    const first = detectAccess([booking()], context())[0]
    const later = detectAccess([booking()], {
      ...context(),
      now: new Date(NOW.getTime() + 300_000),
    })[0]
    expect(first?.dedupeKey).toBe(later?.dedupeKey)
    expect(first?.dedupeKey).toBe('access.code_missing:booking:booking-1')
  })

  it('carry the arrival as the deadline', () => {
    expect(detectAccess([booking()], context())[0]?.dueAt).toBe(
      '2026-09-12T12:00:00.000Z',
    )
  })
})
