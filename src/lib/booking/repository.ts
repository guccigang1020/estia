/**
 * The data-access contract for the booking operations.
 *
 * Injected for the same reason `ActorSource` and `AvailabilitySource` are: the
 * value in this domain is the state machine, the overlap arithmetic and the
 * money, and none of it can be exercised properly through a database
 * connection. With the reads and writes behind an interface, the whole booking
 * flow — create, amend, cancel, hold, convert — runs in a millisecond against
 * an in-memory implementation, and the Supabase version is a mapping with no
 * decisions in it.
 *
 * Every write takes the transaction handle the service pipeline opened. That is
 * not optional politeness: the booking row, its audit event and the hold it
 * consumed have to commit together, and a write that quietly used its own
 * connection would break that without failing anything.
 */

import type { TransactionHandle } from '../service'
import type { AvailabilitySource } from './availability'
import type { HoldDraft } from './holds'
import type { BookingSnapshot } from './state-machine'
import type {
  Agorot,
  BookingAttribution,
  BookingStatus,
  Hold,
  PriceLine,
} from './types'

/** A booking before the database has given it an id, a reference or a version. */
export interface BookingDraft {
  organizationId: string
  propertyId: string | null
  unitId: string
  guestName: string
  guestCount: number
  checkIn: string
  checkOut: string
  status: BookingStatus
  attribution: BookingAttribution
  lines: readonly PriceLine[]
  totalAgorot: Agorot
  depositRequiredAgorot: Agorot
  createdByUserId: string
}

/** Only what an operation may change. Notably absent: `version` and `id`. */
export interface BookingPatch {
  status?: BookingStatus
  checkIn?: string
  checkOut?: string
  lines?: readonly PriceLine[]
  totalAgorot?: Agorot
  depositRequiredAgorot?: Agorot
}

export interface BookingStore {
  loadBooking(
    organizationId: string,
    bookingId: string,
  ): Promise<BookingSnapshot | null>

  /**
   * Write the booking.
   *
   * This is where the exclusion constraint lives, and where a lost race
   * surfaces. An implementation must let that failure propagate rather than
   * catching it — the operation layer is what turns it into a conflict the
   * guest can understand.
   */
  insertBooking(
    draft: BookingDraft,
    tx: TransactionHandle,
  ): Promise<BookingSnapshot>

  /**
   * Apply the patch and bump the version.
   *
   * `expectedVersion` is passed through to the `WHERE` clause. The pipeline has
   * already compared versions in memory, but that comparison happened before
   * the transaction; the one that counts is the one the database makes.
   */
  updateBooking(args: {
    bookingId: string
    patch: BookingPatch
    expectedVersion: number
    tx: TransactionHandle
  }): Promise<BookingSnapshot>
}

export interface HoldStore {
  loadHold(organizationId: string, holdId: string): Promise<Hold | null>

  /**
   * Every hold this person has that has not been released.
   *
   * Expired ones included, deliberately: liveness is decided in the domain
   * against the clock, so that a missing sweeper cannot inflate an agent's
   * count and lock them out of their own work.
   */
  loadHoldsByUser(
    organizationId: string,
    userId: string,
  ): Promise<readonly Hold[]>

  insertHold(draft: HoldDraft, tx: TransactionHandle): Promise<Hold>

  /** Persist a hold the domain has returned — released, extended or converted. */
  saveHold(hold: Hold, tx: TransactionHandle): Promise<Hold>
}

export interface BookingRepository
  extends AvailabilitySource, BookingStore, HoldStore {}
