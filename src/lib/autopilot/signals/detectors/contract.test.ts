import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../../booking/dates'
import type { DetectorContext } from '../facts'
import { ALL_MODULES, NO_MODULES } from '../modules'

import { detectContract, type ContractFacts } from './contract'

const NOW = new Date('2026-09-10T09:00:00.000Z')

const CONTEXT: DetectorContext = {
  modules: ALL_MODULES,
  now: NOW,
  timeZone: PROPERTY_TIME_ZONE,
}

function booking(overrides: Partial<ContractFacts> = {}): ContractFacts {
  return {
    bookingId: 'booking-1',
    propertyId: 'villa-1',
    label: 'וילה ים · משפחת כהן',
    required: true,
    sentAt: '2026-09-01T09:00:00.000Z',
    signedAt: null,
    arrivalAt: '2026-09-12T12:00:00.000Z',
    ...overrides,
  }
}

describe('detectContract', () => {
  it('says nothing for a business with no contracts module', () => {
    expect(
      detectContract([booking()], { ...CONTEXT, modules: NO_MODULES }),
    ).toHaveLength(0)
  })

  it('says nothing when no signature was ever asked for', () => {
    expect(
      detectContract([booking({ required: false })], CONTEXT),
    ).toHaveLength(0)
  })

  it('says nothing once it is signed', () => {
    expect(
      detectContract(
        [booking({ signedAt: '2026-09-05T09:00:00.000Z' })],
        CONTEXT,
      ),
    ).toHaveLength(0)
  })

  it('separates never sent from sent and unsigned', () => {
    const unsent = detectContract([booking({ sentAt: null })], CONTEXT)[0]
    const unsigned = detectContract([booking()], CONTEXT)[0]

    expect(unsent?.code).toBe('contract.not_sent')
    expect(unsigned?.code).toBe('contract.unsigned')
    // Two problems, two people, two keys.
    expect(unsent?.dedupeKey).not.toBe(unsigned?.dedupeKey)
  })

  it('sits in payment_risk with the rest of the confirmation policy', () => {
    expect(detectContract([booking()], CONTEXT)[0]?.domain).toBe('payment_risk')
  })

  it('keeps the same key on a second pass', () => {
    const first = detectContract([booking()], CONTEXT)[0]
    const second = detectContract([booking()], {
      ...CONTEXT,
      now: new Date(NOW.getTime() + 300_000),
    })[0]
    expect(first?.dedupeKey).toBe(second?.dedupeKey)
    expect(first?.dedupeKey).toBe('contract.unsigned:booking:booking-1')
  })

  it('carries the arrival as the deadline the screen shows', () => {
    expect(detectContract([booking()], CONTEXT)[0]?.dueAt).toBe(
      '2026-09-12T12:00:00.000Z',
    )
  })
})
