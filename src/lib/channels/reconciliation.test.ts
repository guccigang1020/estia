import { describe, expect, it } from 'vitest'

import {
  ASK_ALWAYS,
  exceptionsFrom,
  openFor,
  reconcile,
  type AuthorityPolicy,
  type ReconciliationInput,
} from './reconciliation'
import { CONNECTOR_ID, ORG, days } from './testing'
import type { ChannelException } from './types'

const LISTING = {
  channelCode: 'booking_com' as const,
  externalListingId: 'BC-100',
  externalVariantId: null,
}

const NOW = new Date('2026-02-05T10:00:00Z')

function input(patch: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    organizationId: ORG,
    connectorId: CONNECTOR_ID,
    channelCode: 'booking_com',
    listing: LISTING,
    unitId: 'unit-1',
    localDays: days([
      ['2026-03-10', 'free'],
      ['2026-03-11', 'free'],
    ]),
    externalDays: [
      { date: '2026-03-10', unitsAvailable: 1, rateAgorot: null },
      { date: '2026-03-11', unitsAvailable: 1, rateAgorot: null },
    ],
    authority: ASK_ALWAYS,
    now: NOW,
    ...patch,
  }
}

describe('nothing is resolved automatically', () => {
  it('marks every decision as needing a person', () => {
    const report = reconcile(
      input({
        localDays: days([['2026-03-10', 'booked']]),
        externalDays: [
          { date: '2026-03-10', unitsAvailable: 1, rateAgorot: null },
        ],
      }),
    )

    expect(report.decisions).toHaveLength(1)
    for (const decision of report.decisions) {
      expect(decision.automatable).toBe(false)
    }
  })
})

describe('availability', () => {
  it('flags a night ESTIA has sold that the channel is still offering', () => {
    const report = reconcile(
      input({
        localDays: days([['2026-03-10', 'booked']]),
        externalDays: [
          { date: '2026-03-10', unitsAvailable: 2, rateAgorot: null },
        ],
      }),
    )

    const decision = report.decisions[0]
    expect(decision.kind).toBe('oversold_risk')
    expect(decision.recommended).toBe('push_to_channel')
    expect(report.nightsAgreed).toBe(0)
  })

  it('recommends closing the channel even when the channel is authoritative', () => {
    // "Believe the channel about what was sold" never means "let the channel
    // resell a night we have already sold".
    const channelWins: AuthorityPolicy = {
      availability: 'channel',
      rates: 'channel',
      reservations: 'channel',
    }

    const report = reconcile(
      input({
        authority: channelWins,
        localDays: days([['2026-03-10', 'booked']]),
        externalDays: [
          { date: '2026-03-10', unitsAvailable: 1, rateAgorot: null },
        ],
      }),
    )

    expect(report.decisions[0].recommended).toBe('push_to_channel')
  })

  it('flags a free night the channel has closed, and follows the policy', () => {
    const estiaWins = reconcile(
      input({
        authority: { availability: 'estia', rates: 'ask', reservations: 'ask' },
        localDays: days([['2026-03-10', 'free']]),
        externalDays: [
          { date: '2026-03-10', unitsAvailable: 0, rateAgorot: null },
        ],
      }),
    )
    expect(estiaWins.decisions[0].kind).toBe('undersold')
    expect(estiaWins.decisions[0].recommended).toBe('push_to_channel')

    const channelWins = reconcile(
      input({
        authority: {
          availability: 'channel',
          rates: 'ask',
          reservations: 'ask',
        },
        localDays: days([['2026-03-10', 'free']]),
        externalDays: [
          { date: '2026-03-10', unitsAvailable: 0, rateAgorot: null },
        ],
      }),
    )
    expect(channelWins.decisions[0].recommended).toBe('accept_from_channel')
  })

  it('counts agreement rather than only listing problems', () => {
    const report = reconcile(input())
    expect(report.nightsCompared).toBe(2)
    expect(report.nightsAgreed).toBe(2)
    expect(report.decisions).toEqual([])
  })

  it('ignores a night the channel did not report on', () => {
    const report = reconcile(
      input({
        localDays: days([
          ['2026-03-10', 'free'],
          ['2026-03-99', 'free'],
        ]),
        externalDays: [
          { date: '2026-03-10', unitsAvailable: 1, rateAgorot: null },
        ],
      }),
    )

    expect(report.nightsCompared).toBe(1)
  })

  it('reports a mutual block quietly, at the bottom', () => {
    const report = reconcile(
      input({
        localDays: days([
          ['2026-03-10', 'blocked'],
          ['2026-03-11', 'booked'],
        ]),
        externalDays: [
          { date: '2026-03-10', unitsAvailable: 0, rateAgorot: null },
          { date: '2026-03-11', unitsAvailable: 0, rateAgorot: null },
        ],
      }),
    )

    // The booked night agrees and produces nothing; the blocked one is worth
    // one quiet line.
    expect(report.decisions.map((decision) => decision.kind)).toEqual([
      'blocked_both_ways',
    ])
  })

  it('sorts the double-booking risk above everything else', () => {
    const report = reconcile(
      input({
        localDays: days([
          ['2026-03-10', 'free'],
          ['2026-03-11', 'booked'],
        ]),
        externalDays: [
          { date: '2026-03-10', unitsAvailable: 0, rateAgorot: null },
          { date: '2026-03-11', unitsAvailable: 1, rateAgorot: null },
        ],
      }),
    )

    expect(report.decisions[0].kind).toBe('oversold_risk')
  })
})

describe('rates', () => {
  it('follows the rate policy, separately from availability', () => {
    const report = reconcile(
      input({
        authority: {
          availability: 'estia',
          rates: 'channel',
          reservations: 'ask',
        },
        localRates: { '2026-03-10': 90_000 },
        externalDays: [
          { date: '2026-03-10', unitsAvailable: 1, rateAgorot: 85_000 },
          { date: '2026-03-11', unitsAvailable: 1, rateAgorot: null },
        ],
      }),
    )

    const rate = report.decisions.find(
      (decision) => decision.kind === 'rate_differs',
    )
    expect(rate?.recommended).toBe('accept_from_channel')
  })

  it('says nothing when the channel reports no rate', () => {
    const report = reconcile(input({ localRates: { '2026-03-10': 90_000 } }))
    expect(report.decisions).toEqual([])
  })
})

describe('reservations', () => {
  it('reports a reservation that exists only at the channel', () => {
    const report = reconcile(
      input({
        externalReservations: [
          {
            externalReservationId: 'R-1',
            checkIn: '2026-03-10',
            checkOut: '2026-03-12',
            cancelled: false,
          },
        ],
      }),
    )

    const decision = report.decisions[0]
    expect(decision.kind).toBe('reservation_only_at_channel')
    // Never "accept from channel": creating a booking from a sweep would be a
    // second door into `bookings`.
    expect(decision.recommended).toBe('investigate')
  })

  it('reports a booking the channel no longer lists', () => {
    const report = reconcile(
      input({
        localReservations: [
          {
            bookingId: 'booking-1',
            externalReservationId: 'R-1',
            checkIn: '2026-03-10',
            checkOut: '2026-03-12',
            cancelled: false,
          },
        ],
      }),
    )

    expect(report.decisions[0].kind).toBe('reservation_only_in_estia')
    expect(report.decisions[0].bookingId).toBe('booking-1')
  })

  it('does not report a reservation both sides hold', () => {
    const shared = {
      externalReservationId: 'R-1',
      checkIn: '2026-03-10',
      checkOut: '2026-03-12',
      cancelled: false,
    }

    const report = reconcile(
      input({
        externalReservations: [shared],
        localReservations: [{ bookingId: 'b1', ...shared }],
      }),
    )

    expect(report.decisions).toEqual([])
  })

  it('flags a booking the channel has cancelled, without applying it', () => {
    const report = reconcile(
      input({
        externalReservations: [
          {
            externalReservationId: 'R-1',
            checkIn: '2026-03-10',
            checkOut: '2026-03-12',
            cancelled: true,
          },
        ],
        localReservations: [
          {
            bookingId: 'b1',
            externalReservationId: 'R-1',
            checkIn: '2026-03-10',
            checkOut: '2026-03-12',
            cancelled: false,
          },
        ],
      }),
    )

    expect(report.decisions[0].kind).toBe('reservation_only_in_estia')
    expect(report.decisions[0].channelSays).toContain('מבוטלת')
  })
})

describe('promotion to exceptions', () => {
  it('promotes only what can cost a bed or a booking', () => {
    const report = reconcile(
      input({
        localDays: days([
          ['2026-03-10', 'booked'],
          ['2026-03-11', 'free'],
        ]),
        externalDays: [
          { date: '2026-03-10', unitsAvailable: 1, rateAgorot: 90_000 },
          { date: '2026-03-11', unitsAvailable: 0, rateAgorot: null },
        ],
        localRates: { '2026-03-10': 80_000 },
        externalReservations: [
          {
            externalReservationId: 'R-7',
            checkIn: '2026-04-01',
            checkOut: '2026-04-03',
            cancelled: false,
          },
        ],
      }),
    )

    const drafts = exceptionsFrom(report, {
      organizationId: ORG,
      connectorId: CONNECTOR_ID,
      occurredAt: NOW,
    })

    expect(drafts.map((draft) => draft.kind).sort()).toEqual([
      'availability_mismatch',
      'unknown_booking',
    ])
    // A rate that differs and a night the channel closed are decisions, not
    // emergencies, and do not join the queue a double booking is in.
  })
})

describe('open exceptions for a connector', () => {
  it('counts open and acknowledged, never resolved', () => {
    const base: ChannelException = {
      id: 'e1',
      organizationId: ORG,
      connectorId: CONNECTOR_ID,
      channelCode: 'booking_com',
      kind: 'mapping_missing',
      severity: 'critical',
      state: 'open',
      title: 't',
      detail: 'd',
      externalReservationId: null,
      externalListingId: null,
      bookingId: null,
      unitId: null,
      propertyId: null,
      dedupeKey: 'k1',
      occurredAt: NOW,
      resolvedAt: null,
      resolvedByUserId: null,
      resolutionNote: null,
    }

    const open = openFor(
      [
        base,
        { ...base, id: 'e2', state: 'acknowledged', dedupeKey: 'k2' },
        { ...base, id: 'e3', state: 'resolved', dedupeKey: 'k3' },
        { ...base, id: 'e4', connectorId: 'other', dedupeKey: 'k4' },
      ],
      CONNECTOR_ID,
    )

    expect(open.map((exception) => exception.id)).toEqual(['e1', 'e2'])
  })
})
