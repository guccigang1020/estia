import { describe, expect, it } from 'vitest'

import {
  contentFingerprint,
  ingestReservation,
  reservationLedgerKey,
  type IngestionInput,
} from './ingestion'
import {
  CONNECTOR_ID,
  ORG,
  aLedgerRecord,
  aMapping,
  aReservation,
  aUnit,
} from './testing'

const NOW = new Date('2026-02-01T09:05:00Z')

function input(patch: Partial<IngestionInput> = {}): IngestionInput {
  return {
    organizationId: ORG,
    connectorId: CONNECTOR_ID,
    reservation: aReservation(),
    mappings: [aMapping()],
    units: [aUnit()],
    existing: null,
    organizationCurrency: 'ILS',
    now: NOW,
    ...patch,
  }
}

describe('idempotency', () => {
  it('the same reservation delivered twice produces ONE booking intent', () => {
    const reservation = aReservation()

    const first = ingestReservation(input({ reservation }))
    expect(first.kind).toBe('booking_intent')

    // The second delivery arrives with the ledger row the first one wrote.
    const second = ingestReservation(
      input({ reservation, existing: aLedgerRecord(reservation) }),
    )

    expect(second.kind).toBe('duplicate')
    if (second.kind !== 'duplicate') return
    expect(second.reason).toBe('same_revision')
    expect(second.existing.bookingId).toBe('booking-1')
  })

  it('keys on the channel and the reservation id, and nothing else', () => {
    expect(reservationLedgerKey('booking_com', 'R-900')).toBe(
      'channel:booking_com:R-900',
    )
    // Two channels may legitimately issue the same number.
    expect(reservationLedgerKey('airbnb', 'R-900')).not.toBe(
      reservationLedgerKey('booking_com', 'R-900'),
    )
  })

  it('deduplicates on content when the channel has no revision counter', () => {
    const reservation = aReservation({ revision: null })
    const outcome = ingestReservation(
      input({ reservation, existing: aLedgerRecord(reservation) }),
    )

    expect(outcome.kind).toBe('duplicate')
    if (outcome.kind !== 'duplicate') return
    expect(outcome.reason).toBe('same_content')
  })

  it('ignores fields the business would not act on', () => {
    // A channel that stamps a fresh delivery timestamp into every redelivery
    // must not make every redelivery look like a modification.
    const one = aReservation({ externalModifiedAt: new Date('2026-02-01') })
    const two = aReservation({ externalModifiedAt: new Date('2026-02-02') })
    expect(contentFingerprint(one)).toBe(contentFingerprint(two))
  })

  it('reports an older revision as a stale webhook and does not rewind the ledger', () => {
    const stored = aLedgerRecord(aReservation({ revision: 5 }))
    const outcome = ingestReservation(
      input({ reservation: aReservation({ revision: 3 }), existing: stored }),
    )

    expect(outcome.kind).toBe('exception')
    if (outcome.kind !== 'exception') return
    expect(outcome.exception.kind).toBe('stale_webhook')
    // The ledger already holds a newer truth; moving it back would let the
    // old version through on the next delivery.
    expect(outcome.ledger).toBeNull()
  })

  it('routes a newer revision to the modification engine', () => {
    const stored = aLedgerRecord(aReservation({ revision: 1 }))
    const outcome = ingestReservation(
      input({
        reservation: aReservation({ revision: 2, guestCount: 5 }),
        existing: stored,
      }),
    )

    expect(outcome.kind).toBe('modification')
  })

  it('routes a cancellation to the cancellation engine', () => {
    const stored = aLedgerRecord(aReservation({ revision: 1 }))
    const outcome = ingestReservation(
      input({
        reservation: aReservation({ revision: 2, status: 'cancelled' }),
        existing: stored,
      }),
    )

    expect(outcome.kind).toBe('cancellation')
  })
})

describe('mapping', () => {
  it('an unmapped listing produces an exception and NEVER a booking', () => {
    const outcome = ingestReservation(input({ mappings: [] }))

    expect(outcome.kind).toBe('exception')
    if (outcome.kind !== 'exception') return
    expect(outcome.exception.kind).toBe('mapping_missing')
    expect(outcome.exception.severity).toBe('critical')
    expect(outcome.exception.externalReservationId).toBe('R-900')
    // The delivery is still remembered, so the redelivery in four minutes
    // does not raise the same exception again.
    expect(outcome.ledger).not.toBeNull()
  })

  it('refuses two active mappings rather than choosing a bedroom', () => {
    const outcome = ingestReservation(
      input({
        mappings: [
          aMapping({ id: 'a', unitId: 'unit-a' }),
          aMapping({ id: 'b', unitId: 'unit-b' }),
        ],
        units: [aUnit({ unitId: 'unit-a' }), aUnit({ unitId: 'unit-b' })],
      }),
    )

    expect(outcome.kind).toBe('exception')
    if (outcome.kind !== 'exception') return
    expect(outcome.exception.kind).toBe('duplicate_mapping')
  })

  it('refuses a mapping that was never activated', () => {
    const outcome = ingestReservation(
      input({ mappings: [aMapping({ state: 'validated' })] }),
    )

    expect(outcome.kind).toBe('exception')
    if (outcome.kind !== 'exception') return
    expect(outcome.exception.detail).toContain('validated')
  })

  it('refuses a mapping pointing at a unit that no longer exists', () => {
    const outcome = ingestReservation(input({ units: [] }))

    expect(outcome.kind).toBe('exception')
    if (outcome.kind !== 'exception') return
    expect(outcome.exception.kind).toBe('mapping_missing')
  })
})

describe('validation', () => {
  it('refuses inverted dates rather than swapping them', () => {
    const outcome = ingestReservation(
      input({
        reservation: aReservation({
          stay: { checkIn: '2026-03-13', checkOut: '2026-03-10' },
        }),
      }),
    )

    expect(outcome.kind).toBe('exception')
    if (outcome.kind !== 'exception') return
    expect(outcome.exception.kind).toBe('invalid_reservation')
  })

  it('never converts a foreign currency', () => {
    const outcome = ingestReservation(
      input({ reservation: aReservation({ currency: 'EUR' }) }),
    )

    expect(outcome.kind).toBe('exception')
    if (outcome.kind !== 'exception') return
    expect(outcome.exception.detail).toContain('EUR')
  })

  it('refuses a reservation with no guests', () => {
    const outcome = ingestReservation(
      input({ reservation: aReservation({ guestCount: 0 }) }),
    )
    expect(outcome.kind).toBe('exception')
  })
})

describe('the booking intent', () => {
  it('fills the booking.create form and carries its own idempotency key', () => {
    const outcome = ingestReservation(input())
    expect(outcome.kind).toBe('booking_intent')
    if (outcome.kind !== 'booking_intent') return

    const { intent } = outcome
    expect(intent.operation).toBe('booking.create')
    expect(intent.idempotencyKey).toBe('channel:booking_com:R-900')
    expect(intent.input.unitId).toBe('unit-1')
    expect(intent.input.unitLabel).toBe('סוויטת הכרמל')
    expect(intent.input.propertyId).toBe('prop-1')
    // Channel imports arrive already sold — `INITIAL_STATUSES` admits this.
    expect(intent.input.status).toBe('confirmed')
    expect(intent.input.source).toBe('booking_com')
    expect(intent.input.sourceChannel).toBe('Booking.com')
  })

  it('maps Expedia onto the frozen enum without losing its name', () => {
    const outcome = ingestReservation(
      input({
        reservation: aReservation({ channelCode: 'expedia' }),
        mappings: [aMapping({ channelCode: 'expedia' })],
      }),
    )
    if (outcome.kind !== 'booking_intent') throw new Error('expected an intent')

    expect(outcome.intent.input.source).toBe('other_channel')
    expect(outcome.intent.input.sourceChannel).toBe('Expedia')
  })

  it('reports the rounding rather than absorbing it', () => {
    // 100,000 agorot over three nights is 33,333.33 a night, and the odd
    // agora has to be visible to whoever compares this to the OTA statement.
    const outcome = ingestReservation(
      input({ reservation: aReservation({ grossAgorot: 100_000 }) }),
    )
    if (outcome.kind !== 'booking_intent') throw new Error('expected an intent')

    expect(outcome.intent.channelGrossAgorot).toBe(100_000)
    expect(outcome.intent.roundingAgorot).not.toBe(0)
    expect(
      outcome.intent.input.agreedNightlyAgorot * 3 +
        outcome.intent.roundingAgorot,
    ).toBe(100_000)
  })

  it('omits the party split the channel did not send', () => {
    const outcome = ingestReservation(
      input({
        reservation: aReservation({
          adults: null,
          children: null,
          infants: null,
        }),
      }),
    )
    if (outcome.kind !== 'booking_intent') throw new Error('expected an intent')

    expect('adults' in outcome.intent.input).toBe(false)
  })
})

describe('the same stay under two reservation numbers', () => {
  it('is a duplicate booking exception, not a second booking', () => {
    const outcome = ingestReservation(
      input({
        sameStay: [
          {
            bookingId: 'booking-earlier',
            unitId: 'unit-1',
            checkIn: '2026-03-10',
            checkOut: '2026-03-13',
            externalReservationId: 'R-800',
            channelCode: 'booking_com',
          },
        ],
      }),
    )

    expect(outcome.kind).toBe('exception')
    if (outcome.kind !== 'exception') return
    expect(outcome.exception.kind).toBe('duplicate_booking')
    expect(outcome.exception.bookingId).toBe('booking-earlier')
  })

  it('does not fire on a different unit or different dates', () => {
    const outcome = ingestReservation(
      input({
        sameStay: [
          {
            bookingId: 'other',
            unitId: 'unit-2',
            checkIn: '2026-03-10',
            checkOut: '2026-03-13',
            externalReservationId: 'R-800',
            channelCode: 'booking_com',
          },
        ],
      }),
    )

    expect(outcome.kind).toBe('booking_intent')
  })
})
