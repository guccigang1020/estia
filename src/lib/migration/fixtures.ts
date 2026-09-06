/**
 * Builders the tests share.
 *
 * Kept in one file rather than copied into eleven, because a fixture repeated
 * eleven times drifts: the day somebody adds a field to `BookingValues`, ten of
 * the copies keep compiling with the old shape and only the one they touched is
 * updated. A single builder makes that a compile error everywhere at once.
 *
 * Nothing here reaches a database, a clock or a random source. Every fixture is
 * deterministic, which is what lets a test assert an exact report rather than
 * "something with roughly these counts".
 */

import type { Actor } from '../authz/can'
import type { AuditActor } from '../audit/events'
import type { Grant } from '../authz/permissions'
import { fingerprint } from '../service/idempotency'
import type {
  BookingValues,
  GuestValues,
  ImportRecord,
  ImportValues,
} from './types'

export function guest(
  overrides: Partial<GuestValues> & { fullName: string },
): GuestValues {
  return {
    externalId: null,
    phone: null,
    email: null,
    language: 'he',
    nationality: null,
    city: null,
    tags: [],
    notes: null,
    marketingConsent: false,
    ...overrides,
  }
}

export function booking(
  overrides: Partial<BookingValues> & {
    guestName: string
    unitName: string
    checkIn: string
    checkOut: string
  },
): BookingValues {
  return {
    externalId: null,
    propertyName: null,
    guestPhone: null,
    guestEmail: null,
    guestCount: 2,
    adults: null,
    children: null,
    infants: null,
    status: null,
    source: null,
    totalAgorot: null,
    depositAgorot: null,
    notes: null,
    ...overrides,
  }
}

/**
 * A record, with its digest computed the same way `validate.ts` computes it.
 *
 * Computed rather than hard-coded, so a test cannot accidentally assert
 * idempotency against a hash that no real parse would ever produce.
 */
export function record(
  rowNumber: number,
  values: ImportValues,
  sourceId: string | null = null,
): ImportRecord {
  return {
    rowNumber,
    entity: values.entity,
    sourceId,
    contentHash: fingerprint(values),
    values,
  }
}

export function guestRecord(
  rowNumber: number,
  values: Partial<GuestValues> & { fullName: string },
  sourceId: string | null = null,
): ImportRecord {
  return record(rowNumber, { entity: 'guests', guest: guest(values) }, sourceId)
}

export function bookingRecord(
  rowNumber: number,
  values: Partial<BookingValues> & {
    guestName: string
    unitName: string
    checkIn: string
    checkOut: string
  },
  sourceId: string | null = null,
): ImportRecord {
  return record(
    rowNumber,
    { entity: 'bookings', booking: booking(values) },
    sourceId,
  )
}

/** An actor holding whatever the operation under test asks for. */
export function actorWith(grants: readonly Grant[]): Actor {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set(),
  }
}

export const auditActor: AuditActor = {
  type: 'user',
  userId: 'user-1',
  label: 'דנה',
}
