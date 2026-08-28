/**
 * `BookingRepository`, backed by Supabase. This is the file that makes a
 * booking a real thing rather than a well-tested idea.
 *
 * The reference specification is `MemoryRepository` in
 * `src/lib/booking/operations.test.ts`. Its awkward cases are reproduced here
 * on purpose, including the ones that look like oversights and are not:
 * `loadHoldsByUser` filters released holds but *not* expired ones, because
 * liveness is decided in the domain against the clock and a missing sweeper
 * must not be able to lock an agent out of their own work.
 *
 * ── What the database does that the domain does not expect ────────────────
 *
 * Four trigger behaviours, all verified against the live project rather than
 * read off the migration. They are not decorations; each one changes what this
 * adapter has to do.
 *
 * **1. `total_agorot` is not writable.** `tg_bookings_freeze_total` runs
 * `BEFORE INSERT OR UPDATE` and overwrites it with the sum of the booking's
 * price lines. An insert that asks for 999 stores 0, because the lines do not
 * exist yet. So the total is never sent; the lines are written and the row is
 * read back. Proved live: `insert booking A → version=1 total_agorot=0 (draft
 * asked 999)`.
 *
 * **2. Writing a price line bumps the booking's version.**
 * `tg_price_lines_recalc_total` updates `bookings`, which fires `bookings_touch`,
 * which is `version := old.version + 1`. Two price lines therefore move a
 * freshly-inserted booking from version 1 to version 3, and the update path
 * from 2 to 4. Proved live: `after 2 price lines: booking version=4`. Returning
 * the version from the insert's own `RETURNING` clause would hand the caller a
 * number that was already stale — and the caller uses it as `expectedVersion`
 * on the next write, so it would produce a spurious conflict on the very next
 * edit. Every write here re-reads.
 *
 * **3. `version` is the trigger's to set, never the adapter's.**
 * `tg_touch_row` increments it on every update. An adapter that also sent
 * `version: expected + 1` would be overwritten, quietly, and only sometimes
 * agree.
 *
 * **4. The exclusion constraint is not on `bookings`.**
 * `tg_bookings_sync_occupancy` and `tg_holds_sync_occupancy` project rows into
 * `public.unit_occupancy`, where `unit_occupancy_no_overlap` lives. An
 * overlapping insert into `bookings` therefore fails with `23P01` naming a
 * constraint on a table the caller never mentioned. See `errors.ts`.
 *
 * ── Three places the port and the schema disagree ─────────────────────────
 *
 * Reported rather than fixed, because the ports are not this work's to change:
 *
 * **`BookingDraft.guestName` versus `bookings.guest_id`.** The column is a
 * `NOT NULL` foreign key to `guests`; the draft carries a name and nothing
 * else. So this adapter creates a guest row per booking. It deliberately does
 * *not* look for an existing guest with the same name: two different people
 * called דנה לוי are two people, and silently merging them into one CRM record
 * — with one shared marketing consent and one shared block flag — is a worse
 * error than a duplicate row an operator can merge on purpose. The real fix is
 * `guestId` on `BookingDraft`.
 *
 * **`BookingDraft.propertyId` is nullable; `bookings.property_id` is not.**
 * When the draft says `null` the property is read from the unit. The unit
 * always has one, so this always succeeds — it just costs a round trip that a
 * non-null draft field would not.
 *
 * **`guestCount` versus `adults`/`children`/`infants`.** The domain counts
 * heads; the schema separates them, and the separation is what drives extra-
 * guest pricing and occupancy limits. A single count is written entirely to
 * `adults` and read back as the sum of all three, which round-trips a booking
 * this adapter created and *under*-reports nothing — but a booking created
 * through a future UI that fills all three will come back to the domain as one
 * number, losing the split.
 */

import type {
  BookingDraft,
  BookingPatch,
  BookingRepository,
} from '../booking/repository'
import type {
  AvailabilityWindow,
  OccupyingBooking,
  UnitAvailabilityRules,
} from '../booking/availability'
import type { HoldDraft } from '../booking/holds'
import type { BookingSnapshot } from '../booking/state-machine'
import {
  BOOKING_SOURCES,
  BOOKING_STATUSES,
  HOLD_REASONS,
  PRICE_LINE_KINDS,
  type Hold,
  type PriceLine,
} from '../booking/types'
import { ConflictError, NotFoundError } from '../errors'
import type { TransactionHandle } from '../service'
import type { Db, Row } from './client'
import { throwWriteError } from './errors'
import {
  asAgorot,
  asEnum,
  asIsoDate,
  asJsonRecord,
  asNumber,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  definedOnly,
  toRow,
  toRows,
} from './mapping'
import { clientFor, recordWrite } from './transaction'

/**
 * The booking row, plus the guest's name from the row it points at.
 *
 * `guests(full_name)` and deliberately **not** `guests!inner(full_name)`. An
 * inner embed makes the join a filter: a reader holding `booking.view` but not
 * `guest.view` would then see no bookings at all, rather than bookings without
 * a guest name. Losing a name is a privacy rule working; losing the calendar is
 * an outage. See `hydrate` for what an absent guest becomes.
 */
const BOOKING_COLUMNS =
  'id, organization_id, property_id, unit_id, guest_id, reference, status, ' +
  'check_in, check_out, adults, children, infants, source, source_channel, ' +
  'agent_user_id, agency_id, campaign_id, referral_id, total_agorot, ' +
  'created_by, version, guests(full_name)'

const PRICE_LINE_COLUMNS =
  'kind, label, amount_agorot, quantity, line_date, sort_order'

const HOLD_COLUMNS =
  'id, organization_id, unit_id, check_in, check_out, reason, ' +
  'held_by_user_id, expires_at, released_at, converted_to_booking_id'

export class SupabaseBookingRepository implements BookingRepository {
  constructor(private readonly db: Db) {}

  // ── AvailabilitySource ──────────────────────────────────────────────────

  /**
   * Bookings that might touch the window.
   *
   * Over-returning is explicitly fine and under-returning is a double booking,
   * so the filter is deliberately loose: every booking on this unit whose stay
   * overlaps, **whatever its status**. Occupancy is decided in the domain over
   * `OCCUPYING_STATUSES`, and `availability.ts` says why in its own header — a
   * `WHERE status IN (...)` here that drifted from that list would make taken
   * dates look free, and would do it silently.
   */
  async loadBookings(
    window: AvailabilityWindow,
  ): Promise<readonly OccupyingBooking[]> {
    const { data, error } = await this.db
      .from('bookings')
      .select('id, reference, status, check_in, check_out')
      .eq('organization_id', window.organizationId)
      .eq('unit_id', window.unitId)
      // Half-open overlap, the same arithmetic as `rangesOverlap`: a stay that
      // ends on the day another begins does not collide.
      .lt('check_in', window.range.checkOut)
      .gt('check_out', window.range.checkIn)
      .is('deleted_at', null)

    if (error) throw error

    return toRows(data).map((row) => {
      const reference = asStringOrNull(row, 'reference')
      const booking: OccupyingBooking = {
        id: asString(row, 'id'),
        status: asEnum(row, 'status', BOOKING_STATUSES),
        checkIn: asIsoDate(row, 'check_in'),
        checkOut: asIsoDate(row, 'check_out'),
      }
      // `reference` is optional on `OccupyingBooking`, so an absent one is
      // omitted rather than set to null — the blocker message reads better
      // without a literal "null" in it.
      if (reference !== null) booking.reference = reference
      return booking
    })
  }

  /**
   * Holds that might touch the window, expired ones included.
   *
   * Released and converted holds come back too. `isHoldLive` in the domain is
   * what decides, and handing it everything is what lets a hold being
   * converted be excluded by id rather than by a `WHERE` clause that would
   * have to duplicate the liveness rule.
   */
  async loadHolds(window: AvailabilityWindow): Promise<readonly Hold[]> {
    const { data, error } = await this.db
      .from('holds')
      .select(HOLD_COLUMNS)
      .eq('organization_id', window.organizationId)
      .eq('unit_id', window.unitId)
      .lt('check_in', window.range.checkOut)
      .gt('check_out', window.range.checkIn)

    if (error) throw error
    return toRows(data).map(toHold)
  }

  /**
   * What the unit will accept, or `null`.
   *
   * `null` means "the engine cannot vouch for this unit", and
   * `checkAvailability` turns it into a refusal rather than a permissive
   * default — deny by default, in the one place where the alternative is
   * selling a unit nobody configured for sale. So a unit that is missing,
   * soft-deleted, or in any status other than `active` produces `null`. A unit
   * under maintenance is not sellable and this is how that is said.
   *
   * The four date lists have no columns anywhere in `0008`–`0012`: there is no
   * rate calendar and no blocked-date table yet. They are read from
   * `units.metadata` under their domain names, which is a documented
   * convention this adapter owns and a migration should later replace. Absent
   * keys mean "no restriction", which is the correct reading — a unit with no
   * blocked-date list has no blocked dates.
   */
  async loadRules(
    organizationId: string,
    unitId: string,
  ): Promise<UnitAvailabilityRules | null> {
    const { data, error } = await this.db
      .from('units')
      .select('id, min_nights, status, metadata')
      .eq('organization_id', organizationId)
      .eq('id', unitId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = toRow(data)
    if (asString(row, 'status') !== 'active') return null

    const metadata = asJsonRecord(row, 'metadata')
    const rules: UnitAvailabilityRules = {
      unitId: asString(row, 'id'),
      minimumNights: asNumber(row, 'min_nights'),
    }

    const byArrival = metadata.minimumNightsByArrival
    if (isRecordOfNumbers(byArrival)) rules.minimumNightsByArrival = byArrival

    const blocked = readDateList(metadata.blockedDates)
    if (blocked) rules.blockedDates = blocked
    const noArrival = readDateList(metadata.noArrivalDates)
    if (noArrival) rules.noArrivalDates = noArrival
    const noDeparture = readDateList(metadata.noDepartureDates)
    if (noDeparture) rules.noDepartureDates = noDeparture

    return rules
  }

  // ── BookingStore ────────────────────────────────────────────────────────

  async loadBooking(
    organizationId: string,
    bookingId: string,
  ): Promise<BookingSnapshot | null> {
    // Scoped by organization in the query as well as by RLS. The policy is the
    // real floor, and this is the second one: an adapter that relied on RLS
    // alone would leak the moment somebody handed it the admin client.
    //
    // Worth naming the behavioural difference from `MemoryRepository`, which
    // returns another tenant's booking and leaves the refusal to the
    // pipeline's second `assertCan`. Here the row is simply not visible, so a
    // cross-tenant read becomes `NotFoundError` rather than `AuthorizationError`.
    // That is the better answer — it does not confirm the booking exists — but
    // it is a different one, and a test asserting the error class will see it.
    const { data, error } = await this.db
      .from('bookings')
      .select(BOOKING_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', bookingId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    return this.hydrate(toRow(data))
  }

  async insertBooking(
    draft: BookingDraft,
    tx: TransactionHandle,
  ): Promise<BookingSnapshot> {
    const db = clientFor(tx, this.db)
    const propertyId =
      draft.propertyId ?? (await this.propertyForUnit(db, draft))
    const guestId = await this.createGuest(db, draft)

    const { data, error } = await db
      .from('bookings')
      .insert({
        organization_id: draft.organizationId,
        property_id: propertyId,
        unit_id: draft.unitId,
        guest_id: guestId,
        status: draft.status,
        check_in: draft.checkIn,
        check_out: draft.checkOut,
        // The whole party as adults. See the header: the port carries one
        // number and the schema wants three, and inventing a split would be
        // this adapter guessing at how many of them are children.
        adults: draft.guestCount,
        children: 0,
        infants: 0,
        source: draft.attribution.source,
        source_channel: draft.attribution.sourceChannel,
        agent_user_id: draft.attribution.agentUserId,
        agency_id: draft.attribution.agencyId,
        campaign_id: draft.attribution.campaignId,
        referral_id: draft.attribution.referralId,
        created_by: draft.createdByUserId,
        // `total_agorot` is absent on purpose. `tg_bookings_freeze_total`
        // owns it and would overwrite whatever were sent. `reference` and
        // `guest_token` are absent for the same reason: the column defaults
        // generate them, and the reference is what a guest quotes on the phone.
      })
      .select(BOOKING_COLUMNS)
      .single()

    if (error) {
      // The one translation this layer performs, and only for `23P01` from
      // `unit_occupancy_no_overlap`. Everything else — a network failure, a
      // missing grant, a foreign key — propagates as itself, because telling a
      // guest their dates are taken when the connection dropped is a specific
      // and expensive lie.
      throwWriteError(error, {
        resourceType: 'booking',
        range: { checkIn: draft.checkIn, checkOut: draft.checkOut },
      })
    }

    const inserted = toRow(data)
    const bookingId = asString(inserted, 'id')
    recordWrite(tx, `bookings(${bookingId})`)

    await this.writePriceLines(db, {
      bookingId,
      organizationId: draft.organizationId,
      propertyId,
      lines: draft.lines,
      tx,
    })

    // Re-read rather than map what the insert returned. The price lines have
    // just moved the version and the total, and handing back the pre-line
    // numbers would give the caller an `expectedVersion` that is already
    // wrong — a conflict on the next edit, for no reason.
    const snapshot = await this.loadBooking(draft.organizationId, bookingId)
    if (!snapshot) {
      // Reachable only when the caller may create a booking but not read one
      // back: `bookings_insert` requires `booking.create`, `bookings_select`
      // requires `booking.view`, and nothing forces an organization to grant
      // both together. Saying so plainly beats returning a half-built object.
      throw new NotFoundError('booking', bookingId)
    }
    return snapshot
  }

  async updateBooking(args: {
    bookingId: string
    patch: BookingPatch
    expectedVersion: number
    tx: TransactionHandle
  }): Promise<BookingSnapshot> {
    const { bookingId, patch, expectedVersion, tx } = args
    const db = clientFor(tx, this.db)

    if (patch.totalAgorot !== undefined && patch.lines === undefined) {
      // Not a silent no-op. `total_agorot` is derived from the price lines by
      // trigger, so a patch that moves the total without moving the lines
      // cannot be honoured, and pretending otherwise would report a price
      // change that did not happen. Every current call site sends the two
      // together — see `booking.amend` — so this is a guard against a future
      // caller, not a live failure.
      throw new Error(
        'BookingPatch.totalAgorot cannot be applied without lines: ' +
          'bookings.total_agorot is derived from booking_price_lines by ' +
          'tg_bookings_freeze_total. Send the lines that produce the total.',
      )
    }

    const columns = definedOnly({
      status: patch.status,
      check_in: patch.checkIn,
      check_out: patch.checkOut,
    })

    // Even a lines-only patch takes the lock. `updated_at` is touched by the
    // trigger anyway; naming the row in a version-conditional update is what
    // makes the optimistic check happen in the database rather than only in
    // the pipeline's memory, which is the whole point of `expectedVersion`.
    const { data, error } = await db
      .from('bookings')
      .update(
        Object.keys(columns).length > 0
          ? columns
          : { updated_at: new Date().toISOString() },
      )
      .eq('id', bookingId)
      .eq('version', expectedVersion)
      .select('id, organization_id, property_id, version')

    if (error) {
      // Moving the dates can collide exactly as creating them can.
      throwWriteError(error, {
        resourceType: 'booking',
        resourceId: bookingId,
        range:
          patch.checkIn && patch.checkOut
            ? { checkIn: patch.checkIn, checkOut: patch.checkOut }
            : undefined,
      })
    }

    const rows = toRows(data)
    if (rows.length === 0) {
      // Zero rows is a conflict, never a silent success. Either somebody else
      // wrote first and the version moved, or the row is not visible to this
      // caller — and both mean this update did not happen. Proved live: a
      // `where id = ... and version = 99` matched 0 rows.
      throw new ConflictError({
        resourceType: 'booking',
        resourceId: bookingId,
        expectedVersion,
        actualVersion: await this.currentVersion(db, bookingId),
      })
    }

    const updated = rows[0]
    const organizationId = asString(updated, 'organization_id')
    recordWrite(tx, `bookings(${bookingId})`)

    if (patch.lines !== undefined) {
      await this.writePriceLines(db, {
        bookingId,
        organizationId,
        propertyId: asString(updated, 'property_id'),
        lines: patch.lines,
        tx,
        replace: true,
      })
    }

    const snapshot = await this.loadBooking(organizationId, bookingId)
    if (!snapshot) throw new NotFoundError('booking', bookingId)
    return snapshot
  }

  // ── HoldStore ───────────────────────────────────────────────────────────

  async loadHold(organizationId: string, holdId: string): Promise<Hold | null> {
    const { data, error } = await this.db
      .from('holds')
      .select(HOLD_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', holdId)
      .maybeSingle()

    if (error) throw error
    return data ? toHold(toRow(data)) : null
  }

  /**
   * Every hold this person has that has not been released.
   *
   * Expired ones included, matching `MemoryRepository` exactly: it filters
   * `releasedAt === null` and nothing else. `countLiveHoldsBy` in the domain
   * applies the clock. A `WHERE expires_at > now()` here would look like an
   * optimisation and would be a behaviour change — it would make an agent's
   * live-hold count depend on a query rather than on the domain's definition
   * of live.
   */
  async loadHoldsByUser(
    organizationId: string,
    userId: string,
  ): Promise<readonly Hold[]> {
    const { data, error } = await this.db
      .from('holds')
      .select(HOLD_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('held_by_user_id', userId)
      .is('released_at', null)

    if (error) throw error
    return toRows(data).map(toHold)
  }

  async insertHold(draft: HoldDraft, tx: TransactionHandle): Promise<Hold> {
    const db = clientFor(tx, this.db)
    const propertyId = await this.propertyForUnit(db, draft)

    const { data, error } = await db
      .from('holds')
      .insert({
        organization_id: draft.organizationId,
        property_id: propertyId,
        unit_id: draft.unitId,
        check_in: draft.checkIn,
        check_out: draft.checkOut,
        reason: draft.reason,
        held_by_user_id: draft.heldByUserId,
        expires_at: draft.expiresAt,
        released_at: draft.releasedAt,
        converted_to_booking_id: draft.convertedToBookingId,
      })
      .select(HOLD_COLUMNS)
      .single()

    if (error) {
      // A hold is projected into `unit_occupancy` too, so it collides with
      // bookings and with other live holds through the same constraint.
      throwWriteError(error, {
        resourceType: 'hold',
        range: { checkIn: draft.checkIn, checkOut: draft.checkOut },
      })
    }

    const hold = toHold(toRow(data))
    recordWrite(tx, `holds(${hold.id})`)
    return hold
  }

  /**
   * Persist a hold the domain has returned — released, extended or converted.
   *
   * Unconditional on version, because `HoldStore.saveHold` takes no
   * `expectedVersion` and the domain's `Hold` carries none. That is last write
   * wins, and it is safe for the three transitions that exist: releasing an
   * already-released hold is idempotent, and converting one is guarded by the
   * `converted_to_booking_id` the caller read. If holds ever gain an operation
   * where two writers can disagree, the port needs a version and this needs to
   * refuse — it cannot be fixed here alone.
   */
  async saveHold(hold: Hold, tx: TransactionHandle): Promise<Hold> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('holds')
      .update({
        check_in: hold.checkIn,
        check_out: hold.checkOut,
        reason: hold.reason,
        expires_at: hold.expiresAt,
        released_at: hold.releasedAt,
        converted_to_booking_id: hold.convertedToBookingId,
      })
      .eq('id', hold.id)
      .eq('organization_id', hold.organizationId)
      .select(HOLD_COLUMNS)

    if (error) {
      throwWriteError(error, {
        resourceType: 'hold',
        resourceId: hold.id,
        range: { checkIn: hold.checkIn, checkOut: hold.checkOut },
      })
    }

    const rows = toRows(data)
    if (rows.length === 0) throw new NotFoundError('hold', hold.id)

    recordWrite(tx, `holds(${hold.id})`)
    return toHold(rows[0])
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** The booking row plus everything that is not on it. */
  private async hydrate(row: Row): Promise<BookingSnapshot> {
    const bookingId = asString(row, 'id')
    const organizationId = asString(row, 'organization_id')

    const [lines, depositHeldAgorot] = await Promise.all([
      this.loadPriceLines(bookingId),
      this.loadDepositHeld(organizationId, bookingId),
    ])

    return {
      id: bookingId,
      organizationId,
      propertyId: asStringOrNull(row, 'property_id'),
      unitId: asString(row, 'unit_id'),
      reference: asString(row, 'reference'),
      status: asEnum(row, 'status', BOOKING_STATUSES),
      checkIn: asIsoDate(row, 'check_in'),
      checkOut: asIsoDate(row, 'check_out'),
      // Empty when the guest row is not visible to this reader — `guests_select`
      // requires `guest.view`, which a cleaner does not hold. The name is
      // withheld, not lost: the booking, its dates and its unit still render,
      // which is exactly what a housekeeping board needs and no more. A screen
      // that must show a guest name has to require `guest.view` itself rather
      // than read an empty string as "unnamed guest".
      guestName: readGuestName(row),
      // Read back as the sum, so a booking created through a UI that fills all
      // three columns still reports the whole party rather than the adults.
      guestCount:
        asNumber(row, 'adults') +
        asNumber(row, 'children') +
        asNumber(row, 'infants'),
      version: asNumber(row, 'version'),
      // `depositRequiredAgorot` is not a column. `priceStay` emits the
      // refundable deposit as a `deposit` price line and includes it in the
      // total — see `pricing.ts` — so the lines are already the record of it,
      // and deriving it here is reading the same fact rather than storing it
      // twice and letting the two disagree.
      depositRequiredAgorot: sumLinesOfKind(lines, 'deposit'),
      depositHeldAgorot,
      totalAgorot: asAgorot(row, 'total_agorot'),
      lines,
      attribution: {
        source: asEnum(row, 'source', BOOKING_SOURCES),
        sourceChannel: asStringOrNull(row, 'source_channel'),
        agentUserId: asStringOrNull(row, 'agent_user_id'),
        agencyId: asStringOrNull(row, 'agency_id'),
        campaignId: asStringOrNull(row, 'campaign_id'),
        referralId: asStringOrNull(row, 'referral_id'),
      },
      createdByUserId: asStringOrNull(row, 'created_by'),
    }
  }

  /**
   * The booking's price lines, in display order.
   *
   * A caveat worth stating rather than discovering: `booking_price_lines_select`
   * requires `booking.view_price`, which `bookings_select` does not. A reader
   * holding `booking.view` but not `booking.view_price` — a cleaner, by design
   * — gets an empty list here, and therefore a `depositRequiredAgorot` of zero,
   * while `totalAgorot` reads correctly off the booking row. That is the
   * privacy rule working as intended, and it means a `BookingSnapshot` is not
   * automatically a complete one. Any screen that renders a price breakdown
   * has to require the field permission itself rather than infer it from an
   * empty array.
   */
  private async loadPriceLines(bookingId: string): Promise<PriceLine[]> {
    const { data, error } = await this.db
      .from('booking_price_lines')
      .select(PRICE_LINE_COLUMNS)
      .eq('booking_id', bookingId)
      .order('sort_order', { ascending: true })

    if (error) throw error

    return toRows(data).map((row) => {
      return {
        kind: asEnum(row, 'kind', PRICE_LINE_KINDS),
        label: asString(row, 'label'),
        amount: asAgorot(row, 'amount_agorot'),
        // `numeric`, so PostgREST sends it as a string. Half-guest quantities
        // are not a thing, but the column allows them and `asNumber` is what
        // stops `"1"` reaching arithmetic as text.
        quantity: asNumber(row, 'quantity'),
        date: asStringOrNull(row, 'line_date'),
      }
    })
  }

  /** What is actually held right now. Zero when no deposit was ever taken. */
  private async loadDepositHeld(
    organizationId: string,
    bookingId: string,
  ): Promise<number> {
    const { data, error } = await this.db
      .from('deposits')
      .select('held_agorot')
      .eq('organization_id', organizationId)
      .eq('booking_id', bookingId)
      .maybeSingle()

    if (error) throw error
    return data ? asAgorot(toRow(data), 'held_agorot') : 0
  }

  private async writePriceLines(
    db: Db,
    args: {
      bookingId: string
      organizationId: string
      propertyId: string
      lines: readonly PriceLine[]
      tx: TransactionHandle
      replace?: boolean
    },
  ): Promise<void> {
    if (args.replace) {
      const { error } = await db
        .from('booking_price_lines')
        .delete()
        .eq('booking_id', args.bookingId)
      if (error) throw error
      recordWrite(args.tx, `booking_price_lines(delete ${args.bookingId})`)
    }

    if (args.lines.length === 0) return

    const { error } = await db.from('booking_price_lines').insert(
      args.lines.map((line, index) => ({
        organization_id: args.organizationId,
        property_id: args.propertyId,
        booking_id: args.bookingId,
        kind: line.kind,
        label: line.label,
        amount_agorot: line.amount,
        quantity: line.quantity,
        line_date: line.date,
        // The domain's array order is the order a guest reads the quote in,
        // and rows have no inherent order. Storing the index is what keeps
        // "3 nights, cleaning, then the discount" from coming back shuffled.
        sort_order: index,
      })),
    )

    if (error) throw error
    recordWrite(
      args.tx,
      `booking_price_lines(${args.lines.length} × ${args.bookingId})`,
    )
  }

  /**
   * A guest row for this booking's named guest.
   *
   * See the header for why this creates rather than matches. `full_name` is
   * the only field the port carries; everything else on `guests` is left to
   * its default, so the record is honest about knowing nothing more.
   */
  private async createGuest(db: Db, draft: BookingDraft): Promise<string> {
    const { data, error } = await db
      .from('guests')
      .insert({
        organization_id: draft.organizationId,
        full_name: draft.guestName,
        created_by: draft.createdByUserId,
      })
      .select('id')
      .single()

    if (error) throw error
    return asString(toRow(data), 'id')
  }

  /** The unit's property, for the columns the domain leaves out. */
  private async propertyForUnit(
    db: Db,
    draft: { organizationId: string; unitId: string },
  ): Promise<string> {
    const { data, error } = await db
      .from('units')
      .select('property_id')
      .eq('organization_id', draft.organizationId)
      .eq('id', draft.unitId)
      .maybeSingle()

    if (error) throw error
    if (!data) throw new NotFoundError('unit', draft.unitId)
    return asString(toRow(data), 'property_id')
  }

  /**
   * The version a conflicting row actually holds, for the error message.
   *
   * Best effort: the row may be invisible to this caller, in which case the
   * honest answer is `null` and the message says "found none". A second query
   * that itself threw would replace a useful conflict with a confusing one.
   */
  private async currentVersion(
    db: Db,
    bookingId: string,
  ): Promise<number | null> {
    const { data, error } = await db
      .from('bookings')
      .select('version')
      .eq('id', bookingId)
      .maybeSingle()

    if (error || !data) return null
    return asNumber(toRow(data), 'version')
  }
}

// ── Row mapping ───────────────────────────────────────────────────────────

function toHold(row: Row): Hold {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    unitId: asString(row, 'unit_id'),
    checkIn: asIsoDate(row, 'check_in'),
    checkOut: asIsoDate(row, 'check_out'),
    reason: asEnum(row, 'reason', HOLD_REASONS),
    heldByUserId: asString(row, 'held_by_user_id'),
    // Normalised through `Date`. Postgres renders `+00:00` and the domain
    // compares expiry against `toISOString()` output, which renders `Z`; as
    // strings those are not equal, and a hold's liveness is exactly such a
    // comparison.
    expiresAt: asTimestamp(row, 'expires_at'),
    releasedAt: asTimestampOrNull(row, 'released_at'),
    convertedToBookingId: asStringOrNull(row, 'converted_to_booking_id'),
  }
}

function sumLinesOfKind(
  lines: readonly PriceLine[],
  kind: PriceLine['kind'],
): number {
  return lines
    .filter((line) => line.kind === kind)
    .reduce((total, line) => total + line.amount, 0)
}

/** The embedded guest's name, or `''` when the reader may not see it. */
function readGuestName(row: Row): string {
  const embedded = row.guests
  const guest = Array.isArray(embedded)
    ? (embedded[0] as Row | undefined)
    : (embedded as Row | null)
  if (!guest) return ''
  return asStringOrNull(guest, 'full_name') ?? ''
}

function isRecordOfNumbers(
  value: unknown,
): value is Readonly<Record<string, number>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every((entry) => typeof entry === 'number')
}

function readDateList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((entry): entry is string => typeof entry === 'string')
}
