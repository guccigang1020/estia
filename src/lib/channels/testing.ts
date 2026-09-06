/**
 * Fixtures for the channel manager's tests.
 *
 * Builders rather than constants, because almost every test here is about one
 * field being different — a revision that moved, a mapping that is suspended,
 * a night the channel still has open — and a test that has to restate twenty
 * unrelated fields to change one is a test nobody writes the second of.
 *
 * It lives beside the module rather than in the test files so that the
 * *screens'* tests can build the same shapes; `notifications/testing.ts` is
 * the precedent and this follows it.
 */

import type { DayAvailability } from '../booking/availability'

import type {
  ChannelCode,
  ChannelReservation,
  ChannelReservationRecord,
  Connector,
  Listing,
  ListingMapping,
} from './types'
import { contentFingerprint, reservationLedgerKey } from './ingestion'
import type { LocalBookingState } from './modification'
import type { UnitFact } from './mapping'
import type { ConnectorContract, ConnectorRequest } from './connector'
import { succeed } from './types'

export const ORG = 'org-1'
export const CONNECTOR_ID = 'conn-1'
export const PROPERTY = 'prop-1'
export const UNIT = 'unit-1'

export function aConnector(patch: Partial<Connector> = {}): Connector {
  return {
    id: CONNECTOR_ID,
    organizationId: ORG,
    propertyId: PROPERTY,
    channelCode: 'booking_com',
    state: 'active',
    capabilities: [
      'discover_listings',
      'push_availability',
      'pull_reservations',
    ],
    credentialRef: null,
    credentialsExpireAt: null,
    externalAccountId: null,
    lastInboundSyncAt: null,
    lastOutboundSyncAt: null,
    lastWebhookAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    version: 1,
    ...patch,
  }
}

export function aListing(patch: Partial<Listing> = {}): Listing {
  return {
    id: 'listing-1',
    organizationId: ORG,
    connectorId: CONNECTOR_ID,
    channelCode: 'booking_com',
    externalListingId: 'BC-100',
    externalVariantId: null,
    name: 'Villa Carmel',
    maxOccupancy: 6,
    active: true,
    discoveredAt: new Date('2026-01-01T00:00:00Z'),
    ...patch,
  }
}

export function aMapping(patch: Partial<ListingMapping> = {}): ListingMapping {
  return {
    id: 'mapping-1',
    organizationId: ORG,
    connectorId: CONNECTOR_ID,
    channelCode: 'booking_com',
    externalListingId: 'BC-100',
    externalVariantId: null,
    propertyId: PROPERTY,
    unitId: UNIT,
    state: 'active',
    mappedByUserId: 'user-1',
    mappedAt: new Date('2026-01-01T00:00:00Z'),
    version: 1,
    ...patch,
  }
}

export function aUnit(patch: Partial<UnitFact> = {}): UnitFact {
  return {
    unitId: UNIT,
    propertyId: PROPERTY,
    name: 'סוויטת הכרמל',
    sellable: true,
    ...patch,
  }
}

export function aReservation(
  patch: Partial<ChannelReservation> = {},
): ChannelReservation {
  return {
    channelCode: 'booking_com',
    externalReservationId: 'R-900',
    externalListingId: 'BC-100',
    externalVariantId: null,
    status: 'new',
    revision: 1,
    stay: { checkIn: '2026-03-10', checkOut: '2026-03-13' },
    guestName: 'דנה לוי',
    guestCount: 4,
    adults: 3,
    children: 1,
    infants: 0,
    grossAgorot: 300_000,
    netAgorot: 255_000,
    currency: 'ILS',
    externalCreatedAt: new Date('2026-02-01T09:00:00Z'),
    externalModifiedAt: null,
    note: null,
    ...patch,
  }
}

/** The ledger row a first delivery of `reservation` would have written. */
export function aLedgerRecord(
  reservation: ChannelReservation,
  patch: Partial<ChannelReservationRecord> = {},
): ChannelReservationRecord {
  return {
    id: 'ledger-1',
    organizationId: ORG,
    connectorId: CONNECTOR_ID,
    channelCode: reservation.channelCode,
    externalReservationId: reservation.externalReservationId,
    ledgerKey: reservationLedgerKey(
      reservation.channelCode,
      reservation.externalReservationId,
    ),
    revision: reservation.revision,
    contentFingerprint: contentFingerprint(reservation),
    bookingId: 'booking-1',
    lastStatus: reservation.status,
    firstSeenAt: new Date('2026-02-01T09:05:00Z'),
    lastSeenAt: new Date('2026-02-01T09:05:00Z'),
    ...patch,
  }
}

export function aBooking(
  patch: Partial<LocalBookingState> = {},
): LocalBookingState {
  return {
    bookingId: 'booking-1',
    organizationId: ORG,
    propertyId: PROPERTY,
    unitId: UNIT,
    status: 'confirmed',
    stay: { checkIn: '2026-03-10', checkOut: '2026-03-13' },
    guestCount: 4,
    guestName: 'דנה לוי',
    totalAgorot: 300_000,
    version: 3,
    lastChannelSyncAt: new Date('2026-02-01T09:05:00Z'),
    localEdits: [],
    ...patch,
  }
}

export function days(
  entries: readonly (readonly [string, DayAvailability['state']])[],
): readonly DayAvailability[] {
  return entries.map(([date, state]) => ({ date, state }))
}

/**
 * A connector that records what it was asked and answers yes to everything.
 *
 * The point of the spy is the negative assertion: the capability guard must
 * refuse an undeclared call *without reaching this object*, and the only way
 * to prove that is to look at what it was never asked.
 */
export class SpyConnector implements ConnectorContract {
  readonly calls: string[] = []

  constructor(
    readonly channelCode: ChannelCode,
    readonly capabilities: readonly ConnectorContract['capabilities'][number][],
  ) {}

  private note<T>(method: string, value: T) {
    this.calls.push(method)
    return Promise.resolve(succeed(value))
  }

  authenticate(_request: ConnectorRequest) {
    return this.note('authenticate', {
      externalAccountId: 'acct-1',
      expiresAt: null,
      grantedCapabilities: this.capabilities,
    })
  }

  discoverListings(_request: ConnectorRequest) {
    return this.note('discoverListings', [] as const)
  }

  pushAvailability() {
    return this.note('pushAvailability', {
      accepted: 1,
      rejected: 0,
      rejectedEntities: [] as readonly string[],
    })
  }

  pushRates() {
    return this.note('pushRates', {
      accepted: 1,
      rejected: 0,
      rejectedEntities: [] as readonly string[],
    })
  }

  pushRestrictions() {
    return this.note('pushRestrictions', {
      accepted: 1,
      rejected: 0,
      rejectedEntities: [] as readonly string[],
    })
  }

  pullReservations() {
    return this.note('pullReservations', {
      reservations: [] as readonly ChannelReservation[],
      cursor: null,
      hasMore: false,
    })
  }

  acknowledgeModification(_request: ConnectorRequest, id: string) {
    return this.note('acknowledgeModification', {
      externalReservationId: id,
      acknowledgedAt: new Date('2026-02-01T10:00:00Z'),
    })
  }

  acknowledgeCancellation(_request: ConnectorRequest, id: string) {
    return this.note('acknowledgeCancellation', {
      externalReservationId: id,
      acknowledgedAt: new Date('2026-02-01T10:00:00Z'),
    })
  }

  health() {
    return this.note('health', {
      reachable: true,
      channelLastSeenAt: null,
      credentialsExpireAt: null,
      notes: [] as readonly string[],
    })
  }
}

export function aRequest(
  patch: Partial<ConnectorRequest> = {},
): ConnectorRequest {
  return {
    organizationId: ORG,
    connectorId: CONNECTOR_ID,
    correlationId: 'corr-1',
    now: new Date('2026-02-01T10:00:00Z'),
    ...patch,
  }
}
