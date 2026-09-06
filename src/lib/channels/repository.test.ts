import { describe, expect, it } from 'vitest'

import { InMemoryChannelRepository } from './repository'
import { reservationLedgerKey } from './ingestion'
import { draftException } from './exceptions'
import {
  CONNECTOR_ID,
  ORG,
  PROPERTY,
  aConnector,
  aReservation,
} from './testing'

const NOW = new Date('2026-02-01T09:05:00Z')

function ledgerFor(externalId: string, revision: number | null = 1) {
  const reservation = aReservation({
    externalReservationId: externalId,
    revision,
  })
  return {
    organizationId: ORG,
    connectorId: CONNECTOR_ID,
    channelCode: reservation.channelCode,
    externalReservationId: externalId,
    ledgerKey: reservationLedgerKey(reservation.channelCode, externalId),
    revision,
    contentFingerprint: 'fp-1',
    lastStatus: reservation.status,
    seenAt: NOW,
  }
}

describe('the reservation ledger', () => {
  it('reports created: false on the second delivery, and does not duplicate', async () => {
    const repo = new InMemoryChannelRepository()

    const first = await repo.upsertReservation(ledgerFor('R-1'))
    expect(first.created).toBe(true)

    const second = await repo.upsertReservation(ledgerFor('R-1', 2))
    expect(second.created).toBe(false)
    expect(second.record.id).toBe(first.record.id)
    expect(second.record.revision).toBe(2)
    expect(repo.reservations).toHaveLength(1)
  })

  it('is found by its ledger key', async () => {
    const repo = new InMemoryChannelRepository()
    await repo.upsertReservation(ledgerFor('R-1'))

    const found = await repo.findReservation(ORG, 'channel:booking_com:R-1')
    expect(found?.externalReservationId).toBe('R-1')
    expect(
      await repo.findReservation('other-org', 'channel:booking_com:R-1'),
    ).toBeNull()
  })

  it('never repoints a ledger row at a second booking', async () => {
    // One OTA reservation claiming two bookings makes neither cancellable.
    const repo = new InMemoryChannelRepository()
    await repo.upsertReservation(ledgerFor('R-1'))

    await repo.attachBooking(ORG, 'channel:booking_com:R-1', 'booking-a')
    await repo.attachBooking(ORG, 'channel:booking_com:R-1', 'booking-b')

    expect(repo.reservations[0].bookingId).toBe('booking-a')
  })
})

describe('the exception queue', () => {
  const draft = (subject: string) =>
    draftException('mapping_missing', {
      organizationId: ORG,
      connectorId: CONNECTOR_ID,
      channelCode: 'booking_com',
      occurredAt: NOW,
      subject,
      detail: 'd',
    })

  it('collapses one problem into one row however often it arrives', async () => {
    const repo = new InMemoryChannelRepository()

    const first = await repo.raiseException(draft('BC-1'))
    const second = await repo.raiseException(draft('BC-1'))

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(repo.exceptions).toHaveLength(1)
  })

  it('lists only what is still waiting on a person, unless asked otherwise', async () => {
    const repo = new InMemoryChannelRepository()
    await repo.raiseException(draft('BC-1'))
    await repo.raiseException(draft('BC-2'))

    await repo.settleException(
      ORG,
      repo.exceptions[0].id,
      'resolved',
      'user-1',
      'מופה מחדש.',
      NOW,
    )

    expect(await repo.listExceptions(ORG)).toHaveLength(1)
    expect(
      await repo.listExceptions(ORG, { includeSettled: true }),
    ).toHaveLength(2)
  })

  it('keeps an acknowledged exception in the queue', async () => {
    const repo = new InMemoryChannelRepository()
    await repo.raiseException(draft('BC-1'))

    await repo.settleException(
      ORG,
      repo.exceptions[0].id,
      'acknowledged',
      'user-1',
      null,
      NOW,
    )

    expect(await repo.listExceptions(ORG)).toHaveLength(1)
    expect(repo.exceptions[0].resolvedAt).toBeNull()
  })
})

describe('connectors and mappings', () => {
  it('includes an organization-wide connection under a property filter', async () => {
    // Filtering it out would make a correctly configured business look
    // unconnected.
    const repo = new InMemoryChannelRepository()
    repo.connectors.push(
      aConnector({ id: 'c1', propertyId: null }),
      aConnector({ id: 'c2', propertyId: PROPERTY }),
      aConnector({ id: 'c3', propertyId: 'prop-other' }),
    )

    const found = await repo.listConnectors(ORG, PROPERTY)
    expect(found.map((connector) => connector.id)).toEqual(['c1', 'c2'])
  })

  it('saves a mapping as a draft, never as active', async () => {
    // The setup flow's last step is a person pressing activate. A mapping that
    // goes live on save makes that step decorative.
    const repo = new InMemoryChannelRepository()

    const mapping = await repo.saveMapping(
      ORG,
      CONNECTOR_ID,
      {
        channelCode: 'booking_com',
        externalListingId: 'BC-1',
        externalVariantId: null,
        propertyId: PROPERTY,
        unitId: 'unit-1',
      },
      'user-1',
    )

    expect(mapping.state).toBe('draft')

    await repo.setMappingState(ORG, mapping.id, 'active')
    expect((await repo.listMappings(ORG))[0].state).toBe('active')
  })

  it('upserts discovered listings rather than re-creating them', async () => {
    const repo = new InMemoryChannelRepository()
    const discovered = {
      channelCode: 'booking_com' as const,
      externalListingId: 'BC-1',
      externalVariantId: null,
      name: 'Villa',
      maxOccupancy: 4,
      active: true,
    }

    const first = await repo.saveListings(ORG, CONNECTOR_ID, [discovered], NOW)
    const second = await repo.saveListings(
      ORG,
      CONNECTOR_ID,
      [{ ...discovered, name: 'Villa Carmel', active: false }],
      NOW,
    )

    // The id survives, because mappings and exceptions reference it.
    expect(second[0].id).toBe(first[0].id)
    expect(second[0].name).toBe('Villa Carmel')
    expect(repo.listings).toHaveLength(1)
  })
})

describe('sync counters', () => {
  it('counts failures and rejected entities inside the window only', async () => {
    const repo = new InMemoryChannelRepository()
    const base = {
      organizationId: ORG,
      connectorId: CONNECTOR_ID,
      direction: 'outbound' as const,
      capability: 'push_availability' as const,
      entitiesAttempted: 10,
      entitiesAccepted: 8,
      correlationId: 'corr',
      refusalKind: null,
      refusalDetail: null,
    }

    await repo.recordSyncRun({
      ...base,
      status: 'partial',
      startedAt: new Date(Date.now() - 3_600_000),
      finishedAt: new Date(),
      entitiesRejected: 2,
      failedEntities: ['BC-1:2026-03-10'],
    })
    await repo.recordSyncRun({
      ...base,
      status: 'ok',
      startedAt: new Date(Date.now() - 7_200_000),
      finishedAt: new Date(),
      entitiesRejected: 0,
      failedEntities: [],
    })
    await repo.recordSyncRun({
      ...base,
      status: 'refused',
      startedAt: new Date(Date.now() - 90 * 3_600_000),
      finishedAt: new Date(),
      entitiesRejected: 50,
      failedEntities: ['old'],
    })

    const counters = await repo.syncCounters(ORG, CONNECTOR_ID, 24)
    expect(counters.recentFailures).toBe(1)
    expect(counters.pendingOutbound).toBe(2)
    expect(counters.failedEntities).toEqual(['BC-1:2026-03-10'])
  })
})
