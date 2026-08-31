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

import type { EventType } from '../preparation/types'
import type { TransactionHandle } from '../service'
import type { AvailabilitySource } from './availability'
import type { HoldDraft } from './holds'
import type { BookingParty, SleepingRequest } from './party'
import type { BookingSnapshot } from './state-machine'
import type {
  Agorot,
  BookingAttribution,
  BookingStatus,
  Hold,
  PriceLine,
} from './types'

/**
 * A booking before the database has given it an id, a reference or a version.
 *
 * ── `guestCount` and `party` are both here, and both are load-bearing ──────
 *
 * `guestCount` is the whole head count and stays because it is what the stay is
 * priced and its capacity checked against. `party` is the same number split the
 * way `public.bookings` has stored it since 0009 — `adults`, `children`,
 * `infants` — and `totalGuests(party)` always equals `guestCount`; the create
 * operation refuses the draft otherwise. Two fields rather than one derived
 * accessor because the adapter writes three columns and the pricing reads one,
 * and a port that made either of them compute the other would push arithmetic
 * into a mapping layer.
 *
 * ── What an adapter is expected to do with the last four fields ────────────
 *
 * `party` maps onto the three existing columns. `sleeping`, `eventType` and
 * `specialRequests` have **no columns yet** — see the migration described in
 * this work's report — and `SupabaseBookingRepository` therefore cannot store
 * them today. They are on the draft regardless, because the operation collects
 * them, validates them and names them in the audit event, and a port that
 * omitted them would make the intake unreachable rather than merely unstored.
 *
 * All four are optional, and the reason is honesty about a port mid-migration
 * rather than doubt about whether they matter. `booking.create` always supplies
 * every one of them; what optionality buys is that an adapter written before
 * the split, and the fixtures that exercise it, keep compiling and keep
 * behaving exactly as they did. An adapter that finds them absent is looking at
 * a draft from a caller older than the split, and `legacyParty(guestCount)` in
 * `./party` is the documented answer for that case — the same whole-party-as-
 * adults mapping the Supabase adapter has always written.
 */
export interface BookingDraft {
  organizationId: string
  propertyId: string | null
  unitId: string
  guestName: string
  /** Every head, infants included. Always `totalGuests(party)`. */
  guestCount: number
  /** The same party, as the three columns the schema already holds. */
  party?: BookingParty
  /** Couples, extra beds and cots, as asked for at the desk. */
  sleeping?: SleepingRequest
  /** Which kind of stay this is, from the preparation engine's frozen list. */
  eventType?: EventType
  /** Free Hebrew text — "שתי מיטות תינוק". Null when nothing was said. */
  specialRequests?: string | null
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
